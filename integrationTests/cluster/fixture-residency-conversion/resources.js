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

const SNAPSHOT_FLAGS = { INVALIDATED: 1, REPLICA: 4, EVICTED: 8, FULL_WRITE_HEAD: 0x40000 };
export class ConversionSnapshot extends Resource {
	get(target) {
		const id = String(target.id);
		const entry = tables.Converted.primaryStore.getEntry(id);
		const node = { id, hostname: server.hostname, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) };
		if (!entry) return { ...node, stored: false };
		let owners;
		try {
			owners = tables.Converted.getRecordResidency({
				key: id,
				residencyId: entry.residencyId,
				residencySlot: entry.residencySlot,
			});
		} catch (error) {
			owners = `error: ${error.message}`;
		}
		return {
			...node,
			stored: true,
			version: entry.version,
			flags: entry.metadataFlags,
			flagNames: Object.keys(SNAPSHOT_FLAGS).filter((name) => entry.metadataFlags & SNAPSHOT_FLAGS[name]),
			expiresAt: entry.expiresAt,
			residencyId: entry.residencyId,
			slot: entry.residencySlot,
			owners,
			localOwner: Array.isArray(owners) ? owners.includes(server.hostname) : undefined,
			hasBody: entry.value?.body !== undefined,
		};
	}
}

export class ConversionDrain extends Resource {
	async put() {
		const REPLICA = 4; // Primary metadata bit shared by both binaries.
		tables.Converted.setTTLExpiration({ replicaExpiration: 0 });
		let demoted = 0;
		for (const entry of tables.Converted.primaryStore.getRange({ start: true })) {
			if (entry.metadataFlags & REPLICA) {
				await tables.Converted.evict(entry.key, entry.value, entry.version);
				demoted++;
			}
		}
		const remaining = Array.from(tables.Converted.primaryStore.getRange({ start: true })).filter(
			(entry) => entry.metadataFlags & REPLICA
		).length;
		return { demoted, remaining };
	}
}

export class PlainRows extends Resource {
	get() {
		return Array.from(tables.Plain.primaryStore.getRange({ start: true }), (entry) => ({
			id: entry.key,
			version: entry.version,
			record: entry.value,
			flags: entry.metadataFlags,
		}));
	}
}
