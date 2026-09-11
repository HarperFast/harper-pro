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
import { onMessageByType } from '../core/server/threads/manageThreads.js';
import { server } from '../core/server/Server.ts';
import { ClientError } from '../core/utility/errors/hdbError.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import {
	deliverDelegationRecall,
	deliverDelegationRequest,
	type DelegationRecall,
	type DelegationReply,
	type DelegationRequest,
} from '../core/resources/recordLockCoordinator.ts';
import { getRepairConnectionsForDB, sendOperationToNode } from './replicator.ts';

export const DELEGATE_OPERATION = 'record_lock_delegate';
export const RECALL_OPERATION = 'record_lock_recall';

/** Bound on a relay through the main thread to the owner worker. */
const RELAY_TIMEOUT_MS = 5_000;
const NOT_HOME: DelegationReply = { granted: false, reason: 'not-home' };
const RECALLED = Object.freeze({ recalled: true as const });

// ---- ownership readers, installed by recordLockTransport.ts so this module never imports it -----

interface OwnershipReaders {
	ownsDatabase(database: string): boolean;
	/** Main thread only: the owner worker for a database, `undefined` when the main thread is the owner. */
	ownerFor(database: string): any;
	/** Main thread only: whether the main thread itself owns the database. */
	mainOwns(database: string): boolean;
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
	epoch: number;
	leaseMs: number;
}

export interface RecallOperation {
	operation: typeof RECALL_OPERATION;
	database: string;
	table: string;
	key: unknown;
	token: DelegationRecall['token'];
}

/**
 * Send a lock operation to `nodeName`, preferring this worker's live outbound subscription session
 * for the database. The `sendOperationToNode` fallback opens a connection per call; it exists so a
 * directional topology (a home this node only receives from) still works, not as the fast path.
 */
export async function sendRecordLockOperation(
	nodeName: string,
	database: string,
	operation: DelegateOperation | RecallOperation
): Promise<any> {
	for (const connection of getRepairConnectionsForDB(database)) {
		if (connection.nodeName !== nodeName) continue;
		const session = connection.liveSession;
		if (session?.sendOperation) return session.sendOperation({ ...operation });
	}
	const node = (server.nodes ?? []).find((candidate: any) => candidate?.name === nodeName);
	if (!node?.url) throw new Error(`no connection or hdb_nodes row for ${nodeName}`);
	return sendOperationToNode(node, { ...operation });
}

// ---- receive side ------------------------------------------------------------------------------

function principalNodeName(request: any): string | undefined {
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
		epoch: request.epoch,
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

// ---- relay through the main thread to the owner worker -----------------------------------------

type RelayKind = 'delegate' | 'recall';
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
	await deliverDelegationRecall(database, table, payload);
	return RECALLED;
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
		parentPort.postMessage({ type: 'record-lock-rpc-reply', requestId: message.requestId, reply });
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

server.registerOperation?.({ name: DELEGATE_OPERATION, execute: executeDelegate, httpMethod: 'POST' });
server.registerOperation?.({ name: RECALL_OPERATION, execute: executeRecall, httpMethod: 'POST' });
