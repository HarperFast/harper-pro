/**
 * The successor-freshness barrier (harper `docs/record-lock-ownership.md` §7, harper#2542;
 * `RECORD_LOCK_FRESHNESS_DESIGN.md`). Core hands a granted delegation's inherited
 * `(origin, position)` dependency set — or `null`, a recovery marker — to
 * `ClusterLockTransport.establishLockFreshness()` and admits only once it resolves. The only proof
 * accepted here is a `lockBarrier` control entry the origin committed after the fenced write, matched
 * on `(origin, position, nonce)` once this node has applied it: a numeric log key is not an
 * append-order proof (rocksdb-js appends in commit order and reissues keys after a clock step), and a
 * received frame is not an applied one.
 *
 * Pure over its dependencies so the decisions are unit-testable without a cluster: which
 * dependencies are refused outright (a non-member, a stale level, an unreplicated table, a poisoned
 * `(origin, table)`, self-origin after a reclone), when a barrier is requested, and how a wait ends.
 */
import { ClientError } from '../core/utility/errors/hdbError.ts';
import {
	RESTART_ATTEMPT_MS,
	type LockDependencySet,
	type LockHomeMap,
} from '../core/resources/recordLockCoordinator.ts';
import { MAX_LOCK_LEASE_MS } from '../core/resources/recordLock.ts';
import { RECORD_LOCKS_CAPABILITY } from './protocolCapabilities.ts';

/** Bounds what abandoned callers can pin per database; beyond it a new wait rejects rather than queues. */
export const MAX_OUTSTANDING_BARRIERS = 10_000;
/** Deadline sweep cadence while anything is outstanding. Waits settle on the applied entry, not on this. */
export const BARRIER_SWEEP_MS = 250;
/**
 * A barrier whose request failed is asked again on core's restart backoff (record-locks.md §4.5 (2)):
 * jittered between half and all of a step that doubles from the minimum to the maximum.
 */
export const BARRIER_RETRY_MIN_MS = 250;
export const BARRIER_RETRY_MAX_MS = 2_000;
const NONCE_BOUND = Number.MAX_SAFE_INTEGER;
/** The replication clock domain (`isValidFrameTxnLogKey` in replicationConnection.ts): finite, positive, a date. */
const MAX_DATE_TIMESTAMP = 8.64e15;
export function isValidLogPosition(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DATE_TIMESTAMP;
}

export interface FreshnessDeps {
	thisNodeName(): string;
	homeMap(): LockHomeMap | undefined;
	/** The peer's exact advertised `recordLocks` level, 0 while unknown or absent. */
	peerLevel(peer: string): number;
	tableReplicates(table: string): boolean;
	isPoisoned(origin: string, table: string): boolean;
	everRecloned(): boolean;
	/**
	 * Ask `origin` to commit a barrier for the table; resolves to the entry's origin-log position.
	 * `timeoutMs` is the attempt's bound, never more than what is left of the lock's own deadline: the
	 * deadline sweep below only settles the WAIT, so without bounding the request too, a
	 * member that accepts the connection and never answers leaves a response waiter (and, on the per-call
	 * fallback connection, a socket) pinned for the life of that connection — one per failed handoff.
	 */
	requestBarrier(origin: string, table: string, nonce: number, timeoutMs: number): Promise<number>;
	monotonicNow(): number;
	nonce?(): number;
	random?(): number;
	setTimer?(callback: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
}

export interface FreshnessStats {
	outstanding: number;
	applied: number;
	timeouts: number;
	retried: number;
	rejected: Record<string, number>;
}

interface Waiter {
	deadlineMono: number;
	settle(error?: Error): void;
}

interface Outstanding {
	nonce: number;
	origin: string;
	table: string;
	deadlineMono: number;
	/** From the origin's reply, once it arrives. */
	position: number | undefined;
	/** From the receive path, once the entry commits here — can precede the reply. */
	appliedPosition: number | undefined;
	waiters: Waiter[];
	/**
	 * Each attempt is bounded like core's request to a home, so one sent on a connection that never
	 * answers is asked again on a fresh nonce; doubled after an attempt that used it all, so an origin
	 * that is slow rather than gone is still given the time to answer.
	 */
	attemptMs: number;
	sentAt: number;
	retry?: { stepMs: number; timer?: unknown; lastError: string };
}

export interface FreshnessBarrier {
	establish(
		table: string,
		dependencies: LockDependencySet | null,
		deadlineMs: number
	): Promise<LockDependencySet | void>;
	/** A `lockBarrier` entry committed on this node. Returns whether anything was waiting on it. */
	noteBarrierApplied(origin: string, position: number, nonce: number): boolean;
	stats(): FreshnessStats;
	/** Settle every wait with 503; the transport is being replaced or the database released. */
	close(): void;
}

function unavailable(message: string): ClientError {
	return new ClientError(message, 503);
}

export function createFreshnessBarrier(database: string, deps: FreshnessDeps): FreshnessBarrier {
	// A wait between attempts is in `waits` but not `attempts`, so the cap, the sweep and `close()` still see it.
	const waits = new Set<Outstanding>();
	const attempts = new Map<number, Outstanding>();
	const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms).unref());
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
	const nonce = deps.nonce ?? (() => Math.floor(Math.random() * NONCE_BOUND));
	const random = deps.random ?? Math.random;
	const rejected: Record<string, number> = {};
	let applied = 0;
	let timeouts = 0;
	let retried = 0;
	let sweep: unknown;
	let closed = false;

	// A check that throws is answered as poisoned: a settlement callback must end in a 503, never escape.
	const poisonedPair = (origin: string, table: string): boolean => {
		try {
			return deps.isPoisoned(origin, table);
		} catch {
			return true;
		}
	};

	const reject = (reason: string, message: string): never => {
		rejected[reason] = (rejected[reason] ?? 0) + 1;
		throw unavailable(message);
	};

	const settleEntry = (entry: Outstanding, error?: Error) => {
		waits.delete(entry);
		if (attempts.get(entry.nonce) === entry) attempts.delete(entry.nonce);
		if (entry.retry?.timer !== undefined) {
			clearTimer(entry.retry.timer);
			entry.retry.timer = undefined;
		}
		const waiters = entry.waiters;
		entry.waiters = [];
		for (const waiter of waiters) waiter.settle(error);
	};

	const sweepDeadlines = () => {
		sweep = undefined;
		const now = deps.monotonicNow();
		for (const entry of waits) {
			const live: Waiter[] = [];
			for (const waiter of entry.waiters) {
				if (waiter.deadlineMono > now) {
					live.push(waiter);
					continue;
				}
				timeouts++;
				waiter.settle(
					unavailable(
						`the lock wait elapsed before ${entry.origin} confirmed the barrier for ${database}.${entry.table}`
					)
				);
			}
			entry.waiters = live;
			if (live.length === 0) settleEntry(entry);
		}
		if (waits.size > 0) sweep = setTimer(sweepDeadlines, BARRIER_SWEEP_MS);
	};

	const armSweep = () => {
		if (sweep === undefined && !closed) sweep = setTimer(sweepDeadlines, BARRIER_SWEEP_MS);
	};

	const requestFailed = (entry: Outstanding, message: string) =>
		unavailable(
			`could not obtain a record lock barrier from ${entry.origin} for ${database}.${entry.table}: ${message}`
		);

	const send = (entry: Outstanding) => {
		const attemptNonce = entry.nonce;
		entry.sentAt = deps.monotonicNow();
		const timeoutMs = Math.min(entry.deadlineMono - entry.sentAt, entry.attemptMs);
		let request: Promise<number>;
		try {
			// At least 1ms: `sendOperation` reads 0 as "no bound" on the fallback path, and a wait whose
			// deadline has already elapsed is the sweep's business, not an unbounded request's.
			request = deps.requestBarrier(entry.origin, entry.table, attemptNonce, Math.max(1, timeoutMs));
		} catch (error) {
			request = Promise.reject(error);
		}
		request.then(
			(position) => {
				if (attempts.get(attemptNonce) !== entry) return;
				if (!isValidLogPosition(position)) {
					settleEntry(
						entry,
						unavailable(`${entry.origin} answered the barrier for ${database}.${entry.table} without a usable position`)
					);
					return;
				}
				entry.position = position;
				if (entry.appliedPosition === position) {
					if (poisonedPair(entry.origin, entry.table)) {
						rejected.poisoned = (rejected.poisoned ?? 0) + 1;
						settleEntry(
							entry,
							unavailable(
								`${database}.${entry.table} from ${entry.origin} recorded a replication hole while its barrier was in flight`
							)
						);
						return;
					}
					applied++;
					settleEntry(entry);
				} else if (entry.appliedPosition !== undefined) {
					settleEntry(
						entry,
						unavailable(
							`${entry.origin} applied a barrier for ${database}.${entry.table} at a different position than it answered`
						)
					);
				}
			},
			(error) => {
				if (attempts.get(attemptNonce) === entry) retryLater(entry, (error as Error)?.message ?? String(error));
			}
		);
	};

	/**
	 * A failed request — a socket closed under it, no connection, the origin's refusal while it boots —
	 * is what an origin restarting looks like, so it is asked again until the lock's own deadline: a
	 * process restart outlasts core's 10 s home ride-through under load. An origin down for good fails
	 * the handoffs whose lineage names it (every recovery handoff, which asks all members), and their
	 * waits hold `MAX_OUTSTANDING_BARRIERS` slots until their deadlines, so a burst of them can fill the
	 * database's cap for handoffs that name only live origins. A restarted origin's barrier still
	 * follows everything its log held before the restart.
	 */
	const retryLater = (entry: Outstanding, message: string) => {
		const now = deps.monotonicNow();
		const retry = (entry.retry ??= { stepMs: BARRIER_RETRY_MIN_MS, lastError: '' });
		retry.lastError = message;
		// The transport's timer runs on whole milliseconds and can fire just short of the bound.
		if (now - entry.sentAt >= entry.attemptMs - BARRIER_RETRY_MIN_MS) entry.attemptMs *= 2;
		// The last attempt is fitted into the deadline, as core fits its last wait, with a step of its own.
		const leftMs = entry.deadlineMono - now - BARRIER_RETRY_MIN_MS;
		if (!(leftMs > 0)) {
			settleEntry(entry, requestFailed(entry, message));
			return;
		}
		const delayMs = Math.min(leftMs, retry.stepMs / 2 + random() * (retry.stepMs / 2));
		retry.stepMs = Math.min(BARRIER_RETRY_MAX_MS, retry.stepMs * 2);
		attempts.delete(entry.nonce);
		retry.timer = setTimer(() => reissue(entry), delayMs);
	};

	const reissue = (entry: Outstanding) => {
		const retry = entry.retry!;
		retry.timer = undefined;
		if (!waits.has(entry)) return;
		const now = deps.monotonicNow();
		if (now >= entry.deadlineMono) {
			settleEntry(entry, requestFailed(entry, retry.lastError));
			return;
		}
		try {
			checkRequest(entry.origin, entry.table);
		} catch (error) {
			settleEntry(
				entry,
				error instanceof ClientError ? error : requestFailed(entry, (error as Error)?.message ?? String(error))
			);
			return;
		}
		retried++;
		entry.nonce = nonce();
		entry.position = undefined;
		entry.appliedPosition = undefined;
		attempts.set(entry.nonce, entry);
		send(entry);
	};

	/** Resolves to the barrier's position once the origin's entry has committed on this node. */
	const awaitBarrier = (origin: string, table: string, deadlineMono: number): Promise<number> => {
		const entry: Outstanding = {
			nonce: nonce(),
			origin,
			table,
			deadlineMono,
			position: undefined,
			appliedPosition: undefined,
			waiters: [],
			attemptMs: RESTART_ATTEMPT_MS,
			sentAt: 0,
		};
		// Registered before the request leaves, so the applied entry cannot arrive unmatched.
		waits.add(entry);
		attempts.set(entry.nonce, entry);
		const wait = new Promise<number>((resolve, rejectWait) => {
			let settled = false;
			entry.waiters.push({
				deadlineMono,
				settle(error) {
					if (settled) return;
					settled = true;
					if (error) rejectWait(error);
					else resolve(entry.position as number);
				},
			});
		});
		armSweep();
		send(entry);
		return wait;
	};

	const checkOrigin = (origin: string, table: string, homeMap: LockHomeMap) => {
		if (!homeMap.homes.includes(origin))
			reject('not-member', `${origin} is not a member of the record lock home map for ${database}`);
		if (deps.peerLevel(origin) !== RECORD_LOCKS_CAPABILITY)
			reject('level', `${origin} does not advertise record lock capability level ${RECORD_LOCKS_CAPABILITY}`);
		if (poisonedPair(origin, table))
			reject(
				'poisoned',
				`${database}.${table} from ${origin} has a recorded replication hole on this node; record locks cannot prove freshness for it until this node is recloned`
			);
	};

	const checkRequest = (origin: string, table: string) => {
		const homeMap = deps.homeMap();
		if (!homeMap) reject('no-home-map', `no agreed record lock home map for ${database}`);
		if (!deps.tableReplicates(table))
			reject('unreplicated', `${database}.${table} does not replicate, so a cluster lock cannot be made fresh on it`);
		checkOrigin(origin, table, homeMap);
	};

	return {
		async establish(table, dependencies, deadlineMs) {
			if (closed) throw unavailable(`record lock freshness for ${database} is closed`);
			const homeMap = deps.homeMap();
			if (!homeMap) reject('no-home-map', `no agreed record lock home map for ${database}`);
			if (!deps.tableReplicates(table))
				reject('unreplicated', `${database}.${table} does not replicate, so a cluster lock cannot be made fresh on it`);
			const deadlineMono = deps.monotonicNow() + Math.min(Math.max(deadlineMs, 0), MAX_LOCK_LEASE_MS);
			const self = deps.thisNodeName();
			const origins: string[] = [];
			if (dependencies === null) {
				for (const member of homeMap.homes) if (member !== self) origins.push(member);
			} else {
				for (const [origin, position] of dependencies) {
					if (!isValidLogPosition(position))
						reject('invalid-position', `a record lock dependency on ${origin} names an invalid log position`);
					if (origin !== self) origins.push(origin);
					// Own history is provable only while the local log is the one that wrote it.
					else if (deps.everRecloned())
						reject(
							'recloned',
							`${database} on this node was recloned, so its own earlier record lock lineage cannot be proven`
						);
				}
			}
			// Every refusal before the first wait starts: a wait started for an earlier origin would be
			// left asking on its own, holding a slot, with nothing to settle its rejection.
			for (const origin of origins) checkOrigin(origin, table, homeMap);
			if (waits.size + origins.length > MAX_OUTSTANDING_BARRIERS)
				reject('capacity', `too many record lock barriers are outstanding for ${database}`);
			const positions = await Promise.all(origins.map((origin) => awaitBarrier(origin, table, deadlineMono)));
			if (dependencies === null) return origins.map((origin, index) => [origin, positions[index]] as const);
		},
		noteBarrierApplied(origin, position, nonce) {
			const entry = attempts.get(nonce);
			if (!entry || entry.origin !== origin) return false;
			entry.appliedPosition = position;
			if (entry.position === undefined) return true;
			if (entry.position === position) {
				// A hole recorded while the request was in flight sits before this entry.
				if (poisonedPair(origin, entry.table)) {
					rejected.poisoned = (rejected.poisoned ?? 0) + 1;
					settleEntry(
						entry,
						unavailable(
							`${database}.${entry.table} from ${origin} recorded a replication hole while its barrier was in flight`
						)
					);
					return true;
				}
				applied++;
				settleEntry(entry);
			} else {
				settleEntry(
					entry,
					unavailable(
						`${origin} applied a barrier for ${database}.${entry.table} at a different position than it answered`
					)
				);
			}
			return true;
		},
		stats() {
			return { outstanding: waits.size, applied, timeouts, retried, rejected: { ...rejected } };
		},
		close() {
			closed = true;
			if (sweep !== undefined) {
				clearTimer(sweep);
				sweep = undefined;
			}
			for (const entry of Array.from(waits))
				settleEntry(
					entry,
					unavailable(`record lock freshness for ${database} was closed while waiting on ${entry.origin}`)
				);
		},
	};
}
