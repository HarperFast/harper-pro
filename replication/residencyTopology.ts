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
} from '../core/resources/residencyMaps.ts';
import { server } from '../core/server/Server.ts';
import { ClientError } from '../core/utility/errors/hdbError.ts';
import * as logger from '../core/utility/logging/harper_logger.ts';
import { getHDBNodeTable, getReplicationRecipients } from './knownNodes.ts';
import { PING_TIMEOUT } from './replicationConnection.ts';

const agreements = new WeakMap<object, Map<string, Map<string, Int32Array>>>();
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
	const local = residencyConfigurationDigest();
	const mismatch = digest !== local && !(digest === undefined && local === null);
	const status = agreement(peer);
	Atomics.store(status, 0, mismatch ? 1 : 0);
	if (mismatch && Atomics.compareExchange(status, 1, 0, 1) === 0)
		logger.warn?.(`Declarative residency blocked: replication.shards differs from peer ${peer}`);
}

export function recordResidencyMapAgreement(database: string, peer: string, error?: unknown): void {
	const status = agreement(peer, database);
	if (error) Atomics.or(status, 0, 1);
	else Atomics.and(status, 0, ~1);
	if (error && !(Atomics.or(status, 1, 1) & 1))
		logger.warn?.(`Declarative residency blocked for ${database}: map from ${peer} could not be installed`, error);
}

export function recordResidencyPolicyAgreement(database: string, peer: string, error?: unknown): void {
	const status = agreement(peer, database);
	if (error) Atomics.or(status, 0, 2);
	else Atomics.and(status, 0, ~2);
	if (error && !(Atomics.or(status, 1, 2) & 2))
		logger.warn?.(`Declarative residency blocked for ${database}: policy from ${peer} could not be installed`, error);
}

export function residencyTopologyErrors(database?: string): string[] {
	const errors = [];
	for (const node of server.nodes ?? []) {
		if (Atomics.load(agreement(node.name), 0)) errors.push(`replication.shards differs from peer ${node.name}`);
		if (database) {
			const flags = Atomics.load(agreement(node.name, database), 0);
			if (flags & 1) errors.push(`residency map agreement with ${node.name} is blocked`);
			if (flags & 2) errors.push(`residency policy agreement with ${node.name} is blocked`);
		}
	}
	return errors;
}

setResidencyPlacementGuard((database, owners, requireConnected) => {
	const errors = residencyTopologyErrors(database);
	if (errors.length)
		throw new ResidencyPlacementError(`Declarative residency blocked for ${database}: ${errors.join('; ')}`, 503);
	if (requireConnected === undefined || !owners || owners.includes(server.hostname)) return;
	const recipients = getReplicationRecipients(database);
	const reachable = recipients.filter((node) => owners.includes(node.name));
	if (!reachable.length)
		throw new ResidencyPlacementError(`No replication route reaches the owners of a record in ${database}`, 503);
	if (requireConnected) {
		const auditStore = Object.values(databases[database] ?? {}).find((Table) => Table.auditStore)?.auditStore;
		if (!auditStore || !reachable.some((node) => residencySenderConnected(auditStore, database, node.name)))
			throw new ResidencyPlacementError(
				`No new residency owner is connected for ${database}; attribute-slot change refused`,
				503
			);
	}
});

server.registerOperation?.({
	name: 'initialize_residency_slots',
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
		const snapshot = readResidencyMap(database);
		const errors = residencyTopologyErrors(database);
		const quarantine = databaseResidencyBlockReason(database);
		if (quarantine) errors.push(quarantine);
		if (configurationError) errors.push(configurationError);
		else if (configuration.shards && !configuration.shards.includes(configuration.shard))
			errors.push('replication.shard is not in replication.shards');
		else if (!configuration.shards && !snapshot)
			errors.push('replication.shards is required before a map is installed');
		if (!snapshot) errors.push('no residency map is installed');
		status[database] = {
			version: snapshot?.version,
			digest: snapshot?.digest,
			shardsDigest: configuration?.digest,
			blocked: errors.length > 0,
			errors,
		};
	}
	return status;
}

export function registerResidencyConversion() {
	if (isDedicatedPoolWorker() || getWorkerIndex() === undefined) return;
	server.registerOperation({
		name: 'verify_residency_slots',
		httpMethod: 'POST',
		requiresSuperUser: true,
		execute(request) {
			const Table = databases[request.database]?.[request.table];
			if (!Table) throw new ClientError('Table not found', 404);
			const snapshot = readResidencyMap(request.database);
			if (!snapshot) throw new ClientError('Install the custom residency map before comparing placement', 409);
			return compareResidencyPlacement(Table, request.policy, snapshot);
		},
	});
}
