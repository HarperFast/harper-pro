// Writes the transaction-log state a node holds after two origins have written at the same log key: one
// transaction in this node's `local` log and one in another origin's log, both at `version`. Records are
// written the way the replication apply loop writes them (explicit timestamp, origin `nodeId`), so a
// record whose origin is `ghost` lands in the `ghost` log.
export class OriginLogWrite extends Resource {
	static loadAsInstance = false;
	async post(target, data) {
		const Table = databases.data.OriginRecord;
		const auditStore = Table.auditStore;
		const nodeLogs = auditStore.loadLogs();
		auditStore.ensureLogExists(data.ghost);
		const ghostNodeId = nodeLogs.indexOf(auditStore.logByName.get(data.ghost));
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
