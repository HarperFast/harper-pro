/**
 * Own-origin recovery after a lost transaction-log tail (harper-pro#1364). Table writes run WAL-off, so
 * between memtable flushes a node's `local` log is the only on-disk record of its own commits, and a power
 * loss can drop a tail its peers already confirmed. Each start opens an epoch: the window `(after, before)`
 * where an own write can be missing here yet held by a peer. Every capable peer is asked for its entries
 * of this node's origin in that window over the ordinary subscription, and reports once it has sent them;
 * record-lock freshness refuses own lineage in the window until every peer that may hold it has reported.
 * Design: replication/DESIGN.md "Own-origin recovery".
 *
 * State lives in the database's `dbis` store so every thread reads the same facts: the epoch row, written
 * on the main thread before workers start, and one report row per peer, written by whichever thread holds
 * that peer's socket once its recovered rows are durable.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getDatabases } from '../core/resources/databases.ts';
import { getNodeNameForId } from '../core/resources/nodeIdMapping.ts';
import { getLogPurgeBounds } from '../core/resources/auditStore.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import { getHDBNodeTable, probeNodeRow } from './knownNodes.ts';
import { findLastCommittedLogKey, ORIGIN_CURSOR_OVERLAP_MS } from './replicationConnection.ts';

const EPOCH = Symbol.for('ownOriginRecovery');
const REPORT = Symbol.for('ownOriginRecovered');
const MIN_START = 1;

export interface OwnOriginEpoch {
	/** Where peers start returning own writes: the log's last key less the commit-order overlap, or 1. */
	after: number;
	/** The highest own key the log held (or had purged through) when the epoch opened; 0 if none. */
	lastKey: number;
	/** The native clock when the epoch opened: every key minted since is above it. Identifies the epoch. */
	before: number;
	/** Peers that had replicated this database with this node when the epoch opened. */
	requiredPeers: string[];
	finished?: boolean;
}

export interface OwnOriginReport {
	epoch: number;
	/** How far the peer had purged this node's log, when past the epoch's start. */
	purgedThrough?: number;
	/** Set when the peer's read of this node's log did not end cleanly. */
	failed?: boolean;
}

export type OwnLineage = { state: 'intact' } | { state: 'pending' | 'unprovable'; detail: string };

const finishedEpochs = new Map<string, number>();

function dbisFor(database: string): any {
	const tables = getDatabases()[database];
	for (const tableName in tables) {
		const dbisDB = tables[tableName]?.dbisDB;
		if (dbisDB) return dbisDB;
	}
	return undefined;
}

/**
 * The start of the window. The log is appended in commit order, not key order, so an entry lost after the
 * last durable one can carry a lower key; the same overlap ordinary resume uses (`ORIGIN_CURSOR_OVERLAP_MS`)
 * covers it. An empty or unreadable log, or none at all, starts at 1. An unfinished earlier epoch keeps its
 * start, since its window may still hold writes no peer has returned.
 */
export function recoveryStart(
	lastKey: number | undefined,
	purgeBound: number | undefined,
	previous: OwnOriginEpoch | undefined
): number {
	const known = Math.max(lastKey ?? 0, purgeBound ?? 0);
	let after = known > 0 ? Math.max(MIN_START, known - ORIGIN_CURSOR_OVERLAP_MS) : MIN_START;
	if (previous && !previous.finished && previous.after < after) after = Math.max(MIN_START, previous.after);
	return after;
}

/** Names of the peers with a replication cursor in this database, i.e. that have sent it here. */
export function peersWithCursors(dbisDB: any, auditStore: any): string[] {
	const names = new Set<string>();
	for (const { key } of dbisDB.getRange({
		start: Symbol.for('seq'),
		end: [Symbol.for('seq'), Buffer.from([0xff])],
	})) {
		const id = key?.[1];
		if (typeof id !== 'number' || id === 0) continue;
		const name = getNodeNameForId(auditStore, id, true);
		if (name) names.add(name);
	}
	return [...names];
}

/**
 * Open this start's epoch for one database, before any worker writes to it. Synchronous so the row is
 * visible to the first subscription a worker builds; the WAL sync that makes it survive power loss follows.
 */
export function openOwnOriginRecoveryEpoch(database: string, auditStore: any, dbisDB: any): OwnOriginEpoch | undefined {
	const rootStore = auditStore?.rootStore;
	if (auditStore?.reusableIterable !== true || !dbisDB || typeof rootStore?.getMonotonicTimestamp !== 'function')
		return undefined;
	const previous = readEpoch(dbisDB);
	const purgeBound = getLogPurgeBounds(auditStore, 'local')?.get('local');
	const lastKey = findLastCommittedLogKey(auditStore, 'local') || undefined;
	const epoch: OwnOriginEpoch = {
		after: recoveryStart(lastKey, purgeBound, previous),
		lastKey: Math.max(lastKey ?? 0, purgeBound ?? 0),
		before: rootStore.getMonotonicTimestamp(),
		requiredPeers: peersWithCursors(dbisDB, auditStore),
	};
	dbisDB.putSync(EPOCH, epoch);
	finishedEpochs.delete(database);
	rootStore
		.syncWal?.()
		?.catch?.((error: unknown) =>
			logger.warn?.(`Own-origin recovery: could not sync the recovery epoch of ${database}`, error)
		);
	logger.info?.(
		`Own-origin recovery for ${database}: asking ${epoch.requiredPeers.length} peer(s) for this node's writes after ${new Date(epoch.after).toISOString()}`
	);
	return epoch;
}

export function readEpoch(dbisDB: any): OwnOriginEpoch | undefined {
	const epoch = dbisDB?.getSync(EPOCH);
	return epoch && typeof epoch.after === 'number' && typeof epoch.before === 'number' ? epoch : undefined;
}

export function readReport(dbisDB: any, peer: string): OwnOriginReport | undefined {
	return dbisDB?.getSync([REPORT, peer]);
}

/** The range a subscription to `peer` asks for, while the epoch is open and that peer has not reported. */
export function recoveryRangeFor(dbisDB: any, peer: string): { startTime: number; endTime: number } | undefined {
	const epoch = readEpoch(dbisDB);
	if (!epoch || epoch.finished) return undefined;
	if (readReport(dbisDB, peer)?.epoch === epoch.before) return undefined;
	return { startTime: epoch.after, endTime: epoch.before };
}

function isMember(name: string): boolean {
	try {
		return probeNodeRow(getHDBNodeTable().primaryStore, name).outcome !== 'deleted';
	} catch {
		return true;
	}
}

/** A peer that purged past everything this node still held may have purged what it lost. */
function purgedPastLog(report: OwnOriginReport, epoch: OwnOriginEpoch): boolean {
	return report.purgedThrough !== undefined && report.purgedThrough > epoch.lastKey;
}

function cleanReport(report: OwnOriginReport | undefined, epoch: OwnOriginEpoch): boolean {
	return report?.epoch === epoch.before && !report.failed && !purgedPastLog(report, epoch);
}

/**
 * Store `peer`'s report for epoch `epochId`; the caller has made the rows it delivered durable first.
 * Marks the epoch finished once every required peer that is still a member reported cleanly, so the next
 * start does not carry its window forward.
 */
export async function recordReport(database: string, peer: string, report: OwnOriginReport): Promise<void> {
	const dbisDB = dbisFor(database);
	if (!dbisDB) return;
	const epoch = readEpoch(dbisDB);
	if (!epoch || epoch.before !== report.epoch) return;
	await dbisDB.put([REPORT, peer], report);
	if (purgedPastLog(report, epoch))
		logger.warn?.(
			`Own-origin recovery for ${database}: ${peer} purged this node's writes through ${new Date(report.purgedThrough).toISOString()}; writes this node lost before then cannot be recovered, and cluster locks cannot prove this node's own lineage until it restarts with complete history or is recloned`
		);
	if (report.failed)
		logger.warn?.(`Own-origin recovery for ${database}: ${peer} could not read this node's writes cleanly`);
	if (epoch.finished) return;
	for (const name of epoch.requiredPeers) {
		if (name !== peer && isMember(name) && !cleanReport(readReport(dbisDB, name), epoch)) return;
	}
	if (!cleanReport(report, epoch)) return;
	await dbisDB.put(EPOCH, { ...epoch, finished: true });
	logger.info?.(`Own-origin recovery for ${database}: every peer returned this node's writes`);
}

/**
 * Whether this node's own history is proven at `position` (null: anywhere, for a grant whose lineage the
 * home lost). Outside the window the local log is authoritative; inside it, every member that may hold an
 * own write (cursor peers and lock homes) must have reported cleanly for this epoch. A peer's report covers
 * the tables its route sends here; a table it does not send is taken as one it never received from here.
 */
export function ownLineage(
	database: string,
	position: number | null,
	homes: readonly string[],
	self: string,
	memberCheck: (name: string) => boolean = isMember
): OwnLineage {
	const epoch = readEpoch(dbisFor(database));
	if (!epoch || finishedEpochs.get(database) === epoch.before) return { state: 'intact' };
	if (position !== null && (position <= epoch.after || position >= epoch.before)) return { state: 'intact' };
	return lineageFromReports(
		epoch,
		homes,
		self,
		(peer) => readReport(dbisFor(database), peer),
		memberCheck,
		() => finishedEpochs.set(database, epoch.before)
	);
}

export function lineageFromReports(
	epoch: OwnOriginEpoch,
	homes: readonly string[],
	self: string,
	reportOf: (peer: string) => OwnOriginReport | undefined,
	memberCheck: (name: string) => boolean,
	onFinished?: () => void
): OwnLineage {
	if (epoch.finished) {
		onFinished?.();
		return { state: 'intact' };
	}
	const required = new Set([...epoch.requiredPeers, ...homes]);
	required.delete(self);
	for (const peer of required) {
		if (!memberCheck(peer)) continue;
		const report = reportOf(peer);
		if (report?.epoch !== epoch.before)
			return { state: 'pending', detail: `${peer} has not returned this node's writes since it restarted` };
		if (report.failed || purgedPastLog(report, epoch))
			return {
				state: 'unprovable',
				detail: `${peer} ${report.failed ? 'could not read' : 'had purged'} this node's writes in the recovery window`,
			};
	}
	return { state: 'intact' };
}

const FLUSH_TIMEOUT_MS = 60_000;
interface FlushState {
	running?: Promise<void>;
	next?: Promise<void>;
}
const flushes = new WeakMap<object, FlushState>();

/**
 * A flush that begins after this call, so it covers every row committed before it: rocksdb-js syncs the
 * transaction logs when a flush begins. Callers arriving while one runs share the single flush after it.
 */
export function flushAfterNow(rootStore: any): Promise<void> {
	let state = flushes.get(rootStore);
	if (!state) flushes.set(rootStore, (state = {}));
	if (!state.running) {
		const running = Promise.resolve()
			.then(() => rootStore.flush())
			.finally(() => {
				if (state.running === running) state.running = undefined;
			});
		state.running = running;
		return running;
	}
	state.next ??= state.running
		.catch(() => {})
		.then(() => {
			state.next = undefined;
			return flushAfterNow(rootStore);
		});
	return state.next;
}

/** Test-only: parks reports until `<dir>/release` exists, so a test can act while recovery is unconfirmed. */
const REPORT_HOLD_DIRECTORY = process.env.HARPER_TEST_HOLD_OWN_ORIGIN_REPORT_DIR;
async function holdReportForTest(): Promise<void> {
	if (!REPORT_HOLD_DIRECTORY) return;
	const release = join(REPORT_HOLD_DIRECTORY, 'release');
	if (existsSync(release)) return;
	writeFileSync(join(REPORT_HOLD_DIRECTORY, 'held'), String(Date.now()));
	logger.warn?.(`[test] holding own-origin recovery reports until ${release} exists`);
	while (!existsSync(release)) await delay(50);
}

/**
 * Called once every row `peer` returned has committed: make them durable, then record the report. Never
 * throws; a failure leaves the peer unreported, so the next subscription asks it again.
 */
export function settleOwnOriginReport(database: string, peer: string, report: OwnOriginReport, rootStore: any): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	holdReportForTest()
		.then(() => {
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`flush did not finish within ${FLUSH_TIMEOUT_MS} ms`)),
					FLUSH_TIMEOUT_MS
				);
				timer.unref?.();
			});
			return Promise.race([flushAfterNow(rootStore), deadline]);
		})
		.then(() => recordReport(database, peer, report))
		.catch((error) =>
			logger.warn?.(`Own-origin recovery: could not record ${peer}'s report for ${database}; it is asked again`, error)
		)
		.finally(() => clearTimeout(timer));
}
