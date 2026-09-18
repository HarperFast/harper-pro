/**
 * The wire for record lock delegations (harper `docs/record-lock-ownership.md` §3, §11): unicast
 * request/grant/recall between a delegate and a key's home, carried as two registered operations
 * over the replication connections that already exist.
 *
 * Send side. A request goes over the live outbound subscription session to the home when this
 * worker has one — its inbound end on the home is placed on the home's coordinating worker by
 * `subscriptionManager`, so the request lands exactly where the coordinator lives — and otherwise
 * over a fresh operation connection (`sendOperationToNode`), which any of the home's workers may
 * accept.
 *
 * Receive side. An operation arrives on whichever thread holds the socket. If that thread owns the
 * database's coordination it answers directly; otherwise it relays through the main thread, which
 * knows the owner, and waits for the owner's answer under a bound. A relay that times out is
 * answered `not-home`, which the requester treats as retryable inside its own timeout and never as a
 * grant.
 *
 * The requester's identity is the authenticated node principal of the connection the request came
 * in on — never a field of the payload. A caller that is not a known node gets 403: these operations
 * exist for peers, and a human with `super_user` must not be able to mint or clear a delegation.
 */
import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { onMessageByType, onThreadExit, sendToThread } from '../core/server/threads/manageThreads.js';
import { server } from '../core/server/Server.ts';
import { ClientError } from '../core/utility/errors/hdbError.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import {
	acquireForRelay,
	deliverDelegationRecall,
	deliverDelegationRequest,
	quiesceDelegations,
	releaseForRelay,
	revokeRelayedAdmission,
	writeLockBarrier,
	type DelegationRecall,
	type DelegationReply,
	type DelegationRequest,
	type LockRound,
} from '../core/resources/recordLockCoordinator.ts';
import { getRepairConnectionsForDB, sendOperationToNode } from './replicator.ts';
import { RECORD_LOCKS_CAPABILITY } from './protocolCapabilities.ts';
import { MAX_OUTSTANDING_BARRIERS } from './recordLockFreshness.ts';
import type { TransitionOperation } from './recordLockApply.ts';

export const DELEGATE_OPERATION = 'record_lock_delegate';
export const RECALL_OPERATION = 'record_lock_recall';
export const BARRIER_OPERATION = 'record_lock_barrier';

/** Bound on a relay through the main thread to the owner worker. */
const RELAY_TIMEOUT_MS = 5_000;
const NOT_HOME: DelegationReply = { granted: false, reason: 'not-home' };
const RECALLED = Object.freeze({ recalled: true as const });
/**
 * A barrier is a replicated write a peer can make this node perform, so each caller gets a token
 * bucket per database. One barrier is written per WAIT — nothing is merged across callers, since a
 * caller matches the entry on its own nonce — so the burst is sized at exactly what one honest peer
 * can have in flight for a database at all: its own `MAX_OUTSTANDING_BARRIERS` client-side cap. Below
 * that a legitimate wave of concurrent cold handoffs would be refused by this node's rate bound
 * rather than by the peer's own, turning otherwise-valid locks into 503s; above it the bound would
 * stop describing anything. The refill is the sustained ceiling, far above the cold-handoff rate the
 * measured protocol can drive (`RECORD_LOCK_COST_DELEGATIONS.md`) and far below what would let one
 * member turn a request loop into cluster-wide log and apply work.
 */
export const BARRIER_RATE_PER_SECOND = 2_000;
export const BARRIER_BURST = MAX_OUTSTANDING_BARRIERS;

// ---- ownership readers, installed by recordLockTransport.ts so this module never imports it -----

interface OwnershipReaders {
	ownsDatabase(database: string): boolean;
	/** Main thread only: the owner worker for a database, `undefined` when the main thread is the owner. */
	ownerFor(database: string): any;
	/** Main thread only: whether the main thread itself owns the database. */
	mainOwns(database: string): boolean;
	/** The thread id of the worker that coordinates `database`, or undefined when not yet known here. */
	ownerThreadId?(database: string): number | undefined;
	/** Whether `node` is in the database's current agreed home map, at this node's own level. */
	isMember?(database: string, node: string): boolean;
	/** The peer's exact advertised `recordLocks` level, 0 while unknown. */
	peerLevel?(database: string, node: string): number;
	tableReplicates?(database: string, table: string): boolean;
}
let ownership: OwnershipReaders = {
	ownsDatabase: () => false,
	ownerFor: () => undefined,
	mainOwns: () => false,
};
export function setRecordLockOwnershipReaders(readers: OwnershipReaders): void {
	ownership = readers;
}

// ---- send side ---------------------------------------------------------------------------------

export interface DelegateOperation {
	operation: typeof DELEGATE_OPERATION;
	database: string;
	table: string;
	key: unknown;
	generation: number;
	leaseMs: number;
}

export interface RecallOperation {
	operation: typeof RECALL_OPERATION;
	database: string;
	table: string;
	key: unknown;
	token: DelegationRecall['token'];
}

export interface BarrierOperation {
	operation: typeof BARRIER_OPERATION;
	database: string;
	table: string;
	nonce: number;
}

/**
 * Send a lock operation to `nodeName`, preferring this worker's live outbound subscription session
 * for the database. The `sendOperationToNode` fallback opens a connection per call; it exists so a
 * directional topology (a home this node only receives from) still works, not as the fast path.
 */
export async function sendRecordLockOperation(
	nodeName: string,
	database: string,
	operation: DelegateOperation | RecallOperation | BarrierOperation | TransitionOperation,
	timeoutMs?: number
): Promise<any> {
	for (const connection of getRepairConnectionsForDB(database)) {
		if (connection.nodeName !== nodeName) continue;
		const session = connection.liveSession;
		if (session?.sendOperation) return session.sendOperation({ ...operation }, timeoutMs);
	}
	const node = (server.nodes ?? []).find((candidate: any) => candidate?.name === nodeName);
	if (!node?.url) throw new Error(`no connection or hdb_nodes row for ${nodeName}`);
	return sendOperationToNode(node, { ...operation }, timeoutMs === undefined ? undefined : { timeoutMs });
}

// ---- receive side ------------------------------------------------------------------------------

export function principalNodeName(request: any): string | undefined {
	// `hdb_user` is the principal the connection's authentication resolved and the operation
	// dispatcher attached. Nothing else on the request is trusted for identity: a body field such as
	// `user` is caller-supplied and would let anyone name a known node and mint or clear delegations.
	const name = request?.hdb_user?.name;
	if (typeof name !== 'string' || name.length === 0) return undefined;
	// The principal must be a node this node knows, not merely a user whose name looks like one.
	return (server.nodes ?? []).some((node: any) => node?.name === name) ? name : undefined;
}

async function executeDelegate(request: any): Promise<DelegationReply> {
	const requester = principalNodeName(request);
	if (!requester) throw new ClientError('record lock delegation requests are accepted from cluster nodes only', 403);
	if (typeof request.database !== 'string' || typeof request.table !== 'string')
		throw new ClientError('database and table are required', 400);
	const delegation: DelegationRequest = {
		key: request.key,
		requester,
		generation: request.generation,
		leaseMs: request.leaseMs,
	};
	if (ownership.ownsDatabase(request.database))
		return deliverDelegationRequest(request.database, request.table, delegation);
	return relay('delegate', request.database, request.table, delegation);
}

async function executeRecall(request: any): Promise<{ recalled: true }> {
	const from = principalNodeName(request);
	if (!from) throw new ClientError('record lock recalls are accepted from cluster nodes only', 403);
	if (typeof request.database !== 'string' || typeof request.table !== 'string')
		throw new ClientError('database and table are required', 400);
	if (!Array.isArray(request.token) || request.token.length !== 3) throw new ClientError('token is required', 400);
	const recall: DelegationRecall = { key: request.key, token: request.token };
	if (ownership.ownsDatabase(request.database)) {
		await deliverDelegationRecall(request.database, request.table, recall);
		return { recalled: true };
	}
	// A relay that timed out or failed on the owner did NOT drain the delegate; answering success
	// would let the home believe it had. Core's re-grant is gated on the replicated release entry,
	// not on this ack, so the failure costs the home a retry rather than exclusion — but it must be a
	// failure.
	const answer = await relay('recall', request.database, request.table, recall);
	// Structural, not identity: a relayed reply crosses postMessage and is a structured clone.
	if (answer?.recalled !== true)
		throw new ClientError('record lock recall did not reach the coordinating worker in time', 503);
	return RECALLED;
}

// ---- the recovery / freshness fence: a lockBarrier written on request -------------------------

const barrierBuckets = new Map<string, { tokens: number; refilledAt: number }>();

function admitBarrierRequest(caller: string, database: string, now = Date.now()): boolean {
	const key = JSON.stringify([caller, database]);
	let bucket = barrierBuckets.get(key);
	if (!bucket) barrierBuckets.set(key, (bucket = { tokens: BARRIER_BURST, refilledAt: now }));
	const refill = ((now - bucket.refilledAt) / 1_000) * BARRIER_RATE_PER_SECOND;
	if (refill > 0) {
		bucket.tokens = Math.min(BARRIER_BURST, bucket.tokens + refill);
		bucket.refilledAt = now;
	}
	if (bucket.tokens < 1) return false;
	bucket.tokens -= 1;
	return true;
}

/**
 * Every check runs before any state is touched or a write is made: a departed-but-known node, or one
 * at another level, must not be able to make this node commit replicated entries. One entry per
 * request, never merged across callers — a caller matches the entry on its own nonce, so a shared
 * write would answer one of them with an entry that never carries its nonce.
 */
async function executeBarrier(request: any): Promise<{ position: number }> {
	const caller = principalNodeName(request);
	if (!caller) throw new ClientError('record lock barriers are written for cluster nodes only', 403);
	if (typeof request.database !== 'string' || typeof request.table !== 'string')
		throw new ClientError('database and table are required', 400);
	if (!ownership.isMember?.(request.database, caller))
		throw new ClientError(`${caller} is not a member of the record lock home map for ${request.database}`, 403);
	if (ownership.peerLevel?.(request.database, caller) !== RECORD_LOCKS_CAPABILITY)
		throw new ClientError(`${caller} does not advertise record lock capability level ${RECORD_LOCKS_CAPABILITY}`, 403);
	if (!ownership.tableReplicates?.(request.database, request.table))
		throw new ClientError(`${request.database}.${request.table} does not replicate`, 400);
	if (!Number.isSafeInteger(request.nonce) || request.nonce < 0)
		throw new ClientError('a barrier nonce must be a non-negative integer', 400);
	if (!admitBarrierRequest(caller, request.database))
		throw new ClientError(`too many record lock barrier requests from ${caller} for ${request.database}`, 429);
	const position = await writeLockBarrier(request.database, request.table, request.nonce);
	return { position };
}

// ---- relay through the main thread to the owner worker -----------------------------------------

type RelayKind = 'delegate' | 'recall' | 'quiesce';
let nextRelayId = 1;
const pendingRelays = new Map<number, (reply: any) => void>();

function awaitRelay(requestId: number, fallback: any): Promise<any> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			pendingRelays.delete(requestId);
			resolve(fallback);
		}, RELAY_TIMEOUT_MS).unref();
		pendingRelays.set(requestId, (reply) => {
			clearTimeout(timer);
			pendingRelays.delete(requestId);
			resolve(reply);
		});
	});
}

async function relay(kind: RelayKind, database: string, table: string, payload: unknown): Promise<any> {
	const fallback = kind === 'delegate' ? NOT_HOME : undefined;
	const requestId = nextRelayId++;
	const message = { type: 'record-lock-rpc', requestId, kind, database, table, payload };
	if (parentPort) {
		const answer = awaitRelay(requestId, fallback);
		parentPort.postMessage(message);
		return answer;
	}
	// Main thread received it directly (single-threaded mode, or an operation accepted on main).
	return routeFromMain(message, fallback);
}

async function executeLocally(kind: RelayKind, database: string, table: string, payload: any): Promise<any> {
	if (kind === 'delegate') return deliverDelegationRequest(database, table, payload);
	if (kind === 'quiesce') return quiesceDelegations(database, payload?.deadlineMs);
	await deliverDelegationRecall(database, table, payload);
	return RECALLED;
}

/**
 * Drain this database's delegations on the thread that actually coordinates them (harper-pro#856).
 *
 * The operations API answers on whichever thread took the request, and coordinator state is
 * per-thread: calling `quiesceDelegations` here would sweep an empty registry and report "nothing
 * outstanding" while the owner thread still holds every grant — a drain claimed but not performed,
 * which is the one thing this must never do. A relay that cannot reach the owner reports that as an
 * error rather than an empty result, so the operator falls back to the drain interval.
 */
export async function quiesceOnOwner(database: string, deadlineMs: number): Promise<any> {
	if (ownership.ownsDatabase(database)) return quiesceDelegations(database, deadlineMs);
	const answer = await relay('quiesce', database, '', { deadlineMs });
	if (!answer || typeof answer !== 'object' || !Array.isArray(answer.outstanding))
		throw new ClientError('the record lock drain did not reach the coordinating worker in time', 503);
	return answer;
}

/**
 * Main thread: answer locally when main owns the database, otherwise forward to the owner worker.
 * The forward hop carries an id minted HERE — worker-minted ids are per worker and would collide in
 * this map when two workers relay at once.
 */
async function routeFromMain(message: any, fallback: any): Promise<any> {
	const { kind, database, table, payload } = message;
	if (ownership.mainOwns(database)) return executeLocally(kind, database, table, payload);
	const owner = ownership.ownerFor(database);
	if (!owner) return fallback;
	const hopId = nextRelayId++;
	const answer = awaitRelay(hopId, fallback);
	try {
		owner.postMessage({ type: 'record-lock-rpc', requestId: hopId, kind, database, table, payload });
	} catch (error) {
		logger.debug?.('Could not forward a record lock rpc to the owner worker', error);
		pendingRelays.get(hopId)?.(fallback);
	}
	return answer;
}

if (parentPort) {
	// A request relayed in from main: this worker owns the database.
	onMessageByType('record-lock-rpc', async (message) => {
		let reply: any;
		try {
			reply = await executeLocally(message.kind, message.database, message.table, message.payload);
		} catch (error) {
			logger.warn?.('record lock rpc failed on the owner worker', error);
			reply = message.kind === 'delegate' ? NOT_HOME : undefined;
		}
		try {
			parentPort.postMessage({ type: 'record-lock-rpc-reply', requestId: message.requestId, reply });
		} catch (error) {
			// A throw here (e.g. mid-shutdown) would otherwise reject this async handler under Node's
			// default unhandled-rejection policy and kill the worker; the relay's own timeout already
			// covers the caller side.
			logger.debug?.('Could not return a record lock rpc reply to the relaying worker', error);
		}
	});
	onMessageByType('record-lock-rpc-reply', (message) => {
		pendingRelays.get(message.requestId)?.(message.reply);
	});
} else {
	// On main a 'record-lock-rpc' only ever arrives from a worker that received it on a non-owner
	// socket; owner workers answer with 'record-lock-rpc-reply'.
	onMessageByType('record-lock-rpc', async (message, worker) => {
		const fallback = message.kind === 'delegate' ? NOT_HOME : undefined;
		let reply = fallback;
		try {
			reply = await routeFromMain(message, fallback);
		} catch (error) {
			// A throw here would be an unhandled rejection on the main thread while the origin worker
			// waits out its relay timeout; answer with the fail-closed fallback instead.
			logger.warn?.('record lock rpc failed on the main thread', error);
		}
		try {
			worker?.postMessage({ type: 'record-lock-rpc-reply', requestId: message.requestId, reply });
		} catch (error) {
			logger.debug?.('Could not return a record lock rpc reply to its origin worker', error);
		}
	});
	onMessageByType('record-lock-rpc-reply', (message) => {
		pendingRelays.get(message.requestId)?.(message.reply);
	});
}

// ---- harper-pro#852: relay a local lock() to the owner worker (see replication/DESIGN.md) --------
// The ADMISSION crosses the worker-to-worker port mesh, never the handle: the owner does not write the
// delegation release until this worker acknowledges the fence or the handle's lease elapses. A caller
// worker's exit is NOT a fence on this path — `onThreadExit` below keeps its admission to the lease for
// exactly that reason — because the next holder here is a PEER node, which a process-wide native key
// lock says nothing about. Exit-counts-as-fenced belongs to main's ownerless handoff
// (`broadcastOwnerlessAndWait`), where the departed and admitted threads are both on this node.

const ACQUIRE_REQUEST = 'record-lock-acquire';
const ACQUIRE_REPLY = 'record-lock-acquire-reply';
const RELEASE_REQUEST = 'record-lock-release';
const REVOKE_REQUEST = 'record-lock-revoke';
const REVOKE_ACK = 'record-lock-revoke-ack';

/**
 * This owner thread's identity for the life of the process, defence-in-depth against a release that
 * outlived the owner that granted it. The primary guard is elsewhere: when the coordinating thread for
 * a database changes, every caller fences and forgets its relayed handles for it
 * (`fenceRelayedAdmissionsForDatabase`), so a stale release is not produced across a handoff. The
 * session catches the residue — a release already in flight when the owner changed carries the old
 * owner's session, and an owner ignores anything not stamped with its own. Within one thread the
 * admission-id sequence never restarts under it (a transport rebuild adopts the coordinator, carrying
 * the counter), so no same-thread reuse can collide.
 */
const OWNER_SESSION = randomBytes(8).toString('hex');

/**
 * What a relayed acquire reserves, out of the wait it was given, for the two thread hops. Core already
 * subtracted its own allowance before calling, so this wait is a budget to spend, never one to add to:
 * the caller holds the native key throughout, so overshooting blocks every other worker on that key.
 * The owner is therefore asked for the wait minus this margin, and answers inside the caller's budget.
 *
 * The margin is capped at a QUARTER of the budget, because a flat subtraction turns a short wait into
 * no wait at all: a `lock(id, { timeout: 200 })`, or any lock that spent most of a longer timeout on the
 * native key first, would reach the owner with `waitMs: 0` and fail on the first contention it met —
 * off-owner only, which is exactly the uniformity this relay exists to provide. A margin too small for
 * the hop costs nothing new: the caller's own timer settles it as the same retryable 503, and a grant
 * that lands after it is handed back.
 */
const ACQUIRE_HOP_MS = 250;
const hopMargin = (waitMs: number) => Math.min(ACQUIRE_HOP_MS, Math.floor(waitMs / 4));

// ---- caller side: obtain / release an admission from the owner worker ---------------------------

interface PendingAcquire {
	resolve: (answer: { round?: LockRound; session?: string; error?: { message: string; statusCode?: number } }) => void;
	timer: ReturnType<typeof setTimeout>;
	settled: boolean;
	ownerThreadId: number;
	database: string;
	table: string;
	key: unknown;
}
let nextAcquireId = 1;
const pendingAcquires = new Map<number, PendingAcquire>();
/** Owner session per relayed admission this worker holds, so a release/ack names the right owner. */
const remoteAdmissionSessions = new Map<string, string>();
const KEY_SEP = String.fromCharCode(0);
const admissionSessionKey = (database: string, table: string, admissionId: number) =>
	`${database}${KEY_SEP}${table}${KEY_SEP}${admissionId}`;

/** Called by the transport (core's `acquireOnOwner`). Resolves with the owner-minted round. */
export async function acquireOnOwnerRelay(
	database: string,
	table: string,
	key: unknown,
	leaseMs: number,
	waitMs: number
): Promise<LockRound> {
	const ownerThreadId = ownership.ownerThreadId?.(database);
	if (ownerThreadId === undefined)
		throw new ClientError(
			`No record lock coordinating worker is known yet for ${database}; retry once the owner is assigned`,
			503
		);
	const requestId = nextAcquireId++;
	const answer = await new Promise<{
		round?: LockRound;
		session?: string;
		error?: { message: string; statusCode?: number };
	}>((resolve) => {
		const timer = setTimeout(() => {
			const pending = pendingAcquires.get(requestId);
			if (!pending || pending.settled) return;
			pending.settled = true;
			pendingAcquires.delete(requestId);
			resolve({
				error: { message: 'the record lock acquire did not reach the coordinating worker in time', statusCode: 503 },
			});
		}, waitMs).unref();
		pendingAcquires.set(requestId, { resolve, timer, settled: false, ownerThreadId, database, table, key });
		const unreachable = () => {
			const pending = pendingAcquires.get(requestId);
			if (!pending || pending.settled) return;
			pending.settled = true;
			clearTimeout(timer);
			pendingAcquires.delete(requestId);
			resolve({ error: { message: `the record lock owner worker for ${database} is not reachable`, statusCode: 503 } });
		};
		// No origin field: the owner reads the sender identity from the port the harness stamped. A throw
		// here (an exited or unknown thread id — the cached owner can be stale across a handoff) must
		// settle as a retryable 503, never escape the executor and reject with a bare Error while leaking
		// the pending entry and its timer.
		let sent = false;
		try {
			sent = sendToThread(ownerThreadId, {
				type: ACQUIRE_REQUEST,
				requestId,
				database,
				table,
				key,
				leaseMs,
				// The owner gets the wait minus the hop margin, so its answer lands before the timer above.
				waitMs: Math.max(0, waitMs - hopMargin(waitMs)),
			});
		} catch (error) {
			logger.debug?.(`could not send a record lock acquire to the owner worker for ${database}`, error);
		}
		if (!sent) unreachable();
	});
	if (answer.error) throw new ClientError(answer.error.message, answer.error.statusCode ?? 503);
	if (!answer.round || !answer.session)
		throw new ClientError(`the record lock owner worker for ${database} returned no usable admission`, 503);
	remoteAdmissionSessions.set(admissionSessionKey(database, table, answer.round.admissionId), answer.session);
	return answer.round;
}

/** Called by the transport (core's `releaseOnOwner`). Fire-and-forget; the owner also has a lease. */
export function releaseOnOwnerRelay(database: string, table: string, key: unknown, admissionId: number): void {
	const sessionKey = admissionSessionKey(database, table, admissionId);
	const session = remoteAdmissionSessions.get(sessionKey);
	remoteAdmissionSessions.delete(sessionKey);
	const ownerThreadId = ownership.ownerThreadId?.(database);
	if (ownerThreadId === undefined || session === undefined) return;
	try {
		sendToThread(ownerThreadId, { type: RELEASE_REQUEST, database, table, key, admissionId, session });
	} catch (error) {
		logger.debug?.(`could not send a record lock release to the owner worker for ${database}`, error);
	}
}

/** Drop this worker's cached owner sessions for a database whose coordinating thread changed, so a
 * later release cannot carry a session that named a departed owner (harper-pro#852). */
export function clearRelaySessionsForDatabase(database: string): void {
	const prefix = `${database}${KEY_SEP}`;
	for (const sessionKey of remoteAdmissionSessions.keys())
		if (sessionKey.startsWith(prefix)) remoteAdmissionSessions.delete(sessionKey);
}

/** Fail every in-flight acquire for a database whose coordinating thread changed, with a retryable
 * 503, so a `lock()` sent to a now-departed owner retries against the successor immediately rather
 * than waiting out its whole timeout (harper-pro#852). */
export function failRelayAcquiresForDatabase(database: string): void {
	for (const [requestId, pending] of pendingAcquires) {
		if (pending.database !== database || pending.settled) continue;
		pending.settled = true;
		clearTimeout(pending.timer);
		pendingAcquires.delete(requestId);
		pending.resolve({
			error: { message: `the record lock owner for ${database} changed; retry against the successor`, statusCode: 503 },
		});
	}
}

// A relayed acquire reply, and a revoke, arrive from the owner over its own port; the ack goes back on
// that same port so it cannot be misrouted after an ownership change.
export function handleAcquireReply(message: any, port: any): void {
	const pending = pendingAcquires.get(message.requestId);
	const senderThreadId = port?.threadId;
	// Only the thread the request was sent to can answer it. Request ids are a plain per-worker
	// sequence and a worker reaches the ports it holds, so without this a sibling could settle another
	// worker's acquire with a round no cluster admission backs.
	const wrongSender = pending !== undefined && senderThreadId !== pending.ownerThreadId;
	// A grant from a thread that no longer coordinates the database (the owner changed while this
	// acquire was in flight) is stale — the delegation behind it died with that owner. Hand it back and
	// let the caller retry against the new owner, rather than install a handle no delegation backs. The
	// database is the one the request named, never the reply payload the sender controls.
	const staleOwner =
		message.round && senderThreadId !== ownership.ownerThreadId?.(pending ? pending.database : message.database);
	if (!pending || pending.settled || wrongSender || staleOwner) {
		// The caller already timed out, or the owner changed: the owner minted an admission nobody will
		// use — hand it back to the GRANTING owner (this reply's source thread and session), not the
		// current owner, so it actually drops rather than being rejected on a session mismatch.
		if (message.round && message.session && senderThreadId !== undefined) {
			try {
				sendToThread(senderThreadId, {
					type: RELEASE_REQUEST,
					database: message.database,
					table: message.table,
					key: message.key,
					admissionId: message.round.admissionId,
					session: message.session,
				});
			} catch (error) {
				logger.debug?.('could not hand a stale record lock grant back to its owner', error);
			}
		}
		if (pending && !pending.settled && !wrongSender && staleOwner) {
			pending.settled = true;
			clearTimeout(pending.timer);
			pendingAcquires.delete(message.requestId);
			pending.resolve({
				error: { message: `the record lock owner for ${pending.database} changed during the acquire`, statusCode: 503 },
			});
		}
		return;
	}
	pending.settled = true;
	clearTimeout(pending.timer);
	pendingAcquires.delete(message.requestId);
	pending.resolve({ round: message.round, session: message.session, error: message.error });
}
onMessageByType(ACQUIRE_REPLY, handleAcquireReply);

/** Caller side: fence this worker's handle for an admission the owner is recalling. Named and
 * exported so its sender gate can be tested, the same reason `handleAcquireReply` is. */
export function handleRevokeRequest(message: any, port: any): void {
	// An unstamped port has no verifiable origin, and during a handoff's ownerless window the expected
	// owner is undefined too, so the comparison alone would let the two match. Reject the unstamped
	// sender outright, as every other identity gate in this file does.
	if (port?.threadId === undefined) return;
	// A revoke from a thread that no longer coordinates the database is from a departed owner; the
	// handles it granted were already fenced fail-closed when this worker learned the owner changed
	// (`fenceRelayedAdmissionsForDatabase`), so honoring it now would only risk latching a spurious
	// revoke against the NEW owner's independently-minted id. Drop it.
	if (port.threadId !== ownership.ownerThreadId?.(message.database)) return;
	// Fence this worker's handle for the named admission and acknowledge ONLY once it is provably
	// fenced (revokeRelayedAdmission resolves at the real revokeLease, latching a revoke that raced the
	// handle's install). A throw or rejection means the fence is not proven, so no ack is sent — the
	// owner falls back to its own lease bound rather than being told a fence that did not happen.
	// Runs on whichever worker took the lock; the coordinator resolves the admission by owner id.
	// `Promise.resolve().then(...)` so a SYNCHRONOUS throw from `revokeRelayedAdmission` (e.g. a table
	// dropped or reloaded between acquire and revoke) becomes a rejection rather than escaping this
	// handler — an unhandled throw here would take the worker down mid-transition.
	Promise.resolve()
		.then(() => revokeRelayedAdmission(message.database, message.table, message.admissionId))
		.then(
			() => {
				// The admission is fenced and done; drop its cached session so revoked handles do not leak a
				// map entry for the life of the process.
				remoteAdmissionSessions.delete(admissionSessionKey(message.database, message.table, message.admissionId));
				try {
					port.postMessage({ type: REVOKE_ACK, revokeId: message.revokeId });
				} catch (error) {
					logger.debug?.('could not acknowledge a record lock revoke to the owner worker', error);
				}
			},
			(error) => logger.warn?.('a relayed record lock handle did not confirm its fence', error)
		);
}
onMessageByType(REVOKE_REQUEST, handleRevokeRequest);

// ---- owner side: mint / release an admission for a peer worker, and drive revocation ------------

interface OwnerAdmission {
	origin: number;
	database: string;
	table: string;
	key: unknown;
	admissionId: number;
	port: any;
}
/** Relayed admissions this thread minted as owner, keyed by (database, table, admissionId). */
const ownerAdmissions = new Map<string, OwnerAdmission>();
const ownershipGenerations = new Map<string, number>();
const ownershipGeneration = (database: string) => ownershipGenerations.get(database) ?? 0;
let nextRevokeId = 1;
const pendingRevokeAcks = new Map<number, { threadId: number; settle: () => void }>();

function releaseOwnerAdmission(admission: OwnerAdmission): void {
	try {
		const released = releaseForRelay(admission.database, admission.table, admission.key, admission.admissionId);
		if (released && typeof (released as Promise<void>).then === 'function')
			(released as Promise<void>).catch((error) =>
				logger.warn?.('failed to release a relayed record lock admission', error)
			);
	} catch (error) {
		logger.warn?.('failed to release a relayed record lock admission', error);
	}
}

/**
 * Owner side: mint an admission for a peer worker's `lock()`. Named and exported so the deny paths
 * below can be tested — `manageThreads` offers no way to raise a worker->worker message, the same
 * reason `handleAcquireReply` is exported.
 */
export async function handleAcquireRequest(message: any, port: any): Promise<void> {
	const { requestId, database, table, key, leaseMs, waitMs } = message;
	// The origin is the sender thread, taken from the port the harness stamped — never a payload field,
	// so a malformed worker cannot claim another's identity or target another's handle. A message with
	// no port has no way back and no verifiable origin; drop it rather than reject this async handler
	// (an unhandled rejection would take the worker down).
	if (port?.threadId === undefined) return;
	const origin = port.threadId;
	const generation = ownershipGeneration(database);
	const reply = (payload: any) => {
		try {
			port.postMessage({ type: ACQUIRE_REPLY, requestId, database, table, key, ...payload });
			return true;
		} catch (error) {
			logger.debug?.('could not return a record lock acquire reply to the origin worker', error);
			return false;
		}
	};
	// This thread must actually coordinate the database. A misrouted request (an ownership change the
	// caller had not yet learned) fails closed rather than relaying onward into a loop.
	if (!ownership.ownsDatabase(database)) {
		reply({ error: { message: `this worker does not coordinate ${database}`, statusCode: 503 } });
		return;
	}
	try {
		const round = await acquireForRelay(database, table, key, leaseMs, waitMs, (grantedRound: LockRound) => {
			ownerAdmissions.set(admissionSessionKey(database, table, grantedRound.admissionId), {
				origin,
				database,
				table,
				key,
				admissionId: grantedRound.admissionId,
				port,
			});
			return () => revokeRemoteHandle(database, table, grantedRound, leaseMs, port, origin);
		});
		// Ownership can be given up across the await, after `onRecordLockOwnershipLost` already swept. The
		// coordinator that replaces this one starts empty, so this grant backs nothing and must not reach
		// the caller. The generation, not the boolean, is what makes that check sound: a lose→regain cycle
		// hands the database back to THIS thread with a fresh coordinator, and the caller cannot tell the
		// two apart — same thread id, same process-wide session. Disposed exactly like an undeliverable
		// reply: release the admission rather than hold it to its lease against a ghost.
		const lostOwnership = !ownership.ownsDatabase(database) || ownershipGeneration(database) !== generation;
		if (lostOwnership || !reply({ round, session: OWNER_SESSION })) {
			const admission = ownerAdmissions.get(admissionSessionKey(database, table, round.admissionId));
			if (admission) {
				ownerAdmissions.delete(admissionSessionKey(database, table, round.admissionId));
				releaseOwnerAdmission(admission);
			}
			if (lostOwnership)
				reply({ error: { message: `this worker no longer coordinates ${database}`, statusCode: 503 } });
		}
	} catch (error: any) {
		reply({ error: { message: error?.message ?? 'record lock acquire failed', statusCode: error?.statusCode ?? 503 } });
	}
}
onMessageByType(ACQUIRE_REQUEST, handleAcquireRequest);

export function handleRelease(message: any, port: any): void {
	const { database, table, admissionId, session } = message;
	// Ignore a release stamped with another owner's session: it names an admission a departed owner
	// minted, not one this thread holds.
	if (session !== OWNER_SESSION) return;
	const admission = ownerAdmissions.get(admissionSessionKey(database, table, admissionId));
	if (!admission) return;
	// Only the worker the admission was minted for may release it. The session is shared across this
	// owner's admissions and admission ids are a plain sequence, so the session alone lets any thread
	// that learned it drop a SIBLING's admission while that sibling's handle can still commit — which
	// admits a peer node concurrently. The origin is the id captured from the stamped port at acquire.
	if (port?.threadId !== admission.origin) return;
	ownerAdmissions.delete(admissionSessionKey(database, table, admissionId));
	releaseOwnerAdmission(admission);
}
onMessageByType(RELEASE_REQUEST, handleRelease);

export function handleRevokeAck(message: any, port: any): void {
	const pending = pendingRevokeAcks.get(message.revokeId);
	// Same rule, and the sharper consequence: this ack is what tells the owner the handle is fenced, so
	// an ack from anyone but the holder makes it write `lockRelease` while the real holder can still
	// commit — the cross-node two-writer the fence exists to close.
	if (!pending || port?.threadId !== pending.threadId) return;
	pending.settle();
}
onMessageByType(REVOKE_ACK, handleRevokeAck);

/**
 * Fence a relayed handle on the worker that holds it, and resolve once it acknowledges — or once the
 * handle's own lease has elapsed, past which it fences itself. Core awaits this before it writes the
 * delegation release, so the successor can only be admitted after this handle can no longer commit.
 * The wait is bounded by the handle's REMAINING lease (`leaseMs` from the acquire that minted it),
 * so a dead or wedged caller delays the release only until the handle would have expired anyway.
 *
 * This is the fence promise core awaits, and it is deliberately RESOLVE-ONLY: it never rejects and
 * always settles (on the ack, or on the lease timer). That is the contract `#revokeAllAndSettle`
 * relies on — a rejecting or never-settling revoker is what would let the home re-grant against an
 * unfenced handle, and this side guarantees neither happens.
 */
function revokeRemoteHandle(
	database: string,
	table: string,
	round: LockRound,
	leaseMs: number,
	port: any,
	origin: number
): Promise<void> {
	ownerAdmissions.delete(admissionSessionKey(database, table, round.admissionId));
	const revokeId = nextRevokeId++;
	const remainingLease = Math.max(0, round.mintedMono + leaseMs - performance.now());
	return new Promise<void>((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			pendingRevokeAcks.delete(revokeId);
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(done, remainingLease).unref();
		pendingRevokeAcks.set(revokeId, { threadId: origin, settle: done });
		try {
			// The caller's own port, captured at acquire; a fence on the thread that holds the handle.
			port.postMessage({ type: REVOKE_REQUEST, revokeId, database, table, admissionId: round.admissionId });
		} catch (error) {
			// The port is gone: the handle went with its worker. The lease bound resolves it.
			logger.debug?.('could not send a record lock revoke to the holding worker', error);
			if (!(remainingLease > 0)) done();
		}
	});
}

/**
 * On a caller worker's exit, forget the bookkeeping for the relayed admissions it held here, but do
 * NOT release them early: an ungraceful exit (a graceful one has already unlocked its handles before
 * exiting) may leave a write the dead worker handed to the storage layer still flushing, and releasing
 * now would let another node be admitted against a write that has not landed. The admission's own lease
 * is the crash backstop the rest of the design relies on, so let the owner's coordinator expire it on
 * schedule (harper-pro#852). Only the local map entry is dropped, to keep it from leaking.
 */
onThreadExit((threadId: number) => {
	for (const [admissionKey, admission] of ownerAdmissions) {
		if (admission.origin !== threadId) continue;
		ownerAdmissions.delete(admissionKey);
	}
});

/**
 * This thread is no longer the coordinating worker for a database, without having exited. Forget the
 * bookkeeping, do not release — the callers fenced their handles and dropped their owner sessions when
 * they learned the owner changed, so no release will ever arrive to collect these entries, and the
 * coordinator's lease is what retires the admission itself. The generation bump is what a lose→regain
 * cycle leaves behind: the thread id and `OWNER_SESSION` are identical across it, so it is the only
 * thing either side can use to tell one coordinator's grants from its successor's.
 */
export function onRecordLockOwnershipLost(database: string): void {
	ownershipGenerations.set(database, ownershipGeneration(database) + 1);
	for (const [admissionKey, admission] of ownerAdmissions) {
		if (admission.database !== database) continue;
		ownerAdmissions.delete(admissionKey);
	}
}

server.registerOperation?.({ name: DELEGATE_OPERATION, execute: executeDelegate, httpMethod: 'POST' });
server.registerOperation?.({ name: RECALL_OPERATION, execute: executeRecall, httpMethod: 'POST' });
server.registerOperation?.({ name: BARRIER_OPERATION, execute: executeBarrier, httpMethod: 'POST' });
