import { toBufferKey } from 'ordered-binary';
import { LOCAL_ONLY } from '../core/resources/auditStore.ts';

const BATCH_SIZE = 256;
const failedCopies = new Map<string, { tableName: string; key: any }>();

export function isLegacyCopyPeer(response: any): boolean {
	const match = typeof response?.version === 'string' && /^v?(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(response.version);
	if (!match || Number(match[1]) < 4) throw new Error('Unsupported peer version for replication base copy');
	return Number(match[1]) === 4;
}

export async function verifyLegacyCopyBaseline({
	peerName,
	databaseName,
	tables,
	request,
	isClosed,
}: {
	peerName: string;
	databaseName: string;
	tables: Record<string, any>;
	request: (operation: any) => Promise<any>;
	isClosed: () => boolean;
}): Promise<void> {
	const cacheKey = JSON.stringify([peerName, databaseName]);
	const descriptions = new Map<string, { primaryKey: string; updatedTime: string }>();
	function checkOpen() {
		if (isClosed()) throw new Error('Connection closed during legacy copy verification');
	}
	async function verifyBatch(tableName: string, entries: Array<{ key: any; version: number }>) {
		checkOpen();
		let description = descriptions.get(tableName);
		if (!description) {
			const remote = await request({ operation: 'describe_table', database: databaseName, table: tableName });
			checkOpen();
			const timestamps = remote.attributes?.filter(
				(attribute) => attribute.assigned_updated_time || attribute.attribute === '__updatedtime__'
			);
			if (
				typeof remote.hash_attribute !== 'string' ||
				timestamps?.length !== 1 ||
				timestamps[0].computed ||
				['Date', 'String'].includes(timestamps[0].type)
			)
				throw new Error('Cannot verify v4 baseline without numeric update timestamps');
			description = { primaryKey: remote.hash_attribute, updatedTime: timestamps[0].attribute };
			descriptions.set(tableName, description);
		}
		const response = await request({
			operation: 'search_by_id',
			database: databaseName,
			table: tableName,
			ids: entries.map((entry) => entry.key),
			get_attributes: [description.primaryKey, description.updatedTime],
		});
		checkOpen();
		if (!Array.isArray(response?.results)) throw new Error('Invalid legacy baseline verification response');
		const versions = new Map<string, number>();
		for (const row of response.results) {
			const key = row[description.primaryKey];
			if (key !== undefined) versions.set(toBufferKey(key).toString('hex'), row[description.updatedTime]);
		}
		for (const entry of entries) {
			const remoteVersion = versions.get(toBufferKey(entry.key).toString('hex'));
			if (!Number.isFinite(entry.version) || !Number.isFinite(remoteVersion) || remoteVersion < entry.version) {
				failedCopies.delete(cacheKey);
				if (failedCopies.size >= 256) failedCopies.delete(failedCopies.keys().next().value);
				failedCopies.set(cacheKey, { tableName, key: entry.key });
				throw new Error('Historical restoration from v5 to v4 is unsupported');
			}
		}
	}
	const cursors: Array<{ tableName: string; iterator: Iterator<any>; first?: IteratorResult<any> }> = [];
	try {
		// Pin every table before the first peer RPC; concurrent writes belong to post-copy audit replay.
		for (const [tableName, table] of Object.entries(tables)) {
			const cursor = {
				tableName,
				iterator: table.primaryStore.getRange({ snapshot: true, versions: true })[Symbol.iterator](),
			};
			cursors.push(cursor);
			const first = cursor.iterator.next();
			cursors[cursors.length - 1].first = first.done ? first : { done: false, value: copyEntry(first.value) };
		}
		const previousFailure = failedCopies.get(cacheKey);
		if (previousFailure) {
			const table = tables[previousFailure.tableName];
			const entry = await table?.primaryStore.getEntry(previousFailure.key);
			checkOpen();
			if (entry && !(entry.metadataFlags & LOCAL_ONLY))
				await verifyBatch(previousFailure.tableName, [{ key: previousFailure.key, version: entry.version }]);
			failedCopies.delete(cacheKey);
		}
		for (const { tableName, iterator, first } of cursors) {
			let entries: Array<{ key: any; version: number }> = [];
			for (let next = first; !next.done; next = iterator.next()) {
				checkOpen();
				const entry = next.value;
				if (entry.metadataFlags & LOCAL_ONLY) continue;
				entries.push(copyEntry(entry));
				if (entries.length === BATCH_SIZE) {
					await verifyBatch(tableName, entries);
					entries = [];
				}
			}
			if (entries.length) await verifyBatch(tableName, entries);
		}
		failedCopies.delete(cacheKey);
	} finally {
		for (const { iterator } of cursors) iterator.return?.();
	}
}

function copyEntry(entry) {
	return {
		key: Buffer.isBuffer(entry.key) ? Buffer.from(entry.key) : entry.key,
		version: entry.version,
		metadataFlags: entry.metadataFlags,
	};
}
