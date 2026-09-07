// Endpoints the cluster record-lock tests drive. Every error keeps its statusCode so the test sees
// core's 423 / 503 / 409 as the HTTP status.
const holds = new Map();
let nextToken = 1;

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

/** POST { id, lease?, timeout?, scope? }: take a held lock that outlives the request; answers a token. */
export class LockHold extends Resource {
	async post(data) {
		const record = await tables.Counter.lock(data.id, { ...lockOptions(data), hold: true });
		const token = String(nextToken++);
		holds.set(token, record);
		return { token, n: record.getProperty('n') ?? null };
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

export class LockRelease extends Resource {
	async post(data) {
		const record = holds.get(data.token);
		holds.delete(data.token);
		if (record) await record.unlock();
		return { released: !!record };
	}
}

/** The lock control entries in this node's Counter transaction log: type and local origin id (0 = self). */
export class LockControlEntries extends Resource {
	async get() {
		const entries = [];
		for (const entry of tables.Counter.auditStore.getRange({ start: 1 })) {
			if (entry.tableId !== tables.Counter.tableId) continue;
			if (entry.type === 'lockRequest' || entry.type === 'lockGrant' || entry.type === 'lockRelease')
				entries.push({ type: entry.type, nodeId: entry.nodeId ?? 0 });
		}
		return entries;
	}
}
