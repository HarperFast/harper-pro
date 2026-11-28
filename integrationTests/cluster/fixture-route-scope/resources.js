function routeRow(peer) {
	const Table = databases.data.Progress;
	const auditStore = Table.auditStore;
	const nodeLogs = auditStore.loadLogs();
	const peerId = nodeLogs.indexOf(auditStore.logByName.get(peer));
	return { Table, peerId, key: [Symbol.for('seq'), peerId] };
}

/**
 * Reads `data`'s route row and recorded scope for `peer`, or with `clear` strips the coverage a certificate leaves
 * there: from every origin (`all`), or from the peer's own entry only (`direct`, a peer whose floor sent nothing).
 */
export class RouteState extends Resource {
	static loadAsInstance = false;
	async post(target, data) {
		const { Table, peerId, key } = routeRow(data.peer);
		if (!(peerId > 0)) return { found: false };
		const row = Table.dbisDB.getSync(key);
		if (data.clear && row?.nodes) {
			const nodes = row.nodes.map((node) =>
				data.clear === 'all' || node.id === peerId
					? { ...node, fullCoverage: undefined, certifiedFrom: undefined }
					: node
			);
			await Table.dbisDB.put(key, { ...row, nodes });
		}
		const current = Table.dbisDB.getSync(key);
		return {
			found: true,
			peerId,
			nodes: (current?.nodes ?? []).map((node) => ({
				id: node.id,
				fullCoverage: node.fullCoverage ?? null,
				partialHistory: node.partialHistory ?? null,
				certifiedFrom: node.certifiedFrom ?? null,
			})),
			scope: Table.dbisDB.getSync([Symbol.for('routeScope'), peerId]) ?? null,
		};
	}
}
