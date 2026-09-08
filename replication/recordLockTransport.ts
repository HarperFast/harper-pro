/**
 * The harper-pro side of cluster-wide record locks (harper-pro#438, W9 Phase 1 of harper#483).
 *
 * Core owns the Ricart–Agrawala coordinator and both ends of the wire: it writes its control entries
 * to the table's own transaction log, and its replicated-event sink applies a received entry in the
 * same apply loop that commits the data records ahead of it. What core cannot know is topology, and
 * that is all this module supplies:
 *
 * - `participants(database)`: every member of the database's replication group, each with whether
 *   it advertised `recordLocks` — the mixed-version gate. Over-inclusion costs a 423 or a 503;
 *   omission is the two-holder case, so direction (send-only / receive-only) is deliberately ignored.
 * - `ownsCoordination()`: whether this worker thread is the one the main thread assigned to the
 *   database. Coordinator state is per thread while the key lock it arbitrates is process-wide, so
 *   exactly one thread may run rounds, and it must be the thread whose sockets apply the database's
 *   inbound entries — `subscriptionManager` places every (peer, database) subscription on the owner.
 *   Ownership is conferred by message rather than derived from `workerIndex` (an overlapping
 *   replacement worker starts with the index of the worker it replaces) and moves only when the
 *   owner has exited: a live owner may still hold keys, and core's release, expiry and deferred-grant
 *   paths do not consult ownership, so revoking a live owner would leave its holds arbitrated by
 *   nobody while a fresh coordinator granted the same keys.
 *
 * The capability a peer advertised is kept in the per-(database, peer) shared status buffer so the
 * owner can read it for a peer whose socket lives on another thread (an inbound-only peer), and so a
 * peer that is briefly down does not flip `lock()` between 423 and 503.
 *
 * With `replication.recordLocks` off (the default) every replicated database gets a transport that
 * fails closed instead, so a cluster-scoped `lock()` reports the missing enablement rather than
 * quietly arbitrating on this node alone.
 */
import { parentPort } from 'node:worker_threads';
import { getWorkerIndex, onMessageByType, whenThreadsStarted, workers } from '../core/server/threads/manageThreads.js';
import {
	registerClusterLockTransport,
	unregisterClusterLockTransport,
	type ClusterLockTransport,
	type LockParticipant,
} from '../core/resources/recordLockCoordinator.ts';
import { getDatabases } from '../core/resources/databases.ts';
import { server } from '../core/server/Server.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import { getReplicationSharedStatus } from './knownNodes.ts';
import { isExplicitDatabaseSubscription, isReplicatedDatabase } from './replicatedDatabases.ts';
import { CLUSTER_RECORD_LOCKS_ENABLED } from './recordLockConfig.ts';

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
	/** When the outbound link to the peer went down per the W1 truth slots, or undefined while up. */
	downSince(status: Float64Array): number | undefined;
	ownsDatabase(database: string): boolean;
}

/** Pure over its dependencies so the participant derivation is unit-testable without a cluster. */
export function createRecordLockTransport(database: string, deps: RecordLockTransportDeps): ClusterLockTransport {
	// The shared buffer for a (database, peer) is stable for the process, and core reads the grant
	// set fresh on every acquire, so the views are cached rather than re-resolved per call.
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
	return {
		participants(): LockParticipant[] {
			const self = deps.thisNodeName();
			// Core skips this node; listing it keeps a lone node's set non-empty so its rounds complete at
			// once with an empty grant set instead of failing closed on "unknown participant set".
			const participants: LockParticipant[] = [{ nodeId: self, capable: true }];
			const replicationDatabases = deps.replicationDatabases();
			const shard = deps.shard();
			const auditStore = deps.auditStore(database);
			for (const node of deps.nodes()) {
				const name = node?.name;
				if (typeof name !== 'string' || name === self) continue;
				if (!isReplicationGroupMember(node, database, replicationDatabases, shard)) continue;
				const participant: LockParticipant = { nodeId: name, capable: false };
				if (auditStore) {
					const status = statusFor(auditStore, name);
					// Never learned reads as unsupported: the gate fails closed until the peer has said so itself.
					participant.capable = readPeerLockCapability(status) === LOCK_CAPABILITY_SUPPORTED;
					participant.downSince = deps.downSince(status);
				}
				participants.push(participant);
			}
			return participants;
		},
		ownsCoordination(): boolean {
			return deps.ownsDatabase(database);
		},
	};
}

export const RECORD_LOCKS_DISABLED_MESSAGE =
	"cluster record locks are not enabled on this node (replication.recordLocks); lock with { scope: 'node' } for a node-local lock";

/**
 * Registered while `replication.recordLocks` is off: `ownsCoordination` is true so core reaches the
 * participant set, which refuses — a 503 naming the switch instead of the off-owner retry advice —
 * and a received entry is ignored as coming from no known participant, so this node never grants.
 */
export function createDisabledRecordLockTransport(): ClusterLockTransport {
	return {
		participants(): LockParticipant[] {
			throw new Error(RECORD_LOCKS_DISABLED_MESSAGE);
		},
		ownsCoordination(): boolean {
			return true;
		},
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

let downSinceReader: (status: Float64Array) => number | undefined = () => undefined;
/**
 * Installed by `replicator.ts`, which already imports the connection module; importing it here would
 * close a cycle through the connection module's own import of this one.
 */
export function setConnectionDownSinceReader(reader: (status: Float64Array) => number | undefined): void {
	downSinceReader = reader;
}

const productionDeps: RecordLockTransportDeps = {
	thisNodeName: getThisNodeName,
	nodes: () => server.nodes ?? [],
	replicationDatabases: () => env.get(CONFIG_PARAMS.REPLICATION_DATABASES),
	shard: () => env.get(CONFIG_PARAMS.REPLICATION_SHARD),
	auditStore: auditStoreFor,
	downSince: (status) => downSinceReader(status),
	ownsDatabase: ownsRecordLockCoordination,
};

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
	if (parentPort) parentPort.postMessage({ type: 'record-lock-owner-request', database });
	else whenThreadsStarted.then(() => recordLockOwnerFor(database));
}

/** The database is no longer replicated here. Cluster scope keeps failing closed (core's rule). */
export function releaseRecordLockTransport(database: string): void {
	if (!transports.delete(database)) return;
	unregisterClusterLockTransport(database);
	ownedDatabases.delete(database);
	if (!parentPort) releaseRecordLockOwner(database);
}

export interface RecordLockDatabaseStats {
	held: number;
	pending: number;
	deferred: number;
	droppedOffOwner: number;
}

/** Summed `LockCoordinator.stats` over the database's tables on this thread. */
export function localRecordLockStats(database: string): RecordLockDatabaseStats | undefined {
	const tables = getDatabases()[database];
	if (!tables) return undefined;
	const total: RecordLockDatabaseStats = { held: 0, pending: 0, deferred: 0, droppedOffOwner: 0 };
	for (const tableName in tables) {
		let stats: RecordLockDatabaseStats | undefined;
		try {
			stats = tables[tableName]?.lockCoordinator?.stats;
		} catch {
			// The getter fails closed on an unusable node identity; status reporting must not.
		}
		if (!stats) continue;
		total.held += stats.held;
		total.pending += stats.pending;
		total.deferred += stats.deferred;
		total.droppedOffOwner += stats.droppedOffOwner;
	}
	return total;
}

if (parentPort) {
	onMessageByType('record-lock-owner', (message) => setRecordLockOwnership(message.database, message.owned === true));
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

function confer(worker: any, database: string, owned: boolean): void {
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
				entry.held = stats.held;
				entry.pending = stats.pending;
				entry.deferred = stats.deferred;
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

if (!parentPort) {
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
