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

// The node-name -> id mapping as stored, and a way to persist the record an older version writes when a peer
// relays a name to it (harper-pro#1246). Hand-encoded msgpack, since a component cannot import msgpackr:
// { remoteNameToId: { name: id, ... }, nodeName }.
const msgpackString = (text) => {
	const bytes = Buffer.from(text);
	return Buffer.concat([Buffer.from(bytes.length < 32 ? [0xa0 | bytes.length] : [0xd9, bytes.length]), bytes]);
};
const msgpackInt = (n) => Buffer.from(n < 128 ? [n] : [0xcd, n >> 8, n & 255]);
const msgpackMap = (entries) => Buffer.concat([Buffer.from([0x80 | entries.length]), ...entries.flat()]);
export class NodeIdMappingRecord extends Resource {
	static loadAsInstance = false;
	get() {
		const auditStore = databases.data.unnamed_rows.primaryStore.rootStore.auditStore;
		const stored = auditStore.getBinary(Symbol.for('remote-ids'));
		return { record: stored ? Buffer.from(stored).toString('base64') : null };
	}
	post(target, data) {
		const auditStore = databases.data.unnamed_rows.primaryStore.rootStore.auditStore;
		const names = Object.entries(data.remoteNameToId).map(([name, id]) => [msgpackString(name), msgpackInt(id)]);
		auditStore.putSync(
			Symbol.for('remote-ids'),
			msgpackMap([
				[msgpackString('remoteNameToId'), msgpackMap(names)],
				[msgpackString('nodeName'), msgpackString(data.nodeName)],
			])
		);
		return data.remoteNameToId;
	}
}
