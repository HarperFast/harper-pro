import {
	originReadyWord,
	ORIGIN_READY,
	ORIGIN_BOUND_BUSY,
	recoveryBoundKey,
	recoveryBoundSourceKey,
	recordShardingOriginBound,
} from './shardingOriginAdmission.ts';
import { createHash, randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { databases, getDatabases, databaseResidencyBlockReason, onRemovedDB } from '../core/resources/databases.ts';
import {
	readResidencyMap,
	getResidencyMapTable,
	getResidencyConfiguration,
	assertResidencyEngine,
	setResidencyBaselineGuard,
	acquireResidencyMapFence,
	ResidencyPlacementError,
} from '../core/resources/residencyMaps.ts';
import {
	shardingNativeRoots,
	shardingConvertedTables,
	hasExistingOwnerAssertion,
	shardingBaselineState,
} from '../core/resources/shardingCompleteness.ts';
import { certifyOriginFloor, publishOriginFloor, isValidFloor } from '../core/resources/originClosedFloor.ts';
import {
	persistOriginClosedFloor,
	readOriginClosedFloor,
	getDatabaseGeneration,
	getAuditFloor,
} from '../core/resources/auditStore.ts';
import { server } from '../core/server/Server.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import {
	broadcast,
	onMessageByType,
	requestFromMainThread,
	answerMainThreadRequests,
} from '../core/server/threads/manageThreads.ts';
import * as logger from '../core/utility/logging/harper_logger.ts';
import { exportIdMapping } from '../core/resources/nodeIdMapping.ts';
import { registerShutdownDrain } from '../core/components/shutdownDrain.ts';
import { createBackoff } from './backoff.ts';
import { isResidencyRecord } from './residencyWire.ts';
import {
	agreedPeerShard,
	shardingLayout,
	shardingSourceAgreement,
	shardingCertificate,
	shardingRecoveryScopes,
	certifyShardingCopy,
	notifyShardingRecoveryChange,
} from './shardingRecovery.ts';
import {
	advanceShardingHistory,
	inheritShardingHistory,
	readShardingHistory,
	readShardingBaseline,
	validateShardingFloors,
	frozenShardingOriginFloor,
	type ShardingBootstrapState,
} from './shardingBootstrapState.ts';
import { SHARDING_BOOTSTRAP_OPERATION, setShardingBootstrapHandler } from './shardingBootstrapRpc.ts';

type Member = { name: string; shard: number; [key: string]: any };
type View = {
	database: string;
	shard: number;
	layout: string;
	agreement: string;
	initializer: string;
	members: Member[];
	mapVersion: number;
};
type Request = {
	database: string;
	shard: number;
	agreement: string;
	action: string;
	run?: string;
	expected?: Record<string, string | null>;
};
type RootEvidence = { generation: string; history?: ShardingBootstrapState };
type Evidence = { roots: RootEvidence[]; certificate?: string; floor?: number; bound?: number; priorOrigin?: boolean };
type Diagnostic = { phase: string; reason?: string; shard?: number; backupRequired?: boolean };
const readiness = new Map<string, Map<number, Int32Array>>();
const diagnostics = new Map<string, Uint8Array>();
const localLayouts = new Map<string, string | undefined>();
let enabled = false;
const admittedRoots = new WeakMap<object, Map<string, number>>();
const lostOrigins = new Map<string, string>();
const checkedOrigins = new Map<string, Map<string, string>>();

export class ShardingOriginHistoryLostError extends ResidencyPlacementError {
	constructor(origin: string) {
		super(
			`Sharding origin history lost for ${origin.slice(0, 200)}: restore a complete backup preserving its audit, or rejoin with a fresh root under a new node name`,
			503
		);
	}
}

export function validateShardingOriginEvidence(
	answers: { priorOrigin?: boolean; bound?: number }[],
	origin: string
): number {
	if (answers.some((answer) => answer.priorOrigin === true)) throw new ShardingOriginHistoryLostError(origin);
	if (
		answers.some(
			(answer) =>
				answer.priorOrigin !== false ||
				typeof answer.bound !== 'number' ||
				!Number.isFinite(answer.bound) ||
				answer.bound < 0
		)
	)
		throw new Error(
			'Waiting for prior sharding origin evidence from every member; upgrade peers with incomplete evidence'
		);
	return Math.max(0, ...answers.map((answer) => answer.bound));
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readyWord(database: string, shard: number): Int32Array {
	let shards = readiness.get(database);
	if (!shards) readiness.set(database, (shards = new Map()));
	let word = shards.get(shard);
	if (!word) {
		word = new Int32Array(
			getResidencyMapTable().auditStore.getUserSharedBuffer(['sharding-ready', database, shard], new ArrayBuffer(4))
		);
		shards.set(shard, word);
	}
	return word;
}

function diagnosticBuffer(database: string): Uint8Array {
	let buffer = diagnostics.get(database);
	if (!buffer) {
		buffer = new Uint8Array(
			getResidencyMapTable().auditStore.getUserSharedBuffer(
				['sharding-recovery-status', database],
				new ArrayBuffer(4104)
			)
		);
		diagnostics.set(database, buffer);
	}
	return buffer;
}

function report(database: string, status: Diagnostic): void {
	if (
		lostOrigins.has(database) &&
		lostOrigins.get(database) === JSON.stringify([getThisNodeName(), boundRootGenerations(database)])
	)
		status = {
			phase: 'origin-history-lost',
			reason: new ShardingOriginHistoryLostError(getThisNodeName()).message,
			backupRequired: true,
		};
	const buffer = diagnosticBuffer(database);
	const words = new Int32Array(buffer.buffer, buffer.byteOffset, 2);
	const bytes = Buffer.from(JSON.stringify(status));
	if (bytes.length > buffer.length - 8) throw new Error('Sharding recovery diagnostic is too large');
	Atomics.add(words, 0, 1);
	buffer.set(bytes, 8);
	Atomics.store(words, 1, bytes.length);
	Atomics.add(words, 0, 1);
}

export function shardingBootstrapStatus(database: string): Diagnostic | undefined {
	if (!enabled) return;
	const buffer = diagnosticBuffer(database);
	const words = new Int32Array(buffer.buffer, buffer.byteOffset, 2);
	const generation = Atomics.load(words, 0);
	if (!generation || generation % 2) return { phase: 'waiting', reason: 'Waiting for sharding recovery evidence' };
	try {
		const status = JSON.parse(Buffer.from(buffer.subarray(8, 8 + Atomics.load(words, 1))).toString());
		if (generation === Atomics.load(words, 0)) {
			if (status.phase === 'ready') {
				const held = shardingNativeRoots(database).find(
					({ root }) => !(Atomics.load(originReadyWord(root, database), 0) & ORIGIN_READY)
				);
				if (held)
					return {
						phase: 'waiting',
						reason: `Waiting for sharding origin certification at recovery bound ${held.catalog.getSync([recoveryBoundKey, database]) ?? 'unknown'} from ${held.catalog.getSync([recoveryBoundSourceKey, database]) ?? 'configured origin history'}`,
					};
			}
			return status;
		}
	} catch {}
	return { phase: 'waiting', reason: 'Waiting for sharding recovery evidence' };
}

export function assertShardingStartupReady(database: string, shard: number, root?: object): void {
	if (!enabled) return;
	if (!localLayouts.has(database)) localLayouts.set(database, shardingLayout(database));
	if (
		Atomics.load(readyWord(database, shard), 0) === 1 &&
		(!root || (Atomics.load(originReadyWord(root, database), 0) & ORIGIN_READY) !== 0) &&
		(!root || !localLayouts.get(database) || Atomics.load(shardingBaselineState(root, database), 0) === 1)
	)
		return;
	throw new ResidencyPlacementError(
		shardingBootstrapStatus(database)?.reason ?? `Waiting for shard ${shard} initialization in ${database}`,
		503
	);
}

export function canResumeShardingHistory(database: string, shard: number, requested: number): boolean {
	const layout = shardingLayout(database, shard);
	if (!layout || !isValidFloor(requested)) return false;
	const roots = shardingNativeRoots(database);
	return (
		roots.length > 0 &&
		roots.every(
			({ catalog, auditStore }) =>
				readShardingHistory(catalog, layout)?.phase === 'active' && getAuditFloor(auditStore) <= requested
		)
	);
}

export function shardingOriginStarts(
	database: string
): Record<number, { agreement: string; floor: number }> | undefined {
	if (!enabled || database === 'system') return;
	const map = readResidencyMap(database);
	if (!map) return;
	const roots = shardingNativeRoots(database);
	if (roots.some(({ root }) => !(Atomics.load(originReadyWord(root, database), 0) & ORIGIN_READY))) return;
	const starts = {};
	for (const shard of new Set(map.ranges.map((range) => range.shard))) {
		if (Atomics.load(readyWord(database, shard), 0) !== 1) continue;
		const layout = shardingLayout(database, shard);
		const floors = shardingNativeRoots(database).map(({ catalog }) => readShardingHistory(catalog, layout)?.localFloor);
		if (floors.length && floors.every(isValidFloor))
			starts[shard] = { agreement: shardingSourceAgreement(database, shard), floor: Math.min(...floors) };
	}
	return starts;
}

const originStartKey = Symbol.for('sharding-origin-start');

export async function noteShardingOriginStart(database: string, origin: string, starts: unknown): Promise<void> {
	const layout = shardingLayout(database);
	if (!layout || !origin || !starts || typeof starts !== 'object') return;
	const direct = starts[getResidencyConfiguration().shard];
	if (direct?.agreement !== shardingSourceAgreement(database) || !isValidFloor(direct.floor)) return;
	const key = [originStartKey, layout, origin];
	for (const { catalog } of shardingNativeRoots(database)) {
		const committed = catalog.transactionSync(
			(transaction: any) => {
				const previous = transaction.getSync(key);
				if (!isValidFloor(previous) || direct.floor < previous) transaction.putSync(key, direct.floor);
				return true;
			},
			{ retryOnBusy: true }
		);
		if (committed !== true) throw new Error('Sharding origin starting floor did not commit');
		await catalog.flush({ allowWriteStall: true });
	}
}

export function shardingInitialFloor(database: string, origin: string): number | undefined {
	const layout = shardingCertificate(database);
	if (!layout) return;
	const floors = [];
	for (const { catalog } of shardingNativeRoots(database)) {
		const history = readShardingHistory(catalog, layout);
		const initial = history?.phase === 'active' ? history.floors?.[origin] : undefined;
		const stored = catalog.getSync([originStartKey, layout, origin]);
		const candidates = [initial, stored].filter(isValidFloor);
		if (!candidates.length) return;
		floors.push(Math.min(...candidates));
	}
	return floors.length ? Math.min(...floors) : undefined;
}

async function recordedOriginBound(database: string, origin: string): Promise<number> {
	let bound = 0;
	for (const { root, catalog, auditStore } of shardingNativeRoots(database)) {
		const id = exportIdMapping(auditStore)[origin];
		if (id === undefined) continue;
		for (const { key, value } of catalog.getRange({
			start: Symbol.for('seq'),
			end: [Symbol.for('seq'), Buffer.from([255])],
		})) {
			if (key[1] === id && isValidFloor(value?.seqId)) bound = Math.max(bound, value.seqId);
			for (const state of value?.nodes ?? []) {
				if (state.id !== id) continue;
				for (const value of [state.closedFloor, state.originLogKey, state.lastTxnTime])
					if (isValidFloor(value)) bound = Math.max(bound, value);
			}
		}
		if (id === 0) {
			const copiedBound = catalog.getSync([recoveryBoundKey, database]);
			bound = Math.max(bound, readOriginClosedFloor(auditStore), isValidFloor(copiedBound) ? copiedBound : 0);
		}
		const entries = auditStore.getRange({ log: id, start: Math.max(1, bound) });
		let count = 0;
		for (const entry of entries) {
			if (isValidFloor(entry.txnLogKey)) bound = Math.max(bound, entry.txnLogKey);
			if (++count % 256 === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (root.status === 'closed' || root.status === 'closing') throw new Error('Sharding database is closing');
			}
		}
		if (entries.failedLogs?.size || entries.corruptFrameStop?.breaks)
			throw new Error('Sharding origin recovery bounds require readable audit history');
	}
	return bound;
}

export function missingShardingOriginStart(database: string): boolean {
	if (!Object.values(databases[database] ?? {}).some((Table) => Table.residency)) return false;
	const shards = new Set(readResidencyMap(database)?.ranges.map((range) => range.shard));
	return (
		shards.size > 0 &&
		shardingNativeRoots(database).some(({ catalog }) =>
			[...shards].some(
				(shard) =>
					frozenShardingOriginFloor(
						readShardingHistory(catalog, shardingLayout(database, shard)),
						getThisNodeName()
					) === undefined
			)
		)
	);
}

export async function hasPriorShardingOrigin(database: string, layout: string, origin: string): Promise<boolean> {
	const conversions = shardingConvertedTables(database);
	for (const { root, catalog, auditStore } of shardingNativeRoots(database)) {
		if (
			isValidFloor(readShardingHistory(catalog, layout)?.floors?.[origin]) ||
			isValidFloor(catalog.getSync([originStartKey, layout, origin]))
		)
			return true;
		const id = exportIdMapping(auditStore)[origin];
		if (id === undefined) continue;
		const converted = new Set(conversions.find((entry) => entry.catalog === catalog)?.tables.map(({ name }) => name));
		const tables = new Map(
			Object.values(databases[database] ?? {})
				.filter((Table) => Table.residency && Table.auditStore === auditStore)
				.map((Table) => [Table.tableId, !converted.has(Table.tableName)])
		);
		const entries = auditStore.getRange({ log: id, start: 1 });
		let count = 0;
		for (const entry of entries) {
			if (typeof entry.type !== 'string') throw new Error('Sharding admission requires readable prior-origin history');
			if (
				tables.has(entry.tableId) &&
				isResidencyRecord(entry.type) &&
				(tables.get(entry.tableId) || entry.residencySlot !== undefined || entry.previousResidencySlot !== undefined)
			)
				return true;
			if (++count % 256 === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (root.status === 'closed' || root.status === 'closing') throw new Error('Sharding database is closing');
			}
		}
		if (entries.failedLogs?.size || entries.corruptFrameStop?.breaks)
			throw new Error('Sharding admission requires readable prior-origin history');
	}
	return false;
}

async function checkNewShardingOrigin(current: View, refreshEvidence = true): Promise<number | undefined> {
	const name = getThisNodeName();
	const roots = shardingNativeRoots(current.database);
	if (
		roots.every(
			({ catalog }) => frozenShardingOriginFloor(readShardingHistory(catalog, current.layout), name) !== undefined
		)
	)
		return;
	const generation = JSON.stringify([name, boundRootGenerations(current.database)]);
	if (lostOrigins.get(current.database) === generation) throw new ShardingOriginHistoryLostError(name);
	try {
		if (
			(await hasPriorShardingOrigin(current.database, current.layout, name)) ||
			roots.some(({ catalog }) => {
				const history = readShardingHistory(catalog, current.layout);
				return (
					(history?.localFloor !== undefined || history?.localOrigin !== undefined) && history.localOrigin !== name
				);
			})
		)
			throw new ShardingOriginHistoryLostError(name);
		const evidenceScope = JSON.stringify([generation, current.agreement]);
		if (!refreshEvidence && checkedOrigins.get(current.database)?.get(current.layout) === evidenceScope) return;
		const answers = await Promise.allSettled(
			current.members.filter((member) => member.name !== name).map((member) => call(member, current, 'origin-bound'))
		);
		const bound = validateShardingOriginEvidence(
			answers.map((answer) => (answer.status === 'fulfilled' ? answer.value : {})),
			name
		);
		let layouts = checkedOrigins.get(current.database);
		if (!layouts) checkedOrigins.set(current.database, (layouts = new Map()));
		layouts.set(current.layout, evidenceScope);
		return bound;
	} catch (error) {
		if (error instanceof ShardingOriginHistoryLostError) {
			lostOrigins.set(current.database, generation);
			logger.warn?.(`${current.database}: ${error.message}`);
		}
		throw error;
	}
}

const ORIGIN_BOUND_REQUEST = 'sharding-origin-bound';

function boundRootGenerations(database: string): string[] {
	const generations = shardingNativeRoots(database).map(({ auditStore }) => getDatabaseGeneration(auditStore)?.id);
	if (generations.some((generation) => !generation))
		throw new ResidencyPlacementError('Sharding recovery requires a durable local root generation', 503);
	return generations.sort();
}

function assertBoundRootGenerations(database: string, expected: string[]): void {
	const current = boundRootGenerations(database);
	if (current.length !== expected.length || current.some((generation, index) => generation !== expected[index]))
		throw new ResidencyPlacementError('Sharding database changed during origin recovery', 503);
}

async function requestOriginBound(
	action: 'copy' | 'resume',
	database: string,
	bound: number,
	source: string
): Promise<void> {
	const generations = boundRootGenerations(database);
	try {
		await requestFromMainThread(ORIGIN_BOUND_REQUEST, { action, database, bound, source, generations }, 30_000);
	} catch (error) {
		throw Object.assign(new ResidencyPlacementError(`Sharding origin recovery refused: ${error.message}`, 503), {
			cause: error,
		});
	}
	assertBoundRootGenerations(database, generations);
}

export async function receiveShardingOriginBound({ action, database, bound, source, generations }): Promise<void> {
	if (!isMainThread) throw new Error('Sharding origin bounds must be persisted by the main thread');
	if (
		!['copy', 'resume'].includes(action) ||
		typeof database !== 'string' ||
		typeof source !== 'string' ||
		!isValidFloor(bound) ||
		!Array.isArray(generations)
	)
		throw new ResidencyPlacementError('Invalid sharding origin recovery request', 503);
	getDatabases();
	assertBoundRootGenerations(database, generations);
	if (action === 'copy') await noteShardingCopyBound(database, bound, source);
	else await noteShardingResumeBound(database, bound, source);
	assertBoundRootGenerations(database, generations);
}

export async function noteShardingCopyBound(database: string, bound: number, source: string): Promise<void> {
	const roots = shardingNativeRoots(database);
	if (
		roots.every(
			({ root, auditStore }) =>
				Atomics.load(originReadyWord(root, database), 0) & ORIGIN_READY && readOriginClosedFloor(auditStore) >= bound
		)
	)
		return;
	if (!isMainThread) return requestOriginBound('copy', database, bound, source);
	for (const { root, catalog, auditStore } of roots) {
		if (Atomics.load(originReadyWord(root, database), 0) & ORIGIN_READY && readOriginClosedFloor(auditStore) >= bound)
			continue;
		await recordShardingOriginBound(root, catalog, database, bound, source);
	}
}

export async function noteShardingResumeBound(database: string, requested: number, source: string): Promise<void> {
	if (!enabled || !isValidFloor(requested) || !readResidencyMap(database)) return;
	const roots = shardingNativeRoots(database);
	for (const { root, auditStore } of roots) {
		const candidate = certifyOriginFloor(root);
		if (candidate !== undefined && candidate !== null) {
			persistOriginClosedFloor(auditStore, candidate);
			publishOriginFloor(root, candidate);
		}
	}
	if (roots.every(({ auditStore }) => readOriginClosedFloor(auditStore) >= requested)) return;
	if (!isMainThread) return requestOriginBound('resume', database, requested, source);
	for (const word of readiness.get(database)?.values() ?? []) Atomics.store(word, 0, 0);
	for (const { root, catalog } of roots) await recordShardingOriginBound(root, catalog, database, requested, source);
	throw new ResidencyPlacementError(
		`Waiting for local sharding origin certification to reach peer recovery bound ${requested} from ${source}`,
		503
	);
}

async function enableOrigin(current: View, priorBound = 0): Promise<void> {
	const roots = shardingNativeRoots(current.database);
	const pending = roots
		.map((stores) => ({
			...stores,
			admission: Atomics.load(originReadyWord(stores.root, current.database), 0) & ~ORIGIN_READY,
		}))
		.filter(({ root, admission }) => admittedRoots.get(root)?.get(current.layout) !== admission);
	if (pending.some(({ admission }) => admission & ORIGIN_BOUND_BUSY))
		throw new Error('Waiting for a sharding origin recovery bound to become durable');
	if (!pending.length) {
		Atomics.store(readyWord(current.database, current.shard), 0, 1);
		return;
	}
	Atomics.store(readyWord(current.database, current.shard), 0, 0);
	const bound = Math.max(priorBound, await recordedOriginBound(current.database, getThisNodeName()));
	for (const { root, catalog, auditStore, admission } of pending) {
		if (root.status === 'closed' || root.status === 'closing') throw new Error('Sharding database is closing');
		const history = readShardingHistory(catalog, current.layout);
		if (history?.phase !== 'active') throw new Error('Waiting for established sharding history');
		const storedBound = catalog.getSync([recoveryBoundKey, current.database]);
		const required = Math.max(
			bound,
			isValidFloor(storedBound) ? storedBound : 0,
			history.localFloor ?? 0,
			history.floors?.[getThisNodeName()] ?? 0
		);
		if (history.localFloor === undefined && !hasExistingOwnerAssertion(current.database)) {
			const tables = new Map(
				Object.values(databases[current.database])
					.filter((Table) => Table.residency && Table.auditStore === auditStore)
					.map((Table) => [Table.tableId, Table])
			);
			let count = 0;
			const entries = auditStore.getRange({ log: 0, start: 1 });
			for (const entry of entries) {
				if (typeof entry.type !== 'string')
					throw new Error('Sharding origin initialization requires readable audit history');
				if (tables.has(entry.tableId) && isResidencyRecord(entry.type))
					throw new Error(
						'Local sharding history has no frozen origin start; restore a complete backup or rejoin with a fresh root under a new node name'
					);
				if (++count % 256 === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					if (root.status === 'closed' || root.status === 'closing') throw new Error('Sharding database is closing');
				}
			}
			if (entries.failedLogs?.size || entries.corruptFrameStop?.breaks)
				throw new Error('Sharding origin initialization requires readable audit history');
		}
		const candidate = certifyOriginFloor(root);
		if (candidate === null)
			throw new Error(`Waiting for a local origin reservation to close before sharding bound ${required}`);
		if (candidate !== undefined) {
			persistOriginClosedFloor(auditStore, candidate);
			publishOriginFloor(root, candidate);
		}
		const floor = readOriginClosedFloor(auditStore);
		if (!isValidFloor(floor) || floor < required)
			throw new Error(
				`Waiting for sharding origin floor ${floor} to reach recovery bound ${required} from ${catalog.getSync([recoveryBoundSourceKey, current.database]) ?? 'configured origin history'}`
			);
		if (history.localFloor === undefined)
			advanceShardingHistory(catalog, current.layout, {
				...history,
				localFloor: floor,
				localOrigin: getThisNodeName(),
			});
		await catalog.flush({ allowWriteStall: true });
		if (root.status === 'closed' || root.status === 'closing') throw new Error('Sharding database is closing');
		if ((Atomics.load(originReadyWord(root, current.database), 0) & ~ORIGIN_READY) !== admission)
			throw new Error('Sharding recovery bound changed during origin certification');
		let layouts = admittedRoots.get(root);
		if (!layouts) admittedRoots.set(root, (layouts = new Map()));
		layouts.set(current.layout, admission);
	}
	Atomics.store(readyWord(current.database, current.shard), 0, 1);
	await broadcast({ type: 'sharding-baseline-changed', database: current.database }, true);
}

function view(database: string, shard: number): View {
	if (process.env.HARPER_TEST_OMIT_REPLICATION_CAPABILITIES === '1')
		throw new Error('Local node does not advertise sharding recovery admission');
	if (typeof database !== 'string' || !Object.hasOwn(databases, database) || database === 'system')
		throw new Error('Unknown sharded database');
	const blocked = databaseResidencyBlockReason(database);
	if (blocked) throw new Error(blocked);
	assertResidencyEngine(database);
	const map = readResidencyMap(database);
	const policies = Object.values(databases[database])
		.filter((Table) => Table.residency)
		.map((Table) => [Table.tableName, Table.residency])
		.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
	if (!map || !policies.length || !Number.isInteger(shard) || !map.ranges.some((range) => range.shard === shard))
		throw new Error('No installed sharding policy for this shard');
	const configuration = getResidencyConfiguration();
	const members: Member[] = [{ name: getThisNodeName(), shard: configuration.shard }];
	for (const node of server.nodes ?? []) {
		if (node.name === getThisNodeName()) continue;
		const authored = agreedPeerShard(node.name, node.shard);
		if (authored === undefined) throw new Error(`Waiting for authenticated shard membership from ${node.name}`);
		members.push({ ...node, shard: authored });
	}
	members.sort((a, b) => a.name.localeCompare(b.name));
	for (const range of map.ranges)
		if (!members.some((member) => member.shard === range.shard))
			throw new Error(`Waiting for a member of shard ${range.shard}`);
	const initializer = members.find((member) => member.shard === shard)?.name;
	if (!initializer) throw new Error(`Waiting for an owner of shard ${shard}`);
	return {
		database,
		shard,
		members,
		initializer,
		mapVersion: map.version,
		layout: shardingLayout(database, shard),
		agreement: digest([map.digest, policies, configuration.digest, members.map(({ name, shard }) => [name, shard])]),
	};
}

async function flushRoots(database: string): Promise<void> {
	for (const { catalog } of shardingNativeRoots(database)) await catalog.flush({ allowWriteStall: true });
}

function evidence(current: View): Evidence {
	return {
		roots: shardingNativeRoots(current.database).map(({ catalog, auditStore }) => ({
			generation: getDatabaseGeneration(auditStore)?.id,
			history: readShardingHistory(catalog, current.layout),
		})),
		certificate: shardingCertificate(current.database),
	};
}

async function call(member: Member, current: View, action: string, extra: Partial<Request> = {}): Promise<Evidence> {
	const request = {
		operation: SHARDING_BOOTSTRAP_OPERATION,
		from: getThisNodeName(),
		database: current.database,
		shard: current.shard,
		agreement: current.agreement,
		action,
		...extra,
	};
	if (member.name === getThisNodeName()) return receive(request, member.name);
	try {
		return await (server.replication.sendOperationToNode as any)(member, request, { timeoutMs: 5000 });
	} catch (error) {
		throw new Error(`Waiting for ${member.name} at sharding ${action}: ${error.message}`, { cause: error });
	}
}

function localSeed(current: View): void {
	if (shardingCertificate(current.database) === current.layout || hasExistingOwnerAssertion(current.database)) return;
	if (shardingConvertedTables(current.database).some((root) => root.tables.length))
		throw new Error(
			`Missing existing-owner completeness assertion: run initialize_shard_map for ${current.database} with existing_owner and expected_digest`
		);
	if (current.mapVersion !== 1)
		throw new Error('A noninitial shard map requires a complete co-owner or backup restore');
	for (const Table of Object.values(databases[current.database])) {
		if (!Table.residency) continue;
		for (const entry of Table.primaryStore.getRange({ start: true })) {
			const slot = Table.residency.byAttribute ? entry.residencySlot : Table.getResidencySlot(entry.key);
			if (
				slot === undefined ||
				readResidencyMap(current.database).ranges.some(
					(range) => range.shard === current.shard && range.start <= slot && range.end > slot
				)
			)
				throw new Error(
					'Owned sharding data has no certified baseline; a complete co-owner or backup restore is required'
				);
		}
	}
}

function requireRun(current: View, run: string): void {
	for (const { catalog } of shardingNativeRoots(current.database)) {
		const history = readShardingHistory(catalog, current.layout);
		if (history?.run !== run || history.agreement !== current.agreement)
			throw new Error('Sharding coordinator run or agreement changed');
	}
}

async function receive(request: Request, member: string): Promise<Evidence> {
	const current = view(request.database, request.shard);
	if (!current.members.some((candidate) => candidate.name === member) || request.agreement !== current.agreement)
		throw new Error('Sharding membership, map or policy agreement differs');
	if (request.action === 'origin-bound') {
		await flushRoots(current.database);
		return {
			...evidence(current),
			bound: await recordedOriginBound(current.database, member),
			priorOrigin: await hasPriorShardingOrigin(current.database, current.layout, member),
		};
	}
	if (request.action === 'inspect') {
		await flushRoots(current.database);
		return evidence(current);
	}
	if (typeof request.run !== 'string' || !request.run || request.run.length > 128)
		throw new Error('Invalid sharding coordinator run');
	if (request.action !== 'floor' && request.action !== 'witness-proof' && member !== current.initializer)
		throw new Error('Only the agreed initial owner may coordinate sharding startup');
	const roots = shardingNativeRoots(current.database);
	if (request.action === 'begin') {
		if (!request.expected || Object.keys(request.expected).length !== roots.length)
			throw new Error('Sharding grant requires the observed native root set');
		for (const { auditStore, catalog } of roots) {
			const generation = getDatabaseGeneration(auditStore)?.id;
			if (!generation || !Object.hasOwn(request.expected, generation))
				throw new Error('Sharding native root generation changed');
			const previous = readShardingHistory(catalog, current.layout);
			if (previous?.run === request.run && previous.agreement === current.agreement) continue;
			advanceShardingHistory(
				catalog,
				current.layout,
				{ initializer: current.initializer, agreement: current.agreement, run: request.run, phase: 'began' },
				false,
				request.expected[generation] ?? undefined
			);
		}
	} else {
		requireRun(current, request.run);
		if (request.action === 'floor') {
			for (const { root, catalog, auditStore } of roots) {
				const history = readShardingHistory(catalog, current.layout);
				if (history.localFloor !== undefined) continue;
				const candidate = certifyOriginFloor(root);
				if (candidate === null) throw new Error('Waiting for a reserved local origin key to close');
				if (candidate !== undefined) {
					persistOriginClosedFloor(auditStore, candidate);
					publishOriginFloor(root, candidate);
				}
				const floor = readOriginClosedFloor(auditStore);
				if (!isValidFloor(floor)) throw new Error('No durable local origin floor is available');
				advanceShardingHistory(catalog, current.layout, {
					...history,
					localFloor: floor,
					localOrigin: getThisNodeName(),
				});
			}
		} else if (request.action === 'witness') {
			const answers = await Promise.all(
				current.members.map((candidate) => call(candidate, current, 'floor', { run: request.run }))
			);
			const floors = Object.fromEntries(
				current.members.map((candidate, index) => [candidate.name, answers[index].floor])
			);
			validateShardingFloors(
				floors,
				current.members.map((candidate) => candidate.name)
			);
			requireRun(current, request.run);
			const initial = current.initializer === getThisNodeName();
			const release = acquireResidencyMapFence(current.database, {});
			try {
				if (initial) localSeed(current);
				for (const { catalog, scope } of shardingRecoveryScopes(current.database)) {
					const history = readShardingHistory(catalog, current.layout);
					advanceShardingHistory(catalog, current.layout, { ...history, phase: 'witnessed', floors, scope }, initial);
				}
			} finally {
				release();
			}
		} else if (request.action === 'activate') {
			const proofs = await Promise.all(
				current.members.map((candidate) => call(candidate, current, 'witness-proof', { run: request.run }))
			);
			const local = readShardingHistory(roots[0].catalog, current.layout);
			if (
				proofs.some(
					(proof) =>
						!proof.roots.length ||
						proof.roots.some(
							(root) =>
								root.history?.run !== request.run ||
								root.history.agreement !== current.agreement ||
								!['witnessed', 'active'].includes(root.history.phase) ||
								digest(root.history.floors) !== digest(local.floors)
						)
				)
			)
				throw new Error('Waiting for every member’s durable sharding witness');
			requireRun(current, request.run);
			for (const { catalog } of roots)
				advanceShardingHistory(catalog, current.layout, {
					...readShardingHistory(catalog, current.layout),
					phase: 'active',
				});
		} else if (request.action !== 'witness-proof') throw new Error('Unknown private sharding bootstrap action');
	}
	await flushRoots(current.database);
	const result = evidence(current);
	if (request.action === 'floor') result.floor = Math.min(...result.roots.map((root) => root.history.localFloor));
	return result;
}

async function coordinate(current: View): Promise<void> {
	const local = shardingNativeRoots(current.database);
	if (local.every(({ catalog }) => readShardingHistory(catalog, current.layout)?.phase === 'active')) {
		return;
	}
	const inspections = await Promise.allSettled(current.members.map((member) => call(member, current, 'inspect')));
	const reports = inspections.filter((result) => result.status === 'fulfilled').map((result) => result.value);
	const histories = reports.flatMap((report) => report.roots.map((root) => root.history).filter(Boolean));
	const established = histories.find((history) => history.phase === 'active');
	if (established) {
		for (const { catalog } of shardingNativeRoots(current.database))
			inheritShardingHistory(catalog, current.layout, established);
		await flushRoots(current.database);
		return;
	}
	const failed = inspections.find((result) => result.status === 'rejected');
	if (failed) throw failed.reason;
	if (current.initializer !== getThisNodeName())
		throw new Error(`Waiting for initial owner ${current.initializer} of shard ${current.shard}`);
	localSeed(current);
	const witnessed = histories.find((history) => history.phase === 'witnessed');
	if (witnessed && witnessed.agreement !== current.agreement)
		throw new Error(
			'Sharding membership changed after a durable witness; restore agreement or recover from a complete co-owner'
		);
	const run =
		witnessed?.run ?? histories.find((history) => history.agreement === current.agreement)?.run ?? randomUUID();
	for (let i = 0; i < current.members.length; i++) {
		if (reports[i].roots.every((root) => root.history?.run === run)) continue;
		await call(current.members[i], current, 'begin', {
			run,
			expected: Object.fromEntries(reports[i].roots.map((root) => [root.generation, root.history?.run ?? null])),
		});
	}
	await Promise.all(current.members.map((member) => call(member, current, 'witness', { run })));
	await Promise.all(current.members.map((member) => call(member, current, 'activate', { run })));
}

async function publishLocalBaseline(database: string): Promise<void> {
	const release = acquireResidencyMapFence(database, {});
	let changed = false;
	try {
		const layout = shardingLayout(database);
		localLayouts.set(database, layout);
		if (!layout) return;
		const scopes = shardingRecoveryScopes(database);
		if (shardingCertificate(database) !== layout) {
			const witnessed = scopes.every(({ catalog, scope }) => readShardingBaseline(catalog, layout)?.scope === scope);
			const asserted =
				scopes.every(({ catalog }) => readShardingHistory(catalog, layout)?.phase === 'active') &&
				hasExistingOwnerAssertion(database);
			if (asserted && !witnessed)
				for (const shard of new Set(readResidencyMap(database)?.ranges.map((range) => range.shard)))
					await checkNewShardingOrigin(view(database, shard));
			if (witnessed || asserted) await certifyShardingCopy(database, layout, scopes);
		}
		const certified = shardingCertificate(database) === layout;
		if (
			certified &&
			shardingNativeRoots(database).some(({ root }) => Atomics.load(shardingBaselineState(root, database), 0) !== 1)
		)
			await flushRoots(database);
		for (const { root } of shardingNativeRoots(database))
			if (Atomics.exchange(shardingBaselineState(root, database), 0, certified ? 1 : 0) !== Number(certified))
				changed = true;
	} finally {
		release();
	}
	if (changed) await broadcast({ type: 'sharding-baseline-changed', database }, true);
}

export function startShardingBootstrap(): void {
	if (enabled) return;
	enabled = true;
	setShardingBootstrapHandler(receive);
	onMessageByType('sharding-baseline-changed', ({ database }) => {
		localLayouts.delete(database);
		notifyShardingRecoveryChange(database);
	});
	setResidencyBaselineGuard((database, root) => {
		if (!localLayouts.get(database)) localLayouts.set(database, shardingLayout(database));
		if (!localLayouts.get(database) || Atomics.load(shardingBaselineState(root, database), 0) === 1) return;
		return shardingBootstrapStatus(database)?.reason ?? 'Waiting for a complete sharding baseline';
	});
	onRemovedDB((database) => {
		for (const word of readiness.get(database)?.values() ?? []) Atomics.store(word, 0, 0);
		readiness.delete(database);
		diagnostics.delete(database);
		localLayouts.delete(database);
		lostOrigins.delete(database);
		checkedOrigins.delete(database);
	});
	if (!isMainThread) return;
	answerMainThreadRequests(ORIGIN_BOUND_REQUEST, receiveShardingOriginBound);
	const backoffs = new Map<string, { backoff: ReturnType<typeof createBackoff>; next: number }>();
	let running = false;
	let stopped = false;
	const tick = async () => {
		if (running || stopped) return;
		running = true;
		try {
			getDatabases();
			for (const [database, tables] of Object.entries(databases)) {
				if (!Object.values(tables).some((Table) => Table.residency)) continue;
				let retry = backoffs.get(database);
				if (!retry)
					backoffs.set(
						database,
						(retry = { backoff: createBackoff({ initialMs: 500, maxMs: 5000, minMs: 250 }), next: 0 })
					);
				if (retry.next > Date.now()) continue;
				try {
					await publishLocalBaseline(database);
					const origins = [];
					for (const shard of new Set(readResidencyMap(database)?.ranges.map((range) => range.shard))) {
						const current = view(database, shard);
						await coordinate(current);
						await checkNewShardingOrigin(current, false);
						origins.push(current);
					}
					await publishLocalBaseline(database);
					if (localLayouts.get(database) && !shardingCertificate(database)) {
						const converted = shardingConvertedTables(database).some((root) => root.tables.length);
						const reason =
							converted && !hasExistingOwnerAssertion(database)
								? 'Missing existing-owner completeness assertion through initialize_shard_map'
								: 'Waiting for a certified same-shard copy; if the entire shard was lost, restore a complete backup';
						report(database, { phase: 'recovery-required', reason, backupRequired: true });
					} else {
						for (const current of origins) await enableOrigin(current, await checkNewShardingOrigin(current));
						for (const { root } of shardingNativeRoots(database)) {
							const word = originReadyWord(root, database);
							const state = Atomics.load(word, 0);
							const layouts = admittedRoots.get(root);
							if (
								state & ORIGIN_BOUND_BUSY ||
								[...new Set(readResidencyMap(database).ranges.map((range) => range.shard))].some(
									(shard) => layouts?.get(shardingLayout(database, shard)) !== (state & ~ORIGIN_READY)
								) ||
								Atomics.compareExchange(word, 0, state, state | ORIGIN_READY) !== state
							)
								throw new Error('Sharding recovery bound changed before origin enablement');
						}
						report(database, { phase: 'ready' });
					}
					retry.backoff.reset();
					retry.next = Date.now() + 1000;
				} catch (error) {
					report(database, {
						phase: error instanceof ShardingOriginHistoryLostError ? 'origin-history-lost' : 'waiting',
						reason: String(error.message).slice(0, 700),
						...(error instanceof ShardingOriginHistoryLostError ? { backupRequired: true } : {}),
					});
					retry.next = Date.now() + retry.backoff.nextDelay();
				}
			}
		} catch (error) {
			logger.warn?.('Sharding initialization could not inspect local databases', error);
		} finally {
			running = false;
		}
	};
	const timer = setInterval(() => {
		void tick();
	}, 500).unref();
	registerShutdownDrain({
		hasWork: () => false,
		async drain() {
			stopped = true;
			clearInterval(timer);
		},
	});
	void tick();
}
