import { threadId } from 'node:worker_threads';

tables.RollingRows.setResidencyById((id) => Number(id));

export class RollingLocal extends Resource {
	get() {
		return {
			threadId,
			policy: tables.RollingRows.residency ?? null,
			rows: Array.from(tables.RollingRows.primaryStore.getRange({ start: true }), (entry) => ({
				id: entry.key,
				version: entry.version,
				value: entry.value,
			})),
		};
	}
}
