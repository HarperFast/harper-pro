const FULL_WRITE_HEAD = 0x40000;

// the stored row itself, so a test can see a tombstone, which no query returns
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
