/**
 * Table lifecycle on the wire. Core owns the two facts — a generation's `createdTime` and the `droppedTime`
 * marker that survives its drop — and the rule `isDeadGeneration`; this module shapes what a peer sends,
 * and validates what a peer sent (`DB_SCHEMA[4]` can delete a local table).
 */
import { isDeadGeneration, getTableDrops, type TableDropMarker } from '../core/resources/databases.ts';

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

export function dropMarkersByTable(markers: TableDropMarker[]): Map<string, TableDropMarker> {
	const byTable = new Map<string, TableDropMarker>();
	for (const marker of markers) {
		const existing = byTable.get(marker.table);
		if (!existing || existing.droppedTime < marker.droppedTime) byTable.set(marker.table, marker);
	}
	return byTable;
}

/**
 * This node's markers by table, read from the catalog on every call: `databaseEventsEmitter` is per
 * thread, so a cache here would miss a drop performed on another thread.
 */
export function localDropMarkers(databaseName: string): Map<string, TableDropMarker> {
	return dropMarkersByTable(getTableDrops(databaseName));
}

/**
 * A definition with no stamp (an older peer, or a table that predates the stamps) counts as created at 0,
 * except while this node holds a generation newer than the marker, which an unstamped peer is taken to
 * describe: a not-yet-upgraded peer's writes to a recreated table keep flowing through a rolling upgrade,
 * and the stale copy such a peer might hold instead is retired as soon as it runs the current build.
 */
export function definitionIsDead(
	definition: { createdTime?: unknown },
	marker: TableDropMarker | undefined,
	localTable?: { createdTime?: number }
): boolean {
	if (!marker) return false;
	const createdTime = definition.createdTime;
	if (typeof createdTime !== 'number') {
		return !localTable || isDeadGeneration(localTable.createdTime, marker.droppedTime);
	}
	return isDeadGeneration(createdTime, marker.droppedTime);
}

/**
 * Whether a table still holds a record written before `time`. Versions are origin write times, so a row
 * of a generation created after a drop is never older than that drop; one that is proves the table is the
 * generation the drop retired. Stops at the first such row; a table without one is read once in full.
 */
export function hasRowOlderThan(table: { primaryStore: any }, time: number): boolean {
	for (const entry of table.primaryStore.getRange({ versions: true, lazy: true })) {
		if (entry.version < time) return true;
	}
	return false;
}
