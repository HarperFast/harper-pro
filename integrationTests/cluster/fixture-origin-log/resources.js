import './standinSyncWal.mjs';

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
				originGeneration: node.originGeneration ?? null,
				fullCoverage: node.fullCoverage ?? null,
				certifiedFrom: node.certifiedFrom ?? null,
				floorRevoked: node.floorRevoked ?? null,
				hole: node.hole ?? null,
				partialHistory: node.partialHistory ?? null,
			};
		}
		return {
			seqId: row?.seqId ?? null,
			syncWalInstalled: typeof auditStore?.rootStore?.syncWal === 'function',
			nodes,
		};
	}
}

/**
 * POST /SetRouteCoverage with `{ table: '<table name>', peer: '<remote node name>', fullCoverage?: boolean, clearSeq?: boolean }`
 * mutates `[Symbol.for('seq'), peerId]` and `[Symbol.for('copyCursor'), peerId]` on `data`'s `dbisDB`
 * (and bumps `origin-state-epoch` when `clearSeq` is true) so integration tests can exercise
 * partial-to-full coverage widening and base-copy recovery.
 */
export class SetRouteCoverage extends Resource {
	static loadAsInstance = false;

	async post(target, data) {
		const Table = databases.data[data.table];
		const auditStore = Table.auditStore;
		const nodeLogs = auditStore.loadLogs();
		const peerId = nodeLogs.indexOf(auditStore.logByName.get(data.peer));
		if (!(peerId > 0)) return { updated: false };
		const seqKey = [Symbol.for('seq'), peerId];
		const row = Table.dbisDB.getSync(seqKey);
		if (data?.clearSeq) {
			for (const entry of Table.dbisDB.getRange({
				start: Symbol.for('seq'),
				end: [Symbol.for('seq'), Buffer.from([0xff])],
			})) {
				const value = entry.value;
				if (!value?.nodes) continue;
				const clearedNodes = value.nodes.map((node) => ({
					...node,
					lastTxnTime: undefined,
					originLogKey: undefined,
				}));
				await Table.dbisDB.put(entry.key, {
					...value,
					...(Array.isArray(entry.key) && entry.key[1] === peerId ? { seqId: 0 } : undefined),
					nodes: clearedNodes,
				});
			}
			await Table.dbisDB.remove([Symbol.for('copyCursor'), peerId]);
			for (const entry of Table.dbisDB.getRange({
				start: Symbol.for('copyBound'),
				end: [Symbol.for('copyBound'), Buffer.from([0xff])],
			})) {
				await Table.dbisDB.remove(entry.key);
			}
			return { cleared: true };
		}
		if (!row?.nodes) return { updated: false };
		const nodes = row.nodes.map((node) => ({
			...node,
			fullCoverage: data?.fullCoverage ?? false,
		}));
		await Table.dbisDB.put(seqKey, { ...row, nodes });
		return { updated: true };
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
let heldTransactionDone;
export class HoldTransaction extends Resource {
	static loadAsInstance = false;
	async post(target, data) {
		const Table = databases.data[data.table];
		const context = {};
		let markStaged;
		const staged = new Promise((resolve) => (markStaged = resolve));
		const released = new Promise((resolve) => (releaseHeldTransaction = resolve));
		heldTransactionDone = transaction(context, async () => {
			await Table.put({ id: data.id, name: 'held' }, context);
			markStaged();
			await released;
		}).catch(() => {
			markStaged?.();
		});
		await staged;
		return { held: data.id };
	}
}

export class ReleaseTransaction extends Resource {
	static loadAsInstance = false;
	async post() {
		const released = releaseHeldTransaction !== undefined;
		const done = heldTransactionDone;
		releaseHeldTransaction?.();
		releaseHeldTransaction = undefined;
		heldTransactionDone = undefined;
		await done;
		return { released };
	}
}

// Progress-reporting subscriptions by name, for issuing a checkpoint on one node and resuming it on another.
const checkpointSubscriptions = new Map();
export class CheckpointSubscription extends Resource {
	static loadAsInstance = false;
	async post(target, data) {
		const Table = databases.data[data.table];
		const name = data.name ?? 'default';
		if (data.action === 'open' || data.action === 'resume') {
			checkpointSubscriptions.get(name)?.subscription.end();
			const events = [];
			const errors = [];
			const request = {
				omitCurrent: true,
				reportProgress: true,
				listener: (event) => {
					if (event.type === 'put' || event.type === 'delete') events.push(event.id);
				},
			};
			if (data.action === 'resume') {
				if (data.checkpoint !== undefined) request.resume = data.checkpoint;
				if (data.startTime !== undefined) request.startTime = data.startTime;
			}
			let subscription;
			try {
				subscription = await Table.subscribe(request);
			} catch (error) {
				return { refused: { statusCode: error.statusCode ?? null, code: error.code ?? null, message: error.message } };
			}
			subscription.on('close', () => {
				if (subscription.closedWith instanceof Error) errors.push(subscription.closedWith.message);
			});
			const state = { subscription, events, errors, verified: null };
			subscription.resumeVerified?.then((verified) => (state.verified = verified));
			checkpointSubscriptions.set(name, state);
			return { opened: name };
		}
		const state = checkpointSubscriptions.get(name);
		if (!state) throw new Error(`No subscription named ${name}`);
		if (data.action === 'close') {
			state.subscription.end();
			checkpointSubscriptions.delete(name);
			return { closed: name };
		}
		return {
			checkpoint: state.subscription.checkpoint?.() ?? null,
			events: state.events,
			errors: state.errors,
			verified: state.verified,
			closed: state.subscription.closed,
		};
	}
}

// Reads, or writes (`record`), a durable MQTT session row: the test copies a row between nodes whose system
// database does not replicate, standing in for the replication the row gets in a cluster.
export class DurableSessionRecord extends Resource {
	static loadAsInstance = false;
	async post(target, data) {
		if (data.record) {
			await databases.system.hdb_durable_session.put(data.record);
			return { written: data.record.id };
		}
		const record = await databases.system.hdb_durable_session.get(data.id);
		return { record: record ? JSON.parse(JSON.stringify(record)) : null };
	}
}
