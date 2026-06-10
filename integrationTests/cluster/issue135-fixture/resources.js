export class SearchCount extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const snapshotId = target.get('snapshotId');
		if (!snapshotId) return { error: 'snapshotId query param required' };

		const rows = [];
		for await (const row of tables.ScoreEvidence.search({
			conditions: [{ attribute: 'snapshotId', value: snapshotId }],
		})) {
			rows.push(row.id);
		}
		return { count: rows.length, ids: rows };
	}
}
