import { createRequire } from 'node:module';

const FULL_WRITE_HEAD = 0x40000;

// The name a replicated entry's origin id stands for: its log's, else the node id mapping the copy delivered
// (a node that never connected to an origin has no log for it).
function originName(auditStore, nodeId) {
	if (!nodeId) return null;
	const logs = auditStore.loadLogs();
	for (const [name, log] of auditStore.logByName) if (log === logs[nodeId]) return name;
	try {
		const { unpack } = createRequire(process.argv[1])('msgpackr');
		const mapping = unpack(auditStore.getBinary(Symbol.for('remote-ids'))).remoteNameToId;
		return Object.keys(mapping).find((name) => mapping[name] === nodeId) ?? null;
	} catch {
		return null;
	}
}

export class StoredRow extends Resource {
	static loadAsInstance = false;

	async post(target, { database, table, id }) {
		const Table = databases[database][table];
		const entry = Table.primaryStore.getEntry(id);
		if (!entry) return { stored: false };
		return {
			stored: true,
			present: entry.value != null,
			version: entry.version,
			origin: originName(Table.auditStore, entry.nodeId),
			fullWriteHead: Boolean(entry.metadataFlags & FULL_WRITE_HEAD),
			originId: entry.nodeId ?? 0,
			// a tombstone's own identity is its boundary; only one under a later write is separate state
			boundary:
				!(entry.metadataFlags & FULL_WRITE_HEAD) && entry.copiedDeleteBoundary
					? {
							version: entry.copiedDeleteBoundary.version,
							origin: originName(Table.auditStore, entry.copiedDeleteBoundary.nodeId),
						}
					: undefined,
			history: (await Table.getHistoryOfRecord(id)).length,
		};
	}
}

// Writes committed in one transaction, so a peer applies them in one frame.
export class WriteTogether extends Resource {
	static loadAsInstance = false;

	async post(target, { database, writes }) {
		const context = {};
		await transaction(context, async () => {
			for (const { table, op, id, record } of writes) {
				const Table = databases[database][table];
				if (op === 'patch') await Table.patch(id, record, context);
				else if (op === 'publish') await Table.publish(id, record, context);
				else if (op === 'rewrite')
					await Table.put(id, JSON.parse(JSON.stringify(await Table.get(id, context))), context);
				else await Table.put(id, record, context);
			}
		});
		const versions = {};
		for (const { table, id } of writes) versions[id] = databases[database][table].primaryStore.getEntry(id)?.version;
		return versions;
	}
}

// A write older than the row's stored version, from the origin that wrote it, as replication applies one.
export class Redeliver extends Resource {
	static loadAsInstance = false;

	async post(target, { database, table, id, record, behind }) {
		const Table = databases[database][table];
		const { version, nodeId } = Table.primaryStore.getEntry(id);
		const olderVersion = version - behind;
		const context = { source: {}, sourceApply: true, timestamp: olderVersion };
		await transaction(context, async () => {
			const row = await Table.getResource(id, context);
			row._writeUpdate(id, record, true, { isNotification: true, nodeId, version: olderVersion });
		});
	}
}
