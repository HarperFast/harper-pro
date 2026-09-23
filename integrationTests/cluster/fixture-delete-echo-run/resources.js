/**
 * Fixture for deleteEchoRun.test.mjs. `PlantDeleteRun` POST `{ ids, copies }` appends the sequence `ids`
 * `copies` times under the shared log key of those ids' latest deletes — the run an echo left behind.
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
