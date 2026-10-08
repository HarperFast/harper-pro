/**
 * Table lifecycle on the wire. Core owns the stamps, the drop markers and the rule; this module validates what a
 * peer sent, since `DB_SCHEMA[4]` can make this node drop a table.
 */
import type { TableDropMarker } from '../core/resources/databases.ts';

export const MAX_DROP_MARKERS_PER_FRAME = 10000;

export function validateDropMarkers(raw: unknown): TableDropMarker[] {
	if (!Array.isArray(raw)) return [];
	const byTable = new Map<string, TableDropMarker>();
	for (const entry of raw.slice(0, MAX_DROP_MARKERS_PER_FRAME)) {
		const table = (entry as any)?.table;
		const droppedTime = (entry as any)?.droppedTime;
		if (typeof table !== 'string' || table.length === 0 || table.includes('/')) continue;
		if (typeof droppedTime !== 'number' || !Number.isFinite(droppedTime) || droppedTime <= 0) continue;
		const existing = byTable.get(table);
		if (!existing || existing.droppedTime < droppedTime) byTable.set(table, { table, droppedTime });
	}
	return [...byTable.values()];
}

const ROWS_PER_TURN = 10000;

/**
 * Where a table's rows sit relative to `time`. Versions are origin write times, so a row of a generation
 * created after a drop is never older than that drop; one that is proves the table is the generation the
 * drop retired, and the scan stops there. A table with no older row is read in full, yielding the worker
 * every ROWS_PER_TURN rows (a full read measured about 2.3 s per million rows on RocksDB); undefined once
 * `cancelled`.
 */
export async function rowsAround(
	table: { primaryStore: any },
	time: number,
	cancelled?: () => boolean
): Promise<{ older: boolean; newer: boolean } | undefined> {
	let newer = false;
	let sinceYield = 0;
	for (const entry of table.primaryStore.getRange({ versions: true, lazy: true })) {
		if (entry.version < time) return { older: true, newer };
		newer = true;
		if (++sinceYield === ROWS_PER_TURN) {
			sinceYield = 0;
			await new Promise((resolve) => setImmediate(resolve));
			if (cancelled?.()) return undefined;
		}
	}
	return { older: false, newer };
}
