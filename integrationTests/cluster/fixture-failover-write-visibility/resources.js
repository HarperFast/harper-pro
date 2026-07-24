/**
 * QA-651 diagnostic endpoint: dumps the `writer` index and the primary (base)
 * store DIRECTLY, bypassing every query surface, so the test can tell
 * index-vs-base divergence apart from node-vs-node lag (D-230/D-242).
 *
 * search_by_value / REST / SQL all join through the primary record and SKIP
 * on absence — none of them can ever reveal a dangling index entry. Only a
 * raw `indices.<attr>.getRange()` scan can.
 */
export class IndexDump extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const tag = target.get('tag');
		const table = tables.Ledger;

		// Raw index-store scan. `start: null` is required — LMDB's default start
		// key (Buffer.from([5])) sorts after `null` and silently skips
		// null-keyed index entries.
		const indexEntries = [];
		for (const { key, value } of table.indices.writer.getRange({ start: null })) {
			if (!tag || key === tag) indexEntries.push({ writer: key, id: value });
		}

		// Raw base-store (primaryStore) scan — ground truth for rows that
		// actually exist, entirely independent of any index.
		const baseEntries = [];
		for (const { key, value } of table.primaryStore.getRange({ start: null })) {
			if (value && (!tag || value.writer === tag)) {
				baseEntries.push({ id: key, writer: value.writer, seq: value.seq });
			}
		}

		return { indexEntries, baseEntries };
	}
}
