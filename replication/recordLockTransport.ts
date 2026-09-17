/**
 * The harper-pro side of cluster-wide record locks (harper-pro#438, W9 Phase 1 of harper#483), for
 * the amortized-ownership protocol in harper `docs/record-lock-ownership.md`.
 *
 * Core owns the coordinator: the home ring, the delegation table, recall-and-drain, fencing tokens,
 * and the one control entry (`lockRelease`) that still rides the table's own transaction log. What
 * core cannot know is topology and the wire, and that is what this module supplies:
 *
 * - `homeMap(database)`: the **operator-agreed** `(generation, homes[])` for the database
 *   (harper-pro#825, `replication/recordLockHomes.ts`) — never derived from `hdb_nodes` or
 *   liveness. Returns `undefined` until this node has an active generation, its `homeIncarnation`
 *   is known, or any peer named in `homes[]` advertises a disagreeing digest for it (a mismatch
 *   fails the whole map closed rather than shrinking the ring — see
 *   `replication/RECORD_LOCK_HOMES_DESIGN.md` §4 for why the latter is itself a two-arbiter bug).
 *   A frozen, per-thread cache — never storage I/O, hashing or sorting on the read path — refreshed
 *   only when this node's own durable row changes (`onRecordLockHomesChanged`).
 * - `homeIncarnation`: a durable, monotonic counter bumped once per **coordination incarnation** —
 *   a process start, or a coordinating-worker handoff (`recordLockOwnerFor`, below) — persisted on
 *   this node's own `hdb_nodes` row (`recordLockIncarnation`). Core orders fencing tokens on it.
 * - `requestDelegation` / `recallDelegation`: unicast operations over the existing replication
 *   connections (`recordLockRpc.ts`).
 * - `ownsCoordination()`: whether this worker thread is the one the main thread assigned to the
 *   database. Coordinator state is per thread while the key lock it arbitrates is process-wide, so
 *   exactly one thread may coordinate, and it must be the thread whose sockets apply the database's
 *   inbound entries — `subscriptionManager` places every (peer, database) subscription on the owner.
 *   Ownership is conferred by message rather than derived from `workerIndex` and moves only when the
 *   owner has exited: a live owner still holds delegations and grants.
 *
 * A peer's advertised home-map digest (`RECORD_LOCK_HOMES_DIGEST`, `replicationConnection.ts`) is
 * kept in the per-(database, peer) shared status buffer so the owner can read it for a peer whose
 * socket lives on another thread.
 *
 * With `replication.recordLocks` off (the default) every replicated database gets a transport that
 * fails closed instead, so a cluster-scoped `lock()` reports the missing enablement rather than
 * quietly arbitrating on this node alone.
 */
import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import {
	getWorkerIndex,
	hasThreadExited,
	onMessageByType,
	whenThreadsStarted,
	workers,
} from '../core/server/threads/manageThreads.js';
import {
	fenceRelayedAdmissions,
	registerClusterLockTransport,
	unregisterClusterLockTransport,
	type ClusterLockTransport,
	type DelegationRecall,
	type DelegationReply,
	type DelegationRequest,
	type LockHomeMap,
	type LockRound,
} from '../core/resources/recordLockCoordinator.ts';
import { getDatabases } from '../core/resources/databases.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import { getHDBNodeTable, getReplicationSharedStatus, shouldReplicateFromNode } from './knownNodes.ts';
import { ClientError } from '../core/utility/errors/hdbError.ts';
import { CLUSTER_RECORD_LOCKS_ENABLED } from './recordLockConfig.ts';
import {
	currentRow,
	onRecordLockHomesChanged,
	setHomesDrainReader,
	setHomesMembershipReaders,
	type RecordLockGenerationState,
} from './recordLockHomes.ts';
import {
	BARRIER_OPERATION,
	DELEGATE_OPERATION,
	RECALL_OPERATION,
	acquireOnOwnerRelay,
	clearRelaySessionsForDatabase,
	failRelayAcquiresForDatabase,
	quiesceOnOwner,
	releaseOnOwnerRelay,
	sendRecordLockOperation,
	setRecordLockOwnershipReaders,
} from './recordLockRpc.ts';
import { createFreshnessBarrier, type FreshnessBarrier, type FreshnessStats } from './recordLockFreshness.ts';
import { ANY_TABLE, everRecloned, forgetPoisonState, isPoisoned, poison, poisonedPairs } from './recordLockPoison.ts';
import { getNodeNameForId } from '../core/resources/nodeIdMapping.ts';
import {
	registerReplicatedApplyFailureListener,
	unregisterReplicatedApplyFailureListener,
	type ReplicatedApplyFailureListener,
} from '../core/resources/replicatedApplyFailure.ts';
import { ensureNode } from './subscriptionManager.ts';
import { getRepairConnectionsForDB } from './replicator.ts';
import './recordLockApply.ts';

// Slots 29..31 of the 32-slot per-(database, peer) status buffer (`getReplicationSharedStatus`);
// 0..28 are taken (13..28 by the R4 fire-classification counters, harper-pro#431). 29 is the
// capability support flag; 30 is the home-map digest agreement tri-state; 31 is the exact
// advertised level (below). The buffer is full — grow `REPLICATION_SHARED_STATUS_SLOTS` for the next.
export const RECORD_LOCKS_CAPABILITY_POSITION = 29;
export const LOCK_CAPABILITY_UNKNOWN = 0;
export const LOCK_CAPABILITY_UNSUPPORTED = 1;
export const LOCK_CAPABILITY_SUPPORTED = 2;

export const RECORD_LOCK_HOMES_AGREEMENT_POSITION = 30;
export const HOMES_AGREEMENT_UNKNOWN = 0;
export const HOMES_AGREEMENT_MISMATCH = 1;
export const HOMES_AGREEMENT_MATCH = 2;

/** Record what a peer's own `NODE_NAME` bag said, on whichever thread its socket landed. */
export function recordPeerLockCapability(status: Float64Array, supported: boolean): void {
	status[RECORD_LOCKS_CAPABILITY_POSITION] = supported ? LOCK_CAPABILITY_SUPPORTED : LOCK_CAPABILITY_UNSUPPORTED;
}

export function readPeerLockCapability(status: Float64Array): number {
	const value = status[RECORD_LOCKS_CAPABILITY_POSITION];
	return value === LOCK_CAPABILITY_SUPPORTED || value === LOCK_CAPABILITY_UNSUPPORTED ? value : LOCK_CAPABILITY_UNKNOWN;
}

/**
 * Byte-exact comparison happens on the socket thread that receives the peer's digest
 * (`replicationConnection.ts`); only the tri-state result lands here, never the digest itself.
 */
export function recordPeerHomesAgreement(status: Float64Array, matches: boolean): void {
	status[RECORD_LOCK_HOMES_AGREEMENT_POSITION] = matches ? HOMES_AGREEMENT_MATCH : HOMES_AGREEMENT_MISMATCH;
}

export function readPeerHomesAgreement(status: Float64Array): number {
	const value = status[RECORD_LOCK_HOMES_AGREEMENT_POSITION];
	return value === HOMES_AGREEMENT_MATCH || value === HOMES_AGREEMENT_MISMATCH ? value : HOMES_AGREEMENT_UNKNOWN;
}

/** Slot 31: the peer's exact advertised `recordLocks` level, so a refusal can name it. 0 while unknown. */
export const RECORD_LOCK_LEVEL_POSITION = 31;

export function recordPeerLockLevel(status: Float64Array, level: number): void {
	status[RECORD_LOCK_LEVEL_POSITION] = Number.isSafeInteger(level) && level >= 0 ? level : 0;
}

export function readPeerLockLevel(status: Float64Array): number {
	const value = status[RECORD_LOCK_LEVEL_POSITION];
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// ---- successor-freshness barriers, one per registered database on the coordinating thread --------

const freshnessBarriers = new Map<string, FreshnessBarrier>();

function installFreshnessBarrier(database: string, barrier: FreshnessBarrier): void {
	freshnessBarriers.get(database)?.close();
	freshnessBarriers.set(database, barrier);
}

function closeFreshnessBarrier(database: string): void {
	freshnessBarriers.get(database)?.close();
	freshnessBarriers.delete(database);
}

const applyFailureListeners = new Map<string, ReplicatedApplyFailureListener>();

/**
 * A replicated transaction core skipped after a terminal apply failure is a hole no barrier can see;
 * core awaits this listener before it consumes the next event (harper#2628), so the poison row is
 * durable before any later frame can advance the cursor past the hole.
 */
function listenForApplyFailures(database: string): void {
	if (applyFailureListeners.has(database)) return;
	const listener: ReplicatedApplyFailureListener = async (failure) => {
		const auditStore = auditStoreFor(database);
		const origin = getNodeNameForId(auditStore, failure.nodeId, true) ?? `node#${failure.nodeId}`;
		await poison(
			database,
			origin,
			typeof failure.table === 'string' ? failure.table : ANY_TABLE,
			`terminal apply failure at ${failure.position}: ${(failure.error as Error)?.message ?? failure.error}`
		);
	};
	applyFailureListeners.set(database, listener);
	registerReplicatedApplyFailureListener(database, listener);
}

function stopListeningForApplyFailures(database: string): void {
	const listener = applyFailureListeners.get(database);
	if (!listener) return;
	applyFailureListeners.delete(database);
	unregisterReplicatedApplyFailureListener(database, listener);
}

/**
 * A `lockBarrier` entry committed on this thread (`replicationConnection.ts`, from the frame's
 * onCommit). The waiter lives on the database's coordinating thread; a stream applying elsewhere
 * hands it through main, which knows the owner, on the existing record-lock message path.
 */
export function recordLockBarrierApplied(database: string, origin: string, position: number, nonce: number): void {
	if (ownsRecordLockCoordination(database)) {
		freshnessBarriers.get(database)?.noteBarrierApplied(origin, position, nonce);
		return;
	}
	const message = { type: 'record-lock-barrier-applied', database, origin, position, nonce };
	try {
		if (parentPort) parentPort.postMessage(message);
		else routeBarrierAppliedFromMain(message);
	} catch (error) {
		logger.debug?.('Could not relay an applied record lock barrier', error);
	}
}

function routeBarrierAppliedFromMain(message: any): void {
	const owner = recordLockOwners.get(message.database);
	if (owner === MAIN_OWNER) {
		freshnessBarriers.get(message.database)?.noteBarrierApplied(message.origin, message.position, message.nonce);
		return;
	}
	if (!owner || owner === PENDING_BUMP) return;
	try {
		owner.postMessage(message);
	} catch (error) {
		logger.debug?.('Could not forward an applied record lock barrier to the owner worker', error);
	}
}

export interface RecordLockTransportDeps {
	thisNodeName(): string;
	/** Any table's auditStore for the database, which is what keys the shared status buffers. */
	auditStore(database: string): any;
	ownsDatabase(database: string): boolean;
	/** This node's persisted `recordLockIncarnation`, or 0 while unknown. */
	homeIncarnation(): number;
	send(nodeName: string, database: string, operation: any): Promise<any>;
	/**
	 * Whether this node's `recordLockIncarnation` was 0 (never persisted) the instant BEFORE this
	 * process's own bump — i.e. no previous incarnation of this process could have issued anything, so
	 * core's construction-anchored restart quarantine (`grantableAfterMono`) can be waived. A read of
	 * the pre-bump durable value, not a flag that toggles: this is what makes it correct even when the
	 * transport is constructed before `bumpHomeIncarnation` resolves (`ensureRecordLockTransport` does
	 * not wait for it).
	 */
	isFirstIncarnation(): boolean;
	/** Monotonic ms, for `grantableAfterMono` — the same clock `performance.now()` reads elsewhere. */
	monotonicNow(): number;
	/** The successor-freshness barrier for the database, built over this transport's own `homeMap()`. */
	freshness(database: string, homeMap: () => LockHomeMap | undefined): FreshnessBarrier;
	/** harper-pro#852: obtain an admission from the owner worker for an off-owner `lock()`. */
	acquireOnOwner(database: string, table: string, key: unknown, leaseMs: number, waitMs: number): Promise<LockRound>;
	/** harper-pro#852: release a relayed admission on the owner worker. */
	releaseOnOwner(database: string, table: string, key: unknown, admissionId: number): void;
}

/**
 * Pure over its dependencies and the injected cache reader so `homeMap()` is unit-testable without
 * a cluster or storage. `cacheFor` returns the frozen, already-current active generation for the
 * database — never storage I/O, hashing or sorting; that work happens in `refreshCache`, off the
 * hot path, triggered only by `onRecordLockHomesChanged`.
 */
export function createRecordLockTransport(
	database: string,
	deps: RecordLockTransportDeps,
	cacheFor: () => RecordLockGenerationState | undefined
): ClusterLockTransport {
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
	// Read once, at transport construction, matching when core reads it (`LockCoordinator`'s
	// constructor, once per coordinator build): a fresh node that has never incarnated before has
	// provably granted nothing, so core's construction-anchored restart quarantine
	// (`DELEGATION_LEASE_MS + skew`, several minutes, the default whenever this is omitted) can be
	// waived outright. A genuine restart (a prior incarnation existed) leaves this undefined, so core's
	// own default quarantine applies — that is the correct, safe default core already enforces.
	const grantableAfterMono = deps.isFirstIncarnation() ? deps.monotonicNow() : undefined;
	let freshness: FreshnessBarrier | undefined;
	const transport: ClusterLockTransport = {
		grantableAfterMono,
		establishLockFreshness(db: string, table: string, _key: unknown, dependencies, deadlineMs: number) {
			freshness ??= deps.freshness(db, () => transport.homeMap(db));
			return freshness.establish(table, dependencies, deadlineMs);
		},
		homeMap(): LockHomeMap | undefined {
			const active = cacheFor();
			if (!active) return undefined;
			const homeIncarnation = deps.homeIncarnation();
			if (!(homeIncarnation > 0)) return undefined;
			const self = deps.thisNodeName();
			const auditStore = deps.auditStore(database);
			for (const peer of active.homes) {
				if (peer === self) continue;
				if (!auditStore) return undefined;
				const status = statusFor(auditStore, peer);
				// Digest agreement (the operator-stated topology matches) and wire-protocol capability
				// (the peer can actually speak this level's delegation/recall/lockRelease shape) are
				// independent: a coincidentally-matching digest from a peer at the wrong protocol level
				// is not enough — see `RECORD_LOCKS_CAPABILITY`'s mutual-exclusion comment. Fails closed
				// on `UNKNOWN` for either one too: a peer this node has not yet heard from is exactly as
				// unsafe to treat as agreeing as one that actively disagrees (§4.1: "a digest check is
				// not a freshness check").
				if (readPeerLockCapability(status) !== LOCK_CAPABILITY_SUPPORTED) return undefined;
				if (readPeerHomesAgreement(status) !== HOMES_AGREEMENT_MATCH) return undefined;
			}
			return { generation: active.generation, homes: active.homes, homeIncarnation };
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
				generation: request.generation,
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
		// harper-pro#852: a `lock()` served on a non-owner worker gets its admission from the owner
		// worker over the port mesh. Core installs the returned round as a remote admission and drives
		// the release/revoke through these.
		acquireOnOwner(db: string, table: string, key: unknown, leaseMs: number, waitMs: number): Promise<LockRound> {
			return deps.acquireOnOwner(db, table, key, leaseMs, waitMs);
		},
		releaseOnOwner(db: string, table: string, key: unknown, admissionId: number): void {
			deps.releaseOnOwner(db, table, key, admissionId);
		},
	};
	return transport;
}

export const RECORD_LOCKS_DISABLED_MESSAGE =
	"cluster record locks are not enabled on this node (replication.recordLocks); lock with { scope: 'node' } for a node-local lock";

/**
 * Registered while `replication.recordLocks` is off: `ownsCoordination` is true so core reaches
 * `homeMap()`, which refuses — a 503 naming the switch instead of the off-owner retry advice — and
 * a received request or entry finds no map, so this node never grants.
 */
export function createDisabledRecordLockTransport(): ClusterLockTransport {
	const disabled = () => Promise.reject(new ClientError(RECORD_LOCKS_DISABLED_MESSAGE, 503));
	return {
		homeMap(): LockHomeMap | undefined {
			throw new ClientError(RECORD_LOCKS_DISABLED_MESSAGE, 503);
		},
		ownsCoordination(): boolean {
			return true;
		},
		requestDelegation: disabled,
		recallDelegation: disabled,
		establishLockFreshness: disabled,
	};
}

// ---- per-thread active-generation cache, refreshed only on change --------------------------------

const activeCache = new Map<string, RecordLockGenerationState | undefined>();

function cacheForDatabase(database: string): RecordLockGenerationState | undefined {
	return activeCache.get(database);
}

/** This thread's currently-cached active-generation digest, for the handshake/re-announce send path
 * in `replicationConnection.ts` — never storage I/O; whatever `refreshCache` last populated. */
export function currentHomesDigest(database: string): string | undefined {
	return activeCache.get(database)?.digest;
}

async function refreshCache(database: string): Promise<void> {
	const before = activeCache.get(database);
	try {
		const row = await currentRow(database);
		activeCache.set(database, row?.active);
	} catch (error) {
		// A storage error must not leave a stale (possibly superseded) generation cached; undefined is
		// the fail-closed default `homeMap()` already treats as "not available."
		activeCache.delete(database);
		logger.warn?.(`Could not refresh the record lock home map for ${database}`, error);
	}
	const after = activeCache.get(database);
	// Core's coordinator seeds its restart-quarantine incarination tracking (`#coordinatingIncarnation`)
	// from THIS transport's `homeMap()` return value at the coordinator's own construction instant —
	// and only there; it is never re-seeded later from a homeMap() call that starts succeeding after
	// construction. A coordinator lazily built while this database still had no active generation (the
	// ordinary case — `cluster_status` polling during bootstrap reads `lockCoordinator` well before
	// `bootstrapHomeMap` finishes) gets stuck with that gap for its whole lifetime unless something
	// forces a fresh one. Recreating the transport the instant an active generation first appears (or
	// changes) is what gives core a fresh coordinator to lazily build next, this time with `homeMap()`
	// already answering something real at its construction instant.
	if (before?.generation !== after?.generation) recreateRecordLockTransport(database);
}

/** Leaf bound: main waiting on ONE worker (or a worker waiting on main's own local refresh alone). */
const HOMES_CHANGED_ACK_TIMEOUT_MS = 2_000;
/**
 * The origin-to-main relay additionally waits out main's own local refresh AND its full parallel
 * fan-out to every sibling worker, each individually bounded by `HOMES_CHANGED_ACK_TIMEOUT_MS` — a
 * relay budget equal to that leaf budget can never be met whenever a sibling is slow, which is
 * exactly the case this protocol exists to catch (a real pre-push review finding).
 */
const HOMES_CHANGED_RELAY_TIMEOUT_MS = HOMES_CHANGED_ACK_TIMEOUT_MS + 1_500;
let nextHomesChangedRequestId = 1;
const pendingHomesChangedAcks = new Map<number, (ok: boolean) => void>();

/**
 * Refreshes this thread's own cache and confirms it before returning — the local half of what makes
 * a `stageGeneration`/`activateGeneration` response real quiescence evidence, not a durable write
 * racing an unawaited refresh (a real pre-push review finding).
 */
async function applyHomesChanged(database: string): Promise<void> {
	await refreshCache(database);
	pushHomesDigestToPeers(database);
	reconcileAllPeerHomesAgreement(database);
}

/**
 * Registers a pending ack for `requestId` and returns a promise that resolves once a true ack
 * arrives, and REJECTS on a false ack or on timing out. A stage/activate response is quiescence
 * evidence only if every thread genuinely confirmed — treating a missing ack as success (the
 * previous version) is indistinguishable from the exact failure this protocol exists to catch: a
 * live thread whose event loop is too busy to have applied the change yet, still granting under the
 * old generation (a real pre-push review finding — Adjudicated-Severity: blocker).
 */
function waitForHomesChangedAck(requestId: number, timeoutMs: number, database: string, label: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingHomesChangedAcks.delete(requestId);
			reject(
				new ClientError(
					`Could not confirm ${label} applied the record lock home map change for ${database} within ${timeoutMs}ms`,
					503
				)
			);
		}, timeoutMs).unref();
		pendingHomesChangedAcks.set(requestId, (ok) => {
			clearTimeout(timer);
			pendingHomesChangedAcks.delete(requestId);
			if (ok) resolve();
			else reject(new ClientError(`${label} could not apply the record lock home map change for ${database}`, 503));
		});
	});
}

/**
 * Sends `record-lock-homes-changed` to one worker and waits for its ack, fail-closed. A synchronous
 * `postMessage` throw settles the SAME pending-ack entry `waitForHomesChangedAck` already armed
 * (rather than deleting it and manufacturing a second, unrelated rejection) — the entry's resolver is
 * what clears its timer; abandoning it left that timer's own rejection unhandled ~`timeoutMs` later,
 * which Node's default policy turns into a process crash (a real pre-push review finding).
 */
function sendHomesChangedAndWaitAck(worker: any, database: string): Promise<void> {
	const requestId = nextHomesChangedRequestId++;
	const wait = waitForHomesChangedAck(requestId, HOMES_CHANGED_ACK_TIMEOUT_MS, database, 'a worker');
	try {
		worker.postMessage({ type: 'record-lock-homes-changed', database, requestId });
	} catch (error) {
		logger.debug?.(`Could not notify a worker of a record lock home map change for ${database}`, error);
		pendingHomesChangedAcks.get(requestId)?.(false);
	}
	return wait;
}

/** Main thread: relay to every (non-excluded) worker and wait for all of them, bounded per worker. */
async function broadcastHomesChangedAndWait(database: string, exclude?: any): Promise<void> {
	await Promise.all(
		httpWorkers()
			.filter((worker) => worker !== exclude)
			.map((worker) => sendHomesChangedAndWaitAck(worker, database))
	);
}

onRecordLockHomesChanged(async (database) => {
	await applyHomesChanged(database);
	if (parentPort) {
		// Ask main to relay and wait for it to confirm every thread (including main's own state and
		// every sibling worker) has refreshed — fail-closed and on a budget that can outlast main's own
		// fan-out (see `HOMES_CHANGED_RELAY_TIMEOUT_MS`).
		const requestId = nextHomesChangedRequestId++;
		const wait = waitForHomesChangedAck(requestId, HOMES_CHANGED_RELAY_TIMEOUT_MS, database, 'main');
		try {
			parentPort!.postMessage({ type: 'record-lock-homes-changed', database, requestId });
		} catch (error) {
			// Settle the already-armed entry rather than abandon it — see `sendHomesChangedAndWaitAck`.
			logger.debug?.(`Could not notify main of a record lock home map change for ${database}`, error);
			pendingHomesChangedAcks.get(requestId)?.(false);
		}
		await wait;
	} else {
		await broadcastHomesChangedAndWait(database);
	}
});

/** Re-announces this node's new digest on every live outbound connection for the database — an
 * already-connected peer otherwise never sees an activation (§6: the digest is sent at handshake
 * only, not pushed automatically). Best-effort: a peer this reaches later (reconnect, or its own
 * digest receipt) still converges via the ordinary handshake path. */
function pushHomesDigestToPeers(database: string): void {
	for (const connection of getRepairConnectionsForDB(database)) {
		try {
			connection.liveSession?.sendRecordLockHomesDigest?.();
		} catch (error) {
			logger.debug?.(`Could not re-announce the record lock home map digest to ${connection.nodeName}`, error);
		}
	}
}

// ---- peer home-map digest agreement: reconciled centrally, independent of which connection object
// (inbound or outbound — the mesh keeps separate ones per direction, each with its own local state)
// last received a peer's digest or last carried our own send. Keyed by database, not by connection,
// which is what makes "our own digest changed" able to re-evaluate every peer it has ever heard from,
// not just the one connection object that happens to fire next. --------------------------------------

const lastPeerDigest = new Map<string, Map<string, string>>(); // database -> peer -> digest

/** Called from `replicationConnection.ts` on receiving a peer's `RECORD_LOCK_HOMES_DIGEST` frame,
 * regardless of which connection (inbound or outbound) received it. */
export function recordPeerHomesDigest(database: string, peer: string, digest: string): void {
	let perDatabase = lastPeerDigest.get(database);
	if (!perDatabase) lastPeerDigest.set(database, (perDatabase = new Map()));
	perDatabase.set(peer, digest);
	reconcilePeerHomesAgreement(database, peer);
}

function reconcilePeerHomesAgreement(database: string, peer: string): void {
	const theirs = lastPeerDigest.get(database)?.get(peer);
	if (theirs === undefined) return; // nothing heard from this peer yet; leave the buffer's UNKNOWN default
	const auditStore = auditStoreFor(database);
	if (!auditStore) return;
	const ours = currentHomesDigest(database);
	recordPeerHomesAgreement(
		getReplicationSharedStatus(auditStore, database, peer),
		ours !== undefined && ours === theirs
	);
}

/** Our own digest just changed (a fresh activation): every peer we have EVER heard a digest from for
 * this database needs its agreement re-derived against the new value — a peer's own digest frame
 * arriving before ours was ready is exactly the common case (they can activate before us), and
 * without this it would stay wrongly recorded as a mismatch forever, since nothing else re-checks it. */
function reconcileAllPeerHomesAgreement(database: string): void {
	const perDatabase = lastPeerDigest.get(database);
	if (!perDatabase) return;
	for (const peer of perDatabase.keys()) reconcilePeerHomesAgreement(database, peer);
}

// ---- worker side: the databases this thread coordinates, and the registered transports ----------

const ownedDatabases = new Set<string>();
const transports = new Map<string, ClusterLockTransport>();
/**
 * The thread that coordinates each database, as this thread last learned it from main (harper-pro#852).
 * Read by `recordLockRpc.ts` (through the ownership readers) to send a relayed acquire straight to the
 * owner worker. Updated by the `record-lock-owner-thread` broadcast; absent means "owner unknown here",
 * which fails a relayed `lock()` closed until the broadcast arrives.
 */
const ownerThreadByDatabase = new Map<string, number>();

/** Fail-closed fence for every relayed handle this thread holds for a database whose coordinating
 * thread just changed (its old owner exited). Runs across the database's tables, drops the caller's
 * cached owner sessions, and fails any in-flight acquire sent to the departed owner so `lock()` retries
 * against the successor instead of waiting out its whole timeout. */
function fenceRelayedAdmissionsForDatabase(database: string): void {
	const tables = getDatabases()[database];
	// Guard each table: resolving a table's lock coordinator can throw (an unusable node identity, or the
	// disabled transport, which throws by design), and one throw must not abort the loop and leave the
	// remaining tables' relayed handles live — nor escape a fence-ack path or an exit callback.
	if (tables)
		for (const tableName in tables) {
			try {
				fenceRelayedAdmissions(database, tableName);
			} catch (error) {
				logger.warn?.(`Could not fence relayed record locks for ${database}.${tableName}`, error);
			}
		}
	clearRelaySessionsForDatabase(database);
	failRelayAcquiresForDatabase(database);
}

/**
 * Record the coordinating thread this thread now sees for a database, fencing every relayed handle it
 * holds if the thread MOVED (harper-pro#852). Shared by the worker broadcast handler and main's own
 * `broadcastOwnerThread`, so a `lock()` served on main is fenced on an owner change exactly as one on a
 * worker is — main is a serving thread for relayed locks too. A first assignment (no previous owner)
 * grants nothing to fence.
 */
function updateOwnerThread(database: string, next: number | undefined): void {
	const previous = ownerThreadByDatabase.get(database);
	if (next === undefined) ownerThreadByDatabase.delete(database);
	else ownerThreadByDatabase.set(database, next);
	if (previous !== undefined && previous !== next) fenceRelayedAdmissionsForDatabase(database);
}

export function ownsRecordLockCoordination(database: string): boolean {
	return ownedDatabases.has(database);
}

export function setRecordLockOwnership(database: string, owned: boolean): void {
	const wasOwned = ownedDatabases.has(database);
	if (owned) ownedDatabases.add(database);
	else ownedDatabases.delete(database);
	logger.debug?.(`Record lock coordination for ${database} is ${owned ? 'owned' : 'not owned'} by this thread`);
	// Core's coordinator anchors its restart-quarantine waiver (`grantableAfterMono`) at CONSTRUCTION,
	// and only keeps it if this thread already owned coordination at that instant — "a coordinator
	// that has coordinated since it was built never reaches [the reset]; every other way of arriving
	// at ownership" loses the waiver (`recordLockCoordinator.ts#ownershipHorizon`). Ownership is
	// conferred over an async message round trip (`record-lock-owner-request`/`-owner`), strictly
	// after `ensureRecordLockTransport` first registers the transport, so the FIRST-built coordinator
	// (however it gets built — including lazily, off a `cluster_status` poll's `lockCoordinator`
	// getter, which can easily race ahead of that round trip) almost never sees ownership already
	// true. Rebuilding the transport object the instant ownership newly arrives is what gives core a
	// fresh coordinator to build, this time with `ownsCoordination()` already true from its first
	// instant — matching the one case that keeps the waiver.
	if (owned && !wasOwned) recreateRecordLockTransport(database);
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
 * on every path), so a read there is 0 forever and `homeMap()` would be withheld for the life of the
 * process. A point read per call until the bump has landed, then cached — the value changes only
 * across a coordination incarnation.
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
 * message arrives it is 0 and `homeMap()` is withheld.
 */
let homeIncarnation = 0;
export function currentHomeIncarnation(): number {
	return homeIncarnation;
}
/**
 * Whether the FIRST incarnation this thread ever learns of is incarnation 1 — i.e. no previous
 * process incarnated on this node at all, so core's construction-anchored restart quarantine
 * (`grantableAfterMono`) can be waived. Known only once the first `setHomeIncarnation` call lands;
 * `undefined` until then, which `createRecordLockTransport` treats as "not provably first" (the safe
 * default — core's own quarantine applies). Set exactly once: a later, genuine handoff incarnation is
 * never the first, so nothing resets it.
 */
let firstIncarnation: boolean | undefined;
export function isFirstIncarnation(): boolean {
	return firstIncarnation === true;
}
/**
 * Adopt the incarnation main persisted (never backwards). `first` is whether THIS incarnation is the
 * node's first-ever — it decides core's restart-quarantine waiver (`grantableAfterMono`). It starts
 * `true` only on a genuinely fresh node's incarnation 1 and MUST clear on the first handoff bump
 * (`first=false`, `bumpHomeIncarnation`): a handoff means this node has already been an owner and has
 * live relayed handles out, so a successor coordinator built with the waiver would grant a key straight
 * away while a departed worker's handle can still commit (harper-pro#852). Any change re-registers every
 * built transport, because `grantableAfterMono` is read once at coordinator construction, not per call.
 */
export function setHomeIncarnation(value: unknown, first?: boolean): void {
	if (!(typeof value === 'number' && Number.isFinite(value) && value > homeIncarnation)) return;
	homeIncarnation = value;
	// Transition undefined→true (fresh node) or true→false (a handoff bump revokes the waiver). Never
	// false→true: once cleared, a later bump cannot make this incarnation first-ever again.
	if (typeof first === 'boolean' && firstIncarnation !== false && firstIncarnation !== first) {
		firstIncarnation = first;
		for (const database of transports.keys()) recreateRecordLockTransport(database);
	}
}

const productionDeps: RecordLockTransportDeps = {
	thisNodeName: getThisNodeName,
	auditStore: auditStoreFor,
	ownsDatabase: ownsRecordLockCoordination,
	homeIncarnation: currentHomeIncarnation,
	send: sendRecordLockOperation,
	isFirstIncarnation,
	monotonicNow: () => performance.now(),
	acquireOnOwner: acquireOnOwnerRelay,
	releaseOnOwner: releaseOnOwnerRelay,
	freshness(database, homeMap) {
		const barrier = createFreshnessBarrier(database, {
			thisNodeName: getThisNodeName,
			homeMap,
			peerLevel: (peer) => {
				const auditStore = auditStoreFor(database);
				return auditStore ? readPeerLockLevel(getReplicationSharedStatus(auditStore, database, peer)) : 0;
			},
			tableReplicates: (table) => tableReplicates(database, table),
			isPoisoned: (origin, table) => isPoisoned(database, origin, table),
			everRecloned: () => everRecloned(database),
			async requestBarrier(origin, table, nonce) {
				const reply = await sendRecordLockOperation(origin, database, {
					operation: BARRIER_OPERATION,
					database,
					table,
					nonce,
				});
				return reply?.position;
			},
			monotonicNow: () => performance.now(),
		});
		installFreshnessBarrier(database, barrier);
		return barrier;
	},
};

/**
 * Main thread: bump this node's durable home incarnation so every fencing token this coordination
 * incarnation issues orders after every token the previous one did (§5.1) — once per process start,
 * and again on a genuine coordinating-worker handoff (`recordLockOwnerFor`, below), never only once
 * per process. Serialized behind `bumpInFlight` so concurrent reassignments across databases cannot
 * race the read-increment-write.
 */
let bumpInFlight: Promise<number> | undefined;
export async function bumpHomeIncarnation(): Promise<number> {
	if (bumpInFlight) return bumpInFlight;
	const run = (async () => {
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
		const first = previous === 0;
		await ensureNode(self, { recordLockIncarnation: next }, existing ? undefined : { localOnly: true });
		setHomeIncarnation(next, first);
		for (const worker of httpWorkers()) confer(worker, 'record-lock-incarnation', next, first);
		logger.info?.(`Record lock home incarnation for ${self} is now ${next}`);
		return next;
	})();
	bumpInFlight = run;
	try {
		return await run;
	} finally {
		if (bumpInFlight === run) bumpInFlight = undefined;
	}
}

/**
 * Register this thread's transport for a replicated database (idempotent; core recreates the
 * coordinator whenever the transport object changes, so the instance must be stable) and, when
 * enabled, ask the main thread which worker coordinates it.
 */
export function ensureRecordLockTransport(database: string): void {
	if (transports.has(database)) return;
	const transport = CLUSTER_RECORD_LOCKS_ENABLED
		? createRecordLockTransport(database, productionDeps, () => cacheForDatabase(database))
		: createDisabledRecordLockTransport();
	transports.set(database, transport);
	registerClusterLockTransport(database, transport);
	if (!CLUSTER_RECORD_LOCKS_ENABLED) return;
	listenForApplyFailures(database);
	refreshCache(database);
	if (parentPort) {
		parentPort.postMessage({ type: 'record-lock-owner-request', database });
		// harper-pro#852: learn which thread owns it, so a relayed acquire can reach the owner. A worker
		// that registers after the owner was assigned would otherwise never hear the assignment broadcast.
		parentPort.postMessage({ type: 'record-lock-owner-thread-request', database });
		// A worker that registers after main's bump would otherwise never learn the incarnation.
		if (homeIncarnation === 0) parentPort.postMessage({ type: 'record-lock-incarnation-request' });
	} else whenThreadsStarted.then(() => recordLockOwnerFor(database));
}

/** Rebuilds an already-registered database's transport so core rebuilds its coordinator and re-reads
 * `grantableAfterMono` — needed because that field is read once at construction, and this thread's
 * `isFirstIncarnation()` answer can resolve after the transport was first built (`setHomeIncarnation`
 * calls this once, the moment it learns the answer). Ownership/cache wiring is unaffected: only the
 * transport OBJECT is replaced, not this thread's owned/cache state. */
function recreateRecordLockTransport(database: string): void {
	if (!CLUSTER_RECORD_LOCKS_ENABLED || !transports.has(database)) return;
	// The old transport's waits belong to a coordinator core is about to rebuild; settle them now.
	closeFreshnessBarrier(database);
	const transport = createRecordLockTransport(database, productionDeps, () => cacheForDatabase(database));
	transports.set(database, transport);
	registerClusterLockTransport(database, transport);
}

/** The database is no longer replicated here. Cluster scope keeps failing closed (core's rule). */
export function releaseRecordLockTransport(database: string): void {
	if (!transports.delete(database)) return;
	unregisterClusterLockTransport(database);
	closeFreshnessBarrier(database);
	stopListeningForApplyFailures(database);
	forgetPoisonState(database);
	ownedDatabases.delete(database);
	activeCache.delete(database);
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
	/** Admissions this thread obtained from the owner worker for an off-owner `lock()` (harper-pro#852). */
	relayedAdmissions: number;
	/** The home map's member set as this thread sees it, or undefined while the map is withheld. */
	members?: string[];
	/** Successor-freshness barrier counters, from the coordinating thread only. */
	freshness?: FreshnessStats;
	/** `origin:table` pairs with a recorded replication hole; cluster locks fail closed on them. */
	poisoned?: string[];
	/**
	 * Milliseconds until every coordinator on the coordinating thread can prove a drain (core's
	 * `unprovenOwnershipMs`), 0 once it can; absent while the database has no coordinator to attest from.
	 */
	unprovenMs?: number;
}

/** Summed `LockCoordinator.stats` over the database's tables on this thread. */
export function localRecordLockStats(database: string): RecordLockDatabaseStats | undefined {
	const tables = getDatabases()[database];
	if (!tables) return undefined;
	const total: RecordLockDatabaseStats = {
		delegations: 0,
		granted: 0,
		admitted: 0,
		droppedOffOwner: 0,
		relayedAdmissions: 0,
	};
	for (const tableName in tables) {
		let stats: (RecordLockDatabaseStats & { relayedAdmissions?: number }) | undefined;
		let unproven: number | undefined;
		try {
			const coordinator = tables[tableName]?.lockCoordinator;
			stats = coordinator?.stats;
			unproven = coordinator?.unprovenOwnershipMs?.();
		} catch {
			// The getter fails closed on an unusable node identity; status reporting must not.
		}
		if (typeof unproven === 'number') total.unprovenMs = Math.max(total.unprovenMs ?? 0, unproven);
		if (!stats) continue;
		total.delegations += stats.delegations;
		total.granted += stats.granted;
		total.admitted += stats.admitted;
		total.droppedOffOwner += stats.droppedOffOwner;
		total.relayedAdmissions += stats.relayedAdmissions ?? 0;
	}
	try {
		total.members = transports.get(database)?.homeMap(database)?.homes;
		total.freshness = freshnessBarriers.get(database)?.stats();
		try {
			total.poisoned = poisonedPairs(database);
		} catch {
			// A store that cannot be read is reported as nothing rather than failing status.
		}
	} catch {
		// The disabled transport throws here by design; status reporting must not.
	}
	return total;
}

if (parentPort) {
	onMessageByType('record-lock-owner', (message) => setRecordLockOwnership(message.database, message.owned === true));
	// harper-pro#852: main tells this worker which thread coordinates a database, so a relayed acquire
	// can reach the owner directly. `undefined` clears it (no owner, or owner in an in-flight handoff).
	onMessageByType('record-lock-owner-thread', (message) => {
		if (typeof message?.database !== 'string') return;
		updateOwnerThread(message.database, typeof message.threadId === 'number' ? message.threadId : undefined);
		// A requestId means main is waiting for this worker to confirm it has fenced its relayed handles
		// before it lets the successor grant (harper-pro#852). The fence ran synchronously above, so ack now.
		if (message.requestId !== undefined) {
			try {
				parentPort!.postMessage({ type: 'record-lock-owner-thread-ack', requestId: message.requestId });
			} catch (error) {
				logger.debug?.('Could not ack a record lock owner-thread fence to main', error);
			}
		}
	});
	onMessageByType('record-lock-incarnation', (message) => setHomeIncarnation(message.value, message.first));
	onMessageByType('record-lock-homes-changed', (message) => {
		const ack = (ok: boolean) => {
			try {
				parentPort!.postMessage({ type: 'record-lock-homes-changed-ack', requestId: message.requestId, ok });
			} catch (error) {
				logger.debug?.('Could not ack a record lock home map change to main', error);
			}
		};
		applyHomesChanged(message.database).then(
			() => ack(true),
			(error) => {
				logger.warn?.(`Could not apply a record lock home map change for ${message.database}`, error);
				ack(false);
			}
		);
	});
	onMessageByType('record-lock-homes-changed-ack', (message) => {
		pendingHomesChangedAcks.get(message.requestId)?.(message.ok === true);
	});
	onMessageByType('record-lock-barrier-applied', (message) => {
		freshnessBarriers.get(message.database)?.noteBarrierApplied(message.origin, message.position, message.nonce);
	});
	onMessageByType('record-lock-status-request', (message) => {
		const status: Record<string, RecordLockDatabaseStats | undefined> = {};
		for (const database of message.databases ?? []) status[database] = localRecordLockStats(database);
		parentPort.postMessage({ type: 'record-lock-status', requestId: message.requestId, status });
	});
}

// ---- main side: one owner worker per database ------------------------------------------------------

const MAIN_OWNER = Symbol('main thread owns record lock coordination');
/** A database whose owner-handoff incarnation bump has not yet persisted: reported unowned to every
 * caller (`ownsRecordLockCoordination`'s main-side equivalent, `recordLockOwnerFor`'s own callers)
 * rather than assigning a live owner that could grant under a stale incarnation (§5.1). */
const PENDING_BUMP = Symbol('an owner-handoff incarnation bump is in flight');
const recordLockOwners = new Map<string, any>();
/** Every database that has ever had a live owner in this process, for the life of the process —
 * NOT cleared when ownership transiently drops (a failed bump, a release). A failed handoff bump
 * must not make the next attempt look like a first assignment: the previous owner could still have
 * granted under the current (unbumped) incarnation, so the next one still needs a fresh bump before
 * its delegation counter restarts at zero under that same incarnation (§5.1) — the actual danger is
 * "was a worker ever conferred ownership under this incarnation," not "is one live right now." */
const everHadOwner = new Set<string>();
let nextOwnerIndex = 0;

function httpWorkers(): any[] {
	return workers.filter((worker: any) => worker.name === 'http');
}

function confer(worker: any, database: string, owned: boolean): void;
function confer(worker: any, type: 'record-lock-incarnation', value: number, first: boolean): void;
function confer(worker: any, databaseOrType: string, ownedOrValue: boolean | number, first?: boolean): void {
	if (databaseOrType === 'record-lock-incarnation') {
		if (worker === MAIN_OWNER) return;
		try {
			worker.postMessage({ type: 'record-lock-incarnation', value: ownedOrValue, first });
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
			// Tell every worker the owner is gone NOW, before the successor is assigned and can grant, so a
			// surviving relayed handle for this database is fenced fail-closed ahead of any new grant rather
			// than only after the reassignment broadcast lands (harper-pro#852).
			broadcastOwnerThread(database);
			// Nobody may be waiting on a subscription for this database (a lone node), so re-assign here
			// rather than only when the subscription manager re-binds the database's subscriptions.
			recordLockOwnerFor(
				database,
				httpWorkers().filter((candidate) => candidate !== worker)
			);
		}
	});
}

function assignOwner(database: string, owner: any): void {
	recordLockOwners.set(database, owner);
	everHadOwner.add(database);
	confer(owner, database, true);
	watchOwnerExit(owner);
	broadcastOwnerThread(database);
	logger.info?.(
		`Record lock coordination for ${database} assigned to ${owner === MAIN_OWNER ? 'the main thread' : `worker thread ${owner.threadId}`}`
	);
}

/**
 * Tell every http worker which thread coordinates `database` (harper-pro#852), so a `lock()` served
 * on a non-owner worker can send its acquire straight to the owner over the port mesh rather than
 * hopping through main. A PENDING_BUMP or absent owner clears the mapping — a worker with no owner
 * fails a cluster `lock()` closed (503) and retries once the owner is assigned, the same shape as
 * before any owner exists. Main only.
 */
function broadcastOwnerThread(database: string): void {
	const owner = recordLockOwners.get(database);
	const threadId =
		owner === undefined || owner === PENDING_BUMP ? undefined : owner === MAIN_OWNER ? 0 : owner.threadId;
	for (const worker of httpWorkers()) {
		try {
			worker.postMessage({ type: 'record-lock-owner-thread', database, threadId });
		} catch (error) {
			logger.debug?.(`Could not post record lock owner thread of ${database} to a worker`, error);
		}
	}
	// Main serves relayed locks too (single-thread mode, or an operation accepted on main), so update its
	// own view through the same path — fencing any relayed handle main holds when the owner changed.
	updateOwnerThread(database, threadId);
}

/**
 * How long to wait for a LIVE worker to confirm it fenced before declaring it wedged and FAILING the
 * handoff (harper-pro#852). This is deliberately not a "proceed anyway" timeout: proceeding while a
 * worker's relayed handle is still committable is the exact two-writer this gate exists to prevent, and
 * a worker that has not acked has not fenced. A busy worker acks in milliseconds; one that cannot ack
 * within this window is wedged (the stuck-worker monitor will restart it, whose exit resolves the wait
 * below), so failing the handoff and leaving the database unowned until then is the fail-closed choice.
 */
const OWNER_FENCE_ACK_TIMEOUT_MS = 10_000;
let nextOwnerFenceId = 1;
const pendingOwnerFenceAcks = new Map<number, () => void>();

/**
 * Tell every LIVE http worker the database is now ownerless and WAIT for each to confirm it has fenced
 * the relayed handles it held, before the successor is assigned. Resolves once every worker has acked
 * OR exited; REJECTS if a live worker fails to ack within the timeout (handoff fails, database stays
 * unowned and fail-closed). The caller passes the already-filtered live set (the just-exited owner
 * excluded) — recomputing it here could include the departed owner, whose `exit` has already fired and
 * whose closed port neither throws on post nor fires `exit` again, stalling the wait to its timeout.
 *
 * A worker that EXITS is resolved as fenced even though an in-flight async write it submitted could
 * still land. What makes that safe is the process-wide native key lock, NOT the successor's restart
 * quarantine — the argument and its one residual window are at the `onExit` handler below, and in
 * `replication/DESIGN.md`. Main fences its own relayed handles synchronously first. Main thread only.
 */
function broadcastOwnerlessAndWait(database: string, workers: any[] = httpWorkers()): Promise<void> {
	updateOwnerThread(database, undefined);
	if (workers.length === 0) return Promise.resolve();
	return Promise.all(
		workers.map(
			(worker) =>
				new Promise<void>((resolve, reject) => {
					const requestId = nextOwnerFenceId++;
					let settled = false;
					const done = (settle: () => void) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						worker.removeListener?.('exit', onExit);
						pendingOwnerFenceAcks.delete(requestId);
						settle();
					};
					// A worker that exits before acking counts as fenced; a live worker that never acks is
					// wedged, so that rejects and the handoff fails closed.
					//
					// What makes the exit case safe is NOT the coordinator's restart quarantine: that is
					// read only where this node is the key's home, so a peer-homed key renews straight back
					// to this node and never consults it. It is the native key lock, which `lock()` takes
					// before the cluster admission and which is process-wide. Both the departed worker and
					// any new caller admitted afterwards are on THIS node, and they cannot both hold the
					// native key for one key, so a second writer cannot start while the first still holds it.
					// The residual window is narrower than a protocol gap: the departed worker's native
					// handle would have to disappear on thread teardown while a commit it already handed to
					// the storage engine is still in flight. That is a rocksdb-js teardown question
					// (rocksdb-js#865), not something this handoff can close.
					const onExit = () => done(resolve);
					const timer = setTimeout(
						() => done(() => reject(new Error(`worker did not confirm record lock fencing for ${database}`))),
						OWNER_FENCE_ACK_TIMEOUT_MS
					).unref();
					worker.once?.('exit', onExit);
					pendingOwnerFenceAcks.set(requestId, () => done(resolve));
					try {
						worker.postMessage({ type: 'record-lock-owner-thread', database, threadId: undefined, requestId });
					} catch {
						// The port is already gone: the worker exited, so its handles are fenced by definition.
						done(resolve);
					}
				})
		)
	).then(() => undefined);
}

/**
 * The worker that coordinates `database`, assigning one only if none is live: an owner is never
 * moved while it runs (see the module comment). Every placement of a (peer, database) subscription
 * must use this so the coordinator's thread is the one applying the database's inbound entries.
 * Returns `undefined` when the main thread itself is the owner, while no owner is live yet, or
 * while a handoff's incarnation bump has not yet persisted (§5.1) — treated identically by every
 * caller: "not currently owned," never "assign one now" (only this function does that). Main
 * thread only.
 *
 * A genuine handoff — a new owner replacing a previously-live one for this database, not the first
 * assignment — cannot confer ownership synchronously: the incarnation bump must durably persist
 * FIRST, or a replacement coordinator could grant under a stale incarnation and re-mint a token its
 * predecessor already issued. The database is reported unowned (`PENDING_BUMP`) for the duration;
 * every caller already tolerates a transiently-unowned database (a relay answers `not-home`, a
 * cluster lock answers 503) exactly as it does before any owner has ever been assigned. The first
 * assignment has no such race (nothing was live before, so no stale incarnation to re-mint against)
 * and stays synchronous, matching this function's historical contract.
 */
export function recordLockOwnerFor(
	database: string,
	liveWorkers: any[] = httpWorkers(),
	bump: () => Promise<number> = bumpHomeIncarnation
): any {
	if (parentPort) throw new Error('record lock ownership is assigned on the main thread only');
	const current = recordLockOwners.get(database);
	if (current === MAIN_OWNER) return undefined;
	if (current === PENDING_BUMP) return undefined; // a handoff is already in flight; do not start a second
	if (current && liveWorkers.includes(current)) return current;
	const hadPriorOwner = everHadOwner.has(database);
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
	if (!hadPriorOwner) {
		assignOwner(database, owner);
		return owner === MAIN_OWNER ? undefined : owner;
	}
	recordLockOwners.set(database, PENDING_BUMP);
	// Before the successor may grant, BOTH must complete: the incarnation bump (so it cannot re-mint a
	// token) AND every surviving worker confirming it has fenced the departed owner's relayed handles (so
	// none can overlap the successor's first grant). Run them concurrently — the bump is a durable write,
	// the fence-ack is fast — and assign only once both resolve (harper-pro#852).
	Promise.all([bump(), broadcastOwnerlessAndWait(database, liveWorkers)])
		.then(() => {
			// Superseded while the fence/bump was in flight (another reassignment, a release) — abandon.
			if (recordLockOwners.get(database) !== PENDING_BUMP) return;
			// The successor was chosen before a wait that runs as long as OWNER_FENCE_ACK_TIMEOUT_MS and
			// that treats a worker's own exit as a completed fence, so it can resolve on the successor
			// dying. Conferring then would point every relayed `lock()` at a dead thread with no exit
			// handler left to clear the entry — `watchOwnerExit` only attaches inside `assignOwner`, past
			// the point the exit could still fire. Fail closed into the retry below instead.
			if (owner !== MAIN_OWNER && hasThreadExited(owner.threadId))
				throw new Error(`the successor worker exited during the record lock fence wait for ${database}`);
			assignOwner(database, owner);
		})
		.catch((error) => {
			// The bump failed to persist, a live worker did not confirm it fenced its relayed handles, or
			// the successor itself exited. Either way, leave the database unowned (fail closed — a cluster
			// lock 503s) rather than confer ownership while a stale incarnation, an unfenced handle or a
			// dead thread could take it. Retry shortly: a wedged or restarting worker will be back by then,
			// and a wedged one's exit resolves the fence.
			if (recordLockOwners.get(database) === PENDING_BUMP) recordLockOwners.delete(database);
			logger.warn?.(`Deferring record lock owner reassignment for ${database}`, error);
			setTimeout(() => {
				if (!recordLockOwners.has(database) && everHadOwner.has(database)) recordLockOwnerFor(database);
			}, OWNER_FENCE_ACK_TIMEOUT_MS).unref();
		});
	return undefined;
}

export function releaseRecordLockOwner(database: string): void {
	const owner = recordLockOwners.get(database);
	if (!owner) return;
	recordLockOwners.delete(database);
	// A release racing an in-flight handoff bump: deleting the entry (rather than leaving
	// PENDING_BUMP) is what makes the bump's own completion check see itself superseded and abandon.
	if (owner === PENDING_BUMP) return;
	confer(owner, database, false);
	broadcastOwnerThread(database);
}

/** Thread ids of the current owners, for status reporting. */
export function recordLockOwnerThreadIds(): Record<string, number | 'main'> {
	const result: Record<string, number | 'main'> = {};
	for (const [database, owner] of recordLockOwners) {
		if (owner === PENDING_BUMP) continue;
		result[database] = owner === MAIN_OWNER ? 'main' : owner.threadId;
	}
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
		if (owner === PENDING_BUMP) continue;
		databases.push(database);
		result[database] = { ownerThreadId: owner === MAIN_OWNER ? 'main' : owner.threadId };
		if (owner === MAIN_OWNER) Object.assign(result[database], localRecordLockStats(database));
		else {
			// Main is not the owner, but it serves operations — and an operation that calls `lock()`
			// relays from main to the owner worker (harper-pro#852). Count main's own relayed admissions
			// (and any off-owner applies) so a lock served on main is visible, not silently dropped.
			const mainStats = localRecordLockStats(database);
			if (mainStats) {
				result[database].relayedAdmissions = mainStats.relayedAdmissions;
				result[database].droppedOffOwner = mainStats.droppedOffOwner;
			}
		}
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
				entry.freshness = stats.freshness;
				entry.poisoned = stats.poisoned;
				entry.unprovenMs = stats.unprovenMs;
			}
			entry.droppedOffOwner = (entry.droppedOffOwner ?? 0) + stats.droppedOffOwner;
			// Summed over EVERY worker: a relayed admission is minted on the owner but its COUNT lives on
			// the non-owner worker that obtained it (harper-pro#852), so the owner alone would report zero.
			entry.relayedAdmissions = (entry.relayedAdmissions ?? 0) + (stats.relayedAdmissions ?? 0);
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

setHomesDrainReader((database, deadlineMs) => quiesceOnOwner(database, deadlineMs));

setHomesMembershipReaders({
	thisNodeName: getThisNodeName,
	replicatingPeers(database) {
		const self = getThisNodeName();
		const peers: string[] = [];
		for (const node of getHDBNodeTable().search([])) {
			if (!node?.name || node.name === self) continue;
			if (shouldReplicateFromNode(node as any, database)) peers.push(node.name);
		}
		return peers;
	},
});

setRecordLockOwnershipReaders({
	ownsDatabase: ownsRecordLockCoordination,
	ownerFor: (database) => {
		const owner = recordLockOwners.get(database);
		return owner === MAIN_OWNER || owner === PENDING_BUMP ? undefined : owner;
	},
	mainOwns: (database) => recordLockOwners.get(database) === MAIN_OWNER,
	ownerThreadId: (database) => ownerThreadByDatabase.get(database),
	isMember: (database, node) => transports.get(database)?.homeMap(database)?.homes.includes(node) === true,
	peerLevel: (database, node) => {
		const auditStore = auditStoreFor(database);
		return auditStore ? readPeerLockLevel(getReplicationSharedStatus(auditStore, database, node)) : 0;
	},
	tableReplicates: (database, table) => tableReplicates(database, table),
});

function tableReplicates(database: string, table: string): boolean {
	const definition = getDatabases()[database]?.[table];
	return definition !== undefined && definition.replicate !== false;
}

if (!parentPort) {
	if (CLUSTER_RECORD_LOCKS_ENABLED)
		whenThreadsStarted.then(() =>
			bumpHomeIncarnation().catch((error) => logger.error?.('Could not bump the record lock home incarnation', error))
		);
	onMessageByType('record-lock-incarnation-request', (_message, worker) => {
		if (worker && homeIncarnation > 0) confer(worker, 'record-lock-incarnation', homeIncarnation, isFirstIncarnation());
	});
	onMessageByType('record-lock-owner-request', (message, worker) => {
		if (!worker || typeof message?.database !== 'string') return;
		const owner = recordLockOwnerFor(message.database);
		// The assignment above informs a newly assigned owner; a requester that is already the owner
		// (or is not) is answered here so a request that raced its earlier notice is not left guessing.
		confer(worker, message.database, owner === worker);
	});
	onMessageByType('record-lock-owner-thread-request', (message, worker) => {
		if (!worker || typeof message?.database !== 'string') return;
		// Answer with the CURRENT owner thread (do not assign one — `record-lock-owner-request` does that).
		const owner = recordLockOwners.get(message.database);
		const threadId =
			owner === undefined || owner === PENDING_BUMP ? undefined : owner === MAIN_OWNER ? 0 : owner.threadId;
		try {
			worker.postMessage({ type: 'record-lock-owner-thread', database: message.database, threadId });
		} catch (error) {
			logger.debug?.(`Could not answer a record lock owner-thread request for ${message.database}`, error);
		}
	});
	onMessageByType('record-lock-owner-thread-ack', (message) => {
		pendingOwnerFenceAcks.get(message.requestId)?.();
	});
	onMessageByType('record-lock-status', (message) => {
		pendingStatusRequests.get(message.requestId)?.(message.status ?? {});
	});
	onMessageByType('record-lock-barrier-applied', (message) => {
		if (typeof message?.database !== 'string' || typeof message?.origin !== 'string') return;
		routeBarrierAppliedFromMain(message);
	});
	onMessageByType('record-lock-homes-changed', (message, worker) => {
		if (typeof message?.database !== 'string') return;
		const ack = (ok: boolean) => {
			try {
				worker?.postMessage({ type: 'record-lock-homes-changed-ack', requestId: message.requestId, ok });
			} catch (error) {
				logger.debug?.('Could not ack a record lock home map change to the originating worker', error);
			}
		};
		// A worker's own write: refresh main's own state (harmless when main isn't coordinating; load-
		// bearing in single-threaded mode) and relay to every OTHER worker, waiting for all of them
		// before acking the originator — so the originating worker's own await (above) only resolves
		// once main and every sibling worker have genuinely confirmed, not merely been notified. Main's
		// own refresh failing must skip the fan-out and ack false, not paper over it (a real pre-push
		// review finding).
		applyHomesChanged(message.database)
			.then(() => broadcastHomesChangedAndWait(message.database, worker))
			.then(
				() => ack(true),
				(error) => {
					logger.warn?.(
						`Could not confirm every thread refreshed the record lock home map for ${message.database}`,
						error
					);
					ack(false);
				}
			);
	});
	onMessageByType('record-lock-homes-changed-ack', (message) => {
		pendingHomesChangedAcks.get(message.requestId)?.(message.ok === true);
	});
	if (CLUSTER_RECORD_LOCKS_ENABLED)
		whenThreadsStarted.then(() => {
			// Operator-visible at the point the switch takes effect, not only in repo design docs —
			// a real pre-push review finding: enabling this without a startup warning lets an operator
			// follow the runbook straight into a primitive that silently loses updates until harper#2542.
			logger.warn?.(
				'replication.recordLocks is enabled: a cross-node delegation handoff currently guarantees exclusive admission but NOT successor freshness (harper#2542 is outstanding) — two nodes can each read the same predecessor value and both write, silently losing one update, measured at 0.05-0.15% of sections under contention (replication/RECORD_LOCK_COST_DELEGATIONS.md). Do not rely on lock() to protect a read-modify-write across nodes until that lands.'
			);
			// harper-pro#852 removed the former "run one http worker" warning: a cluster-scoped lock() now
			// works uniformly on every http worker, the off-owner ones relaying their admission to the
			// coordinating worker. `cluster_status.recordLocks[db].relayedAdmissions` reports that relay.
		});
}
