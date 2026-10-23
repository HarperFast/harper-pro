import { compareResidencyPlacement } from '../core/resources/residencyConversion.ts';
import { getWorkerIndex } from '../core/server/threads/manageThreads.js';
import { isDedicatedPoolWorker } from '../core/server/threads/workerPools.ts';
import { databases } from '../core/resources/databases.ts';
import {
	getResidencyConfiguration,
	readResidencyMap,
	initializeResidencySlots,
	setResidencyPlacementGuard,
	residencyDeclarationDatabases,
} from '../core/resources/residencyMaps.ts';
import { server } from '../core/server/Server.ts';
import { ClientError } from '../core/utility/errors/hdbError.ts';
import * as logger from '../core/utility/logging/harper_logger.ts';
import { getHDBNodeTable, getReplicationRecipients, getReplicationSharedStatus } from './knownNodes.ts';
import { CONNECTION_STATE_POSITION, CONNECTION_STATE_CONNECTED } from './sharedStatusSlots.ts';

function agreement(peer: string, database?: string): Int32Array {
	return new Int32Array(
		getHDBNodeTable().auditStore.getUserSharedBuffer(['residency-agreement', database ?? '*', peer], new ArrayBuffer(8))
	);
}

export function recordResidencyConfiguration(peer: string, digest: unknown): void {
	const local = getResidencyConfiguration().digest;
	const mismatch = digest !== local && !(digest === undefined && local === null);
	const status = agreement(peer);
	Atomics.store(status, 0, mismatch ? 1 : 0);
	if (mismatch && Atomics.compareExchange(status, 1, 0, 1) === 0)
		logger.warn?.(`Declarative residency blocked: replication.shards differs from peer ${peer}`);
}

export function recordResidencyMapAgreement(database: string, peer: string, error?: unknown): void {
	const status = agreement(peer, database);
	Atomics.store(status, 0, error ? 1 : 0);
	if (error && Atomics.compareExchange(status, 1, 0, 1) === 0)
		logger.warn?.(`Declarative residency blocked for ${database}: map from ${peer} could not be installed`, error);
}

export function residencyTopologyErrors(database?: string): string[] {
	const errors = [];
	for (const node of server.nodes ?? []) {
		if (Atomics.load(agreement(node.name), 0)) errors.push(`replication.shards differs from peer ${node.name}`);
		if (database && Atomics.load(agreement(node.name, database), 0))
			errors.push(`residency map agreement with ${node.name} is blocked`);
	}
	return errors;
}

setResidencyPlacementGuard((database, owners, requireConnected) => {
	const errors = residencyTopologyErrors(database);
	if (errors.length) throw new ClientError(`Declarative residency blocked for ${database}: ${errors.join('; ')}`, 503);
	if (!owners || owners.includes(server.hostname)) return;
	const recipients = getReplicationRecipients(database);
	const reachable = recipients.filter((node) => owners.includes(node.name));
	if (!reachable.length)
		throw new ClientError(`No replication route reaches the owners of a record in ${database}`, 503);
	if (requireConnected) {
		const auditStore = Object.values(databases[database] ?? {}).find((Table) => Table.auditStore)?.auditStore;
		if (
			!auditStore ||
			!reachable.some(
				(node) =>
					getReplicationSharedStatus(auditStore, database, node.name)[CONNECTION_STATE_POSITION] ===
					CONNECTION_STATE_CONNECTED
			)
		)
			throw new ClientError(`No new residency owner is connected for ${database}; attribute-slot change refused`, 503);
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
