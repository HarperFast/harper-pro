import { peerSupportsShardingRecovery, type ResolvedPeerCapabilities } from './protocolCapabilities.ts';
import { assertShardingStartupReady, shardingBootstrapStatus } from './shardingBootstrap.ts';
import { shardingWaitingOrigins } from './shardingRecovery.ts';
import { compareResidencyPlacement } from '../core/resources/residencyConversion.ts';
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
import { PING_TIMEOUT } from './replicationConnection.ts';

const agreements = new WeakMap<object, Map<string, Map<string, Int32Array>>>();
const peerDigests = new WeakMap<object, Map<string, BigUint64Array>>();
const topologyGenerations = new WeakMap<object, Int32Array>();
const topologyCaches = new WeakMap<
	object,
	Map<
		string,
		{ generation: number; configuration: unknown; nodes: unknown; errors: string[]; agreementErrors: string[] }
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

const senders = new WeakMap<object, Map<string, Map<string, BigUint64Array>>>();

function senderStatus(store: any, database: string, peer: string): BigUint64Array {
	let databases = senders.get(store);
	if (!databases) senders.set(store, (databases = new Map()));
	let peers = databases.get(database);
	if (!peers) databases.set(database, (peers = new Map()));
	let status = peers.get(peer);
	if (!status) {
		status = new BigUint64Array(store.getUserSharedBuffer(['residency-sending', database, peer], new ArrayBuffer(16)));
		peers.set(peer, status);
	}
	return status;
}

export function registerResidencySender(store: any, database: string, peer: string, receivedAt = Date.now()) {
	const status = senderStatus(store, database, peer);
	let generation = (Atomics.add(status, 0, 1n) + 1n) & 0xffffffffn;
	if (!generation) generation = (Atomics.add(status, 0, 1n) + 1n) & 0xffffffffn;
	const identity = generation << 32n;
	const stamp = (receivedAt: number) => identity | BigInt(receivedAt >>> 0);
	let closed = false;
	// Publish identity and receive time together. Separate stores let a new connection borrow
	// the previous connection's heartbeat, and a late touch could overwrite its successor's time.
	Atomics.store(status, 1, stamp(receivedAt));
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
	};
}

function residencySenderConnected(store: any, database: string, peer: string): boolean {
	const active = Atomics.load(senderStatus(store, database, peer), 1);
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
		logger.warn?.(`Sharding blocked: replication.shards differs from peer ${peer}`);
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

export function residencyTopologyErrors(database = '*', includeRecovery = true): string[] {
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
		return includeRecovery ? previous.errors : previous.agreementErrors;
	const local = digestFingerprint(configuration === 'invalid' ? configuration : configuration.digest);
	const agreementErrors = [];
	const recoveryErrors = [];
	for (const node of server.nodes ?? []) {
		if (Atomics.load(recoveryLevel(node.name), 0) === -1)
			recoveryErrors.push(`peer ${node.name} does not support sharding recovery admission`);
		const observed = Atomics.load(peerDigest(store, node.name), 0);
		if (observed !== 0n && observed !== local)
			agreementErrors.push(`replication.shards differs from peer ${node.name}`);
		if (database !== '*') {
			const flags = Atomics.load(agreement(node.name, database), 0);
			if (flags & 1) agreementErrors.push(`shard map agreement with ${node.name} is blocked`);
			if (flags & 2) agreementErrors.push(`sharding policy agreement with ${node.name} is blocked`);
		}
	}
	const errors = [...agreementErrors, ...recoveryErrors];
	cache.set(database, { generation, configuration, nodes: server.nodes, errors, agreementErrors });
	return includeRecovery ? errors : agreementErrors;
}

setResidencyPlacementGuard((database, owners, requireConnected, shard, root) => {
	const errors = residencyTopologyErrors(database, requireConnected !== undefined);
	if (errors.length) throw new ResidencyPlacementError(`Sharding blocked for ${database}: ${errors.join('; ')}`, 503);
	if (requireConnected !== undefined && shard !== undefined) assertShardingStartupReady(database, shard, root);
	if (requireConnected === undefined || !owners || owners.includes(server.hostname)) return;
	const recipients = getReplicationRecipients(database);
	const reachable = recipients.filter((node) => owners.includes(node.name));
	if (!reachable.length)
		throw new ResidencyPlacementError(`No replication route reaches the owners of a record in ${database}`, 503);
	if (requireConnected) {
		const auditStore = Object.values(databases[database] ?? {}).find((Table) => Table.auditStore)?.auditStore;
		if (!auditStore || !reachable.some((node) => residencySenderConnected(auditStore, database, node.name)))
			throw new ResidencyPlacementError(
				`No new shard owner is connected for ${database}; attribute-slot change refused`,
				503
			);
	}
});

server.registerOperation?.({
	name: 'initialize_shard_map',
	execute: initializeResidencySlots,
	httpMethod: 'POST',
	requiresSuperUser: true,
});

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
		const errors: string[] = [];
		const quarantine = databaseResidencyBlockReason(database);
		try {
			snapshot = readResidencyMap(database);
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
		status[database] = {
			waitingOrigins,
			recovery,
			version: snapshot?.version,
			digest: snapshot?.digest,
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
