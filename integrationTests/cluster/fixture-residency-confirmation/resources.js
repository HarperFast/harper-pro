tables.Placed.setResidency((record) => record.homes);

export class ResidencyState extends Resource {
	static loadAsInstance = false;

	get(target) {
		target.checkPermission = false;
		const [tableName, id] = String(target.id).split(':');
		const table = tables[tableName];
		const entry = table.primaryStore.getEntry(id);
		return {
			present: Boolean(entry),
			invalidated: Boolean(entry?.metadataFlags & 1),
			value: entry?.value,
			residency: entry?.residencyId ? table.getResidencyRecord(entry.residencyId) : null,
		};
	}

	async post(target, { removeLocal, prefer, latencySlot, statusSlots, residencyFor, residents }) {
		const table = tables.Open;
		// Deliberately leave peers' residency stubs unchanged, as with a stale residency list.
		if (removeLocal) await table.primaryStore.remove(removeLocal);
		if (residencyFor) {
			const { residencyId } = table.primaryStore.getEntry(residencyFor);
			await table.dbisDB.put([Symbol.for('residency_by_id'), residencyId], residents);
		}
		if (prefer) {
			const status = new Float64Array(
				table.auditStore.getUserSharedBuffer(['replicated', 'data', prefer], new ArrayBuffer(statusSlots * 8))
			);
			status[latencySlot] = -Infinity;
		}
		return { ready: true };
	}
}
