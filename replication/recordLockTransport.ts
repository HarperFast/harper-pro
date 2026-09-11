/**
 * The harper-pro side of cluster-wide record locks (harper-pro#438, W9 Phase 1 of harper#483), for
 * the amortized-ownership protocol in harper `docs/record-lock-ownership.md`.
 *
 * Core owns the coordinator: the home ring, the delegation table, recall-and-drain, fencing tokens,
 * and the one control entry (`lockRelease`) that still rides the table's own transaction log. What
 * core cannot know is topology and the wire, and that is what this module supplies:
 *
 * - `epoch(database)`: the membership a key's home is derived from — every member of the database's
 *   replication group that advertised the delegation level of `recordLocks`, plus this node, sorted.
 *   **This is a STATIC epoch**: number 1, never advanced, not agreed. It is the first of the note's
 *   two steps (§9 "static owner"), and it is enough for the ring to be deterministic and for one
 *   arbiter per key to hold. What it cannot do is the note's §4: advance across a restart so a
 *   previous incarnation's delegations are invalidated outright. Until harper-pro#825 lands the
 *   durable, agreed epoch, that obligation (`ClusterLockTransport.epoch` in core) is met the blunt
 *   way — `epoch()` returns undefined for `DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS` after process
 *   start, so this node grants nothing as a home until anything it granted before could have expired.
 *   That also blocks this node's own locks on keys homed elsewhere for the same window; it is the
 *   cost of a static epoch, and #825 removes it.
 * - `homeIncarnation`: a durable, monotonic counter bumped once per process start and persisted on
 *   this node's own `hdb_nodes` row (`recordLockIncarnation`). Core orders fencing tokens on it, so a
 *   random value would not do (§5.1). Workers read it from the `hdb_nodes` mirror; until the bump has
 *   propagated `epoch()` withholds rather than issue tokens under an incarnation that may not exceed
 *   the previous process's.
 * - `requestDelegation` / `recallDelegation`: unicast operations over the existing replication
 *   connections (`recordLockRpc.ts`).
 * - `ownsCoordination()`: whether this worker thread is the one the main thread assigned to the
 *   database. Coordinator state is per thread while the key lock it arbitrates is process-wide, so
 *   exactly one thread may coordinate, and it must be the thread whose sockets apply the database's
 *   inbound entries — `subscriptionManager` places every (peer, database) subscription on the owner.
 *   Ownership is conferred by message rather than derived from `workerIndex` and moves only when the
 *   owner has exited: a live owner still holds delegations and grants.
 *
 * The capability a peer advertised is kept in the per-(database, peer) shared status buffer so the
 * owner can read it for a peer whose socket lives on another thread, and so a peer that is briefly
 * down does not flip membership.
 *
 * With `replication.recordLocks` off (the default) every replicated database gets a transport that
 * fails closed instead, so a cluster-scoped `lock()` reports the missing enablement rather than
 * quietly arbitrating on this node alone.
 */
import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { getWorkerIndex, onMessageByType, whenThreadsStarted, workers } from '../core/server/threads/manageThreads.js';
import {
	DELEGATION_LEASE_MS,
	LOCK_LEASE_SKEW_MS,
	registerClusterLockTransport,
	unregisterClusterLockTransport,
	type ClusterLockTransport,
	type DelegationRecall,
	type DelegationReply,
	type DelegationRequest,
	type LockEpoch,
} from '../core/resources/recordLockCoordinator.ts';
import { getDatabases } from '../core/resources/databases.ts';
import { server } from '../core/server/Server.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import { getHDBNodeTable, getReplicationSharedStatus } from './knownNodes.ts';
import { isExplicitDatabaseSubscription, isReplicatedDatabase } from './replicatedDatabases.ts';
import { CLUSTER_RECORD_LOCKS_ENABLED } from './recordLockConfig.ts';
import { RECORD_LOCKS_CAPABILITY, advertisedRecordLocksLevel } from './protocolCapabilities.ts';
import {
	DELEGATE_OPERATION,
	RECALL_OPERATION,
	sendRecordLockOperation,
	setRecordLockOwnershipReaders,
} from './recordLockRpc.ts';
import { ensureNode } from './subscriptionManager.ts';

/** The static epoch's number. Never advanced; harper-pro#825 replaces the whole epoch. */
export const STATIC_EPOCH_NUMBER = 1;
/** How long after process start this node withholds its epoch. See the module comment. */
export const RESTART_HOLD_MS = DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS;
/** How long a derived epoch is reused before membership is re-read. */
export const EPOCH_MEMO_MS = 250;
const processStartMono = performance.now();

// Slot 13 of the 16-slot per-(database, peer) status buffer (`getReplicationSharedStatus`); 0..12 are
// taken, 13..15 were documented headroom.
export const RECORD_LOCKS_CAPABILITY_POSITION = 13;
export const LOCK_CAPABILITY_UNKNOWN = 0;
export const LOCK_CAPABILITY_UNSUPPORTED = 1;
export const LOCK_CAPABILITY_SUPPORTED = 2;

/** Record what a peer's own `NODE_NAME` bag said, on whichever thread its socket landed. */
export function recordPeerLockCapability(status: Float64Array, supported: boolean): void {
	status[RECORD_LOCKS_CAPABILITY_POSITION] = supported ? LOCK_CAPABILITY_SUPPORTED : LOCK_CAPABILITY_UNSUPPORTED;
}

export function readPeerLockCapability(status: Float64Array): number {
	const value = status[RECORD_LOCKS_CAPABILITY_POSITION];
	return value === LOCK_CAPABILITY_SUPPORTED || value === LOCK_CAPABILITY_UNSUPPORTED ? value : LOCK_CAPABILITY_UNKNOWN;
}

/**
 * Whether an `hdb_nodes` row can run a lock round for `database`: it replicates at all (a full or
 * directional flag) and is in this database's shard set, or it names the database in an explicit
 * subscription — which `shouldReplicateFromNode` also honors outside every other gate, so it must
 * count here too. Mirrors that predicate's membership half without its direction test.
 */
export function isReplicationGroupMember(
	node: any,
	database: string,
	replicationDatabases: unknown,
	shard: unknown
): boolean {
	const replicates = node?.replicates;
	const replicatesSomething =
		replicates === true ||
		(!!replicates &&
			typeof replicates === 'object' &&
			!!(replicates.sends || replicates.receives || replicates.sendsTo?.length || replicates.receivesFrom?.length));
	return (
		(replicatesSomething && isReplicatedDatabase(replicationDatabases, database, () => node.shard === shard, false)) ||
		isExplicitDatabaseSubscription(node?.subscriptions, database)
	);
}

export interface RecordLockTransportDeps {
	thisNodeName(): string;
	/** The `hdb_nodes` mirror; `server.nodes` in production. */
	nodes(): any[];
	replicationDatabases(): unknown;
	shard(): unknown;
	/** Any table's auditStore for the database, which is what keys the shared status buffers. */
	auditStore(database: string): any;
	ownsDatabase(database: string): boolean;
	/** This node's persisted `recordLockIncarnation`, or 0 while unknown. */
	homeIncarnation(): number;
	/** Whether the bag this node actually sends claims the delegation level. See `advertisedRecordLocksLevel`. */
	advertisesLevel(): boolean;
	/** Monotonic ms since process start; `epoch()` withholds until `restartHoldMs` has elapsed. */
	sinceStartMs(): number;
	restartHoldMs: number;
	send(nodeName: string, database: string, operation: any): Promise<any>;
}

/** FNV-1a over the sorted member list, so two nodes with the same set compute the same ringVersion. */
function ringVersionOf(members: string[]): number {
	let hash = 0x811c9dc5;
	for (const member of members) {
		for (let i = 0; i < member.length; i++) {
			hash ^= member.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		hash ^= 0xff;
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Pure over its dependencies so the epoch derivation is unit-testable without a cluster. */
export function createRecordLockTransport(database: string, deps: RecordLockTransportDeps): ClusterLockTransport {
	// The shared buffer for a (database, peer) is stable for the process, and core reads the epoch
	// fresh on every acquire, so the views are cached rather than re-resolved per call.
	const statusViews = new Map<string, Float64Array>();
	let statusViewsStore: any;
	const statusFor = (auditStore: any, peer: string): Float64Array => {
		if (statusViewsStore !== auditStore) {
			statusViews.clear();
			statusViewsStore = auditStore;
		}
		let status = statusViews.get(peer);
		if (!status) statusViews.set(peer, (status = getReplicationSharedStatus(auditStore, database, peer)));
		return status;
	};
	// core reads the epoch on every acquisition that misses a live delegation; a full hdb_nodes scan,
	// a sort and a hash per call is the hot-path cost the design forbids. The membership is invariant
	// between changes, so the derived epoch is reused for a short window — staleness here only delays
	// how quickly this node notices a ring change, which the static epoch cannot make safe anyway.
	let memo: { at: number; epoch: LockEpoch } | undefined;
	return {
		epoch(): LockEpoch | undefined {
			// A previous incarnation of this process may still have delegations admitting on their
			// holders, and a static epoch cannot invalidate them by advancing. Withhold until they could
			// have expired. harper-pro#825 replaces this with an agreed epoch that does advance.
			const now = deps.sinceStartMs();
			if (now < deps.restartHoldMs) return undefined;
			if (memo && now - memo.at < EPOCH_MEMO_MS) return memo.epoch;
			// A node its peers exclude from their rings must not include itself in its own: it would
			// self-home keys the peers home elsewhere, which is two arbiters for one key.
			if (!deps.advertisesLevel()) return undefined;
			const homeIncarnation = deps.homeIncarnation();
			// Tokens must be orderable across restarts; an incarnation that has not yet been bumped and
			// propagated could sit below the previous process's, so no token is issued under it.
			if (!(homeIncarnation > 0)) return undefined;
			const self = deps.thisNodeName();
			const members = [self];
			const replicationDatabases = deps.replicationDatabases();
			const shard = deps.shard();
			const auditStore = deps.auditStore(database);
			for (const node of deps.nodes()) {
				const name = node?.name;
				if (typeof name !== 'string' || name === self) continue;
				if (!isReplicationGroupMember(node, database, replicationDatabases, shard)) continue;
				// Never learned reads as not a member: the ring fails closed until the peer has said so
				// itself, and a peer at another level is a different arbiter, not a slower one.
				if (!auditStore || readPeerLockCapability(statusFor(auditStore, name)) !== LOCK_CAPABILITY_SUPPORTED) continue;
				members.push(name);
			}
			members.sort();
			const epoch: LockEpoch = {
				number: STATIC_EPOCH_NUMBER,
				members,
				ringVersion: ringVersionOf(members),
				homeIncarnation,
			};
			memo = { at: now, epoch };
			return epoch;
		},
		ownsCoordination(): boolean {
			return deps.ownsDatabase(database);
		},
		requestDelegation(node: string, db: string, table: string, request: DelegationRequest): Promise<DelegationReply> {
			return deps.send(node, db, {
				operation: DELEGATE_OPERATION,
				database: db,
				table,
				key: request.key,
				epoch: request.epoch,
				leaseMs: request.leaseMs,
			});
		},
		async recallDelegation(node: string, db: string, table: string, recall: DelegationRecall): Promise<void> {
			await deps.send(node, db, {
				operation: RECALL_OPERATION,
				database: db,
				table,
				key: recall.key,
				token: recall.token,
			});
		},
	};
}

export const RECORD_LOCKS_DISABLED_MESSAGE =
	"cluster record locks are not enabled on this node (replication.recordLocks); lock with { scope: 'node' } for a node-local lock";

/**
 * Registered while `replication.recordLocks` is off: `ownsCoordination` is true so core reaches the
 * epoch, which refuses — a 503 naming the switch instead of the off-owner retry advice — and a
 * received request or entry finds no epoch, so this node never grants.
 */
export function createDisabledRecordLockTransport(): ClusterLockTransport {
	const disabled = () => Promise.reject(new Error(RECORD_LOCKS_DISABLED_MESSAGE));
	return {
		epoch(): LockEpoch | undefined {
			throw new Error(RECORD_LOCKS_DISABLED_MESSAGE);
		},
		ownsCoordination(): boolean {
			return true;
		},
		requestDelegation: disabled,
		recallDelegation: disabled,
	};
}

// ---- worker side: the databases this thread coordinates, and the registered transports ----------

const ownedDatabases = new Set<string>();
const transports = new Map<string, ClusterLockTransport>();

export function ownsRecordLockCoordination(database: string): boolean {
	return ownedDatabases.has(database);
}

export function setRecordLockOwnership(database: string, owned: boolean): void {
	if (owned) ownedDatabases.add(database);
	else ownedDatabases.delete(database);
	logger.debug?.(`Record lock coordination for ${database} is ${owned ? 'owned' : 'not owned'} by this thread`);
}

function auditStoreFor(database: string): any {
	const tables = getDatabases()[database];
	if (!tables) return undefined;
	for (const tableName in tables) {
		const auditStore = tables[tableName]?.auditStore;
		if (auditStore) return auditStore;
	}
	return undefined;
}

/** Kept for `replicator.ts`, which installs it; the delegation transport no longer reads liveness. */
export function setConnectionDownSinceReader(_reader: (status: Float64Array) => number | undefined): void {}

/**
 * This node's persisted home incarnation, read from its OWN `hdb_nodes` row. Not from `server.nodes`:
 * that mirror deliberately excludes the local node (`knownNodes.ts` filters `getThisNodeName()` out
 * on every path), so a read there is 0 forever and `epoch()` would be withheld for the life of the
 * process. A point read per call until the bump has landed, then cached — the value changes only
 * across process starts.
 */
export function readOwnIncarnation(table: { primaryStore: { getSync(key: string): any } }, self: string): number {
	const value = table.primaryStore.getSync(self)?.recordLockIncarnation;
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
/**
 * The incarnation this thread issues tokens under. On the main thread it is what `bumpHomeIncarnation`
 * persisted; on a worker it is ONLY what main told it (`record-lock-incarnation`), never a read of the
 * table: a worker that read the row before the bump landed would see the previous process's value and
 * mint tokens that compare below that process's — the ordering §5.1 exists to prevent. Until main's
 * message arrives it is 0 and `epoch()` is withheld.
 */
let homeIncarnation = 0;
export function currentHomeIncarnation(): number {
	return homeIncarnation;
}
/** Worker side: adopt the value main persisted. Never moves backwards. */
export function setHomeIncarnation(value: unknown): void {
	if (typeof value === 'number' && Number.isFinite(value) && value > homeIncarnation) homeIncarnation = value;
}

const productionDeps: RecordLockTransportDeps = {
	thisNodeName: getThisNodeName,
	nodes: () => server.nodes ?? [],
	replicationDatabases: () => env.get(CONFIG_PARAMS.REPLICATION_DATABASES),
	shard: () => env.get(CONFIG_PARAMS.REPLICATION_SHARD),
	auditStore: auditStoreFor,
	ownsDatabase: ownsRecordLockCoordination,
	homeIncarnation: currentHomeIncarnation,
	advertisesLevel: () =>
		advertisedRecordLocksLevel(
			CLUSTER_RECORD_LOCKS_ENABLED,
			process.env.HARPER_TEST_OMIT_REPLICATION_CAPABILITIES === '1'
		) === RECORD_LOCKS_CAPABILITY,
	sinceStartMs: () => performance.now() - processStartMono,
	// Tests lift the hold: a cluster suite cannot wait six minutes after start, and what the hold
	// protects — a previous incarnation's delegations — does not exist for a freshly created node.
	restartHoldMs: Number.isFinite(Number(process.env.HARPER_TEST_RECORD_LOCK_RESTART_HOLD_MS))
		? Number(process.env.HARPER_TEST_RECORD_LOCK_RESTART_HOLD_MS)
		: RESTART_HOLD_MS,
	send: sendRecordLockOperation,
};

/**
 * Main thread, once per process start: bump this node's durable home incarnation so every fencing
 * token this process issues orders after every token the previous one did. Merged into the own
 * `hdb_nodes` row (`ensureNode` patches), so nothing else on the row is touched.
 */
export async function bumpHomeIncarnation(): Promise<number> {
	const self = getThisNodeName();
	const table = getHDBNodeTable();
	// A node that has never joined a mesh has no row of its own (add_node and the config routes are
	// what write it). A url-less row that replicated would be one peers try to dial, so the counter
	// goes on a LOCAL_ONLY self row instead: invisible to peers, and merged into the real row when
	// add_node later patches it. Without this a lone node with the feature on would fail every
	// cluster lock closed for the life of the process.
	const existing = table.primaryStore.getSync(self);
	const previous = readOwnIncarnation(table, self);
	const next = previous + 1;
	await ensureNode(self, { recordLockIncarnation: next }, existing ? undefined : { localOnly: true });
	setHomeIncarnation(next);
	for (const worker of httpWorkers()) confer(worker, 'record-lock-incarnation', next);
	logger.info?.(`Record lock home incarnation for ${self} is now ${next}`);
	return next;
}

/**
 * Register this thread's transport for a replicated database (idempotent; core recreates the
 * coordinator whenever the transport object changes, so the instance must be stable) and, when
 * enabled, ask the main thread which worker coordinates it.
 */
export function ensureRecordLockTransport(database: string): void {
	if (transports.has(database)) return;
	const transport = CLUSTER_RECORD_LOCKS_ENABLED
		? createRecordLockTransport(database, productionDeps)
		: createDisabledRecordLockTransport();
	transports.set(database, transport);
	registerClusterLockTransport(database, transport);
	if (!CLUSTER_RECORD_LOCKS_ENABLED) return;
	if (parentPort) {
		parentPort.postMessage({ type: 'record-lock-owner-request', database });
		// A worker that registers after main's bump would otherwise never learn the incarnation.
		if (homeIncarnation === 0) parentPort.postMessage({ type: 'record-lock-incarnation-request' });
	} else whenThreadsStarted.then(() => recordLockOwnerFor(database));
}

/** The database is no longer replicated here. Cluster scope keeps failing closed (core's rule). */
export function releaseRecordLockTransport(database: string): void {
	if (!transports.delete(database)) return;
	unregisterClusterLockTransport(database);
	ownedDatabases.delete(database);
	if (!parentPort) releaseRecordLockOwner(database);
}

export interface RecordLockDatabaseStats {
	/** Delegations this node holds as a delegate. */
	delegations: number;
	/** Delegations this node has issued as a home. */
	granted: number;
	/** Live admissions across its delegations. */
	admitted: number;
	droppedOffOwner: number;
	/** The epoch's member set as this thread sees it, or undefined while the epoch is withheld. */
	members?: string[];
}

/** Summed `LockCoordinator.stats` over the database's tables on this thread. */
export function localRecordLockStats(database: string): RecordLockDatabaseStats | undefined {
	const tables = getDatabases()[database];
	if (!tables) return undefined;
	const total: RecordLockDatabaseStats = { delegations: 0, granted: 0, admitted: 0, droppedOffOwner: 0 };
	for (const tableName in tables) {
		let stats: RecordLockDatabaseStats | undefined;
		try {
			stats = tables[tableName]?.lockCoordinator?.stats;
		} catch {
			// The getter fails closed on an unusable node identity; status reporting must not.
		}
		if (!stats) continue;
		total.delegations += stats.delegations;
		total.granted += stats.granted;
		total.admitted += stats.admitted;
		total.droppedOffOwner += stats.droppedOffOwner;
	}
	try {
		total.members = transports.get(database)?.epoch(database)?.members;
	} catch {
		// The disabled transport throws here by design; status reporting must not.
	}
	return total;
}

if (parentPort) {
	onMessageByType('record-lock-owner', (message) => setRecordLockOwnership(message.database, message.owned === true));
	onMessageByType('record-lock-incarnation', (message) => setHomeIncarnation(message.value));
	onMessageByType('record-lock-status-request', (message) => {
		const status: Record<string, RecordLockDatabaseStats | undefined> = {};
		for (const database of message.databases ?? []) status[database] = localRecordLockStats(database);
		parentPort.postMessage({ type: 'record-lock-status', requestId: message.requestId, status });
	});
}

// ---- main side: one owner worker per database ------------------------------------------------------

const MAIN_OWNER = Symbol('main thread owns record lock coordination');
const recordLockOwners = new Map<string, any>();
let nextOwnerIndex = 0;

function httpWorkers(): any[] {
	return workers.filter((worker: any) => worker.name === 'http');
}

function confer(worker: any, database: string, owned: boolean): void;
function confer(worker: any, type: 'record-lock-incarnation', value: number): void;
function confer(worker: any, databaseOrType: string, ownedOrValue: boolean | number): void {
	if (databaseOrType === 'record-lock-incarnation') {
		if (worker === MAIN_OWNER) return;
		try {
			worker.postMessage({ type: 'record-lock-incarnation', value: ownedOrValue });
		} catch (error) {
			logger.debug?.('Could not post the record lock incarnation to a worker', error);
		}
		return;
	}
	const database = databaseOrType;
	const owned = ownedOrValue as boolean;
	if (worker === MAIN_OWNER) {
		setRecordLockOwnership(database, owned);
		return;
	}
	try {
		worker.postMessage({ type: 'record-lock-owner', database, owned });
	} catch (error) {
		// An exited worker: there is nothing left to inform, and its replacement is assigned separately.
		logger.debug?.(`Could not post record lock ownership of ${database} to a worker`, error);
	}
}

const ownersWithExitHandler = new WeakSet<object>();
function watchOwnerExit(worker: any): void {
	if (worker === MAIN_OWNER || ownersWithExitHandler.has(worker)) return;
	ownersWithExitHandler.add(worker);
	worker.once('exit', () => {
		for (const [database, owner] of recordLockOwners) {
			if (owner !== worker) continue;
			recordLockOwners.delete(database);
			// Nobody may be waiting on a subscription for this database (a lone node), so re-assign here
			// rather than only when the subscription manager re-binds the database's subscriptions.
			recordLockOwnerFor(
				database,
				httpWorkers().filter((candidate) => candidate !== worker)
			);
		}
	});
}

/**
 * The worker that coordinates `database`, assigning one only if none is live: an owner is never
 * moved while it runs (see the module comment). Main thread only. Every placement of a (peer,
 * database) subscription must use this so the coordinator's thread is the one applying the
 * database's inbound entries. Returns `undefined` when the main thread itself is the owner, or while
 * no http worker exists and this process is not running its listeners on the main thread.
 */
export function recordLockOwnerFor(database: string, liveWorkers: any[] = httpWorkers()): any {
	if (parentPort) throw new Error('record lock ownership is assigned on the main thread only');
	const current = recordLockOwners.get(database);
	if (current === MAIN_OWNER) return undefined;
	if (current && liveWorkers.includes(current)) return current;
	let owner: any;
	if (liveWorkers.length > 0) {
		nextOwnerIndex %= liveWorkers.length;
		owner = liveWorkers[nextOwnerIndex++];
	} else if (getWorkerIndex() === 0) {
		// Single-threaded mode: the main thread serves requests and holds the subscriptions itself.
		owner = MAIN_OWNER;
	} else {
		return undefined;
	}
	if (current) confer(current, database, false);
	recordLockOwners.set(database, owner);
	confer(owner, database, true);
	watchOwnerExit(owner);
	logger.info?.(
		`Record lock coordination for ${database} assigned to ${owner === MAIN_OWNER ? 'the main thread' : `worker thread ${owner.threadId}`}`
	);
	return owner === MAIN_OWNER ? undefined : owner;
}

export function releaseRecordLockOwner(database: string): void {
	const owner = recordLockOwners.get(database);
	if (!owner) return;
	recordLockOwners.delete(database);
	confer(owner, database, false);
}

/** Thread ids of the current owners, for status reporting. */
export function recordLockOwnerThreadIds(): Record<string, number | 'main'> {
	const result: Record<string, number | 'main'> = {};
	for (const [database, owner] of recordLockOwners) result[database] = owner === MAIN_OWNER ? 'main' : owner.threadId;
	return result;
}

const RECORD_LOCK_STATUS_TIMEOUT_MS = 1000;
let nextStatusRequestId = 1;
const pendingStatusRequests = new Map<number, (status: Record<string, RecordLockDatabaseStats | undefined>) => void>();

export interface RecordLockClusterStatus extends Partial<RecordLockDatabaseStats> {
	ownerThreadId: number | 'main';
}

/**
 * `cluster_status`'s `recordLocks` section: each database's owner with its coordinator counters, and
 * `droppedOffOwner` summed over EVERY http worker — that counter describes entries applied on a
 * non-owner, so reading it from the owner alone would hide exactly the misrouting it reports. Every
 * worker is asked concurrently under one bound so an unresponsive one cannot hang the operation.
 * Main thread only.
 */
export async function collectRecordLockStatus(
	liveWorkers: any[] = httpWorkers()
): Promise<Record<string, RecordLockClusterStatus>> {
	const result: Record<string, RecordLockClusterStatus> = {};
	if (recordLockOwners.size === 0) return result;
	const databases: string[] = [];
	for (const [database, owner] of recordLockOwners) {
		databases.push(database);
		result[database] = { ownerThreadId: owner === MAIN_OWNER ? 'main' : owner.threadId };
		if (owner === MAIN_OWNER) Object.assign(result[database], localRecordLockStats(database));
	}
	const merge = (worker: any, status: Record<string, RecordLockDatabaseStats | undefined>) => {
		for (const database of databases) {
			const stats = status[database];
			if (!stats) continue;
			const entry = result[database];
			if (recordLockOwners.get(database) === worker) {
				entry.delegations = stats.delegations;
				entry.granted = stats.granted;
				entry.admitted = stats.admitted;
				entry.members = stats.members;
			}
			entry.droppedOffOwner = (entry.droppedOffOwner ?? 0) + stats.droppedOffOwner;
		}
	};
	const answers: Promise<void>[] = [];
	for (const worker of liveWorkers) {
		const requestId = nextStatusRequestId++;
		answers.push(
			new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					pendingStatusRequests.delete(requestId);
					resolve();
				}, RECORD_LOCK_STATUS_TIMEOUT_MS).unref();
				pendingStatusRequests.set(requestId, (status) => {
					clearTimeout(timer);
					pendingStatusRequests.delete(requestId);
					merge(worker, status);
					resolve();
				});
				try {
					worker.postMessage({ type: 'record-lock-status-request', requestId, databases });
				} catch {
					clearTimeout(timer);
					pendingStatusRequests.delete(requestId);
					resolve();
				}
			})
		);
	}
	await Promise.all(answers);
	return result;
}

setRecordLockOwnershipReaders({
	ownsDatabase: ownsRecordLockCoordination,
	ownerFor: (database) => {
		const owner = recordLockOwners.get(database);
		return owner === MAIN_OWNER ? undefined : owner;
	},
	mainOwns: (database) => recordLockOwners.get(database) === MAIN_OWNER,
});

if (!parentPort) {
	if (CLUSTER_RECORD_LOCKS_ENABLED)
		whenThreadsStarted.then(() =>
			bumpHomeIncarnation().catch((error) => logger.error?.('Could not bump the record lock home incarnation', error))
		);
	onMessageByType('record-lock-incarnation-request', (_message, worker) => {
		if (worker && homeIncarnation > 0) confer(worker, 'record-lock-incarnation', homeIncarnation);
	});
	onMessageByType('record-lock-owner-request', (message, worker) => {
		if (!worker || typeof message?.database !== 'string') return;
		const owner = recordLockOwnerFor(message.database);
		// The assignment above informs a newly assigned owner; a requester that is already the owner
		// (or is not) is answered here so a request that raced its earlier notice is not left guessing.
		confer(worker, message.database, owner === worker);
	});
	onMessageByType('record-lock-status', (message) => {
		pendingStatusRequests.get(message.requestId)?.(message.status ?? {});
	});
	if (CLUSTER_RECORD_LOCKS_ENABLED)
		whenThreadsStarted.then(() => {
			const count = httpWorkers().length;
			if (count > 1)
				logger.warn?.(
					`replication.recordLocks is enabled with ${count} http worker threads: a cluster-scoped lock() succeeds only on the worker coordinating its database and answers 503 elsewhere (a keep-alive client must reconnect to retry); run one http worker (threads.count: 1) for uniform lock() service`
				);
		});
}
