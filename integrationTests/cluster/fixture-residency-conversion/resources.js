tables.Converted.setResidencyById((id) => (Number(id.slice(-1)) < 5 ? 0 : 1));

export class ConversionRows extends Resource {
	get() {
		return Array.from(tables.Converted.primaryStore.getRange({ start: true }), (entry) => ({
			id: entry.key,
			version: entry.version,
			record: entry.value,
			flags: entry.metadataFlags,
			residencyId: entry.residencyId,
			slot: entry.residencySlot,
		}));
	}
}
export class ConversionAudit extends Resource {
	get() {
		return Array.from(tables.Converted.auditStore.getRange({ start: 1, log: 0 }))
			.filter((row) => row.tableId === tables.Converted.tableId)
			.map((row) => ({
				id: row.recordId,
				type: row.type,
				version: row.version,
				slot: row.residencySlot,
				previousSlot: row.previousResidencySlot,
				flags: row.extendedType,
			}));
	}
}

// The fixture stops remote reads before this explicit rollback drain.
export class ConversionDrain extends Resource {
	async put() {
		const REPLICA = 4; // Primary metadata bit shared by both binaries.
		tables.Converted.setTTLExpiration({ replicaExpiration: 0 });
		let demoted = 0;
		for (const entry of tables.Converted.primaryStore.getRange({ start: true })) {
			if (entry.metadataFlags & REPLICA) {
				await tables.Converted.evict(entry.key);
				demoted++;
			}
		}
		const remaining = Array.from(tables.Converted.primaryStore.getRange({ start: true })).filter(
			(entry) => entry.metadataFlags & REPLICA
		).length;
		return { demoted, remaining };
	}
}
