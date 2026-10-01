/**
 * Table lifecycle on the wire (harper#1212). Core owns the two facts — a generation's `createdTime` on its
 * catalog row and a `droppedTime` marker that survives the drop — and the rule `isDeadGeneration`. This
 * module only shapes what a peer sends and checks what a peer sent: `DB_SCHEMA[4]` is untrusted input
 * that can delete a local table, so every entry is validated and the list is bounded before use.
 */
import { isDeadGeneration, type TableDropMarker } from '../core/resources/databases.ts';

/** A peer that has dropped more distinct names than this is sending a fault, not a schema. */
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
 * A definition (or structure frame) from a peer describes a dead generation when a local marker
 * postdates its stamp. A definition with no stamp — an older peer, or a table that predates the
 * stamps — is treated as created at 0, so any marker beats it, with one exception: while this node
 * holds a generation newer than the marker, an unstamped peer is taken to describe that live table.
 * A not-yet-upgraded peer's writes to a recreated table must keep flowing through a rolling upgrade;
 * the stale copy such a peer might hold instead is retired the moment it runs the current build.
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
