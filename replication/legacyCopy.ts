import { toBufferKey } from 'ordered-binary';
import { LOCAL_ONLY } from '../core/resources/auditStore.ts';

const BATCH_SIZE = 256;
const failedCopies = new Map<string, { tableName: string; key: any }>();

interface VerifyEntry {
	key: any;
	version: number;
	metadataFlags?: number;
	isTombstone: boolean;
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
	async function verifyBatch(tableName: string, entries: VerifyEntry[]) {
		checkOpen();
		let description = descriptions.get(tableName);
		if (!description) {
			const remote = await request({ operation: 'describe_table', database: databaseName, table: tableName });
			checkOpen();
			const timestamps = remote.attributes?.filter(
				(attribute) => attribute.assigned_updated_time || attribute.attribute === '__updatedtime__'
			);
			// `hash_attribute` is a legacy v4 describe_table field; current describe_table reports `primary_key`.
			const primaryKey = remote.hash_attribute ?? remote.primary_key;
			if (
				typeof primaryKey !== 'string' ||
				timestamps?.length !== 1 ||
				timestamps[0].computed ||
				['Date', 'String'].includes(timestamps[0].type)
			)
				throw new Error('Cannot verify replication baseline without numeric update timestamps');
			description = { primaryKey, updatedTime: timestamps[0].attribute };
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
			const remotePresent = Number.isFinite(remoteVersion);
			const remoteBehind = remotePresent && remoteVersion < entry.version;
			// A tombstone passes if the peer lacks the row or is already caught up — it must not be
			// required to hold a row that no longer exists. An OLDER live peer row means it never got
			// the delete, so fail closed exactly as a live row would; leaving would strand it forever.
			const failed =
				!Number.isFinite(entry.version) || (entry.isTombstone ? remoteBehind : !remotePresent || remoteBehind);
			if (failed) {
				failedCopies.delete(cacheKey);
				if (failedCopies.size >= 256) failedCopies.delete(failedCopies.keys().next().value);
				failedCopies.set(cacheKey, { tableName, key: entry.key });
				throw new Error(
					`Historical restoration into an unverified peer is unsupported (${databaseName}.${tableName} key ${String(entry.key)})`
				);
			}
		}
	}
	function eligibleEntry(entry) {
		if (entry.metadataFlags & LOCAL_ONLY) return undefined;
		return copyEntry(entry);
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
			let raw = cursor.iterator.next();
			let eligible;
			while (!raw.done && !(eligible = eligibleEntry(raw.value))) raw = cursor.iterator.next();
			cursors[cursors.length - 1].first = raw.done ? raw : { done: false, value: eligible };
		}
		const previousFailure = failedCopies.get(cacheKey);
		if (previousFailure) {
			const table = tables[previousFailure.tableName];
			const rawEntry = await table?.primaryStore.getEntry(previousFailure.key);
			checkOpen();
			const eligible = rawEntry && eligibleEntry(rawEntry);
			if (eligible) await verifyBatch(previousFailure.tableName, [eligible]);
			failedCopies.delete(cacheKey);
		}
		for (const { tableName, iterator, first } of cursors) {
			let entries: VerifyEntry[] = [];
			for (let next = first; !next.done; next = iterator.next()) {
				checkOpen();
				// `first` is already a validated, copied entry; every later `next` is a fresh raw one.
				const entry = next === first ? next.value : eligibleEntry(next.value);
				if (!entry) continue;
				entries.push(entry);
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
		// A deleted key stays in the primary store as a tombstone (value === null) until audit cleanup
		// removes it.
		isTombstone: !entry.value,
	};
}
