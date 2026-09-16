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
import type { LockDependencySet, LockHomeMap } from '../core/resources/recordLockCoordinator.ts';
import { MAX_LOCK_LEASE_MS } from '../core/resources/recordLock.ts';
import { RECORD_LOCKS_CAPABILITY } from './protocolCapabilities.ts';

/** Bounds what abandoned callers can pin per database; beyond it a new wait rejects rather than queues. */
export const MAX_OUTSTANDING_BARRIERS = 10_000;
/** Deadline sweep cadence while anything is outstanding. Waits settle on the applied entry, not on this. */
export const BARRIER_SWEEP_MS = 250;
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
	/** Ask `origin` to commit a barrier for the table; resolves to the entry's origin-log position. */
	requestBarrier(origin: string, table: string, nonce: number): Promise<number>;
	monotonicNow(): number;
	nonce?(): number;
	setTimer?(callback: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
}

export interface FreshnessStats {
	outstanding: number;
	applied: number;
	timeouts: number;
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
	/** From the origin's reply, once it arrives. */
	position: number | undefined;
	/** From the receive path, once the entry commits here — can precede the reply. */
	appliedPosition: number | undefined;
	waiters: Waiter[];
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
	const outstanding = new Map<number, Outstanding>();
	const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms).unref());
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
	const nonce = deps.nonce ?? (() => Math.floor(Math.random() * NONCE_BOUND));
	const rejected: Record<string, number> = {};
	let applied = 0;
	let timeouts = 0;
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
		outstanding.delete(entry.nonce);
		const waiters = entry.waiters;
		entry.waiters = [];
		for (const waiter of waiters) waiter.settle(error);
	};

	const sweepDeadlines = () => {
		sweep = undefined;
		const now = deps.monotonicNow();
		for (const entry of outstanding.values()) {
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
			if (live.length === 0) outstanding.delete(entry.nonce);
		}
		if (outstanding.size > 0) sweep = setTimer(sweepDeadlines, BARRIER_SWEEP_MS);
	};

	const armSweep = () => {
		if (sweep === undefined && !closed) sweep = setTimer(sweepDeadlines, BARRIER_SWEEP_MS);
	};

	/** Resolves to the barrier's position once the origin's entry has committed on this node. */
	const awaitBarrier = (origin: string, table: string, deadlineMono: number): Promise<number> => {
		if (closed) throw unavailable(`record lock freshness for ${database} is closed`);
		if (outstanding.size >= MAX_OUTSTANDING_BARRIERS)
			reject('capacity', `too many record lock barriers are outstanding for ${database}`);
		const entry: Outstanding = {
			nonce: nonce(),
			origin,
			table,
			position: undefined,
			appliedPosition: undefined,
			waiters: [],
		};
		// Registered before the request leaves, so the applied entry cannot arrive unmatched.
		outstanding.set(entry.nonce, entry);
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
		deps.requestBarrier(origin, table, entry.nonce).then(
			(position) => {
				if (!isValidLogPosition(position)) {
					settleEntry(
						entry,
						unavailable(`${origin} answered the barrier for ${database}.${table} without a usable position`)
					);
					return;
				}
				entry.position = position;
				if (entry.appliedPosition === position) {
					if (poisonedPair(origin, table)) {
						rejected.poisoned = (rejected.poisoned ?? 0) + 1;
						settleEntry(
							entry,
							unavailable(
								`${database}.${table} from ${origin} recorded a replication hole while its barrier was in flight`
							)
						);
						return;
					}
					applied++;
					settleEntry(entry);
				} else if (entry.appliedPosition !== undefined) {
					settleEntry(
						entry,
						unavailable(`${origin} applied a barrier for ${database}.${table} at a different position than it answered`)
					);
				}
			},
			(error) => {
				settleEntry(
					entry,
					unavailable(
						`could not obtain a record lock barrier from ${origin} for ${database}.${table}: ${(error as Error)?.message ?? error}`
					)
				);
			}
		);
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

	return {
		async establish(table, dependencies, deadlineMs) {
			if (closed) throw unavailable(`record lock freshness for ${database} is closed`);
			const homeMap = deps.homeMap();
			if (!homeMap) reject('no-home-map', `no agreed record lock home map for ${database}`);
			if (!deps.tableReplicates(table))
				reject('unreplicated', `${database}.${table} does not replicate, so a cluster lock cannot be made fresh on it`);
			const deadlineMono = deps.monotonicNow() + Math.min(Math.max(deadlineMs, 0), MAX_LOCK_LEASE_MS);
			const self = deps.thisNodeName();
			if (dependencies === null) {
				const members = homeMap.homes.filter((member) => member !== self);
				for (const member of members) checkOrigin(member, table, homeMap);
				const positions = await Promise.all(members.map((member) => awaitBarrier(member, table, deadlineMono)));
				return members.map((member, index) => [member, positions[index]] as const);
			}
			const waits: Promise<number>[] = [];
			for (const [origin, position] of dependencies) {
				if (!isValidLogPosition(position))
					reject('invalid-position', `a record lock dependency on ${origin} names an invalid log position`);
				if (origin === self) {
					// Own history is provable only while the local log is the one that wrote it.
					if (deps.everRecloned())
						reject(
							'recloned',
							`${database} on this node was recloned, so its own earlier record lock lineage cannot be proven`
						);
					continue;
				}
				checkOrigin(origin, table, homeMap);
				waits.push(awaitBarrier(origin, table, deadlineMono));
			}
			await Promise.all(waits);
		},
		noteBarrierApplied(origin, position, nonce) {
			const entry = outstanding.get(nonce);
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
			return { outstanding: outstanding.size, applied, timeouts, rejected: { ...rejected } };
		},
		close() {
			closed = true;
			if (sweep !== undefined) {
				clearTimer(sweep);
				sweep = undefined;
			}
			// Settling deletes from the map, so iterate a snapshot.
			const entries = Array.from(outstanding.values());
			for (const entry of entries)
				settleEntry(
					entry,
					unavailable(`record lock freshness for ${database} was closed while waiting on ${entry.origin}`)
				);
		},
	};
}
