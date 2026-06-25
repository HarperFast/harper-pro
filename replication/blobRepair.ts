import { findIncompleteBlobRefs, findBlobsInObject, isSaving, isBlobComplete } from '../core/resources/blob.ts';
import { getRepairConnectionsForDB } from './replicator.ts';
import { databases } from '../core/resources/databases.ts';
import { server } from '../core/server/Server.ts';
import harperLogger from '../core/utility/logging/harper_logger.js';
import type { Logger } from '../core/utility/logging/logger.ts';

const logger = harperLogger.forComponent('blob-repair').conditional as Logger;

export async function repairBlobs(
	dbName: string
): Promise<{ checked: number; repaired: number; failed: number; noConnection: number }> {
	const database = (databases as any)[dbName];
	if (!database) throw new Error(`Unknown database '${dbName}'`);

	let checked = 0;
	let repaired = 0;
	let failed = 0;
	let noConnection = 0;

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
				const allComplete = entry.value
					? (() => {
							let complete = true;
							findBlobsInObject(entry.value, (blob) => {
								if (!isBlobComplete(blob)) complete = false;
							});
							return complete;
						})()
					: false;

				if (!allComplete) continue; // peer's copy was also incomplete, try next peer

				repaired++;
				peerRepaired = true;
				logger.info?.('Repaired blob for record', recordId, 'in', tableName);
				break;
			} catch (error) {
				logger.warn?.('Blob repair fetch failed for record', recordId, 'in', tableName, error);
			}
		}

		if (!peerRepaired) {
			failed++;
			logger.warn?.('Could not repair blob for record', recordId, 'in', tableName, '— no peer had a complete copy');
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
