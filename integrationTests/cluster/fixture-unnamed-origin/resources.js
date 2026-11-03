// Writes rows the way the replication apply loop does, attributed to an origin id this node has no name
// for: the state a v4-era origin, or a node whose mapping is gone, leaves behind (harper-pro#1235).
export class UnnamedOriginWrite extends Resource {
	static loadAsInstance = false;
	async post(target, data) {
		const Table = databases.data.unnamed_rows;
		for (const id of data.ids) {
			const options = { nodeId: data.nodeId, isNotification: true, ensureLoaded: false, async: true };
			const context = { timestamp: Date.now() };
			await transaction(context, async () => {
				const resource = await Table.getResource(id, context, options);
				await resource._writeUpdate(id, { id, name: id }, true, options);
			});
		}
		return { written: data.ids.length };
	}
}
