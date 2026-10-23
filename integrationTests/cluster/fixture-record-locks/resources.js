// Endpoints the cluster record-lock tests drive. Every error keeps its statusCode so the test sees
// core's 423 / 503 / 409 as the HTTP status. Holds live in this worker's memory: at threads.count > 1 a
// LockWrite/LockRelease must reach the worker that served the LockHold, so take locks with LockOnce.
import { threadId } from 'node:worker_threads';

const holds = new Map();
let nextToken = 1;

// Runs on whichever http worker the ops API routes it to, and reports that thread, so a test can tell
// a non-owner worker served the lock (harper-pro#852).
server.registerOperation?.({
	name: 'lock_probe',
	execute: async function lockProbe(data) {
		const record = await tables.Counter.lock(data.id, { hold: true, lease: 5_000, timeout: 10_000 });
		await record.unlock();
		return { locked: true, threadId };
	},
});

function lockOptions(data) {
	const options = {};
	for (const key of ['lease', 'timeout', 'scope', 'hold']) if (data?.[key] !== undefined) options[key] = data[key];
	return options;
}

/** POST { id, scope? }: lock inside the request transaction, read, increment, save; released at commit. */
export class LockedIncrement extends Resource {
	async post(data) {
		const record = await tables.Counter.lock(data.id, lockOptions(data));
		const n = (record.getProperty('n') ?? 0) + 1;
		record.set('n', n);
		await record.save();
		return { n };
	}
}

/** POST { id, timeout?, scope? }: take and release a lock within one request, so any worker can serve it. */
export class LockOnce extends Resource {
	async post(data) {
		await tables.Counter.lock(data.id, { ...lockOptions(data), hold: false });
		return { threadId };
	}
}

/** POST { id, lease?, timeout?, scope? }: take a held lock that outlives the request; answers a token. */
export class LockHold extends Resource {
	async post(data) {
		const record = await tables.Counter.lock(data.id, { ...lockOptions(data), hold: true });
		const token = `${threadId}:${nextToken++}`;
		holds.set(token, record);
		return { token, threadId, n: record.getProperty('n') ?? null };
	}
}

/** POST { token, n }: write through a held record; 409 from core once its lease has elapsed. */
export class LockWrite extends Resource {
	async post(data) {
		const record = holds.get(data.token);
		if (!record) throw Object.assign(new Error('unknown hold'), { statusCode: 404 });
		record.set('n', data.n);
		await record.save();
		return { n: data.n };
	}
}

/** POST { token }: release a hold; 409 when this worker does not hold the token (a retry may reach the holder). */
export class LockRelease extends Resource {
	async post(data) {
		const record = holds.get(data.token);
		if (!record) throw Object.assign(new Error(`worker ${threadId} does not hold ${data.token}`), { statusCode: 409 });
		holds.delete(data.token);
		await record.unlock();
		return { released: true, threadId };
	}
}

/** The lock release entries in this node's Counter transaction log: type and local origin id (0 = self). */
export class LockControlEntries extends Resource {
	async get() {
		const entries = [];
		for (const entry of tables.Counter.auditStore.getRange({ start: 1 })) {
			if (entry.tableId !== tables.Counter.tableId) continue;
			if (entry.type === 'lockRelease') entries.push({ type: entry.type, nodeId: entry.nodeId ?? 0 });
		}
		return entries;
	}
}
