/** `PlantDeleteRun` POST `{ ids, copies }` appends `copies` echoes of those ids' latest deletes under their log key. */

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
		// Each copy repeats the delete's replicated bytes exactly — what a re-applied echo writes — behind a
		// prelude with no previous-version link. Written to the log directly: `aftercommit` listeners expect
		// decoded records, not raw entries.
		const copiesOf = latest.map((entry) => {
			const prelude = Buffer.alloc(4);
			prelude.writeUInt32BE(entry.structureVersion ?? 0);
			return Buffer.concat([prelude, entry.encoded]);
		});
		await store.transaction((transaction) => {
			transaction.setTimestamp(txnLogKey);
			for (let i = 0; i < copies; i++) {
				for (const copy of copiesOf) auditStore.log.addEntry(copy, transaction.id);
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
