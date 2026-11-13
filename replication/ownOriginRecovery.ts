/**
 * Own-origin recovery after a lost transaction-log tail (harper-pro#1364). Table writes run WAL-off, so
 * between memtable flushes a node's `local` log is the only on-disk record of its own commits, and a power
 * loss can drop a tail its peers already confirmed. A start that may follow such a loss (bootIdentity.ts)
 * opens an epoch: the window `(after, before)` where an own write can be missing here yet held by a peer.
 * Every capable peer is asked for its entries of this node's origin in that window over the ordinary
 * subscription, and reports once it has sent them; record-lock freshness refuses own lineage in the window
 * until every peer that may hold it has reported.
 * Design: replication/DESIGN.md, non-obvious behavior 39.
 *
 * State lives in the database's `dbis` store so every thread reads the same facts: the epoch row, written
 * on the main thread before workers start, and one report row per peer, written by whichever thread holds
 * that peer's socket once its recovered rows are durable.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getDatabases } from '../core/resources/databases.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import { getNodeNameForId } from '../core/resources/nodeIdMapping.ts';
import { getLogPurgeBounds } from '../core/resources/auditStore.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import { getHDBNodeTable, probeNodeRow } from './knownNodes.ts';
import { existingRow as existingHomesRow } from './recordLockHomes.ts';
import { findLastCommittedLogKey, ORIGIN_CURSOR_OVERLAP_MS } from './replicationConnection.ts';

const EPOCH = Symbol.for('ownOriginRecovery');
// Databases whose epoch could not be opened, set on the main thread before workers start, which copy the env.
const FAILED_ENV = 'HARPER_OWN_ORIGIN_RECOVERY_FAILED';
const failedDatabases = new Set((process.env[FAILED_ENV] ?? '').split('\n').filter(Boolean));
const REPORT = Symbol.for('ownOriginRecovered');
const MIN_START = 1;

export interface OwnOriginEpoch {
	/** Where peers start returning own writes: the log's last key less the commit-order overlap, or 1. */
	after: number;
	/** The highest own key the log held (or had purged through) when the epoch opened; 0 if none. */
	lastKey: number;
	/** The native clock when the epoch opened: every key minted since is above it. Identifies the epoch. */
	before: number;
	/** Members that may hold this node's writes when the epoch opened: peers with a cursor here, and members it sends to. */
	requiredPeers: string[];
	finished?: boolean;
	/** The OS boot this epoch opened on, when known: a later start on the same boot continues it. */
	bootId?: string;
}

export interface StartContinuity {
	bootId?: string;
	/** A transaction-log sync failure was recorded since the previous start. */
	syncFailure: boolean;
}

/**
 * The previous epoch still covers this start when the OS kept its page cache, so no own write was lost since;
 * a log holding less than it did when that epoch opened says otherwise, whatever the boot.
 */
export function continuesEpoch(
	previous: OwnOriginEpoch | undefined,
	continuity: StartContinuity,
	held: number
): previous is OwnOriginEpoch {
	return (
		!continuity.syncFailure &&
		continuity.bootId !== undefined &&
		previous?.bootId === continuity.bootId &&
		held >= previous.lastKey
	);
}

export interface OwnOriginReport {
	epoch: number;
	/** How far the peer had purged this node's log, when past the epoch's start. */
	purgedThrough?: number;
	/** Set when the peer's read of this node's log did not end cleanly. */
	failed?: boolean;
}

export type OwnLineage = { state: 'intact' } | { state: 'pending' | 'unprovable'; detail: string };

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
 * last durable one can carry a lower key; this takes the same overlap ordinary resume does
 * (`ORIGIN_CURSOR_OVERLAP_MS`), which is not a proven bound. An empty or unreadable log starts at 1. An
 * unfinished earlier epoch keeps its start, since its window may still hold writes no peer has returned.
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

export function nextEpoch(
	lastKey: number | undefined,
	purgeBound: number | undefined,
	previous: OwnOriginEpoch | undefined,
	before: number,
	requiredPeers: string[]
): OwnOriginEpoch {
	let held = Math.max(lastKey ?? 0, purgeBound ?? 0);
	// an unfinished window is judged against what the log held when it opened, not what it holds since, and
	// still waits on every holder it named
	if (previous && !previous.finished) {
		held = Math.min(held, previous.lastKey);
		requiredPeers = [...new Set([...previous.requiredPeers, ...requiredPeers])];
	}
	return { after: recoveryStart(lastKey, purgeBound, previous), lastKey: held, before, requiredPeers };
}

function peersWithCursors(dbisDB: any, auditStore: any): string[] {
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

export function markOwnOriginRecoveryFailed(database: string): void {
	failedDatabases.add(database);
	process.env[FAILED_ENV] = [...failedDatabases].join('\n');
}

/**
 * Open this start's epoch for one database, before any worker writes to it: the row is written
 * synchronously so the first subscription a worker builds sees it, and the caller awaits the WAL sync
 * this returns before workers start. On the previous epoch's boot with no sync failure since, that epoch
 * stays in force instead: every own write minted since it opened survived, and older ones still wait for
 * the peers that have not reported for it. A failure to read the log opens the widest window rather than
 * none; a failure to write or sync the row is the caller's to mark (`markOwnOriginRecoveryFailed`).
 */
export function openOwnOriginRecoveryEpoch(
	database: string,
	auditStore: any,
	dbisDB: any,
	continuity: StartContinuity,
	/** Members this node sends the database to; a peer that never sent back has no cursor yet may hold its writes. */
	recipients: () => string[]
): Promise<void> | undefined {
	const rootStore = auditStore?.rootStore;
	if (auditStore?.reusableIterable !== true) return undefined;
	if (!dbisDB || typeof rootStore?.getMonotonicTimestamp !== 'function' || typeof rootStore.syncWal !== 'function')
		throw new Error(`${database} has per-origin logs but no store to record a recovery epoch in`);
	const previous = readEpoch(dbisDB);
	let lastKey: number | undefined;
	let purgeBound: number | undefined;
	let logRead = true;
	try {
		// 0 is a cleanly read empty log; undefined is a read that failed
		const last = findLastCommittedLogKey(auditStore, 'local');
		if (last === undefined) throw new Error('the last committed entry could not be read');
		lastKey = last || undefined;
		purgeBound = getLogPurgeBounds(auditStore, 'local')?.get('local');
	} catch (error) {
		logRead = false;
		logger.warn?.(`Own-origin recovery: could not read ${database}'s log; asking peers for all of it`, error);
	}
	if (
		logRead &&
		continuesEpoch(previous, continuity, Math.max(lastKey ?? 0, purgeBound ?? 0)) &&
		!purgeTainted(dbisDB, previous)
	) {
		logger.info?.(
			`Own-origin recovery for ${database}: the OS has not restarted since ${new Date(previous.before).toISOString()}, so this node's own log is intact`
		);
		return undefined;
	}
	const before = rootStore.getMonotonicTimestamp();
	const requiredPeers = [...new Set([...peersWithCursors(dbisDB, auditStore), ...recipients()])];
	// an unread log counts as empty: the widest window, judged against holding nothing
	const epoch = logRead
		? nextEpoch(lastKey, purgeBound, previous, before, requiredPeers)
		: nextEpoch(undefined, undefined, previous, before, requiredPeers);
	if (continuity.bootId !== undefined) epoch.bootId = continuity.bootId;
	dbisDB.putSync(EPOCH, epoch);
	cachedEpochs.delete(database);
	logger.info?.(
		`Own-origin recovery for ${database}: asking peers for this node's writes after ${new Date(epoch.after).toISOString()}`
	);
	return rootStore.syncWal();
}

/**
 * A peer reported purging past what the epoch held, so it stays unprovable however long it is continued; a
 * new epoch judges peers' purges against what the log holds now, as every start did before continuation.
 */
function purgeTainted(dbisDB: any, epoch: OwnOriginEpoch): boolean {
	for (const { value } of dbisDB.getRange({ start: [REPORT], end: [REPORT, Buffer.from([0xff])] })) {
		if (value?.epoch === epoch.before && purgedPastLog(value, epoch)) return true;
	}
	return false;
}

function readEpoch(dbisDB: any): OwnOriginEpoch | undefined {
	const epoch = dbisDB?.getSync(EPOCH);
	return epoch && typeof epoch.after === 'number' && typeof epoch.before === 'number' ? epoch : undefined;
}

function readReport(dbisDB: any, peer: string): OwnOriginReport | undefined {
	return dbisDB?.getSync([REPORT, peer]);
}

export function recoveryRangeFor(dbisDB: any, peer: string): { startTime: number; endTime: number } | undefined {
	const epoch = readEpoch(dbisDB);
	if (!epoch || readReport(dbisDB, peer)?.epoch === epoch.before) return undefined;
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
	return report?.epoch === epoch.before && !purgedPastLog(report, epoch);
}

/**
 * Store `peer`'s report; the caller made the rows it returned durable first. Marks the epoch finished once
 * every required peer and lock home still a member reported cleanly, so the next start does not carry its
 * window forward. A failed read is no answer: it throws, so the peer is asked again.
 */
async function recordReport(database: string, peer: string, report: OwnOriginReport): Promise<void> {
	if (report.failed) throw new Error(`${peer} could not read this node's writes cleanly`);
	const dbisDB = dbisFor(database);
	if (!dbisDB) throw new Error(`no dbis store for ${database}`);
	const epoch = readEpoch(dbisDB);
	if (!epoch || epoch.before !== report.epoch) return;
	await dbisDB.put([REPORT, peer], report);
	if (purgedPastLog(report, epoch))
		logger.warn?.(
			`Own-origin recovery for ${database}: ${peer} purged this node's writes through ${new Date(report.purgedThrough).toISOString()}, past what this node still held; writes it lost before then cannot be recovered, and cluster locks refuse this node's own lineage until it is recloned`
		);
	if (epoch.finished || !cleanReport(report, epoch)) return;
	const homes = (await existingHomesRow(database))?.active?.homes ?? [];
	const lineage = lineageFromReports(
		epoch,
		homes,
		getThisNodeName(),
		(name) => (name === peer ? report : readReport(dbisDB, name)),
		isMember
	);
	if (lineage.state !== 'intact') return;
	await dbisDB.put(EPOCH, { ...epoch, finished: true });
	logger.info?.(`Own-origin recovery for ${database}: every peer returned this node's writes`);
}

// the epoch row is fixed once workers run, and a clean report is never replaced within its epoch
const cachedEpochs = new Map<
	string,
	{ epoch: OwnOriginEpoch; clean: Set<string>; provenFor?: readonly string[] } | null
>();

/**
 * Whether this node's own history is proven at `position` (null: anywhere, for a grant whose lineage the
 * home lost). A position minted since the epoch opened is; one minted before it is proven only once every member
 * that may hold an own write (required peers and lock homes) reported cleanly for this epoch, since the
 * window's start is not a proven boundary. A peer's report covers the tables its route sends here; a table
 * it does not send is taken as one it never received from here.
 */
export function ownLineage(
	database: string,
	position: number | null,
	homes: readonly string[],
	self: string,
	memberCheck: (name: string) => boolean = isMember
): OwnLineage {
	if (failedDatabases.has(database))
		return { state: 'unprovable', detail: 'its recovery epoch could not be recorded at startup' };
	let cached = cachedEpochs.get(database);
	if (cached === null) return { state: 'intact' };
	if (!cached) {
		const dbisDB = dbisFor(database);
		const epoch = readEpoch(dbisDB);
		if (!epoch) {
			// a database created since this start has no epoch and nothing to have lost; epochs open only at startup
			if (dbisDB) cachedEpochs.set(database, null);
			return { state: 'intact' };
		}
		cached = { epoch, clean: new Set() };
		cachedEpochs.set(database, cached);
	}
	const { epoch, clean } = cached;
	if ((position !== null && position >= epoch.before) || cached.provenFor === homes) return { state: 'intact' };
	let skippedNonMember = false;
	const lineage = lineageFromReports(
		epoch,
		homes,
		self,
		(peer) => (clean.has(peer) ? { epoch: epoch.before } : readReport(dbisFor(database), peer)),
		(peer) => {
			if (memberCheck(peer)) return true;
			skippedNonMember = true;
			return false;
		},
		(peer) => clean.add(peer)
	);
	// a home map's array is replaced, never mutated, when it changes; a peer removed now may be re-added
	if (lineage.state === 'intact' && !skippedNonMember) cached.provenFor = homes;
	return lineage;
}

export function lineageFromReports(
	epoch: OwnOriginEpoch,
	homes: readonly string[],
	self: string,
	reportOf: (peer: string) => OwnOriginReport | undefined,
	memberCheck: (name: string) => boolean,
	onClean?: (peer: string) => void
): OwnLineage {
	const required = new Set([...epoch.requiredPeers, ...homes]);
	required.delete(self);
	for (const peer of required) {
		const report = reportOf(peer);
		if (report && cleanReport(report, epoch)) {
			onClean?.(peer);
			continue;
		}
		if (!memberCheck(peer)) continue;
		if (report?.epoch !== epoch.before)
			return { state: 'pending', detail: `${peer} has not returned this node's writes since it restarted` };
		return { state: 'unprovable', detail: `${peer} had purged this node's writes in the recovery window` };
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
 * throws; on a failure the peer stays unreported and `retry` asks it again.
 */
export function settleOwnOriginReport(
	database: string,
	peer: string,
	report: OwnOriginReport,
	rootStore: any,
	retry: () => void
): void {
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
		.catch((error) => {
			logger.warn?.(`Own-origin recovery: could not record ${peer}'s report for ${database}; asking again`, error);
			retry();
		})
		.finally(() => clearTimeout(timer));
}
