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
