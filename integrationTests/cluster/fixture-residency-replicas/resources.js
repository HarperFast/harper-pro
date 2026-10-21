const INVALIDATED = 1;
const REPLICA = 4;
const REPLICA_TABLES = ['Open', 'Kept'];

// A test can hold every GET_RECORD answer on this node between its arrival and the replica write,
// so a newer stub can land in between, and count the settled attempts per record. Both are shared
// memory: the HTTP worker that holds a fetch is rarely the one that handled the control request.
const hold = new Int32Array(tables.Open.auditStore.getUserSharedBuffer('replica-hold', new ArrayBuffer(4)));
const settledFor = (tableName, id) =>
	new Int32Array(tables.Open.auditStore.getUserSharedBuffer(`replica-settled:${tableName}:${id}`, new ArrayBuffer(4)));
for (const name of REPLICA_TABLES) {
	const table = tables[name];
	const storeReplica = table._storeReplica;
	table._storeReplica = async function (existingEntry, entry) {
		while (Atomics.load(hold, 0) === 1) await new Promise((resolve) => setTimeout(resolve, 25));
		try {
			return await storeReplica.call(this, existingEntry, entry);
		} finally {
			Atomics.add(settledFor(name, existingEntry.key), 0, 1);
		}
	};
}

export class ResidencyState extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const [tableName, id] = String(target.id).split(':');
		const table = tables[tableName];
		const entry = table.primaryStore.getEntry(id);
		let history = null;
		try {
			history = entry ? (await table.getHistoryOfRecord(id)).map((event) => event.type) : [];
		} catch {}
		return {
			present: Boolean(entry),
			invalidated: Boolean(entry?.metadataFlags & INVALIDATED),
			replica: Boolean(entry?.metadataFlags & REPLICA),
			expiresAt: entry?.expiresAt ?? null,
			version: entry?.version ?? null,
			value: entry?.value,
			residency: entry?.residencyId ? table.getResidencyRecord(entry.residencyId) : null,
			history,
			storeAttempts: Atomics.load(settledFor(tableName, id), 0),
		};
	}

	async post(target, { table: tableName = 'Open', removeLocal, prefer, holdReplicas, latencySlot, statusSlots }) {
		const table = tables[tableName];
		if (removeLocal) await table.primaryStore.remove(removeLocal);
		if (prefer) {
			const status = new Float64Array(
				table.auditStore.getUserSharedBuffer(['replicated', 'data', prefer], new ArrayBuffer(statusSlots * 8))
			);
			status[latencySlot] = -Infinity;
		}
		if (holdReplicas !== undefined) Atomics.store(hold, 0, holdReplicas ? 1 : 0);
		return { ready: true };
	}
}
