export class CloneLocalRows extends Resource {
	get() {
		return Array.from(tables.CloneRows.primaryStore.getRange({ start: true }), (entry) => ({
			id: entry.key,
			body: entry.value?.body,
		}));
	}
}
