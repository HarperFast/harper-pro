/**
 * Draining a live node before `remove_node` deletes its membership (harper-pro#1348). The node being removed (Y)
 * stops admitting local writes (core's durable write fence) and fixes a target key above every write it admitted;
 * `remove_node`, on any node, waits until every peer that must hold Y's writes has durably recorded a certified
 * origin-closed floor for Y at or above that target. A floor `F` means the peer committed every Y entry below `F`
 * that its route carries, and a floor at or above the target was certified once every admitted write had settled.
 * Design: replication/DESIGN.md "Removing a live node".
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { databases } from '../core/resources/databases.ts';
import {
	isValidFloor,
	localWritesFenced,
	originFloorsDurable,
	restoreLocalWriteFence,
	setLocalWriteFence,
	setNewRootWriteFence,
} from '../core/resources/originClosedFloor.ts';
import {
	getDatabaseGeneration,
	persistLocalWriteFence,
	readLocalWriteFence,
	type LocalWriteFence,
} from '../core/resources/auditStore.ts';
import { exportIdMapping } from '../core/resources/nodeIdMapping.ts';
import { readResidencyMap } from '../core/resources/residencyMaps.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import { server } from '../core/server/Server.ts';
import { ClientError, ServerError } from '../core/utility/errors/hdbError.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import * as hdbLogger from '../core/utility/logging/harper_logger.js';
import { getHDBNodeTable, getReplicationRecipients } from './knownNodes.ts';
import { receivesDirectlyFrom } from './subscriptionManager.ts';
import { principalNodeName } from './recordLockRpc.ts';
import { tableReplicates } from './replicatedDatabases.ts';

export const FENCE_OPERATION = 'remove_node_fence';
export const RECEIPT_OPERATION = 'get_received_origin_floors';
export const DEFAULT_DRAIN_TIMEOUT_MS = 300_000;
const MAX_DRAIN_TIMEOUT_MS = 24 * 3_600_000;
const CALL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
// below this a peer call could not complete, so the drain reports what its last complete poll found
const MIN_CALL_MS = 250;

export interface DatabaseDrain {
	target: number;
	generation?: string;
	sharded: boolean;
	peers: string[];
	/** for a database with a shard map, each shard's other owners: one of them must hold the node's writes */
	shardOwners?: string[][];
}

export interface FenceState {
	node: string;
	epoch: string;
	state: LocalWriteFence['state'];
	databases: Record<string, DatabaseDrain>;
}

export interface ReceivedFloor {
	closedFloor: number | null;
	/** false: this peer does not subscribe to the database from the origin, so it holds none of its writes */
	receives?: false;
	originGeneration?: string;
	fullCoverage?: boolean;
	partialHistory?: boolean;
	hole?: boolean;
	floorRevoked?: boolean;
}

/**
 * Present from before this node fences its roots until before it clears them: while it exists, every root opened on
 * any thread starts fenced, so a database created after the removal's last scan admits no write its receipts miss.
 */
function removalMarkerPath(): string | undefined {
	const rootPath = env.get(CONFIG_PARAMS.ROOTPATH);
	return rootPath ? join(rootPath, 'removal-fence.json') : undefined;
}
export function removalMarked(): boolean {
	const path = removalMarkerPath();
	return path !== undefined && existsSync(path);
}
setNewRootWriteFence((rootStore: any) => rootStore?.databaseName !== 'system' && removalMarked());
// a root this thread opened before registering (at startup) holds no record if it was created mid-removal
if (removalMarked())
	for (const auditStore of [...databaseRoots().values()].flat()) {
		const rootStore = auditStore.rootStore ?? auditStore;
		if (originFloorsDurable(rootStore)) restoreLocalWriteFence(rootStore, () => true);
	}

function syncDirectory(path: string): void {
	const fd = openSync(dirname(path), 'r');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function markRemoval(epoch: string): void {
	const path = removalMarkerPath();
	if (!path) throw new ServerError('This node has no root path to record its removal in', 500);
	if (existsSync(path)) return;
	const temporary = `${path}.${process.pid}.tmp`;
	const fd = openSync(temporary, 'w');
	try {
		writeSync(fd, JSON.stringify({ epoch }));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	syncDirectory(path);
}

export function unmarkRemoval(): void {
	const path = removalMarkerPath();
	if (!path || !existsSync(path)) return;
	rmSync(path, { force: true });
	syncDirectory(path);
}

function isSuperUser(request: any): boolean {
	return request?.hdb_user?.role?.permission?.super_user === true;
}

function authorize(request: any, operation: string): void {
	if (!isSuperUser(request) && !principalNodeName(request))
		throw new ClientError(`${operation} is accepted from cluster nodes and super users only`, 403);
}

/** Every native root of each database other than `system`: a database can keep tables in more than one. */
function databaseRoots(): Map<string, any[]> {
	const roots = new Map<string, any[]>();
	for (const name in databases) {
		if (name === 'system') continue;
		const auditStores = new Set<any>();
		for (const tableName in databases[name]) {
			const auditStore = databases[name][tableName]?.auditStore;
			if (auditStore) auditStores.add(auditStore);
		}
		if (auditStores.size > 0) roots.set(name, [...auditStores]);
	}
	return roots;
}

function assertDrainable(database: string, auditStore: any): void {
	const rootStore = auditStore.rootStore ?? auditStore;
	if (typeof rootStore?.getUserSharedBuffer !== 'function' || !originFloorsDurable(rootStore))
		throw new ClientError(
			`Database ${database} has no durable origin-closed floor (RocksDB with WAL sync is required), so its writes cannot be drained before removal; use force: true to remove without draining`,
			400
		);
}

/**
 * The peers that may hold this node's writes to `database`: every peer it sends the database to. A peer that does
 * not subscribe to it says so in its receipt. For a database with a shard map, a shard this node alone owns would
 * lose its records, which no wait can prevent.
 */
function requiredPeers(
	database: string,
	thisNode: string
): { peers: string[]; sharded: boolean; shardOwners?: string[][] } {
	// writes to tables that do not replicate never leave this node
	if (!Object.values(databases[database] ?? {}).some((table: any) => tableReplicates(table)))
		return { peers: [], sharded: false };
	const peers = getReplicationRecipients(database)
		.filter((node: any) => node?.name && node.name !== thisNode)
		.map((node: any) => node.name)
		.sort();
	const map = readResidencyMap(database);
	if (!map) return { peers, sharded: false };
	const shardOwners: string[][] = [];
	for (const shard of new Set(map.ranges.map((range: any) => range.shard))) {
		const members = (server.shards?.get(shard) ?? []).map((node: any) => (typeof node === 'string' ? node : node.name));
		if (members.includes(thisNode) && !members.some((name: string) => name !== thisNode))
			throw new ClientError(
				`${thisNode} is the only owner of shard ${shard} of database ${database}; removing it would lose that shard's records. Add another owner first, or use force: true`,
				409
			);
		const others = members.filter((name: string) => name !== thisNode && peers.includes(name));
		if (others.length > 0) shardOwners.push(others);
		// includes a shard with no member left (its last owner removed with force): nothing would hold its records
		else if (peers.length > 0)
			throw new ClientError(
				`${thisNode} sends database ${database} to no owner of shard ${shard}, so its writes to that shard's records exist only on it. Use force: true to remove it anyway`,
				409
			);
	}
	return { peers, sharded: true, shardOwners };
}

/**
 * Fence (the default), finalize or cancel this node's removal. Idempotent: a repeat call returns the persisted
 * epoch and targets, and fences any database created since under the same epoch.
 */
export async function removeNodeFence(
	request: any,
	lockDeadline = performance.now() + CALL_TIMEOUT_MS
): Promise<FenceState | { cancelled: true }> {
	authorize(request, FENCE_OPERATION);
	const thisNode = getThisNodeName();
	if (request.node !== thisNode)
		throw new ClientError(`${FENCE_OPERATION} names node '${request.node}', but this node is '${thisNode}'`, 400);
	// a cancel and a finalize each decide from the persisted state, so they must not interleave
	return withFenceLock(() => changeFence(request, thisNode), lockDeadline);
}

const FENCE_LOCK_KEY = [Symbol.for('remove-node-fence')];
class FenceLockTimeout extends ServerError {}
const syncedFences = new WeakMap<object, string>();

async function withFenceLock<T>(work: () => Promise<T>, deadline = performance.now() + CALL_TIMEOUT_MS): Promise<T> {
	const store = getHDBNodeTable().primaryStore;
	for (;;) {
		if (performance.now() > deadline)
			throw new FenceLockTimeout(`Timed out waiting for another ${FENCE_OPERATION} on this node to finish`, 503);
		if (store.tryLock(FENCE_LOCK_KEY)) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	try {
		return await work();
	} finally {
		store.unlock(FENCE_LOCK_KEY);
	}
}

async function changeFence(request: any, thisNode: string): Promise<FenceState | { cancelled: true }> {
	const roots = databaseRoots();
	const fences = [...roots.values()]
		.flat()
		.filter(canBeFenced)
		.map(readLocalWriteFence)
		.filter(Boolean) as LocalWriteFence[];
	const wasRemoving = fences.some((fence) => fence.state === 'removing');
	if (request.cancel) {
		// `force` is the operator's word that the removal finished but its notice never arrived
		if (wasRemoving && request.force !== true)
			throw new ClientError(
				`${thisNode}'s removal was finalized; complete it with remove_node, or, if it was already removed, run ${FENCE_OPERATION} with cancel and force on it`,
				409
			);
		await clearFences(roots);
		hdbLogger.notify(`Removal of ${thisNode} from its cluster was cancelled; local writes are accepted again`);
		return { cancelled: true };
	}
	for (const [database, auditStores] of roots)
		for (const auditStore of auditStores) assertDrainable(database, auditStore);
	for (const [database, auditStores] of roots)
		// replication sends and certifies floors for one root per database; another root's writes have no receipt
		if (auditStores.length > 1)
			throw new ClientError(
				`Database ${database} keeps its tables in more than one storage root, so its writes cannot be drained before removal; use force: true to remove without draining`,
				400
			);
	const epoch = fences.find((fence) => fence.epoch)?.epoch || randomUUID();
	const required = new Map([...roots.keys()].map((database) => [database, requiredPeers(database, thisNode)]));
	if (request.finalize !== undefined) {
		const expected = new Set(request.databases ?? []);
		// the receipts vouch for one target and generation per database; a database dropped and created again since
		// was fenced at another target, with writes before that fence no receipt covers
		const receipted = request.receipts ?? {};
		const fenced = [...roots].every(([database, auditStores]) =>
			auditStores.every((auditStore) => {
				const fence = readLocalWriteFence(auditStore);
				return (
					fence?.epoch === request.finalize &&
					expected.has(database) &&
					fence.target === receipted[database]?.target &&
					getDatabaseGeneration(auditStore)?.id === receipted[database]?.generation
				);
			})
		);
		if (request.finalize !== epoch || !fenced || expected.size !== roots.size)
			throw new ClientError(`${thisNode}'s fence changed since its receipts were collected; retry the removal`, 409);
		for (const [database, now] of required)
			if (!receiptsBindRequired(receipted[database], now))
				throw new ClientError(
					`The peers that must hold ${thisNode}'s writes to database ${database} changed since its receipts were collected; retry the removal`,
					409
				);
	}
	markRemoval(epoch);
	const state: FenceState['state'] = request.finalize !== undefined || wasRemoving ? 'removing' : 'fenced';
	const result: FenceState = { node: thisNode, epoch, state, databases: {} };
	const targets = new Map<any, number>();
	for (const [database, auditStores] of roots) {
		let target = 0;
		for (const auditStore of auditStores) {
			const rootStore = auditStore.rootStore ?? auditStore;
			const existing = readLocalWriteFence(auditStore);
			const fenceTarget =
				existing && isValidFloor(existing.target) ? existing.target : setLocalWriteFence(rootStore, true);
			if (existing && !localWritesFenced(rootStore)) setLocalWriteFence(rootStore, true);
			// finalize always persists: a retry after a failed WAL sync must not report an unsynced state
			const record = `${epoch}:${fenceTarget}:${state}`;
			// a record read back is reported only once this process has synced it: a persist whose WAL sync failed
			// left it committed but not durable
			if (request.finalize !== undefined || syncedFences.get(auditStore) !== record) {
				await persistLocalWriteFence(auditStore, { epoch, target: fenceTarget, state });
				syncedFences.set(auditStore, record);
			}
			targets.set(auditStore, fenceTarget);
			if (fenceTarget > target) target = fenceTarget;
		}
		const { peers, sharded, shardOwners } = required.get(database)!;
		const generation = getDatabaseGeneration(auditStores[0])?.id;
		result.databases[database] = {
			target,
			sharded,
			peers,
			...(shardOwners ? { shardOwners } : {}),
			...(typeof generation === 'string' ? { generation } : {}),
		};
	}
	// finalize persisted across awaits: a database created, or a peer that became required, meanwhile has no
	// receipt, so the state goes back to fenced and the next poll covers it
	if (request.finalize !== undefined) {
		const known = new Set([...roots.values()].flat());
		const created = [...databaseRoots().values()].flat().some((auditStore) => !known.has(auditStore));
		const rebound = [...roots.keys()].some((database) => {
			try {
				return !receiptsBindRequired(request.receipts?.[database], requiredPeers(database, thisNode));
			} catch {
				return true; // a refusal now (an owner gone): the next poll reports it
			}
		});
		if (created || rebound) {
			if (!wasRemoving)
				for (const [auditStore, target] of targets) {
					await persistLocalWriteFence(auditStore, { epoch, target, state: 'fenced' });
					syncedFences.set(auditStore, `${epoch}:${target}:fenced`);
				}
			throw new ClientError(
				created
					? `A database was created on ${thisNode} while its removal was finalized; retry`
					: `The peers that must hold ${thisNode}'s writes changed while its removal was finalized; retry`,
				409
			);
		}
	}
	if (fences.length === 0)
		hdbLogger.notify(`${thisNode} is being removed from its cluster: local writes are now refused`);
	return result;
}

// only a durable-floor (RocksDB) root can hold a fence; reading one on an LMDB root would build a registry it lacks
const canBeFenced = (auditStore: any): boolean => originFloorsDurable(auditStore.rootStore ?? auditStore);

async function clearFences(roots: Map<string, any[]>): Promise<void> {
	// first, so a root opened while these are cleared does not start fenced with nothing left to lift it
	unmarkRemoval();
	for (const auditStores of roots.values())
		for (const auditStore of auditStores) {
			if (
				!canBeFenced(auditStore) ||
				(!readLocalWriteFence(auditStore) && !localWritesFenced(auditStore.rootStore ?? auditStore))
			)
				continue;
			syncedFences.delete(auditStore);
			await persistLocalWriteFence(auditStore, undefined);
			setLocalWriteFence(auditStore.rootStore ?? auditStore, false);
		}
}

/**
 * Lift this node's fence once a peer has removed it (`remove_node_back`, any state), or when it joins a cluster
 * (`add_node`, `add_node_back`), unless a removal was finalized: then only its removal notice, or a forced cancel,
 * lifts it, since its receipts were taken under the fence. Without this a node removed after a finalize, or with
 * `force` after a timeout, refuses local writes for good.
 */
export async function liftFenceAfterRemoval(removed: boolean): Promise<void> {
	await withFenceLock(async () => {
		const roots = databaseRoots();
		const stores = [...roots.values()].flat().filter(canBeFenced);
		const fences = stores.map(readLocalWriteFence).filter(Boolean) as LocalWriteFence[];
		// a clear whose WAL sync failed leaves the word set with no record
		if (
			fences.length === 0 &&
			!stores.some((auditStore) => localWritesFenced(auditStore.rootStore ?? auditStore)) &&
			!removalMarked()
		)
			return;
		if (!removed && fences.some((fence) => fence.state === 'removing')) return;
		await clearFences(roots);
		hdbLogger.notify(`${getThisNodeName()} left its cluster; local writes are accepted again`);
	});
}

/**
 * The certified floor this node has recorded for `origin` on its direct route from it, per database, after a WAL
 * sync: the answer and the records below it survive power loss once it is sent.
 */
export async function getReceivedOriginFloors(request: any): Promise<Record<string, ReceivedFloor>> {
	authorize(request, RECEIPT_OPERATION);
	const { origin } = request;
	if (typeof origin !== 'string' || !origin) throw new ClientError('origin is required', 400);
	if (!Array.isArray(request.databases) || request.databases.some((name: unknown) => typeof name !== 'string'))
		throw new ClientError('databases must be an array of database names', 400);
	const answers: Record<string, ReceivedFloor> = {};
	const roots = new Set<any>();
	for (const database of new Set<string>(request.databases)) {
		answers[database] = { closedFloor: null };
		if (receivesDirectlyFrom(origin, database) === false) {
			answers[database] = { closedFloor: null, receives: false };
			continue;
		}
		const tables = databases[database];
		let auditStore: any;
		let dbisDB: any;
		for (const tableName in tables ?? {}) {
			auditStore ??= tables[tableName]?.auditStore;
			dbisDB ??= tables[tableName]?.dbisDB;
		}
		if (!auditStore || !dbisDB) continue;
		const id = exportIdMapping(auditStore)?.[origin];
		if (typeof id !== 'number') continue;
		const entry = dbisDB.getSync([Symbol.for('seq'), id])?.nodes?.find((node: any) => node?.id === id);
		if (!entry) continue;
		answers[database] = {
			closedFloor: isValidFloor(entry.closedFloor) ? entry.closedFloor : null,
			originGeneration: typeof entry.originGeneration === 'string' ? entry.originGeneration : undefined,
			fullCoverage: entry.fullCoverage === true,
			partialHistory: entry.partialHistory === true,
			hole: entry.hole === true,
			floorRevoked: entry.floorRevoked === true,
		};
		// a database can keep tables in more than one root; the receipt vouches for the records in each
		for (const tableName in tables) {
			const tableAudit = tables[tableName]?.auditStore;
			if (tableAudit) roots.add(tableAudit.rootStore ?? tableAudit);
		}
	}
	// every floor is read before any sync, so each answer is covered by one
	for (const rootStore of roots) {
		if (typeof rootStore.syncWal === 'function') await rootStore.syncWal();
		else rootStore.flushSync?.({ allowWriteStall: true });
	}
	return answers;
}

/**
 * Whether a finalize's receipts were collected from every peer that must now hold the node's writes to a database,
 * under the shard ownership they were judged by: a peer that became required after the last poll was never asked.
 */
export function receiptsBindRequired(
	receipt: { peers?: unknown; shardOwners?: unknown } | undefined,
	required: { peers: string[]; shardOwners?: string[][] }
): boolean {
	const asked = receipt?.peers;
	if (!Array.isArray(asked) || required.peers.some((peer) => !asked.includes(peer))) return false;
	return JSON.stringify(required.shardOwners ?? null) === JSON.stringify(receipt.shardOwners ?? null);
}

export function receiptShortfall(answer: ReceivedFloor | undefined, drain: DatabaseDrain): string | undefined {
	if (!answer || !isValidFloor(answer.closedFloor)) return 'has recorded no certified floor for it';
	if (answer.floorRevoked) return 'had its floor for it revoked';
	if (answer.partialHistory || answer.hole) return 'holds a partial history of it';
	if (drain.generation !== undefined && answer.originGeneration !== drain.generation)
		return 'holds a floor from another generation of the database';
	// a route between shards never carries every table, and its floor covers the records that peer owns
	if (!drain.sharded && !answer.fullCoverage) return 'receives it on a route that does not carry every table';
	if (answer.closedFloor < drain.target)
		return `has its floor at ${answer.closedFloor}, below the target ${drain.target}`;
}

export function drainTimeoutMs(timeout: unknown): number {
	if (timeout === undefined) return DEFAULT_DRAIN_TIMEOUT_MS;
	if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > MAX_DRAIN_TIMEOUT_MS)
		throw new ClientError(`timeout must be an integer number of milliseconds from 1 to ${MAX_DRAIN_TIMEOUT_MS}`, 400);
	return timeout as number;
}

function unsupportedOperation(error: unknown): boolean {
	const message = String((error as Error)?.message ?? error);
	return new RegExp(
		`Operation '?${FENCE_OPERATION}'? (?:is )?not found|unknown operation '?${FENCE_OPERATION}`,
		'i'
	).test(message);
}

function isRefusal(error: any): boolean {
	return (error?.statusCode >= 400 && error.statusCode < 500) || /^ClientError\b/.test(String(error?.message ?? ''));
}

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

class OutOfBudget extends Error {}

type SendOperation = (node: any, operation: any, options: { timeoutMs: number }) => Promise<any>;

/**
 * Fence `name` and wait for every required peer's receipt, then finalize so the fence can no longer be cancelled.
 * Throws, leaving the node fenced and its membership in place, when the budget runs out.
 */
export async function drainNode(
	name: string,
	record: any,
	timeoutMs: number,
	sendOperation: SendOperation,
	nodeRecord: (peer: string) => Promise<any>
): Promise<FenceState> {
	const deadline = performance.now() + timeoutMs;
	const remaining = () => Math.max(0, deadline - performance.now());
	const thisNode = getThisNodeName();
	const local = name === thisNode;
	const withinBudget = <T>(work: Promise<T>): Promise<T> => {
		let timer: ReturnType<typeof setTimeout>;
		const deadlinePassed = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new OutOfBudget()), remaining());
		});
		return Promise.race([work, deadlinePassed]).finally(() => clearTimeout(timer));
	};
	const call = async (target: string, peerRecord: any, operation: any) => {
		if (remaining() <= MIN_CALL_MS) throw new OutOfBudget();
		if (target === thisNode) {
			const request = { ...operation, hdb_user: { name: thisNode, role: { permission: { super_user: true } } } };
			// a fence change that won the lock runs to completion: abandoning it could persist a state after the 504
			if (operation.operation === FENCE_OPERATION) return removeNodeFence(request, deadline);
			return withinBudget(getReceivedOriginFloors(request));
		}
		const response = await sendOperation(peerRecord, operation, { timeoutMs: Math.min(CALL_TIMEOUT_MS, remaining()) });
		return response?.results ?? response;
	};
	const pause = () => new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining())));
	let shortfalls: string[] = [];
	let unreachable: string | undefined;
	while (remaining() > MIN_CALL_MS) {
		let fence: FenceState;
		try {
			fence = await call(name, record, { operation: FENCE_OPERATION, node: name });
		} catch (error) {
			if (error instanceof OutOfBudget || (error instanceof FenceLockTimeout && remaining() <= MIN_CALL_MS)) break;
			if (unsupportedOperation(error))
				throw new ClientError(
					`${name} runs a version that cannot drain its writes before removal; upgrade it, or use force: true to remove it without draining`,
					400
				);
			if (local || isRefusal(error)) throw error;
			// a live node that cannot be reached may still hold writes no peer has: keep trying until the budget ends
			unreachable = `${name} could not be reached to fence it (${errorText(error)})`;
			await pause();
			continue;
		}
		unreachable = undefined;
		// only `system`: nothing to fence or drain, and no record would keep a finalize's epoch
		if (Object.keys(fence.databases).length === 0) return { ...fence, state: 'removing' };
		const byPeer = new Map<string, string[]>();
		for (const [database, drain] of Object.entries(fence.databases))
			for (const peer of drain.peers) byPeer.set(peer, [...(byPeer.get(peer) ?? []), database]);
		const round: string[] = [];
		const holders: Record<string, string[]> = {};
		const notSubscribed: Record<string, Set<string>> = {};
		let budgetSpent = false;
		for (const [peer, peerDatabases] of byPeer) {
			if (remaining() <= MIN_CALL_MS) {
				budgetSpent = true;
				break;
			}
			let answers: Record<string, ReceivedFloor>;
			try {
				answers = await call(peer, peer === thisNode ? undefined : await withinBudget(nodeRecord(peer)), {
					operation: RECEIPT_OPERATION,
					origin: name,
					databases: peerDatabases,
				});
			} catch (error) {
				if (error instanceof OutOfBudget) {
					budgetSpent = true;
					break;
				}
				round.push(`${peer} could not be asked for its receipt (${errorText(error)})`);
				continue;
			}
			for (const database of peerDatabases) {
				if (answers?.[database]?.receives === false) {
					(notSubscribed[database] ??= new Set()).add(peer);
					continue;
				}
				const shortfall = receiptShortfall(answers?.[database], fence.databases[database]);
				if (shortfall) round.push(`${peer} ${shortfall} in database ${database}`);
				else (holders[database] ??= []).push(peer);
			}
		}
		if (budgetSpent) {
			if (shortfalls.length === 0) shortfalls = round;
			break;
		}
		// every peer it sends a replicated database to, or every other owner of one shard, said it does not subscribe
		const unreceived = Object.entries(fence.databases).find(([database, drain]) => {
			const declined = notSubscribed[database];
			if (!declined) return false;
			if (drain.peers.length > 0 && drain.peers.every((peer) => declined.has(peer))) return true;
			return drain.shardOwners?.some((owners) => owners.every((owner) => declined.has(owner))) ?? false;
		})?.[0];
		if (unreceived) {
			let lifted = '';
			if (fence.state !== 'removing')
				lifted = await call(name, record, { operation: FENCE_OPERATION, node: name, cancel: true }).then(
					() => `; ${name} accepts local writes again`,
					(error) => `; ${name} is still fenced (${errorText(error)}): remove_node with cancel: true lifts it`
				);
			throw new ClientError(
				`No peer of ${name} that must hold its writes to database ${unreceived} receives that database from it, so some of those writes exist only on ${name}; use force: true to remove it anyway${lifted}`,
				409
			);
		}
		shortfalls = round;
		if (shortfalls.length === 0) {
			try {
				const finalized: FenceState = await call(name, record, {
					operation: FENCE_OPERATION,
					node: name,
					finalize: fence.epoch,
					databases: Object.keys(fence.databases),
					receipts: Object.fromEntries(
						Object.entries(fence.databases).map(([database, drain]) => [
							database,
							{
								target: drain.target,
								generation: drain.generation,
								peers: drain.peers,
								...(drain.shardOwners ? { shardOwners: drain.shardOwners } : {}),
							},
						])
					),
				});
				for (const database in finalized.databases) finalized.databases[database].peers = holders[database] ?? [];
				return finalized;
			} catch (error) {
				if (error instanceof OutOfBudget || (error instanceof FenceLockTimeout && remaining() <= MIN_CALL_MS)) break;
				// 409: a database appeared or the fence changed; the next poll fences and checks it
				if (local && (error as any)?.statusCode !== 409) throw error;
				shortfalls = [`${name} did not finalize its removal (${errorText(error)})`];
			}
		}
		await pause();
	}
	throw new ServerError(
		`Timed out after ${timeoutMs}ms waiting for ${name}'s writes to reach its peers: ${[...shortfalls, ...(unreachable ? [unreachable] : [])].join('; ') || 'no answer'}. ${name} still refuses local writes and stays a member; run remove_node again to resume the wait, remove_node with cancel: true to stop removing it, or force: true to remove it without the wait (writes only it holds would be lost)`,
		504
	);
}

server.registerOperation?.({ name: FENCE_OPERATION, execute: removeNodeFence, httpMethod: 'POST' });
server.registerOperation?.({ name: RECEIPT_OPERATION, execute: getReceivedOriginFloors, httpMethod: 'POST' });
