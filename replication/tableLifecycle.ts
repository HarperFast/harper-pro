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

/**
 * Where a table's rows sit relative to `time`. Versions are origin write times, so a row of a generation
 * created after a drop is never older than that drop; one that is proves the table is the generation the
 * drop retired, and the scan stops there. A table with no older row is read once in full.
 */
export function rowsAround(table: { primaryStore: any }, time: number): { older: boolean; newer: boolean } {
	let newer = false;
	for (const entry of table.primaryStore.getRange({ versions: true, lazy: true })) {
		if (entry.version < time) return { older: true, newer };
		newer = true;
	}
	return { older: false, newer };
}
