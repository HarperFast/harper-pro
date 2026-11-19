const FULL_WRITE_HEAD = 0x40000;

export class StoredRow extends Resource {
	static loadAsInstance = false;

	post(target, { database, table, id }) {
		const entry = databases[database][table].primaryStore.getEntry(id);
		if (!entry) return { stored: false };
		return {
			stored: true,
			present: entry.value != null,
			version: entry.version,
			fullWriteHead: Boolean(entry.metadataFlags & FULL_WRITE_HEAD),
		};
	}
}
