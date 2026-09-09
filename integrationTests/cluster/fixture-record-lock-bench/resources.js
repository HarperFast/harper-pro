// Endpoints for recordLockCost.bench.mjs. Timing happens in-process so the numbers are the lock
// machinery's, not the HTTP client's; each endpoint answers raw samples and the bench summarizes.

function lockOptions(data) {
	const options = {};
	for (const key of ['lease', 'timeout', 'scope']) if (data?.[key] !== undefined) options[key] = data[key];
	return options;
}

/** POST { ids, lease?, timeout? }: lock+unlock each id in turn; answers per-acquisition and per-release ms. */
export class BenchLock extends Resource {
	async post(data) {
		const options = { ...lockOptions(data), hold: true };
		const acquireMs = [];
		const releaseMs = [];
		for (const id of data.ids) {
			const started = performance.now();
			const record = await tables.Counter.lock(id, options);
			const acquired = performance.now();
			await record.unlock();
			releaseMs.push(performance.now() - acquired);
			acquireMs.push(acquired - started);
		}
		return { acquireMs, releaseMs };
	}
}

/** POST { id, lease?, timeout? }: lock inside the request transaction, read, increment, save; released at commit. */
export class LockedIncrement extends Resource {
	async post(data) {
		const started = performance.now();
		const record = await tables.Counter.lock(data.id, lockOptions(data));
		const lockMs = performance.now() - started;
		const n = (record.getProperty('n') ?? 0) + 1;
		record.set('n', n);
		await record.save();
		return { n, lockMs };
	}
}

/** POST { prefix, count }: `count` unlocked puts, one transaction each; answers the elapsed ms. */
export class BenchWrite extends Resource {
	async post(data) {
		const started = performance.now();
		for (let i = 0; i < data.count; i++) {
			const context = {};
			await transaction(context, () => tables.Counter.put({ id: `${data.prefix}-${i}`, n: i }, context));
		}
		return { elapsedMs: performance.now() - started };
	}
}

/** POST { id }: what a cluster-scoped lock() answers here, to prove which enablement arm a node is in. */
export class LockProbe extends Resource {
	async post(data) {
		try {
			const record = await tables.Counter.lock(data.id, { scope: 'cluster', hold: true, timeout: 2_000 });
			await record.unlock();
			return { acquired: true };
		} catch (error) {
			return { acquired: false, statusCode: error.statusCode, message: error.message };
		}
	}
}

/** Entries and value bytes in this node's Counter transaction log, by entry type. */
export class LogStats extends Resource {
	async get() {
		const byType = {};
		for (const entry of tables.Counter.auditStore.getRange({ start: 1 })) {
			if (entry.tableId !== tables.Counter.tableId) continue;
			const stats = (byType[entry.type] ??= { entries: 0, bytes: 0 });
			stats.entries++;
			stats.bytes += entry.size;
		}
		return byType;
	}
}
