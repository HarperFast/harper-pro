// Writes the way the replication apply loop does (explicit timestamp, origin `nodeId`), so a record whose origin
// is `ghost` lands in the `ghost` transaction log.
export class OriginLogWrite extends Resource {
	static loadAsInstance = false;
	async post(target, data) {
		const Table = databases.data[data.table];
		const auditStore = Table.auditStore;
		const nodeLogs = auditStore.loadLogs();
		auditStore.ensureLogExists(data.ghost);
		const ghostNodeId = nodeLogs.indexOf(auditStore.logByName.get(data.ghost));
		if (!(ghostNodeId > 0)) throw new Error(`No transaction log for ${data.ghost}`);
		for (const { id, fromGhost } of data.records ?? []) {
			const options = {
				nodeId: fromGhost ? ghostNodeId : undefined,
				isNotification: true,
				ensureLoaded: false,
				async: true,
			};
			const context = { timestamp: data.version };
			await transaction(context, async () => {
				const resource = await Table.getResource(id, context, options);
				await resource._writeUpdate(id, { id, name: id }, true, options);
			});
		}
		return { ghostNodeId };
	}
}

export class RecordVersions extends Resource {
	static loadAsInstance = false;
	post(target, data) {
		const primaryStore = databases.data[data.table].primaryStore;
		return Object.fromEntries(data.ids.map((id) => [id, primaryStore.getEntry(id)?.version]));
	}
}
