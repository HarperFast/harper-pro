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
