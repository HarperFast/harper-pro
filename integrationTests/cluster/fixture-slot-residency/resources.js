import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

tables.SlotLegacy.setResidencyById((id) => Number(id.slice(-1)) % 2);

export class SlotLocalRows extends Resource {
	get(target) {
		const table = tables[target.get('table')];
		return Array.from(table.primaryStore.getRange({ start: true }), (entry) => ({
			id: entry.key,
			record: entry.value,
			version: entry.version,
			flags: entry.metadataFlags,
			residencyId: entry.residencyId,
			slot: entry.residencySlot,
		}));
	}
}
export class SlotPolicy extends Resource {
	get(target) {
		const table = tables[target.get('table')];
		return { policy: table.residency, slot: table.getResidencySlot(target.get('id')) };
	}
}

export class SlotReplicationResume extends Resource {
	get(target) {
		const table = tables.SlotAttributes;
		const nodeId = table.auditStore.loadLogs().indexOf(table.auditStore.logByName.get(target.get('node')));
		return {
			seqId: table.dbisDB.getSync([Symbol.for('seq'), nodeId])?.seqId ?? null,
			copying: !!table.dbisDB.getSync([Symbol.for('copyCursor'), nodeId]),
		};
	}
}

export class SlotBlobSeed extends Resource {
	async get(target) {
		const bytes = Buffer.alloc(65536);
		for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
		await tables.SlotBlob.put(target.id, {
			id: target.id,
			region: 0,
			payload: createBlob(Readable.from([bytes]), { saveBeforeCommit: true }),
		});
		return { digest: createHash('sha256').update(bytes).digest('hex') };
	}
}

export class SlotBlobLocalDigest extends Resource {
	async get(target) {
		const record = tables.SlotBlob.primaryStore.getEntry(target.id)?.value;
		if (!record?.payload) return { digest: null };
		const bytes = await record.payload.arrayBuffer();
		return { digest: createHash('sha256').update(Buffer.from(bytes)).digest('hex'), region: record.region };
	}
}

const freezeState = new Uint8Array(
	tables.SlotAttributes.auditStore.getUserSharedBuffer('test-freeze-on-commit', new ArrayBuffer(4096))
);
const freezeLength = new Int32Array(freezeState.buffer, freezeState.byteOffset, 1);
tables.SlotAttributes.auditStore.prependListener('aftercommit', (entries) => {
	const length = Atomics.load(freezeLength, 0);
	if (!length) return;
	const { id, pids } = JSON.parse(Buffer.from(freezeState.subarray(4, 4 + length)).toString());
	if (!entries.some((entry) => entry.tableId === tables.SlotAttributes.tableId && entry.recordId === id)) return;
	if (Atomics.compareExchange(freezeLength, 0, length, 0) !== length) return;
	for (const pid of pids) process.kill(pid, 'SIGSTOP');
});
export class SlotFreezeOnCommit extends Resource {
	get() {
		return { armed: Atomics.load(freezeLength, 0) > 0 };
	}
	post({ id, pids }) {
		const bytes = Buffer.from(JSON.stringify({ id, pids }));
		freezeState.set(bytes, 4);
		Atomics.store(freezeLength, 0, bytes.length);
		return { armed: true, id, pids };
	}
}
