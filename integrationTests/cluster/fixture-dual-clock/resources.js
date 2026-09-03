/**
 * Fixture for dualClockOriginLogKey.test.mjs (harper-pro#790 / harper#2412 stage 0b).
 *
 * `DualClock` is a cache table whose source reports a `lastModified` an hour in the past, so every
 * fill stores a record version well below the timestamp its fill transaction commits at — core #2065's
 * shape, and the only way to tell a record version apart from a transaction-log key.
 *
 * `Clocks` reports both words for one record on whichever node is asked: the version the record is
 * stored at, and the log key(s) its audit entries occupy. A peer must agree with the origin on BOTH.
 */

const SOURCE_BACKDATE_MS = 3600_000;

tables.DualClock.sourcedFrom(
	class extends Resource {
		get() {
			this.getContext().lastModified = Date.now() - SOURCE_BACKDATE_MS;
			return { id: this.getId(), value: 'from-source' };
		}
	}
);

export class Clocks extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const id = String(target.id);
		const table = tables.DualClock;
		const entry = table.primaryStore.getEntry(id);
		const auditStore = table.primaryStore.rootStore.auditStore;
		const audit = [];
		for (const auditRecord of auditStore.getRange({ start: 1 })) {
			if (auditRecord.tableId !== table.tableId) continue;
			if (String(auditRecord.recordId) !== id) continue;
			audit.push({
				type: auditRecord.type,
				version: auditRecord.version,
				localTime: auditRecord.localTime,
				nodeId: auditRecord.nodeId,
			});
		}
		return {
			id,
			present: Boolean(entry),
			value: entry?.value?.value ?? null,
			version: entry?.version ?? null,
			audit,
		};
	}
}
