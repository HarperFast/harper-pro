/**
 * Durable facts the freshness barrier (`recordLockFreshness.ts`) fails closed on, kept in each
 * database's `dbis` store next to the replication cursors:
 *
 * - **Poison**: a record of `(origin, table)` this node dropped (an excluded table, a missing shared
 *   structure, a decode error, a mis-forwarded local-only record) or failed to apply terminally. A
 *   barrier committed after such a hole still proves nothing about the write in it, and a base copy
 *   cannot re-deliver an absence, so the row is permanent — only a fresh clone of this node's
 *   database, which discards the store, clears it.
 * - **Ever recloned**: written when a clone attempt starts, before any copied row lands. Copied rows
 *   carry no local log entry and positions do not identify an incarnation, so once set, this node's
 *   own earlier lineage is not provable from its log.
 *
 * A hole is recorded on whichever thread holds the socket while the barrier that must refuse it waits
 * on the coordinating thread, so the checks here read the **store**, never a per-thread cache: the
 * drop completes only after its row is durable, and a store read on any thread after that sees it.
 * They run on the cold handoff path only (once per barrier), never per lock. The one in-memory
 * layer is a fail-closed mark for a pair whose row could not be written on this thread; it is never
 * treated as recorded, so the next report of the same pair writes again.
 */
import { getDatabases } from '../core/resources/databases.ts';
import * as logger from '../core/utility/logging/harper_logger.js';

const POISON = Symbol.for('lockPoison');
const RECLONED = Symbol.for('lockEverRecloned');
/** `'*'` as the table poisons every table from that origin — a failure whose table is unknown. */
export const ANY_TABLE = '*';

const unwritten = new Map<string, Set<string>>();

function pairKey(origin: string, table: string): string {
	return JSON.stringify([origin, table]);
}

function dbisFor(database: string): any {
	const tables = getDatabases()[database];
	for (const tableName in tables) {
		const dbisDB = tables[tableName]?.dbisDB;
		if (dbisDB) return dbisDB;
	}
	return undefined;
}

function hasRow(dbisDB: any, origin: string, table: string): boolean {
	return dbisDB.getSync([POISON, origin, table]) !== undefined;
}

/**
 * Fails closed: a database whose store cannot be consulted, or whose read throws, is reported as
 * poisoned — the barrier's answer to "unknown" is a 503, never an admission.
 */
export function isPoisoned(database: string, origin: string, table: string): boolean {
	const pending = unwritten.get(database);
	if (pending && (pending.has(pairKey(origin, table)) || pending.has(pairKey(origin, ANY_TABLE)))) return true;
	try {
		const dbisDB = dbisFor(database);
		if (!dbisDB) return true;
		return hasRow(dbisDB, origin, table) || hasRow(dbisDB, origin, ANY_TABLE);
	} catch (error) {
		logger.warn?.(
			`Record locks: could not read the poison state for ${database}; treating ${origin} as poisoned`,
			error
		);
		return true;
	}
}

/** Fails closed the same way: no readable store means this node's own lineage is not provable. */
export function everRecloned(database: string): boolean {
	try {
		const dbisDB = dbisFor(database);
		return dbisDB ? dbisDB.getSync([RECLONED]) === true : true;
	} catch (error) {
		logger.warn?.(`Record locks: could not read the reclone state for ${database}; treating it as recloned`, error);
		return true;
	}
}

/**
 * Record a hole. Resolves only once the row is durable; a caller on the receive path must not let the
 * drop complete before then. A write that throws leaves the pair marked on this thread so it fails
 * closed here regardless, and the next report of the same pair writes again.
 */
export async function poison(database: string, origin: string, table: string, reason: string): Promise<void> {
	const dbisDB = dbisFor(database);
	if (dbisDB && hasRow(dbisDB, origin, table)) return;
	let pending = unwritten.get(database);
	if (!pending) unwritten.set(database, (pending = new Set()));
	const pair = pairKey(origin, table);
	if (!pending.has(pair)) {
		pending.add(pair);
		logger.warn?.(
			`Record locks: ${database}.${table} from ${origin} has a replication hole on this node (${reason}); cluster locks cannot prove freshness for it until this node is recloned`
		);
	}
	if (!dbisDB) throw new Error(`no dbis store for ${database} to record the record lock poison in`);
	await dbisDB.put([POISON, origin, table], { reason, at: Date.now() });
	pending.delete(pair);
}

/** Resolves once the flag is durable; the clone must not copy a row before then. */
export async function markRecloned(database: string): Promise<void> {
	const dbisDB = dbisFor(database);
	if (!dbisDB) throw new Error(`no dbis store for ${database} to record the reclone in`);
	await dbisDB.put([RECLONED], true);
}

/** `origin:table` for every recorded or still-unwritten pair — status reporting, not the lock path. */
export function poisonedPairs(database: string): string[] {
	const pairs = new Set<string>();
	for (const pair of unwritten.get(database) ?? []) pairs.add(pair);
	const dbisDB = dbisFor(database);
	if (dbisDB) {
		for (const { key } of dbisDB.getRange({ start: [POISON], end: [POISON, '￿', '￿'] })) {
			if (Array.isArray(key) && key[0] === POISON && key.length === 3) pairs.add(pairKey(key[1], key[2]));
		}
	}
	return [...pairs].map((pair) => {
		const [origin, table] = JSON.parse(pair);
		return `${origin}:${table}`;
	});
}

/** The database was dropped or replaced on this thread; its unwritten marks go with it. */
export function forgetPoisonState(database: string): void {
	unwritten.delete(database);
}
