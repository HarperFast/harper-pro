import { findIncompleteBlobRefs, findBlobsInObject, isSaving, isBlobComplete } from '../core/resources/blob.ts';
import { getRepairConnectionsForDB } from './replicator.ts';
import { databases } from '../core/resources/databases.ts';
import { server } from '../core/server/Server.ts';
import harperLogger from '../core/utility/logging/harper_logger.js';
import type { Logger } from '../core/utility/logging/logger.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBackoff } from './backoff.ts';

const logger = harperLogger.forComponent('blob-repair').conditional as Logger;

// Paces a sweep whose peers cannot serve anything: without it the per-record loop spins as fast as the
// incomplete-blob cursor yields. Capped low (not at the 30s replication cap) because the delay is paid
// per unrepairable record while the cursor stays open, so a big backlog must still finish in hours.
const REPAIR_RETRY_INITIAL_MS = 50;
const REPAIR_RETRY_MAX_MS = 1000;
// One sweep per database per thread. `repair_blob_data` is fire-and-forget, so repeated calls landing on
// the same thread used to stack concurrent sweeps over the same records, wasting peer fetches and
// defeating the pacing above. Calls routed to different threads are still independent.
const sweepsInFlight = new Set<string>();

export async function allBlobsAreComplete(
	blobs: any[],
	checkBlob: (blob: any) => Promise<boolean> = isBlobComplete
): Promise<boolean> {
	return blobs.length > 0 && (await Promise.all(blobs.map((blob) => checkBlob(blob)))).every(Boolean);
}

export async function repairBlobs(
	dbName: string,
	deps: { sleep?: (ms: number) => Promise<unknown> } = {}
): Promise<{ checked: number; repaired: number; failed: number; noConnection: number }> {
	const database = (databases as any)[dbName];
	if (!database) throw new Error(`Unknown database '${dbName}'`);
	const pause = deps.sleep ?? sleep;

	let checked = 0;
	let repaired = 0;
	let failed = 0;
	let noConnection = 0;
	const backoff = createBackoff({ initialMs: REPAIR_RETRY_INITIAL_MS, maxMs: REPAIR_RETRY_MAX_MS });

	for await (const { tableName, table, recordId } of findIncompleteBlobRefs(database, dbName)) {
		checked++;
		// Refresh connection list per record — connections can change mid-sweep, and this is a
		// cold-path operation so the overhead of re-querying is acceptable.
		const peerConnections = getRepairConnectionsForDB(dbName);
		if (!peerConnections.length) {
			noConnection++;
			logger.warn?.('No peer connections available for blob repair, stopping', dbName, 'checked so far', checked);
			break;
		}

		let peerRepaired = false;
		for (const connection of peerConnections) {
			try {
				const entry = await connection.getRecord({ table, id: recordId, blobRepairOnly: true });
				if (!entry?.value) continue; // peer doesn't have the record

				// Collect in-flight blob save promises set up by receiveBlobs during GET_RECORD_RESPONSE decode.
				const savingPromises: Promise<void>[] = [];
				findBlobsInObject(entry.value, (blob) => {
					const saving = isSaving(blob);
					if (saving) savingPromises.push(saving);
				});

				if (!savingPromises.length) continue; // peer sent no blob data

				await Promise.all(savingPromises);

				// Verify the blobs are now complete on disk — the peer may have sent empty bytes if
				// its own copy was also incomplete (promisedWrites returns Buffer.alloc(0)).
				const repairedBlobs: any[] = [];
				findBlobsInObject(entry.value, (blob) => repairedBlobs.push(blob));
				const allComplete = await allBlobsAreComplete(repairedBlobs);

				if (!allComplete) continue; // peer's copy was also incomplete, try next peer

				repaired++;
				peerRepaired = true;
				logger.info?.('Repaired blob for record', recordId, 'in', tableName);
				break;
			} catch (error) {
				logger.warn?.('Blob repair fetch failed for record', recordId, 'in', tableName, error);
			}
		}

		if (peerRepaired) {
			backoff.reset();
		} else {
			failed++;
			logger.warn?.('Could not repair blob for record', recordId, 'in', tableName, '— no peer had a complete copy');
			await pause(backoff.nextDelay());
		}
	}

	logger.warn?.('Blob repair complete for', dbName, { checked, repaired, failed, noConnection });
	return { checked, repaired, failed, noConnection };
}

server.registerOperation?.({
	name: 'repair_blob_data',
	execute: async (request: any) => {
		if (!request.database) throw new Error('Must provide "database" name for blob repair');
		const dbName = request.database;
		if (!(databases as any)[dbName]) throw new Error(`Unknown database '${dbName}'`);
		if (sweepsInFlight.has(dbName)) return { message: `Blob repair already running for '${dbName}'` };
		sweepsInFlight.add(dbName);
		// fire and forget — repair can take hours on large datasets
		repairBlobs(dbName)
			.catch((err) => logger.error?.('Blob repair failed', dbName, err))
			.finally(() => sweepsInFlight.delete(dbName));
		return { message: 'Blob repair started, check logs for progress' };
	},
	httpMethod: 'POST',
});
