import { createHash } from 'node:crypto';
import { databases } from '../core/resources/databases.ts';
import {
	shardingNativeRoots,
	shardingConvertedTables,
	shardingBaselineState,
} from '../core/resources/shardingCompleteness.ts';
import { readResidencyMap, getResidencyConfiguration } from '../core/resources/residencyMaps.ts';
import { getNodeNameForId } from '../core/resources/nodeIdMapping.ts';
import { getHDBNodeTable, getReplicationSharedStatus } from './knownNodes.ts';
import { server } from '../core/server/Server.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import { readShardingHistory, frozenShardingOriginFloor } from './shardingBootstrapState.ts';
import {
	SHARDING_CERTIFICATE_GENERATION_POSITION,
	SHARDING_CERTIFICATE_POSITION,
	SHARDING_PEER_SHARD_POSITION,
	SHARDING_WAIT_POSITION,
	CONNECTION_STATE_POSITION,
	CONNECTION_STATE_CONNECTED,
} from './sharedStatusSlots.ts';
import type { ResidencyMapSnapshot } from '../core/resources/residencyPolicy.ts';

const certificateKey = Symbol.for('sharding-complete-baseline');
const layouts = new WeakMap<ResidencyMapSnapshot, Map<number, string>>();

export function shardingLayout(database: string, shard?: number): string | undefined {
	if (database === 'system' || !Object.values(databases[database] ?? {}).some((Table) => Table.residency)) return;
	shard ??= getResidencyConfiguration().shard;
	const map = readResidencyMap(database);
	if (!map || !map.ranges.some((range) => range.shard === shard)) return;
	let shards = layouts.get(map);
	if (!shards) layouts.set(map, (shards = new Map()));
	let digest = shards.get(shard);
	if (!digest) {
		digest = createHash('sha256')
			.update(JSON.stringify([map.slots, map.ranges.filter((range) => range.shard === shard)]))
			.digest('hex');
		shards.set(shard, digest);
	}
	return digest;
}

export function shardingRecoveryScopes(database: string): { catalog: any; scope: string }[] {
	return shardingConvertedTables(database).map(({ catalog, tables }) => ({
		catalog,
		scope: createHash('sha256')
			.update(JSON.stringify(tables.sort((a, b) => a.name.localeCompare(b.name))))
			.digest('hex'),
	}));
}

export function shardingCertificate(database: string): string | undefined {
	const layout = shardingLayout(database);
	if (!layout) return;
	const roots = shardingRecoveryScopes(database);
	return roots.length && roots.every(({ catalog, scope }) => catalog.getSync([certificateKey, layout])?.scope === scope)
		? layout
		: undefined;
}

export function shardingSourceAgreement(database: string, shard?: number): string | undefined {
	const layout = shardingLayout(database, shard);
	if (!layout) return;
	const policies = new Map<string, unknown>();
	for (const { catalog } of shardingNativeRoots(database)) {
		for (const { key, value } of catalog.getRange({ start: '', end: '\uffff' })) {
			if (
				typeof key === 'string' &&
				value?.residency &&
				!value.dropping &&
				(value.isPrimaryKey || key.endsWith('/')) &&
				!key.startsWith('/')
			)
				policies.set(key.slice(0, key.indexOf('/')), value.residency);
		}
	}
	return createHash('sha256')
		.update(JSON.stringify([layout, [...policies].sort(([a], [b]) => a.localeCompare(b))]))
		.digest('hex');
}

export function shardingSourceCertificate(database: string): string | undefined {
	const layout = shardingCertificate(database);
	return layout &&
		shardingNativeRoots(database).every(
			({ root, catalog }) =>
				Atomics.load(shardingBaselineState(root, database), 0) === 1 &&
				frozenShardingOriginFloor(readShardingHistory(catalog, layout), getThisNodeName()) !== undefined
		)
		? shardingSourceAgreement(database)
		: undefined;
}

const recoveryListeners = new Set<(database: string) => void>();
export function onShardingRecoveryChange(listener: (database: string) => void): () => void {
	recoveryListeners.add(listener);
	return () => recoveryListeners.delete(listener);
}
export function notifyShardingRecoveryChange(database: string): void {
	for (const listener of recoveryListeners) listener(database);
}

export async function certifyShardingCopy(
	database: string,
	expectedLayout: string,
	expectedScopes = shardingRecoveryScopes(database)
): Promise<void> {
	if (shardingLayout(database) !== expectedLayout) throw new Error('Sharding ownership changed during copy');
	const roots = shardingRecoveryScopes(database);
	if (!roots.length) throw new Error('No database root to certify after sharding copy');
	if (
		roots.length !== expectedScopes.length ||
		roots.some(
			(root) => !expectedScopes.some((expected) => expected.catalog === root.catalog && expected.scope === root.scope)
		)
	)
		throw new Error('Sharding conversion roots changed during copy');
	for (const { catalog, scope } of roots) await catalog.put([certificateKey, expectedLayout], { scope });
	for (const { catalog } of roots) await catalog.flush({ allowWriteStall: true });
	if (shardingCertificate(database) !== expectedLayout)
		throw new Error('Sharding conversion roots changed while certifying copy');
}

export async function revokeShardingCertificate(database: string): Promise<void> {
	const layout = shardingLayout(database);
	if (layout) {
		const roots = shardingNativeRoots(database);
		for (const { root } of roots) Atomics.store(shardingBaselineState(root, database), 0, 0);
		for (const { catalog } of roots) await catalog.remove([certificateKey, layout]);
		for (const { catalog } of roots) await catalog.flush({ allowWriteStall: true });
	}
}

export function agreedPeerShard(peer: string, announced: unknown): number | undefined {
	if (!Number.isInteger(announced)) return;
	const Nodes = getHDBNodeTable();
	// add_node patches the remote row locally; its row origin cannot establish shard authorship.
	// Callers bind the announcement to the authenticated member (or compare it in the direct startup agreement).
	if (Nodes.primaryStore.getSync(peer)?.shard !== announced) return;
	return announced as number;
}

export function admitsShardedCopy(
	ownedLayout: string | undefined,
	localShard: number,
	peerShard: number | undefined,
	peerCertificate: unknown
): boolean {
	return !ownedLayout || (peerShard === localShard && peerCertificate === ownedLayout);
}

export function shardingFailoverShard(database: string, originShard: unknown): unknown {
	return shardingLayout(database) ? getResidencyConfiguration().shard : originShard;
}

export function shardingSourceRequirement(database: string, origin: string): string | undefined {
	if (!shardingLayout(database)) return;
	return `Waiting for origin ${origin} or a complete co-owner of shard ${getResidencyConfiguration().shard}`;
}

export function publishShardingCertificate(
	status: Float64Array,
	shard: number | undefined,
	certificate: unknown
): void {
	const words = new Int32Array(status.buffer, status.byteOffset, status.length * 2);
	const generation = SHARDING_CERTIFICATE_GENERATION_POSITION * 2;
	Atomics.add(words, generation, 1);
	status[SHARDING_PEER_SHARD_POSITION] = shard === undefined ? -1 : shard;
	const valid = typeof certificate === 'string' && /^[a-f0-9]{64}$/.test(certificate);
	for (let i = 0; i < 8; i++)
		Atomics.store(
			words,
			SHARDING_CERTIFICATE_POSITION * 2 + i,
			valid ? parseInt(certificate.slice(i * 8, i * 8 + 8), 16) : 0
		);
	Atomics.add(words, generation, 1);
}

export function peerHasShardingCertificate(status: Float64Array, shard: number, layout: string): boolean {
	if (status[CONNECTION_STATE_POSITION] !== CONNECTION_STATE_CONNECTED) return false;
	const words = new Int32Array(status.buffer, status.byteOffset, status.length * 2);
	const generation = Atomics.load(words, SHARDING_CERTIFICATE_GENERATION_POSITION * 2);
	if (!generation || generation % 2 || status[SHARDING_PEER_SHARD_POSITION] !== shard) return false;
	for (let i = 0; i < 8; i++)
		if (
			Atomics.load(words, SHARDING_CERTIFICATE_POSITION * 2 + i) >>> 0 !==
			parseInt(layout.slice(i * 8, i * 8 + 8), 16)
		)
			return false;
	return generation === Atomics.load(words, SHARDING_CERTIFICATE_GENERATION_POSITION * 2);
}

export function shardingPeerCanRelay(database: string, peer: string): boolean {
	const layout = shardingSourceAgreement(database);
	if (!layout) return true;
	const store = Object.values(databases[database] ?? {}).find((Table) => Table.auditStore)?.auditStore;
	return (
		!!store &&
		peerHasShardingCertificate(
			getReplicationSharedStatus(store, database, peer),
			getResidencyConfiguration().shard,
			layout
		)
	);
}

export function shardingCursorAdmission(
	database: string,
	store: any
): ((source: number, origin: number) => boolean) | undefined {
	if (!shardingLayout(database)) return;
	const sources = new Map<number, boolean>();
	return (source, origin) => {
		if (source === undefined || origin === undefined) return false;
		if (source === origin) return true;
		let admitted = sources.get(source);
		if (admitted === undefined) {
			const name = getNodeNameForId(store, source, true);
			sources.set(source, (admitted = !!name && shardingPeerCanRelay(database, name)));
		}
		return admitted;
	};
}

export function recordShardingWait(database: string, origin: string, waiting: boolean): void {
	const store = Object.values(databases[database] ?? {}).find((Table) => Table.auditStore)?.auditStore;
	if (store) getReplicationSharedStatus(store, database, origin)[SHARDING_WAIT_POSITION] = waiting ? 1 : 0;
}

export function shardingWaitingOrigins(database: string): { origin: string; missingSource: string }[] {
	if (!shardingLayout(database)) return [];
	const store = Object.values(databases[database] ?? {}).find((Table) => Table.auditStore)?.auditStore;
	if (!store) return [];
	return (server.nodes ?? [])
		.filter((node) => getReplicationSharedStatus(store, database, node.name)[SHARDING_WAIT_POSITION] === 1)
		.map((node) => ({ origin: node.name, missingSource: shardingSourceRequirement(database, node.name)! }));
}
