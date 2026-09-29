import { findIncompleteBlobRefs, findBlobsInObject, isSaving, isBlobComplete } from '../core/resources/blob.ts';
import { getRepairConnectionsForDB } from './replicator.ts';
import { databases } from '../core/resources/databases.ts';
import { server } from '../core/server/Server.ts';
import harperLogger from '../core/utility/logging/harper_logger.js';
import type { Logger } from '../core/utility/logging/logger.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBackoff, type Backoff } from './backoff.ts';

const logger = harperLogger.forComponent('blob-repair').conditional as Logger;

const REPAIR_RETRY_INITIAL_MS = 50;
const REPAIR_RETRY_MAX_MS = 1000;
// Do not stop the sweep when this budget is spent: a later record may still be repairable.
const REPAIR_PACING_BUDGET_MS = 60_000;
const REPAIR_UNPACED_WARN_EVERY = 100;

export function createRepairPacing(deps: { now?: () => number; random?: () => number } = {}) {
	let backoff: Backoff | undefined;
	return {
		nextDelay() {
			backoff ??= createBackoff({
				initialMs: REPAIR_RETRY_INITIAL_MS,
				maxMs: REPAIR_RETRY_MAX_MS,
				budgetMs: REPAIR_PACING_BUDGET_MS,
				now: deps.now,
				random: deps.random,
			});
			return backoff.nextDelay();
		},
		reset() {
			backoff = undefined;
		},
	};
}

export async function allBlobsAreComplete(
	blobs: any[],
	checkBlob: (blob: any) => Promise<boolean> = isBlobComplete
): Promise<boolean> {
	return blobs.length > 0 && (await Promise.all(blobs.map((blob) => checkBlob(blob)))).every(Boolean);
}

export async function repairBlobs(
	dbName: string,
	deps: { sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {}
): Promise<{ checked: number; repaired: number; failed: number; noConnection: number }> {
	const database = (databases as any)[dbName];
	if (!database) throw new Error(`Unknown database '${dbName}'`);
	const pause = deps.sleep ?? sleep;

	let checked = 0;
	let repaired = 0;
	let failed = 0;
	let noConnection = 0;
	const pacing = createRepairPacing({ now: deps.now });
	let pacingSpent = false;

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

		// Once unpaced, the per-record warns fire at peer-RTT rate for the rest of the sweep; sample them.
		const logRecord = !pacingSpent || (failed + 1) % REPAIR_UNPACED_WARN_EVERY === 0;
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
				if (logRecord) logger.warn?.('Blob repair fetch failed for record', recordId, 'in', tableName, error);
			}
		}

		if (peerRepaired) {
			pacing.reset();
			pacingSpent = false;
		} else {
			failed++;
			if (logRecord)
				logger.warn?.(
					'Could not repair blob for record',
					recordId,
					'in',
					tableName,
					'— no peer had a complete copy',
					pacingSpent ? `(${failed} failed so far; sampling 1 in ${REPAIR_UNPACED_WARN_EVERY})` : ''
				);
			const delay = pacing.nextDelay();
			if (delay === undefined) {
				if (!pacingSpent) {
					pacingSpent = true;
					logger.warn?.(
						'Blob repair pacing budget spent for',
						dbName,
						`after ${REPAIR_PACING_BUDGET_MS}ms of unrepairable records; continuing the sweep unpaced`
					);
				}
			} else await pause(delay);
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
		// fire and forget — repair can take hours on large datasets
		repairBlobs(dbName).catch((err) => logger.error?.('Blob repair failed', dbName, err));
		return { message: 'Blob repair started, check logs for progress' };
	},
	httpMethod: 'POST',
});
