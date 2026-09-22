/**
 * Fixture for deleteEchoRun.test.mjs (harper-pro#826).
 *
 * `PlantDeleteRun` writes the log state an echo storm left behind on releases before the fix: copies of
 * existing delete entries appended under the delete's own log key. POST `{ ids, copies }` finds each id's
 * latest delete (they must share one log key) and appends the sequence `ids` that many times.
 *
 * `DeleteEntries/<id>` counts the delete entries this node's logs hold for one record.
 */

function deleteEntries(id) {
	const table = tables.EchoTarget;
	const entries = [];
	for (const auditRecord of table.primaryStore.rootStore.auditStore.getRange({ start: 1 })) {
		if (auditRecord.tableId === table.tableId && auditRecord.type === 'delete' && auditRecord.recordId === id)
			entries.push(auditRecord);
	}
	return entries;
}

export class PlantDeleteRun extends Resource {
	static loadAsInstance = false;

	async post(target, { ids, copies }) {
		const store = tables.EchoTarget.primaryStore;
		const auditStore = store.rootStore.auditStore;
		const latest = ids.map((id) => deleteEntries(id).at(-1));
		const txnLogKey = latest[0].txnLogKey;
		if (latest.some((entry) => entry.txnLogKey !== txnLogKey)) throw new Error('the deletes must share a log key');
		const records = latest.map((entry) => ({
			version: entry.version,
			tableId: entry.tableId,
			recordId: entry.recordId,
			previousVersion: entry.previousVersion,
			nodeId: entry.nodeId,
			user: entry.user,
			type: 'delete',
			// the action lives in the low byte; the encoder derives it from `type`
			extendedType: entry.extendedType & ~0xff,
			structureVersion: entry.structureVersion,
		}));
		await store.transaction((transaction) => {
			transaction.setTimestamp(txnLogKey);
			for (let i = 0; i < copies; i++) {
				for (const record of records) auditStore.put(0, { ...record }, { transaction, nodeId: 0 });
			}
		});
		return { txnLogKey, planted: copies * ids.length };
	}
}

export class DeleteEntries extends Resource {
	static loadAsInstance = false;

	get(target) {
		target.checkPermission = false;
		return { count: deleteEntries(String(target.id)).length };
	}
}
