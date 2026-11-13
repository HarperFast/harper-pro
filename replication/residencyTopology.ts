import { peerSupportsShardingRecovery, type ResolvedPeerCapabilities } from './protocolCapabilities.ts';
import { assertShardingStartupReady, shardingBootstrapStatus } from './shardingBootstrap.ts';
import { shardingWaitingOrigins } from './shardingRecovery.ts';
import { compareResidencyPlacement } from '../core/resources/residencyConversion.ts';
import type { ResidencyMapSnapshot } from '../core/resources/residencyPolicy.ts';
import { getWorkerIndex } from '../core/server/threads/manageThreads.js';
import { isDedicatedPoolWorker } from '../core/server/threads/workerPools.ts';
import { databases, databaseResidencyBlockReason } from '../core/resources/databases.ts';
import {
	getResidencyConfiguration,
	readResidencyMap,
	initializeResidencySlots,
	setResidencyPlacementGuard,
	residencyDeclarationDatabases,
	ResidencyPlacementError,
	assertResidencyEngine,
} from '../core/resources/residencyMaps.ts';
import { server } from '../core/server/Server.ts';
import { ClientError } from '../core/utility/errors/hdbError.ts';
import * as logger from '../core/utility/logging/harper_logger.ts';
import { getHDBNodeTable, getReplicationRecipients } from './knownNodes.ts';
import { PING_TIMEOUT, copyHoleStatus, resolveDatabaseStores } from './replicationConnection.ts';

const agreements = new WeakMap<object, Map<string, Map<string, Int32Array>>>();
const peerDigests = new WeakMap<object, Map<string, BigUint64Array>>();
const topologyGenerations = new WeakMap<object, Int32Array>();
const topologyCaches = new WeakMap<
	object,
	Map<
		string,
		{
			generation: number;
			configuration: unknown;
			nodes: unknown;
			errors: string[];
			agreementErrors: string[];
			declarationErrors: string[];
		}
	>
>();

function topologyGeneration(store: any): Int32Array {
	let generation = topologyGenerations.get(store);
	if (!generation) {
		generation = new Int32Array(store.getUserSharedBuffer('sharding-topology-generation', new ArrayBuffer(4)));
		topologyGenerations.set(store, generation);
	}
	return generation;
}

function peerDigest(store: any, peer: string): BigUint64Array {
	let peers = peerDigests.get(store);
	if (!peers) peerDigests.set(store, (peers = new Map()));
	let digest = peers.get(peer);
	if (!digest) {
		digest = new BigUint64Array(store.getUserSharedBuffer(['sharding-peer-digest', peer], new ArrayBuffer(16)));
		peers.set(peer, digest);
	}
	return digest;
}

function digestFingerprint(digest: unknown): bigint {
	if (digest == null) return 1n;
	if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return 2n;
	return 3n + (BigInt('0x' + digest.slice(0, 16)) % 0xfffffffffffffffdn);
}

const senders = new WeakMap<object, Map<string, Map<string, SenderState>>>();

// `status`: [generation counter, active generation and receive time]; `refusal`: [refused generation, highest
// generation that replayed], as uint32 so the write path reads it without allocating
type SenderState = { status: BigUint64Array; refusal: Uint32Array };
const REFUSED = 0;
const REPLAYED = 1;
function senderState(store: any, database: string, peer: string): SenderState {
	let databases = senders.get(store);
	if (!databases) senders.set(store, (databases = new Map()));
	let peers = databases.get(database);
	if (!peers) databases.set(database, (peers = new Map()));
	let state = peers.get(peer);
	if (!state) {
		const buffer = store.getUserSharedBuffer(['residency-sending', database, peer], new ArrayBuffer(24));
		state = { status: new BigUint64Array(buffer, 0, 2), refusal: new Uint32Array(buffer, 16, 2) };
		peers.set(peer, state);
	}
	return state;
}

/**
 * Holds this thread's view of a peer's sender state for the store's lifetime. RocksDB frees a user-shared buffer
 * with its last view, so without one on the main thread, replacing the replication worker would forget a refusal.
 */
export function anchorResidencySender(store: any, database: string, peer: string): void {
	senderState(store, database, peer);
}

export function registerResidencySender(store: any, database: string, peer: string, receivedAt = Date.now()) {
	const { status, refusal } = senderState(store, database, peer);
	let generation = (Atomics.add(status, 0, 1n) + 1n) & 0xffffffffn;
	if (!generation) generation = (Atomics.add(status, 0, 1n) + 1n) & 0xffffffffn;
	const identity = generation << 32n;
	const stamp = (receivedAt: number) => identity | BigInt(receivedAt >>> 0);
	let closed = false;
	// Publish identity and receive time together. Separate stores let a new connection borrow
	// the previous connection's heartbeat, and a late touch could overwrite its successor's time.
	Atomics.store(status, 1, stamp(receivedAt));
	const ordinal = Number(generation);
	return {
		touch(receivedAt = Date.now()) {
			if (closed) return;
			const active = Atomics.load(status, 1);
			if (!active || active >> 32n === generation) Atomics.compareExchange(status, 1, active, stamp(receivedAt));
		},
		close() {
			closed = true;
			const active = Atomics.load(status, 1);
			if (active >> 32n === generation) Atomics.compareExchange(status, 1, active, 0n);
		},
		refused(): boolean {
			const before = raiseRefusalWord(refusal, REFUSED, ordinal);
			const replayed = Atomics.load(refusal, REPLAYED);
			return ordinal >= replayed && !(before !== 0 && before >= replayed);
		},
		replaying() {
			raiseRefusalWord(refusal, REPLAYED, ordinal);
		},
	};
}

function raiseRefusalWord(refusal: Uint32Array, index: number, value: number): number {
	let seen = Atomics.load(refusal, index);
	while (seen < value) {
		const previous = Atomics.compareExchange(refusal, index, seen, value);
		if (previous === seen) return seen;
		seen = previous;
	}
	return seen;
}

/**
 * A refusal no later sender has replayed past. Process memory only: a restart forgets it until the owner refuses
 * again. Read in this order, a replay that lands between the reads can only end the refusal.
 */
export function residencyOwnerRefusing(store: any, database: string, peer: string): boolean {
	const { refusal } = senderState(store, database, peer);
	const refused = Atomics.load(refusal, REFUSED);
	return refused !== 0 && refused >= Atomics.load(refusal, REPLAYED);
}

function acceptingOwnerReachable(store: any, database: string, reachable: { name: string }[], connected: boolean) {
	for (const node of reachable)
		if (
			!residencyOwnerRefusing(store, database, node.name) &&
			(!connected || residencySenderConnected(store, database, node.name))
		)
			return true;
	return false;
}

function databaseAuditStore(database: string): any {
	const tables = databases[database];
	for (const name in tables) if (tables[name].auditStore) return tables[name].auditStore;
}

/**
 * How many of `peers` this node is sending `database` to right now: an active sender whose last receipt
 * is within pingTimeout. Peers in `except` are not counted.
 */
export function countSendingTo(
	database: string,
	peers: readonly (string | { name: string })[],
	except?: ReadonlySet<string>
): number {
	const store = databaseAuditStore(database);
	if (!store) return 0;
	let count = 0;
	for (const peer of peers) {
		const name = typeof peer === 'string' ? peer : peer.name;
		if (!except?.has(name) && residencySenderConnected(store, database, name)) count++;
	}
	return count;
}

function residencySenderConnected(store: any, database: string, peer: string): boolean {
	const active = Atomics.load(senderState(store, database, peer).status, 1);
	return active !== 0n && (Date.now() - Number(active & 0xffffffffn)) >>> 0 < PING_TIMEOUT;
}

function agreement(peer: string, database = '*'): Int32Array {
	const store = getHDBNodeTable().auditStore;
	let databases = agreements.get(store);
	if (!databases) agreements.set(store, (databases = new Map()));
	let peers = databases.get(database);
	if (!peers) databases.set(database, (peers = new Map()));
	let status = peers.get(peer);
	if (!status) {
		status = new Int32Array(store.getUserSharedBuffer(['residency-agreement', database, peer], new ArrayBuffer(8)));
		peers.set(peer, status);
	}
	return status;
}

const recoveryLevels = new WeakMap<object, Map<string, Int32Array>>();
const recoveryKey = Symbol.for('sharding-peer-recovery');

function recoveryLevel(peer: string): Int32Array {
	const Nodes = getHDBNodeTable();
	const store = Nodes.auditStore;
	let levels = recoveryLevels.get(store);
	if (!levels) recoveryLevels.set(store, (levels = new Map()));
	let level = levels.get(peer);
	if (!level) {
		level = new Int32Array(store.getUserSharedBuffer(['sharding-peer-recovery', peer], new ArrayBuffer(4)));
		const stored = Nodes.dbisDB.getSync([recoveryKey, peer]);
		if (stored !== undefined) Atomics.compareExchange(level, 0, 0, stored ? 1 : -1);
		levels.set(peer, level);
	}
	return level;
}

export function recordShardingRecoveryCapability(
	peer: string,
	capabilities: ResolvedPeerCapabilities,
	identityBound: boolean
): void {
	if (!identityBound) return;
	const level = recoveryLevel(peer);
	const supported = peerSupportsShardingRecovery(capabilities);
	const store = getHDBNodeTable().auditStore;
	if (!supported && Atomics.exchange(level, 0, -1) !== -1) Atomics.add(topologyGeneration(store), 0, 1);
	try {
		const catalog = getHDBNodeTable().dbisDB;
		if (catalog.getSync([recoveryKey, peer]) !== supported) catalog.putSync([recoveryKey, peer], supported);
		if (supported && Atomics.exchange(level, 0, 1) !== 1) Atomics.add(topologyGeneration(store), 0, 1);
	} catch (error) {
		if (Atomics.exchange(level, 0, -1) !== -1) Atomics.add(topologyGeneration(store), 0, 1);
		logger.warn?.(`Could not persist sharding recovery capability for ${peer}`, error);
	}
}

export function residencyConfigurationDigest(): string | null {
	try {
		return getResidencyConfiguration().digest;
	} catch {
		// Invalid optional topology must not prevent legacy databases from exchanging their setup.
		// Core still refuses declarative placement, and cluster_status reports the configuration error.
		return 'invalid';
	}
}

export function recordResidencyConfiguration(peer: string, digest: unknown): void {
	const store = getHDBNodeTable().auditStore;
	const status = peerDigest(store, peer);
	const fingerprint = digestFingerprint(digest);
	if (Atomics.exchange(status, 0, fingerprint) !== fingerprint) Atomics.add(topologyGeneration(store), 0, 1);
	if (fingerprint === digestFingerprint(residencyConfigurationDigest())) Atomics.store(status, 1, 0n);
	if (
		fingerprint !== digestFingerprint(residencyConfigurationDigest()) &&
		Atomics.compareExchange(status, 1, 0n, 1n) === 0n
	)
		logger.warn?.(`Sharding blocked: replication.shards differs from peer ${peer} (shard or spare list)`);
}

export function recordResidencyMapAgreement(database: string, peer: string, error?: unknown): void {
	const status = agreement(peer, database);
	const previous = error ? Atomics.or(status, 0, 1) : Atomics.and(status, 0, ~1);
	if (Boolean(previous & 1) !== Boolean(error)) Atomics.add(topologyGeneration(getHDBNodeTable().auditStore), 0, 1);
	if (error && !(Atomics.or(status, 1, 1) & 1))
		logger.warn?.(`Sharding blocked for ${database}: map from ${peer} could not be installed`, error);
}

export function recordResidencyPolicyAgreement(database: string, peer: string, error?: unknown): void {
	const status = agreement(peer, database);
	const previous = error ? Atomics.or(status, 0, 2) : Atomics.and(status, 0, ~2);
	if (Boolean(previous & 2) !== Boolean(error)) Atomics.add(topologyGeneration(getHDBNodeTable().auditStore), 0, 1);
	if (error && !(Atomics.or(status, 1, 2) & 2))
		logger.warn?.(`Sharding blocked for ${database}: policy from ${peer} could not be installed`, error);
}

export function residencyTopologyErrors(database = '*', includeRecovery = true, forDeclaration = false): string[] {
	const store = getHDBNodeTable().auditStore;
	const generation = Atomics.load(topologyGeneration(store), 0);
	let configuration;
	try {
		configuration = getResidencyConfiguration();
	} catch {
		configuration = 'invalid';
	}
	let cache = topologyCaches.get(store);
	if (!cache) topologyCaches.set(store, (cache = new Map()));
	const previous = cache.get(database);
	if (
		previous?.generation === generation &&
		previous.configuration === configuration &&
		previous.nodes === server.nodes
	)
		return forDeclaration ? previous.declarationErrors : includeRecovery ? previous.errors : previous.agreementErrors;
	const local = digestFingerprint(configuration === 'invalid' ? configuration : configuration.digest);
	const agreementErrors = [];
	const policyErrors = [];
	const recoveryErrors = [];
	for (const node of server.nodes ?? []) {
		if (Atomics.load(recoveryLevel(node.name), 0) === -1)
			recoveryErrors.push(`peer ${node.name} does not support sharding recovery admission`);
		const observed = Atomics.load(peerDigest(store, node.name), 0);
		if (observed !== 0n && observed !== local)
			agreementErrors.push(`replication.shards differs from peer ${node.name} (shard or spare list)`);
		if (database !== '*') {
			const flags = Atomics.load(agreement(node.name, database), 0);
			if (flags & 1) agreementErrors.push(`shard map agreement with ${node.name} is blocked`);
			if (flags & 2) policyErrors.push(`sharding policy agreement with ${node.name} is blocked`);
		}
	}
	const declarationErrors = agreementErrors.slice();
	agreementErrors.push(...policyErrors);
	const errors = [...agreementErrors, ...recoveryErrors];
	cache.set(database, { generation, configuration, nodes: server.nodes, errors, agreementErrors, declarationErrors });
	return forDeclaration ? declarationErrors : includeRecovery ? errors : agreementErrors;
}

setResidencyPlacementGuard((database, owners, requireConnected, shard, root, forDeclaration) => {
	const errors = residencyTopologyErrors(database, requireConnected !== undefined, forDeclaration);
	if (errors.length) throw new ResidencyPlacementError(`Sharding blocked for ${database}: ${errors.join('; ')}`, 503);
	if (requireConnected !== undefined && shard !== undefined) assertShardingStartupReady(database, shard, root);
	if (requireConnected === undefined || !owners || owners.includes(server.hostname)) return;
	const recipients = getReplicationRecipients(database);
	const reachable = recipients.filter((node) => owners.includes(node.name));
	if (!reachable.length)
		throw new ResidencyPlacementError(`No replication route reaches the owners of a record in ${database}`, 503);
	const auditStore = (root as any)?.auditStore ?? databaseAuditStore(database);
	if (requireConnected) {
		if (!auditStore || !acceptingOwnerReachable(auditStore, database, reachable, true))
			throw new ResidencyPlacementError(
				`No new shard owner is connected and accepting replication from this node for ${database}; attribute-slot change refused`,
				503
			);
	} else if (auditStore && !acceptingOwnerReachable(auditStore, database, reachable, false))
		throw new ResidencyPlacementError(
			`Every owner of a record in ${database} is refusing replication from this node; retry the write once one accepts it`,
			503
		);
});

server.registerOperation?.({
	name: 'initialize_shard_map',
	execute: initializeResidencySlots,
	httpMethod: 'POST',
	requiresSuperUser: true,
});

/** Owners come from the membership residencyOwners() routes by. */
function shardSummary(snapshot: ResidencyMapSnapshot, localShard: number | undefined) {
	const slots = new Map<number, number>();
	for (const { start, end, shard } of snapshot.ranges) slots.set(shard, (slots.get(shard) ?? 0) + end - start);
	const assigned = new Set<string>();
	let selfMembershipAgrees = true;
	const shards = Array.from(slots, ([shard, count]) => {
		const owners = new Set<string>();
		// declared string[], but knownNodes stores the node records
		const members: (string | { name: string })[] = server.shards?.get(shard) ?? [];
		for (const member of members) owners.add(typeof member === 'string' ? member : member.name);
		for (const owner of owners) assigned.add(owner);
		if (owners.has(server.hostname) !== (shard === localShard)) selfMembershipAgrees = false;
		return { shard, slots: count, owners: Array.from(owners).sort() };
	}).sort((a, b) => a.shard - b.shard);
	const noSlots = (server.nodes ?? [])
		.filter((node) => !assigned.has(node.name) && (node.shard == null || !slots.has(node.shard)))
		.map((node) => node.name);
	if (!assigned.has(server.hostname)) noSlots.push(server.hostname);
	return { summary: { shards, nodesOwningNoSlots: noSlots.sort() }, selfMembershipAgrees };
}

export function residencyStatus() {
	const status = {};
	let configuration;
	let configurationError;
	try {
		configuration = getResidencyConfiguration();
	} catch (error) {
		configurationError = error.message;
	}
	const declarations = new Set(residencyDeclarationDatabases());
	for (const [database, tables] of Object.entries(databases))
		if (Object.values(tables).some((Table) => Table.residency)) declarations.add(database);
	for (const database of declarations) {
		let snapshot;
		let summary: ReturnType<typeof shardSummary>['summary'] | undefined;
		const errors: string[] = [];
		const quarantine = databaseResidencyBlockReason(database);
		try {
			snapshot = readResidencyMap(database);
			if (snapshot) {
				const result = shardSummary(snapshot, configuration?.shard);
				summary = result.summary;
				if (configuration && !result.selfMembershipAgrees)
					errors.push('local shard membership disagrees with replication.shard');
			}
			errors.push(...residencyTopologyErrors(database));
			assertResidencyEngine(database);
		} catch (error) {
			errors.push(error.message ?? 'sharding agreement is unavailable');
		}
		if (quarantine) errors.push(quarantine);
		if (configurationError) errors.push(configurationError);
		else if (configuration.shards && !configuration.shards.includes(configuration.shard))
			errors.push('replication.shard is not in replication.shards');
		else if (!configuration.shards && !snapshot)
			errors.push('replication.shards is required before a map is installed');
		if (!snapshot) errors.push('no shard map is installed');
		const waitingOrigins = shardingWaitingOrigins(database);
		const recovery = shardingBootstrapStatus(database);
		const { dbisDB, auditStore } = resolveDatabaseStores(undefined, databases[database]);
		const checkpointHoles = copyHoleStatus(dbisDB, auditStore);
		status[database] = {
			waitingOrigins,
			recovery,
			checkpointHoles: checkpointHoles.length ? checkpointHoles : undefined,
			version: snapshot?.version,
			digest: snapshot?.digest,
			...summary,
			shardsDigest: configuration?.digest,
			blocked: errors.length > 0 || (recovery !== undefined && recovery.phase !== 'ready'),
			state: quarantine
				? 'quarantined'
				: errors.length
					? 'held'
					: recovery && recovery.phase !== 'ready'
						? recovery.phase
						: 'available',
			restartRequired: !!quarantine,
			errors,
		};
	}
	return status;
}

export function registerResidencyConversion() {
	if (isDedicatedPoolWorker() || getWorkerIndex() === undefined) return;
	server.registerOperation({
		name: 'verify_shard_map',
		httpMethod: 'POST',
		requiresSuperUser: true,
		execute(request) {
			const Table = databases[request.database]?.[request.table];
			if (!Table) throw new ClientError('Table not found', 404);
			const snapshot = readResidencyMap(request.database);
			if (!snapshot) throw new ClientError('Install the custom shard map before comparing placement', 409);
			return compareResidencyPlacement(Table, request.policy, snapshot);
		},
	});
}
