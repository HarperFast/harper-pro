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

export class RecordLogs extends Resource {
	static loadAsInstance = false;
	post(target, data) {
		const Table = databases.data[data.table];
		const logs = {};
		for (const entry of Table.auditStore.getRange({ start: 0, includeLogName: true })) {
			if (data.ids.includes(entry.recordId)) logs[entry.recordId] = entry.logName;
		}
		return logs;
	}
}

export class LogEntryCount extends Resource {
	static loadAsInstance = false;
	post(target, data) {
		const auditStore = databases.data[data.table].auditStore;
		auditStore.loadLogs();
		// getRange would create a log it does not find
		if (!auditStore.logByName.has(data.log)) return { count: 0 };
		let count = 0;
		for (const _entry of auditStore.getRange({ start: 0, log: data.log, snapshot: false })) count++;
		return { count };
	}
}

export class OriginCursors extends Resource {
	static loadAsInstance = false;
	post(target, data) {
		const Table = databases.data[data.table];
		const auditStore = Table.auditStore;
		const nodeLogs = auditStore.loadLogs();
		const nameById = new Map([...auditStore.logByName].map(([name, log]) => [nodeLogs.indexOf(log), name]));
		const peerId = nodeLogs.indexOf(auditStore.logByName.get(data.peer));
		const nodes = Table.dbisDB.getSync([Symbol.for('seq'), peerId])?.nodes ?? [];
		return Object.fromEntries(
			nodes.filter((node) => node.originLogKey).map((node) => [nameById.get(node.id) ?? node.id, node.originLogKey])
		);
	}
}

export class ReplicationCursor extends Resource {
	static loadAsInstance = false;
	post(target, data) {
		const Table = databases.data[data.table];
		const nodeLogs = Table.auditStore.loadLogs();
		const nodeId = nodeLogs.indexOf(Table.auditStore.logByName.get(data.node));
		return { seqId: Table.dbisDB.getSync([Symbol.for('seq'), nodeId])?.seqId ?? null };
	}
}

export class ClosedFloors extends Resource {
	static loadAsInstance = false;
	post(target, data) {
		const Table = databases.data[data.table];
		const auditStore = Table.auditStore;
		const nodeLogs = auditStore.loadLogs();
		const nameById = new Map([...auditStore.logByName].map(([name, log]) => [nodeLogs.indexOf(log), name]));
		const peerId = nodeLogs.indexOf(auditStore.logByName.get(data.peer));
		const row = Table.dbisDB.getSync([Symbol.for('seq'), peerId]);
		const nodes = {};
		for (const node of row?.nodes ?? []) {
			nodes[nameById.get(node.id) ?? node.id] = {
				originLogKey: node.originLogKey ?? null,
				closedFloor: node.closedFloor ?? null,
				relayable: node.relayable ?? null,
			};
		}
		return { seqId: row?.seqId ?? null, nodes };
	}
}

export class OriginFloor extends Resource {
	static loadAsInstance = false;
	post(target, data) {
		const stored = databases.data[data.table].auditStore.getBinary(Symbol.for('origin-closed-floor'));
		return { floor: stored?.byteLength === 8 ? Buffer.from(stored).readDoubleLE(0) : null };
	}
}

// A transaction held open with a staged write: its reserved key holds this node's floor until it is released.
let releaseHeldTransaction;
export class HoldTransaction extends Resource {
	static loadAsInstance = false;
	post(target, data) {
		const Table = databases.data[data.table];
		const context = {};
		const released = new Promise((resolve) => (releaseHeldTransaction = resolve));
		transaction(context, async () => {
			await Table.put({ id: data.id, name: 'held' }, context);
			await released;
		}).catch(() => {});
		return { held: data.id };
	}
}

export class ReleaseTransaction extends Resource {
	static loadAsInstance = false;
	post() {
		const released = releaseHeldTransaction !== undefined;
		releaseHeldTransaction?.();
		releaseHeldTransaction = undefined;
		return { released };
	}
}
