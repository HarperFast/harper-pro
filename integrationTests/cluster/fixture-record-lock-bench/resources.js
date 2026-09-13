// Endpoints for recordLockCost.bench.mjs. Timing happens in-process so the numbers are the lock
// machinery's, not the HTTP client's; each endpoint answers raw samples and the bench summarizes.

function lockOptions(data) {
	const options = {};
	for (const key of ['lease', 'timeout', 'scope']) if (data?.[key] !== undefined) options[key] = data[key];
	return options;
}

/** Reading 0 for an unavailable coordinator would silently classify every key as homed elsewhere. */
function requireGranted() {
	const stats = coordinatorStats();
	if (!stats) throw new Error('record lock coordinator stats are unavailable; cannot classify key homes');
	return stats.granted;
}

function coordinatorStats() {
	try {
		return tables.Counter.lockCoordinator?.stats;
	} catch {
		// The getter throws on an unusable node identity. Status reporting swallows that; a measurement
		// must not, so callers that need a real answer check for undefined rather than reading 0.
		return undefined;
	}
}

/**
 * Lock+unlock each id in turn. `releaseMs` is unlock()'s return, not the release entry's durability.
 * `atMs` is the node's own monotonic reading at each lock, which is the clock delegation expiry runs
 * on, so the caller can place a sample against a delegation's lifetime exactly.
 *
 * `classifyHome` answers, per id, whether THIS node homes the key: a home-local first lock mints its
 * own grant here, so the grant gauge moves; a remote-home one does not. Read outside the timed
 * region, and only sound while this node is the sole requester — which is what the uncontended and
 * repeat measurements arrange.
 */
export class BenchLock extends Resource {
	async post(data) {
		const options = { ...lockOptions(data), hold: true };
		const acquireMs = [];
		const releaseMs = [];
		const atMs = [];
		const homeLocal = data.classifyHome ? [] : undefined;
		// An untimed lock on a key that is always delegated, to absorb the first-lock-in-a-request cost
		// (~0.1-0.25 ms) before anything is timed. Without it that cost sits on the first measured
		// sample and is large enough to hide a loopback round trip. Its own lease is the default, so
		// its delegation outlives any run that shortens the caller's.
		if (data.warmupId !== undefined) {
			const warm = await tables.Counter.lock(data.warmupId, { hold: true });
			await warm.unlock();
		}
		for (const id of data.ids) {
			const grantedBefore = homeLocal ? requireGranted() : 0;
			const started = performance.now();
			const record = await tables.Counter.lock(id, options);
			const acquired = performance.now();
			await record.unlock();
			releaseMs.push(performance.now() - acquired);
			acquireMs.push(acquired - started);
			atMs.push(started);
			if (homeLocal) homeLocal.push(requireGranted() > grantedBefore);
		}
		return { acquireMs, releaseMs, atMs, homeLocal };
	}
}

/** Lock inside the request transaction, increment, save; the commit is the unlock. `sectionMs` ends at save(). */
export class LockedIncrement extends Resource {
	async post(data) {
		const started = performance.now();
		const record = await tables.Counter.lock(data.id, lockOptions(data));
		const lockMs = performance.now() - started;
		const n = (record.getProperty('n') ?? 0) + 1;
		record.set('n', n);
		await record.save();
		return { n, lockMs, sectionMs: performance.now() - started };
	}
}

/** `count` unlocked puts, one transaction each. */
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

/** What a cluster-scoped lock() answers here: the observable for which enablement arm a node is in. */
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

/** This node's coordinator counters: delegations held, grants issued, live admissions, misroutes. */
export class LockStats extends Resource {
	async get() {
		return coordinatorStats() ?? { unavailable: true };
	}
}

/** This node's Counter transaction log, by entry type: count and stored value bytes. */
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
