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
import { getWorkerIndex, onMessageByType, whenThreadsStarted, workers } from '../core/server/threads/manageThreads.js';
import {
	registerClusterLockTransport,
	unregisterClusterLockTransport,
	type ClusterLockTransport,
	type DelegationRecall,
	type DelegationReply,
	type DelegationRequest,
	type LockHomeMap,
} from '../core/resources/recordLockCoordinator.ts';
import { getDatabases } from '../core/resources/databases.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import { getHDBNodeTable, getReplicationSharedStatus } from './knownNodes.ts';
import { ClientError } from '../core/utility/errors/hdbError.ts';
import { CLUSTER_RECORD_LOCKS_ENABLED } from './recordLockConfig.ts';
import { currentRow, onRecordLockHomesChanged, type RecordLockGenerationState } from './recordLockHomes.ts';
import {
	DELEGATE_OPERATION,
	RECALL_OPERATION,
	sendRecordLockOperation,
	setRecordLockOwnershipReaders,
} from './recordLockRpc.ts';
import { ensureNode } from './subscriptionManager.ts';
import { getRepairConnectionsForDB } from './replicator.ts';

// Slots 29 and 30 of the 32-slot per-(database, peer) status buffer (`getReplicationSharedStatus`);
// 0..28 are taken (13..28 by the R4 fire-classification counters, harper-pro#431). 29 is the
// capability level flag; 30 is the home-map digest agreement tri-state. 31 remains headroom.
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
	return {
		grantableAfterMono,
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
	};
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

/** Sends `record-lock-homes-changed` to one worker and waits for its ack, fail-closed. */
function sendHomesChangedAndWaitAck(worker: any, database: string): Promise<void> {
	const requestId = nextHomesChangedRequestId++;
	const wait = waitForHomesChangedAck(requestId, HOMES_CHANGED_ACK_TIMEOUT_MS, database, 'a worker');
	try {
		worker.postMessage({ type: 'record-lock-homes-changed', database, requestId });
	} catch (error) {
		pendingHomesChangedAcks.delete(requestId);
		logger.debug?.(`Could not notify a worker of a record lock home map change for ${database}`, error);
		return Promise.reject(
			new ClientError(`Could not notify a worker of a record lock home map change for ${database}`, 503)
		);
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
			pendingHomesChangedAcks.delete(requestId);
			logger.debug?.(`Could not notify main of a record lock home map change for ${database}`, error);
			throw new ClientError(`Could not notify main of a record lock home map change for ${database}`, 503);
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
 * Worker side: adopt the value main persisted. Never moves backwards. `first` is threaded alongside
 * the very first call only — later calls (a genuine handoff) do not change `firstIncarnation`, since
 * only the thread's FIRST-EVER known incarnation can be a first-ever process incarnation.
 * Re-registers every already-constructed transport once `firstIncarnation` transitions from unknown
 * to known, since `grantableAfterMono` is read once at coordinator construction (`recordLockCoordinator.ts`),
 * not re-read per call — a transport built before this resolved would otherwise carry a stale, overly
 * conservative `undefined` for the rest of the process.
 */
export function setHomeIncarnation(value: unknown, first?: boolean): void {
	if (!(typeof value === 'number' && Number.isFinite(value) && value > homeIncarnation)) return;
	homeIncarnation = value;
	if (firstIncarnation === undefined && typeof first === 'boolean') {
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
	refreshCache(database);
	if (parentPort) {
		parentPort.postMessage({ type: 'record-lock-owner-request', database });
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
	const transport = createRecordLockTransport(database, productionDeps, () => cacheForDatabase(database));
	transports.set(database, transport);
	registerClusterLockTransport(database, transport);
}

/** The database is no longer replicated here. Cluster scope keeps failing closed (core's rule). */
export function releaseRecordLockTransport(database: string): void {
	if (!transports.delete(database)) return;
	unregisterClusterLockTransport(database);
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
	/** The home map's member set as this thread sees it, or undefined while the map is withheld. */
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
		total.members = transports.get(database)?.homeMap(database)?.homes;
	} catch {
		// The disabled transport throws here by design; status reporting must not.
	}
	return total;
}

if (parentPort) {
	onMessageByType('record-lock-owner', (message) => setRecordLockOwnership(message.database, message.owned === true));
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
	logger.info?.(
		`Record lock coordination for ${database} assigned to ${owner === MAIN_OWNER ? 'the main thread' : `worker thread ${owner.threadId}`}`
	);
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
	bump()
		.then(() => {
			// Superseded while the bump was in flight (another reassignment, a release) — abandon.
			if (recordLockOwners.get(database) !== PENDING_BUMP) return;
			assignOwner(database, owner);
		})
		.catch((error) => {
			// Persistence failure: leave the database unowned rather than confer ownership under a
			// stale incarnation. The next caller (a retry, or the next reconcile pass) tries again.
			if (recordLockOwners.get(database) === PENDING_BUMP) recordLockOwners.delete(database);
			logger.error?.(`Could not bump the record lock home incarnation before reassigning ${database}`, error);
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
		return owner === MAIN_OWNER || owner === PENDING_BUMP ? undefined : owner;
	},
	mainOwns: (database) => recordLockOwners.get(database) === MAIN_OWNER,
});

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
	onMessageByType('record-lock-status', (message) => {
		pendingStatusRequests.get(message.requestId)?.(message.status ?? {});
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
			const count = httpWorkers().length;
			if (count > 1)
				logger.warn?.(
					`replication.recordLocks is enabled with ${count} http worker threads: a cluster-scoped lock() succeeds only on the worker coordinating its database and answers 503 elsewhere (a keep-alive client must reconnect to retry); run one http worker (threads.count: 1) for uniform lock() service`
				);
		});
}
