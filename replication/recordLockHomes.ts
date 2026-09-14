/**
 * The operator-agreed home map (harper-pro#825, `docs/record-lock-ownership.md` §4), inside
 * PR #822. Durable, per-database `{active, staged}` state and the operations that transition
 * it — never derived from `hdb_nodes` membership or liveness (§4.1: "no node ever derives,
 * proposes or advances one from what it observes").
 *
 * Storage is a dedicated, `LOCAL_ONLY` system table, `hdb_record_lock_homes` — never
 * replicated or LWW-merged with a peer's copy, exactly like `recordLockIncarnation`'s existing
 * per-node row, but its own table rather than a field grafted onto `hdb_nodes` (a shared-row
 * blob patch cannot give two databases' concurrent transitions per-row atomicity).
 *
 * The transition (§4.3 stage → quiesce/fence → drain → activate) is **operator-timed, not
 * node-timed**, after two planning-review rounds rejected a purely local mechanism:
 * `record_lock_stage_generation` atomically retracts this node's `active` generation in the
 * same durable write that records the new one is staged — so the operation's success response
 * IS real quiescence evidence, with no gap between "told about g+1" and "stopped granting
 * under g." `record_lock_activate_generation` is a separate, explicit operator call, issued
 * only after the operator has, externally, collected a successful stage (or
 * `record_lock_fence_external`) response from every node in `homes(g) ∪ homes(g+1)` and waited
 * `DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS` from the *last* one — no node ever measures that
 * elapsed time itself (a restart or clock correction would make a self-measured wait unsound);
 * every node only ever checks *consistency* (does this activation match what I staged), never
 * *elapsed time*. See RECORD_LOCK_HOMES_DESIGN.md for the two rejected mechanisms and why.
 */
import { createHash } from 'node:crypto';
import Joi from 'joi';
import { table } from '../core/resources/databases.ts';
import { transaction } from '../core/resources/transaction.ts';
import { DELEGATION_LEASE_MS, LOCK_LEASE_SKEW_MS } from '../core/resources/recordLockCoordinator.ts';
import { validateBySchema } from '../core/validation/validationWrapper.js';
import { handleHDBError, hdbErrors, ClientError } from '../core/utility/errors/hdbError.js';
import * as logger from '../core/utility/logging/harper_logger.js';
import { server } from '../core/server/Server.ts';
const { HTTP_STATUS_CODES } = hdbErrors;

const MAX_HOMES = 256;
/** See `planActivate`'s comment: a backstop, not the safety mechanism. Overridable so a test that
 * deliberately exercises "activate arrived too soon" does not need to wait even this long. */
export const MIN_DRAIN_BACKSTOP_MS = Number.isFinite(Number(process.env.HARPER_TEST_RECORD_LOCK_MIN_DRAIN_BACKSTOP_MS))
	? Number(process.env.HARPER_TEST_RECORD_LOCK_MIN_DRAIN_BACKSTOP_MS)
	: 2_000;
const MAX_NODE_NAME_LENGTH = 256;

export interface RecordLockGenerationState {
	generation: number;
	homes: string[];
	digest: string;
	/** Set only on `staged`. Backstop only — see `MIN_DRAIN_BACKSTOP_MS` below. */
	stagedAt?: number;
}

export interface RecordLockHomesRow {
	database: string;
	active?: RecordLockGenerationState;
	staged?: RecordLockGenerationState;
	highestActedOn: number;
	fenced: { node: string; operator: string; at: number }[];
}

// ---- change notification: fires only on THIS thread's own write; recordLockTransport.ts is what
// bridges that to every other thread (it, not this generic storage module, knows the thread topology).
const changeListeners = new Set<(database: string) => void>();
export function onRecordLockHomesChanged(listener: (database: string) => void): () => void {
	changeListeners.add(listener);
	return () => changeListeners.delete(listener);
}
function notifyChanged(database: string): void {
	for (const listener of changeListeners) listener(database);
}

let recordLockHomesTable: any;

/** `LOCAL_ONLY` — never replicated. One row per database; never merged with a peer's copy. */
export function getRecordLockHomesTable() {
	return (
		recordLockHomesTable ||
		(recordLockHomesTable = table({
			table: 'hdb_record_lock_homes',
			database: 'system',
			attributes: [
				{ name: 'database', isPrimaryKey: true },
				{ attribute: 'active' },
				{ attribute: 'staged' },
				{ attribute: 'highestActedOn' },
				{ attribute: 'fenced' },
			],
		}) as any)
	);
}

/**
 * Canonicalize (sort, dedup) before storing or hashing, so operator-typed order never produces
 * a spurious digest mismatch between two nodes that agree on the actual set.
 */
export function canonicalizeHomes(homes: string[]): string[] {
	return [...new Set(homes)].sort();
}

/**
 * Length-prefixed, not delimiter-joined: `['A','B']` and `['A\0B']` must not collide (a real
 * gap in an earlier draft of this module — see RECORD_LOCK_HOMES_DESIGN.md §5). Big-endian
 * uint32 length prefixes on both the count and every element.
 */
export function digestOf(generation: number, homes: string[]): string {
	const hash = createHash('sha256');
	const u32 = Buffer.alloc(4);
	u32.writeUInt32BE(generation >>> 0);
	hash.update(u32);
	u32.writeUInt32BE(homes.length);
	hash.update(u32);
	for (const home of homes) {
		const bytes = Buffer.from(home, 'utf8');
		u32.writeUInt32BE(bytes.length);
		hash.update(u32);
		hash.update(bytes);
	}
	return hash.digest('hex');
}

export function validateGenerationInput(generation: unknown, homes: unknown): asserts homes is string[] {
	if (!(typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0))
		throw new ClientError('generation must be a positive integer', 400);
	if (!Array.isArray(homes) || homes.length === 0 || homes.length > MAX_HOMES)
		throw new ClientError(`homes must be a non-empty array of at most ${MAX_HOMES} node names`, 400);
	for (const home of homes) {
		if (typeof home !== 'string' || home.length === 0 || home.length > MAX_NODE_NAME_LENGTH)
			throw new ClientError('every home must be a non-empty, bounded node name', 400);
	}
}

async function readRow(database: string): Promise<RecordLockHomesRow | undefined> {
	return getRecordLockHomesTable().primaryStore.get(database);
}

async function writeRow(row: RecordLockHomesRow): Promise<void> {
	const writeContext: any = {};
	await transaction(writeContext, async (txn) => {
		const context = (txn as any).getContext();
		const resource: any = await getRecordLockHomesTable().getResource(row.database, context, { async: true });
		await resource._writeUpdate(row.database, row, true, { localOnly: true });
		await resource.save?.();
	});
}

function operatorPrincipal(request: any): string {
	// `hdb_user` is the authenticated principal the operation dispatcher attached; never a request
	// body field, which a caller could set to forge attribution on the audit-only `fenced[]` list.
	const name = request?.hdb_user?.name;
	if (typeof name !== 'string' || name.length === 0)
		throw new ClientError('record lock home map operations require an authenticated user', 401);
	return name;
}

const stageSchema = Joi.object({
	database: Joi.string().required(),
	generation: Joi.number().required(),
	homes: Joi.array().required(),
});

/**
 * Atomically stages `g+1` and retracts `active` in the same durable write, so a successful
 * response IS real quiescence: this node stops granting under the old generation the instant
 * this call returns, not after some later observed condition.
 */
export type StagePlan =
	| { action: 'noop'; staged: RecordLockGenerationState }
	| { action: 'reject'; reason: string }
	| { action: 'write'; row: RecordLockHomesRow };

/**
 * Pure decision over the row's current state — no storage I/O, so the monotonicity, idempotency
 * and replay rules are unit-testable directly. `stage` atomically retracts `active` in the same
 * plan: there is no state where `staged` is set and the old `active` still is (round 2's blocker
 * on quiescence not being immediate — see RECORD_LOCK_HOMES_DESIGN.md §2).
 */
export function planStage(
	existing: RecordLockHomesRow | undefined,
	database: string,
	generation: number,
	homes: string[],
	digest: string,
	now: number = Date.now()
): StagePlan {
	const floor = Math.max(
		existing?.active?.generation ?? 0,
		existing?.staged?.generation ?? 0,
		existing?.highestActedOn ?? 0
	);
	if (existing?.staged?.generation === generation) {
		if (existing.staged.digest === digest) return { action: 'noop', staged: existing.staged };
		return { action: 'reject', reason: `generation ${generation} is already staged with a different home set` };
	}
	if (generation <= floor) return { action: 'reject', reason: `generation ${generation} is not greater than ${floor}` };
	const staged: RecordLockGenerationState = { generation, homes, digest, stagedAt: now };
	return {
		action: 'write',
		row: {
			database,
			active: undefined,
			staged,
			highestActedOn: Math.max(floor, generation),
			fenced: existing?.fenced ?? [],
		},
	};
}

export async function stageGeneration(request: any): Promise<{ staged: RecordLockGenerationState }> {
	const validation = validateBySchema(request, stageSchema);
	if (validation)
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	const { database } = request;
	validateGenerationInput(request.generation, request.homes);
	const homes = canonicalizeHomes(request.homes);
	const generation = request.generation;
	const digest = digestOf(generation, homes);
	const existing = await readRow(database);
	const plan = planStage(existing, database, generation, homes, digest);
	if (plan.action === 'reject') throw new ClientError(plan.reason, 409);
	if (plan.action === 'noop') return { staged: plan.staged };
	await writeRow(plan.row);
	logger.info?.(`Record lock home map for ${database}: staged generation ${generation}, retracted active`);
	notifyChanged(database);
	return { staged: plan.row.staged! };
}

const fenceSchema = Joi.object({
	database: Joi.string().required(),
	node: Joi.string().required(),
});

/**
 * Audit-only: the operator's durable attestation that an unreachable node was stopped outside
 * Harper. No grant path consults this list — its safety is the operator's own action, not
 * anything Harper verifies (see the module comment).
 */
export async function fenceExternal(request: any): Promise<{ fenced: true }> {
	const validation = validateBySchema(request, fenceSchema);
	if (validation)
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	const operator = operatorPrincipal(request);
	const { database, node } = request;
	const existing = await readRow(database);
	await writeRow({
		database,
		active: existing?.active,
		staged: existing?.staged,
		highestActedOn: existing?.highestActedOn ?? 0,
		fenced: [...(existing?.fenced ?? []), { node, operator, at: Date.now() }],
	});
	return { fenced: true };
}

const activateSchema = Joi.object({
	database: Joi.string().required(),
	generation: Joi.number().required(),
	homes: Joi.array().required(),
});

/**
 * Promotes `staged → active`. Refuses unless `staged` matches exactly (replay/consistency
 * check) — never re-derives or checks elapsed time itself; the operator's external wait is the
 * only thing that makes this safe to call (see the module comment).
 */
export type ActivatePlan =
	| { action: 'noop'; active: RecordLockGenerationState }
	| { action: 'reject'; reason: string }
	| { action: 'write'; row: RecordLockHomesRow };

/**
 * Pure decision, mirroring `planStage`: refuses unless `staged` matches exactly (replay/
 * consistency — never elapsed time, which is the operator's job to have already waited out; see
 * RECORD_LOCK_HOMES_DESIGN.md §2).
 */
export function planActivate(
	existing: RecordLockHomesRow | undefined,
	database: string,
	generation: number,
	digest: string,
	now: number = Date.now(),
	minDrainMs: number = MIN_DRAIN_BACKSTOP_MS
): ActivatePlan {
	if (existing?.active?.generation === generation && existing.active.digest === digest)
		return { action: 'noop', active: existing.active };
	if (!existing?.staged || existing.staged.generation !== generation || existing.staged.digest !== digest)
		return { action: 'reject', reason: `no matching staged generation ${generation} for ${database} to activate` };
	// A cheap backstop, not the safety mechanism itself (see the module comment): the real wait is the
	// operator's own external observation, anchored at the LAST stage/fence across the whole affected
	// set, which this node cannot know. This only catches the unambiguous case — an activate landing
	// suspiciously soon after THIS node's own stage — using this node's own clock, which is exactly
	// the thing round 2 said is not sound as the ONLY mechanism. It is deliberately far short of the
	// real drain interval so it cannot be mistaken for one.
	if (typeof existing.staged.stagedAt === 'number' && now - existing.staged.stagedAt < minDrainMs)
		return { action: 'reject', reason: `activation arrived implausibly soon after staging generation ${generation}` };
	return {
		action: 'write',
		row: {
			database,
			active: existing.staged,
			staged: undefined,
			highestActedOn: Math.max(existing.highestActedOn ?? 0, generation),
			fenced: existing.fenced ?? [],
		},
	};
}

export async function activateGeneration(request: any): Promise<{ active: RecordLockGenerationState }> {
	const validation = validateBySchema(request, activateSchema);
	if (validation)
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	const { database } = request;
	validateGenerationInput(request.generation, request.homes);
	const homes = canonicalizeHomes(request.homes);
	const generation = request.generation;
	const digest = digestOf(generation, homes);
	const existing = await readRow(database);
	const plan = planActivate(existing, database, generation, digest);
	if (plan.action === 'reject') throw new ClientError(plan.reason, 409);
	if (plan.action === 'noop') return { active: plan.active };
	await writeRow(plan.row);
	logger.info?.(`Record lock home map for ${database}: activated generation ${generation}`);
	notifyChanged(database);
	return { active: plan.row.active! };
}

/** Current durable row, for `homeMap()` cache population and status reporting. Not the hot path. */
export async function currentRow(database: string): Promise<RecordLockHomesRow | undefined> {
	return readRow(database);
}

export const DELEGATION_DRAIN_MS = DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS;

server.registerOperation?.({
	name: 'record_lock_stage_generation',
	execute: stageGeneration,
	httpMethod: 'POST',
	requiresSuperUser: true,
});
server.registerOperation?.({
	name: 'record_lock_fence_external',
	execute: fenceExternal,
	httpMethod: 'POST',
	requiresSuperUser: true,
});
server.registerOperation?.({
	name: 'record_lock_activate_generation',
	execute: activateGeneration,
	httpMethod: 'POST',
	requiresSuperUser: true,
});
