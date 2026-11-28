import { createRequire } from 'node:module';

const FULL_WRITE_HEAD = 0x40000;

function originName(auditStore, nodeId) {
	if (!nodeId) return null;
	const { unpack } = createRequire(process.argv[1])('msgpackr');
	const mapping = unpack(auditStore.getBinary(Symbol.for('remote-ids'))).remoteNameToId;
	return Object.keys(mapping).find((name) => mapping[name] === nodeId) ?? null;
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
			fullWriteHead: Boolean(entry.metadataFlags & FULL_WRITE_HEAD),
			origin: originName(Table.auditStore, entry.nodeId),
			audited: (await Table.getHistoryOfRecord(id)).length > 0,
		};
	}
}
