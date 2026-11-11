/** This node's route row for `peer`: whether its resume from that peer is floor-only (checkpoint-grade). */
export class RouteState extends Resource {
	static loadAsInstance = false;
	post(target, data) {
		const auditStore = databases.data.Message.auditStore;
		const nodeLogs = auditStore.loadLogs();
		const peerId = nodeLogs.indexOf(auditStore.logByName.get(data.peer));
		const row = databases.data.Message.dbisDB.getSync([Symbol.for('seq'), peerId]);
		const own = row?.nodes?.find((node) => node.id === peerId);
		return {
			seqId: row?.seqId ?? null,
			closedFloor: own?.closedFloor ?? null,
			originGeneration: own?.originGeneration ?? null,
			fullCoverage: own?.fullCoverage ?? null,
			certifiedFrom: own?.certifiedFrom ?? null,
		};
	}
}

/** How many times this node logged each message `peer` published to `topic`. */
export class LoggedMessages extends Resource {
	static loadAsInstance = false;
	post(target, data) {
		const Message = databases.data.Message;
		const counts = {};
		for (const entry of Message.auditStore.getRange({ start: 1, log: data.peer })) {
			if (entry.type !== 'message' || entry.tableId !== Message.tableId || entry.recordId !== data.topic) continue;
			counts[entry.version] = (counts[entry.version] ?? 0) + 1;
		}
		return counts;
	}
}
