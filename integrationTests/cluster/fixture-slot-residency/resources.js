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
