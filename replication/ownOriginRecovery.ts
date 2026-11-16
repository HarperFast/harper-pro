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
import { getLogPurgeBounds, readOriginClosedFloor } from '../core/resources/auditStore.ts';
import { isValidFloor, ORIGIN_FLOOR_TICK_MS } from '../core/resources/originClosedFloor.ts';
import { isReadOnlyMode } from '../core/resources/readOnlyMode.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import { getHDBNodeTable, probeNodeRow } from './knownNodes.ts';
import { existingRow as existingHomesRow } from './recordLockHomes.ts';
import { cursorBelowFloor, findLastCommittedLogKey, ORIGIN_CURSOR_OVERLAP_MS } from './replicationConnection.ts';

const EPOCH = Symbol.for('ownOriginRecovery');
// Databases whose epoch could not be opened, set on the main thread before workers start, which copy the env.
// Tagged with the process id: a replacement main process that inherits the env opened its own epochs.
const FAILED_ENV = 'HARPER_OWN_ORIGIN_RECOVERY_FAILED';
const failedDatabases = new Set(inheritedFailures(process.env[FAILED_ENV]));
function inheritedFailures(value: string | undefined): string[] {
	const [pid, ...databases] = (value ?? '').split('\n');
	return pid === String(process.pid) ? databases.filter(Boolean) : [];
}
const REPORT = Symbol.for('ownOriginRecovered');
// A pass that met a purge is stored apart, so it can never overwrite a clean report from another thread.
const PURGED = Symbol.for('ownOriginPurged');
const DURABLE_FLOOR = Symbol.for('ownOriginDurableFloor');
const LOG_VOUCH = Symbol.for('ownOriginLogVouch');
const MIN_START = 1;

export interface OwnOriginEpoch {
	/** Where peers start returning own writes (exclusive): see `recoveryStart`. */
	after: number;
	/**
	 * The highest own key the log held (or had purged through) when the epoch opened; 0 if none. Not a complete
	 * prefix: a lower key can append after it and be lost. Only a later start's tripwire (`continuesEpoch`).
	 */
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
 * The start of the window (exclusive). The log is appended in commit order, not key order, so an entry lost
 * after the last durable one can carry a lower key. Below a durable floor (`advanceDurableFloor`) nothing can
 * have been lost; it is a reservation's bound, so the start is just below it. Without one (an upgrade's first
 * start, a new database, no flush since a floor was sampled) the start is the overlap ordinary resume takes
 * (`ORIGIN_CURSOR_OVERLAP_MS`), which is not a proven bound. The start is never above that overlap, so a floor
 * can widen the window but not narrow it. An empty or unreadable log starts at 1. An unfinished earlier epoch
 * keeps its start, since its window may still hold writes no peer has returned.
 */
export function recoveryStart(
	lastKey: number | undefined,
	purgeBound: number | undefined,
	previous: OwnOriginEpoch | undefined,
	durableFloor?: number
): number {
	const known = Math.max(lastKey ?? 0, purgeBound ?? 0);
	let after = MIN_START;
	if (known > 0) {
		after = Math.max(MIN_START, known - ORIGIN_CURSOR_OVERLAP_MS);
		if (isValidFloor(durableFloor)) after = Math.max(MIN_START, Math.min(after, cursorBelowFloor(durableFloor)));
	}
	if (previous && !previous.finished && previous.after < after) after = Math.max(MIN_START, previous.after);
	return after;
}

export function nextEpoch(
	lastKey: number | undefined,
	purgeBound: number | undefined,
	previous: OwnOriginEpoch | undefined,
	before: number,
	requiredPeers: string[],
	durableFloor?: number
): OwnOriginEpoch {
	let held = Math.max(lastKey ?? 0, purgeBound ?? 0);
	// an unfinished window is judged against what the log held when it opened, not what it holds since, and
	// still waits on every holder it named
	if (previous && !previous.finished) {
		held = Math.min(held, previous.lastKey);
		requiredPeers = [...new Set([...previous.requiredPeers, ...requiredPeers])];
	}
	return { after: recoveryStart(lastKey, purgeBound, previous, durableFloor), lastKey: held, before, requiredPeers };
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
	process.env[FAILED_ENV] = [process.pid, ...failedDatabases].join('\n');
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
	// decided once per process, before workers append: a reload's view of the log includes this process's writes
	if (!vouchedDatabases.has(database)) recordLogVouch(database, dbisDB, previous, continuity, logStats(auditStore));
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
		? nextEpoch(lastKey, purgeBound, previous, before, requiredPeers, readDurableFloor(dbisDB))
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
 * A peer reported purging into the epoch's window, so it stays unprovable however long it is continued; a
 * new epoch judges peers' purges against what the log holds now, as every start did before continuation.
 */
function purgeTainted(dbisDB: any, epoch: OwnOriginEpoch): boolean {
	for (const { key, value } of dbisDB.getRange({ start: [PURGED], end: [PURGED, Buffer.from([0xff])] })) {
		if (value?.epoch === epoch.before && !cleanReport(readReport(dbisDB, key?.[1], epoch), epoch)) return true;
	}
	return false;
}

function readEpoch(dbisDB: any): OwnOriginEpoch | undefined {
	const epoch = dbisDB?.getSync(EPOCH);
	return epoch && typeof epoch.after === 'number' && typeof epoch.before === 'number' ? epoch : undefined;
}

function readReport(dbisDB: any, peer: string, epoch: OwnOriginEpoch): OwnOriginReport | undefined {
	const clean: OwnOriginReport | undefined = dbisDB?.getSync([REPORT, peer]);
	if (clean?.epoch === epoch.before) return clean;
	const purged: OwnOriginReport | undefined = dbisDB?.getSync([PURGED, peer]);
	return purged?.epoch === epoch.before ? purged : clean;
}

export function recoveryRangeFor(dbisDB: any, peer: string): { startTime: number; endTime: number } | undefined {
	const epoch = readEpoch(dbisDB);
	if (!epoch || readReport(dbisDB, peer, epoch)?.epoch === epoch.before) return undefined;
	return { startTime: epoch.after, endTime: epoch.before };
}

function isMember(name: string): boolean {
	try {
		return probeNodeRow(getHDBNodeTable().primaryStore, name).outcome !== 'deleted';
	} catch {
		return true;
	}
}

/**
 * The window's start is the only key below which this node's log is taken as a complete prefix, under the
 * same overlap the window assumes: a write lost here can carry any key above it, so a peer that purged past
 * it may have purged what was lost.
 */
function purgedIntoWindow(report: OwnOriginReport, epoch: OwnOriginEpoch): boolean {
	return report.purgedThrough !== undefined && report.purgedThrough > epoch.after;
}

function cleanReport(report: OwnOriginReport | undefined, epoch: OwnOriginEpoch): boolean {
	return report?.epoch === epoch.before && !purgedIntoWindow(report, epoch);
}

/**
 * Store `peer`'s report; the caller made the rows it returned durable first. A clean report is true whenever
 * written (that pass returned the whole window), so any clean pass proves the peer, whichever lands last.
 * Marks the epoch finished once every required peer and lock home still a member reported cleanly, so the
 * next start does not carry its window forward. A failed read is no answer: it throws, so the peer is asked again.
 */
async function recordReport(database: string, peer: string, report: OwnOriginReport): Promise<void> {
	if (report.failed) throw new Error(`${peer} could not read this node's writes cleanly`);
	const dbisDB = dbisFor(database);
	if (!dbisDB) throw new Error(`no dbis store for ${database}`);
	const epoch = readEpoch(dbisDB);
	if (!epoch || epoch.before !== report.epoch) return;
	const clean = cleanReport(report, epoch);
	await dbisDB.put([clean ? REPORT : PURGED, peer], report);
	if (!clean && !cleanReport(readReport(dbisDB, peer, epoch), epoch))
		logger.warn?.(
			`Own-origin recovery for ${database}: ${peer} purged this node's writes through ${new Date(report.purgedThrough).toISOString()}, inside the recovery window; writes it lost there cannot be recovered, and cluster locks refuse this node's own lineage until it is recloned`
		);
	if (epoch.finished || !clean) return;
	const homes = (await existingHomesRow(database))?.active?.homes ?? [];
	const lineage = lineageFromReports(
		epoch,
		homes,
		getThisNodeName(),
		(name) => (name === peer ? report : readReport(dbisDB, name, epoch)),
		isMember
	);
	if (lineage.state !== 'intact') return;
	await dbisDB.put(EPOCH, { ...epoch, finished: true });
	logger.info?.(`Own-origin recovery for ${database}: every peer returned this node's writes`);
}

// the epoch row is fixed once workers run, and a clean report stands for its epoch
export const UNPROVEN_RECHECK_MS = 50;
const cachedEpochs = new Map<
	string,
	{
		epoch: OwnOriginEpoch;
		clean: Set<string>;
		provenFor?: readonly string[];
		/** Proven by skipping required peers that were not members; holds only while each stays removed. */
		provenSkipping?: { homes: readonly string[]; skipped: string[] };
		unproven?: { homes: readonly string[]; lineage: OwnLineage; until: number };
	} | null
>();

/**
 * Whether this node's own history is proven at `position` (null: anywhere, for a grant whose lineage the
 * home lost). A position minted since the epoch opened is; one minted before it is proven only once every member
 * that may hold an own write (required peers and lock homes) reported cleanly for this epoch, since the
 * window's start is not a proven boundary. A peer's report covers the tables its route sends here; a table
 * it does not send is taken as one it never received from here. A table with a residency policy is not
 * recovered (its own rows return only in a snapshot copy), so its lineage is not held for recovery.
 */
export function ownLineage(
	database: string,
	position: number | null,
	homes: readonly string[],
	self: string,
	table?: string,
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
	if ((position !== null && position >= epoch.before) || sameHomes(cached.provenFor, homes)) return { state: 'intact' };
	if (table !== undefined && getDatabases()[database]?.[table]?.residency) return { state: 'intact' };
	const skipping = cached.provenSkipping;
	if (skipping && sameHomes(skipping.homes, homes)) {
		if (!skipping.skipped.some(memberCheck)) return { state: 'intact' };
		cached.provenSkipping = undefined;
	}
	const now = performance.now();
	const unproven = cached.unproven;
	if (unproven && unproven.until > now && sameHomes(unproven.homes, homes)) return unproven.lineage;
	const skipped: string[] = [];
	const lineage = lineageFromReports(
		epoch,
		homes,
		self,
		(peer) => (clean.has(peer) ? { epoch: epoch.before } : readReport(dbisFor(database), peer, epoch)),
		(peer) => {
			if (memberCheck(peer)) return true;
			skipped.push(peer);
			return false;
		},
		(peer) => clean.add(peer)
	);
	if (lineage.state !== 'intact') cached.unproven = { homes, lineage, until: now + UNPROVEN_RECHECK_MS };
	else if (skipped.length > 0) cached.provenSkipping = { homes, skipped };
	else cached.provenFor = homes;
	return lineage;
}

function sameHomes(cached: readonly string[] | undefined, homes: readonly string[]): boolean {
	if (cached === homes) return true;
	if (cached?.length !== homes.length) return false;
	for (let i = 0; i < homes.length; i++) if (cached[i] !== homes[i]) return false;
	return true;
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

export interface LogPosition {
	sequence: number;
	offset: number;
}

interface LogStats {
	nextLogPosition?: unknown;
	lastFlushedPosition?: unknown;
}

function isLogPosition(value: any): value is LogPosition {
	return (
		Number.isSafeInteger(value?.sequence) &&
		value.sequence >= 0 &&
		Number.isSafeInteger(value.offset) &&
		value.offset >= 0
	);
}

function compareLogPositions(a: LogPosition, b: LogPosition): number {
	return a.sequence - b.sequence || a.offset - b.offset;
}

export interface DurableFloorState {
	/** `(floor, position)` pairs in sampling order, so ascending in both. */
	samples: Array<{ floor: number; position: LogPosition }>;
	bound: number;
	persisted: number;
	persisting?: boolean;
	sampledAt?: LogPosition;
}

const MAX_FLOOR_SAMPLES = 64;

/**
 * One sampling step: `floor` is a persisted origin-closed floor read before `stats`. Every key below a persisted
 * floor was released, so its commit, and with it its append, had finished; `stats.nextLogPosition` is therefore
 * past every such entry. rocksdb-js syncs every open log segment when a memtable flush begins, before it moves
 * `lastFlushedPosition` past what that flush covers, so once `lastFlushedPosition` reaches a sample's position
 * that sample's floor is durable: no own write keyed below it can be lost. Returns the bound when it rose.
 */
export function advanceDurableFloor(state: DurableFloorState, floor: number, stats: LogStats): number | undefined {
	const next = stats?.nextLogPosition;
	const flushed = stats?.lastFlushedPosition;
	if (!isLogPosition(next) || !isLogPosition(flushed)) return;
	let samples = state.samples;
	if (isValidFloor(floor) && floor > state.bound && floor > (samples.at(-1)?.floor ?? 0)) {
		const last = samples.at(-1);
		// a higher floor over an unchanged log raises its pending sample; once covered, it would only rewrite the row
		if (state.sampledAt && compareLogPositions(next, state.sampledAt) === 0) {
			if (last && compareLogPositions(last.position, next) === 0) last.floor = floor;
		} else {
			// thinned rather than shifted: the oldest samples are the first a flush covers
			if (samples.length >= MAX_FLOOR_SAMPLES) samples = state.samples = samples.filter((_, index) => index % 2 === 0);
			samples.push({ floor, position: next });
			state.sampledAt = next;
		}
	}
	let covered = 0;
	while (covered < samples.length && compareLogPositions(samples[covered].position, flushed) <= 0) covered++;
	if (covered === 0) return;
	const proven = samples[covered - 1].floor;
	samples.splice(0, covered);
	if (proven <= state.bound) return;
	state.bound = proven;
	return proven;
}

export interface LogVouch {
	bootId?: string;
	vouched: boolean;
	/** A sync failure was recorded on this boot: a page that failed writeback can be marked clean and never written. */
	syncFailure?: boolean;
}

/**
 * Whether this process can advance a durable floor over the log earlier processes left. rocksdb-js syncs only the
 * segments it holds open, so bytes an earlier process on this boot left unsynced in a segment no later process
 * reopens stay unsynced while `lastFlushedPosition` passes them. After a reboot whatever survived is on disk. On
 * the same boot, a start that could not vouch taints every later start until a reboot; otherwise a log whose
 * flushed position is already in the segment it appends to (or that has only its first segment) has no such bytes
 * elsewhere. A sync failure on this boot vouches for nothing, whatever the segment.
 */
export function vouchesForEarlierLog(
	recorded: LogVouch | undefined,
	continuity: StartContinuity,
	stats: LogStats | undefined
): boolean {
	if (recorded?.bootId !== undefined && continuity.bootId !== undefined && recorded.bootId !== continuity.bootId)
		return true;
	if (continuity.syncFailure || recorded?.syncFailure) return false;
	const flushed = stats?.lastFlushedPosition;
	const next = stats?.nextLogPosition;
	if (!isLogPosition(flushed) || !isLogPosition(next)) return false;
	// segments start at 1: a log still in its first has no closed segment
	if (next.sequence <= 1) return true;
	return recorded?.vouched !== false && flushed.sequence === next.sequence;
}

// Before any row exists, the previous epoch's boot is the last start known. A verdict that could not be recorded is
// retried by the sampler: until it lands, the older row speaks for this start.
function recordLogVouch(
	database: string,
	dbisDB: any,
	previous: OwnOriginEpoch | undefined,
	continuity: StartContinuity,
	stats: LogStats | undefined
): void {
	let vouched = false;
	// an unreadable row may have carried a failure: keep the refusal sticky
	let syncFailure = true;
	try {
		const row = dbisDB.getSync(LOG_VOUCH);
		const recorded: LogVouch | undefined =
			typeof row?.vouched === 'boolean'
				? row
				: previous?.bootId
					? { bootId: previous.bootId, vouched: true }
					: undefined;
		vouched = vouchesForEarlierLog(recorded, continuity, stats);
		const rebooted =
			recorded?.bootId !== undefined && continuity.bootId !== undefined && recorded.bootId !== continuity.bootId;
		syncFailure = !rebooted && (continuity.syncFailure || recorded?.syncFailure === true);
	} catch (error) {
		logger.warn?.(`Own-origin recovery: could not read ${database}'s log vouch`, error);
	}
	vouchedDatabases.set(database, vouched);
	const row: LogVouch = { vouched };
	if (continuity.bootId !== undefined) row.bootId = continuity.bootId;
	if (syncFailure) row.syncFailure = true;
	if (!writeLogVouch(database, dbisDB, row)) unrecordedVouches.set(database, row);
}

function writeLogVouch(database: string, dbisDB: any, row: LogVouch): boolean {
	try {
		dbisDB.putSync(LOG_VOUCH, row);
		return true;
	} catch (error) {
		warnThrottled(`Own-origin recovery: could not record ${database}'s log vouch`, error);
		return false;
	}
}

function logStats(auditStore: any): LogStats | undefined {
	try {
		return auditStore?.log?.getStats?.();
	} catch (error) {
		logger.warn?.(`Own-origin recovery: could not read the positions of ${auditStore?.rootStore?.path}'s log`, error);
	}
}

function readDurableFloor(dbisDB: any): number | undefined {
	try {
		const floor = dbisDB?.getSync(DURABLE_FLOOR);
		return isValidFloor(floor) ? floor : undefined;
	} catch (error) {
		logger.warn?.('Own-origin recovery: could not read the durable floor; using the overlap', error);
	}
}

const vouchedDatabases = new Map<string, boolean>();
const unrecordedVouches = new Map<string, LogVouch>();
const floorStates = new WeakMap<object, DurableFloorState>();
let samplerTimer: ReturnType<typeof setInterval> | undefined;
let samplerErrorLoggedAt = -Infinity;

function warnThrottled(message: string, error: unknown): void {
	if (performance.now() - samplerErrorLoggedAt < 60_000) return;
	samplerErrorLoggedAt = performance.now();
	logger.warn?.(message, error);
}

export function startDurableFloorSampler(): void {
	if (samplerTimer || isReadOnlyMode()) return;
	samplerTimer = setInterval(sampleDurableFloors, ORIGIN_FLOOR_TICK_MS);
	samplerTimer.unref?.();
}

export function sampleDurableFloors(): void {
	for (const [database, row] of unrecordedVouches) {
		const dbisDB = dbisFor(database);
		if (dbisDB && writeLogVouch(database, dbisDB, row)) unrecordedVouches.delete(database);
	}
	for (const [database, vouched] of vouchedDatabases) {
		if (!vouched) continue;
		try {
			sampleDurableFloor(database);
		} catch (error) {
			warnThrottled(`Own-origin recovery: could not sample ${database}'s durable floor`, error);
		}
	}
}

function sampleDurableFloor(database: string): void {
	let auditStore: any;
	const tables = getDatabases()[database];
	for (const tableName in tables) {
		auditStore = tables[tableName]?.auditStore;
		if (auditStore) break;
	}
	const rootStore = auditStore?.rootStore;
	const dbisDB = dbisFor(database);
	if (
		auditStore?.reusableIterable !== true ||
		!auditStore.log ||
		!dbisDB ||
		!rootStore ||
		rootStore.status === 'closed'
	)
		return;
	let state = floorStates.get(rootStore);
	if (!state) {
		const bound = readDurableFloor(dbisDB) ?? 0;
		floorStates.set(rootStore, (state = { samples: [], bound, persisted: bound }));
	}
	advanceDurableFloor(state, readOriginClosedFloor(auditStore), auditStore.log.getStats());
	if (state.bound <= state.persisted || state.persisting) return;
	// no sync of its own: the floor tick's syncWal makes it durable, and a lost put only leaves an older, true floor
	const floor = state.bound;
	const persisting = state;
	persisting.persisting = true;
	Promise.resolve()
		.then(() => dbisDB.put(DURABLE_FLOOR, floor))
		.then(() => {
			if (floor > persisting.persisted) persisting.persisted = floor;
		})
		.catch((error: unknown) =>
			warnThrottled(`Own-origin recovery: could not record ${database}'s durable floor`, error)
		)
		.finally(() => {
			persisting.persisting = false;
		});
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
