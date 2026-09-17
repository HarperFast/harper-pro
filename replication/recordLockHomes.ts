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
import {
	DELEGATION_LEASE_MS,
	LOCK_LEASE_SKEW_MS,
	type QuiesceResult,
} from '../core/resources/recordLockCoordinator.ts';
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
	/**
	 * Set only on `staged`: §4.3's `homes(g) ∪ homes(g+1)`. Staging retracts `active`, so this is the
	 * only place a staged row still names the ring it stopped serving (harper-pro#862).
	 */
	quiesce?: string[];
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
// AWAITED by stageGeneration/activateGeneration before they return: a successful stage response must
// be real quiescence evidence, not merely a durable write with an unawaited refresh racing behind it
// (a real pre-push review finding — the durable write landing is not the same fact as every
// grant-capable thread having stopped serving the old generation).
const changeListeners = new Set<(database: string) => Promise<void>>();
export function onRecordLockHomesChanged(listener: (database: string) => Promise<void>): () => void {
	changeListeners.add(listener);
	return () => changeListeners.delete(listener);
}
async function notifyChanged(database: string): Promise<void> {
	await Promise.all([...changeListeners].map((listener) => listener(database)));
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
 * uint32 length prefixes on both the count and every element. `generation` is encoded as its
 * decimal string, length-prefixed the same way as a home name — not truncated to 32 bits (an
 * earlier draft's `generation >>> 0` made generations 1 and 2**32+1 hash identically over the
 * same homes, a real pre-push review finding: `validateGenerationInput` accepts any positive
 * safe integer, not just a uint32).
 */
export function digestOf(generation: number, homes: string[]): string {
	const hash = createHash('sha256');
	const u32 = Buffer.alloc(4);
	const generationBytes = Buffer.from(String(generation), 'utf8');
	u32.writeUInt32BE(generationBytes.length);
	hash.update(u32);
	hash.update(generationBytes);
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

/**
 * Serializes every stage/fence/activate call for the SAME database behind one in-process queue, so
 * the read this call's plan decides against can never be stale by the time it writes. Without this,
 * `readRow` (a real `await`, since the underlying store can resolve asynchronously) leaves a yield
 * point between reading and deciding: `stage(g2)` and a concurrent `fenceExternal` can both read the
 * same `active: g1`, and whichever writes second silently discards the other's outcome even though
 * both report success (a real pre-push review finding — the whole-row replace with no compare-and-set
 * against a state that changed underneath it). Different databases still run fully concurrently —
 * only same-database calls queue behind each other, and only for the duration of one read+decide+write.
 */
const rowQueues = new Map<string, Promise<unknown>>();
function withRow<T>(database: string, plan: (existing: RecordLockHomesRow | undefined) => Promise<T>): Promise<T> {
	const prior = rowQueues.get(database) ?? Promise.resolve();
	const run = prior.then(async () => plan(await readRow(database)));
	// Chain the next caller behind this one regardless of outcome; a rejection here must not wedge
	// every later caller for this database behind a promise that will never resolve.
	rowQueues.set(
		database,
		run.catch(() => {})
	);
	return run;
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
	quiesce: Joi.array().required(),
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
	now: number = Date.now(),
	quiesce?: string[]
): StagePlan {
	const floor = Math.max(
		existing?.active?.generation ?? 0,
		existing?.staged?.generation ?? 0,
		existing?.highestActedOn ?? 0
	);
	if (existing?.staged?.generation === generation) {
		if (existing.staged.digest !== digest)
			return { action: 'reject', reason: `generation ${generation} is already staged with a different home set` };
		// A row staged before `quiesce` was recorded learns its participant set from a matching re-stage;
		// `stagedAt` is kept, since nothing about when this node stopped granting has changed.
		if (quiesce && !existing.staged.quiesce)
			return {
				action: 'write',
				row: { ...existing, staged: { ...existing.staged, quiesce }, highestActedOn: Math.max(floor, generation) },
			};
		return { action: 'noop', staged: existing.staged };
	}
	if (generation <= floor) return { action: 'reject', reason: `generation ${generation} is not greater than ${floor}` };
	// This write erases every ring the row still names, so the transition's participant set must cover
	// them all, or a node still serving one of them becomes invisible to a later survey.
	const remembered = [
		...(existing?.active?.homes ?? []),
		...(existing?.staged?.homes ?? []),
		...(existing?.staged?.quiesce ?? []),
	];
	const uncovered = remembered.filter((node) => !quiesce?.includes(node));
	if (uncovered.length > 0)
		return {
			action: 'reject',
			reason: `quiesce must include every node in the ring this node is retracting; missing ${[...new Set(uncovered)].join(', ')}`,
		};
	const staged: RecordLockGenerationState = { generation, homes, digest, stagedAt: now };
	if (quiesce) staged.quiesce = quiesce;
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

/**
 * Never throws: a stage that durably landed must not report failure because the drain did, or the
 * operator retries a transition that already happened. A drain that cannot run at all is reported as
 * unknown, which reads to an orchestrator exactly like outstanding work — fall back to the timer.
 */
async function drainForStage(database: string): Promise<QuiesceResult | { error: string }> {
	try {
		return await drainReader(database, STAGE_DRAIN_BUDGET_MS);
	} catch (error) {
		logger.warn?.(`Record lock quiesce for ${database} could not complete; fall back to the drain interval`, error);
		return { error: (error as Error)?.message ?? String(error) };
	}
}

export async function stageGeneration(
	request: any
): Promise<{ staged: RecordLockGenerationState; quiesced: QuiesceResult | { error: string } }> {
	const staged = await stageRow(request);
	// Deliberately OUTSIDE `withRow`: the drain waits on live critical sections, and holding the
	// database's transition queue for that would block every other stage, fence and activate on this
	// node behind it. The row write already retracted `active`, so nothing new can be granted while
	// this runs, and a concurrent transition is free to proceed.
	return { ...staged, quiesced: await drainForStage(request.database) };
}

async function stageRow(request: any): Promise<{ staged: RecordLockGenerationState }> {
	const validation = validateBySchema(request, stageSchema);
	if (validation)
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	const { database } = request;
	validateGenerationInput(request.generation, request.homes);
	const homes = canonicalizeHomes(request.homes);
	const generation = request.generation;
	const digest = digestOf(generation, homes);
	validateGenerationInput(generation, request.quiesce);
	const quiesce = canonicalizeHomes([...request.quiesce, ...homes]);
	return withRow(database, async (existing) => {
		const plan = planStage(existing, database, generation, homes, digest, Date.now(), quiesce);
		if (plan.action === 'reject') throw new ClientError(plan.reason, 409);
		if (plan.action === 'noop') {
			// Idempotent retry, not a genuine transition — but the PRIOR call may have durably written
			// this exact state and then failed to confirm every thread applied it (a relay timeout, a
			// dead worker). Re-notifying is harmless when nothing changed and is the only way a retry
			// ever reconciles that gap (a real pre-push review finding: a noop that skips notification
			// leaves every unconfirmed thread stuck on the retracted generation with no bound).
			await notifyChanged(database);
			return { staged: plan.staged };
		}
		await writeRow(plan.row);
		logger.info?.(`Record lock home map for ${database}: staged generation ${generation}, retracted active`);
		await notifyChanged(database);
		return { staged: plan.row.staged! };
	});
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
	return withRow(database, async (existing) => {
		await writeRow({
			database,
			active: existing?.active,
			staged: existing?.staged,
			highestActedOn: existing?.highestActedOn ?? 0,
			fenced: [...(existing?.fenced ?? []), { node, operator, at: Date.now() }],
		});
		return { fenced: true };
	});
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
	return withRow(database, async (existing) => {
		const plan = planActivate(existing, database, generation, digest);
		if (plan.action === 'reject') throw new ClientError(plan.reason, 409);
		if (plan.action === 'noop') {
			// See the matching comment in `stageGeneration`: a retry must still reconcile threads the
			// prior call's durable write outran.
			await notifyChanged(database);
			return { active: plan.active };
		}
		await writeRow(plan.row);
		logger.info?.(`Record lock home map for ${database}: activated generation ${generation}`);
		await notifyChanged(database);
		return { active: plan.row.active! };
	});
}

/** Current durable row, for `homeMap()` cache population and status reporting. Not the hot path. */
export async function currentRow(database: string): Promise<RecordLockHomesRow | undefined> {
	return readRow(database);
}

/**
 * Read-only: the home set this node's own view of `hdb_nodes` suggests for `database`, plus the
 * generation and digest that would go with it. **Writes nothing, and is not agreement** — it is the
 * list-assembly step of the §4.3 runbook, so an operator can capture one canonical list instead of
 * typing it, then pass that exact list to `record_lock_stage_generation` and
 * `record_lock_activate_generation` on every node.
 *
 * It deliberately does not stage, activate, or fan out. A mutating version was designed and rejected
 * during planning review, on two counts worth keeping here because both are easy to re-propose:
 *
 * - **Per-node derivation cannot be made safe by the digest check.** `homeMap()` iterates its OWN
 *   `active.homes` (`recordLockTransport.ts`), so a node that derived `[A]` checks no peers at all and
 *   serves its map immediately. Two nodes with disjoint or incomplete views each get a usable ring and
 *   both arbitrate the same key. A digest cannot detect a participant omitted from the set being
 *   digested — which is precisely why §4.1 says the map is stated, not derived.
 * - **No local state proves the absence of prior authority.** A node newly added to a cluster already
 *   active at generation 2 has an untouched row, so any "this node has never acted" guard passes and
 *   it would activate its own generation 1 while the rest of the cluster serves 2.
 *
 * So the derivation here is a *suggestion to a human*, never an authority: whatever this returns still
 * has to be applied identically on every node through the operations that already exist.
 */
// ---- membership readers, installed by recordLockTransport.ts so this module never imports
// knownNodes/subscriptionManager: they import back through recordLockTransport, and a static edge
// here puts this module's own `changeListeners` in the TDZ when it is loaded first.

interface MembershipReaders {
	thisNodeName(): string | undefined;
	/** Peers this node's `hdb_nodes` view says replicate `database` — never this node itself. */
	replicatingPeers(database: string): string[];
}
let membership: MembershipReaders = {
	thisNodeName: () => undefined,
	replicatingPeers: () => [],
};
export function setHomesMembershipReaders(readers: MembershipReaders): void {
	membership = readers;
}

/**
 * Installed by `recordLockTransport.ts`: drain on the thread that coordinates the database, not on
 * whichever one answered the operation. Defaults to refusing rather than reporting a clean drain it
 * never performed.
 */
let drainReader: (database: string, budgetMs: number) => Promise<QuiesceResult | { error: string }> = async () => ({
	error: 'no record lock drain is wired on this node',
});
/**
 * An orchestrator may skip the drain interval for a node ONLY on this: a drain that both completed
 * and found nothing. `complete` is core's statement that the sweep could have seen everything —
 * coordinators are built lazily, so an empty `outstanding` alone is not a proof (harper-pro#856).
 */
export function provesQuiescence(quiesced: QuiesceResult | { error: string } | undefined): boolean {
	// Every field is checked positively: this value crosses a worker boundary, so a malformed reply must
	// read as "not proven" rather than slipping through on a missing `length`.
	return (
		!!quiesced &&
		!('error' in quiesced) &&
		quiesced.complete === true &&
		Array.isArray(quiesced.outstanding) &&
		quiesced.outstanding.length === 0
	);
}
export function setHomesDrainReader(reader: typeof drainReader): void {
	drainReader = reader;
}

export interface HomesProposal {
	generation: number;
	homes: string[];
	digest: string;
	/**
	 * §4.3's `homes(g) ∪ homes(g+1)`: every node that must be staged (or `record_lock_fence_external`'d)
	 * and drained before this generation is activated anywhere. It is NOT `homes` — on a shrink a node
	 * being removed is absent from the new list, and staging only the new list leaves it serving the old
	 * generation while the new ring serves too, which is two arbiters for the same keys.
	 *
	 * Only as complete as the node that answered: it unions this node's own `active` and `staged` rings,
	 * so a node that has neither cannot name a ring the rest of the cluster is serving. Ask a node that
	 * holds the current generation, or union the proposals from several.
	 */
	quiesce: string[];
	warnings: string[];
}

/**
 * Pure decision behind `record_lock_propose_homes`, mirroring `planStage`/`planActivate` so the
 * generation floor, the canonicalization and every warning are unit-testable without a table.
 * `peers` is whatever the caller's view of `hdb_nodes` accepted for this database.
 */
export function planProposal(
	self: string,
	peers: string[],
	existing: RecordLockHomesRow | undefined,
	database: string
): HomesProposal {
	const homes = canonicalizeHomes([self, ...peers]);
	// One past whatever this node has already acted on, so the proposal serves a topology change as
	// well as a first bootstrap; the operator still has to agree it with every other node.
	const generation =
		Math.max(existing?.active?.generation ?? 0, existing?.staged?.generation ?? 0, existing?.highestActedOn ?? 0) + 1;
	validateGenerationInput(generation, homes);
	const quiesce = canonicalizeHomes([...homes, ...(existing?.active?.homes ?? []), ...(existing?.staged?.homes ?? [])]);
	const warnings: string[] = [];
	if (canonicalizeHomes(peers).length === 0)
		warnings.push(
			`no replicating peers for ${database} are visible from ${self}; this proposal would home every key on ${self} alone`
		);
	if (existing?.staged)
		warnings.push(
			`generation ${existing.staged.generation} is already staged on ${self} and would have to be resolved first`
		);
	const leaving = quiesce.filter((node) => !homes.includes(node));
	if (leaving.length > 0)
		warnings.push(
			`${leaving.join(', ')} leave the ring in this proposal and are not in homes, but MUST still be staged or fenced and drained before activation, or they keep granting under the old generation; a staged departing node is never activated, so it stays unable to lock until it is given its own generation, which is what leaving the ring means`
		);
	// `quiesce` is only as complete as the node that answered: it is built from THIS node's row, so a
	// node with no active ring (never bootstrapped, or already staged — staging retracts `active`)
	// cannot contribute the ring the cluster is actually serving, and the union silently omits it.
	if (!existing?.active)
		warnings.push(
			`${self} has no active generation for ${database}, so quiesce carries only this proposal: if the cluster IS serving a generation, ask a node that has it and union the results before staging anything`
		);
	warnings.push(
		"this is one node's view, not agreement: stage (or fence) and drain every node in `quiesce`, then activate this exact list on every node in `homes`, and compare digests across nodes before activating"
	);
	return { generation, homes, digest: digestOf(generation, homes), quiesce, warnings };
}

export async function proposeHomes(request: any): Promise<
	HomesProposal & {
		database: string;
		source: 'hdb_nodes';
		current: { active?: RecordLockGenerationState; staged?: RecordLockGenerationState };
	}
> {
	const validation = validateBySchema(request, proposeSchema);
	if (validation)
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	const { database } = request;
	const self = membership.thisNodeName();
	if (!self) throw new ClientError('this node has no resolved node name', 503);
	const peers = membership.replicatingPeers(database);
	const existing = await readRow(database);
	return {
		database,
		...planProposal(self, peers, existing, database),
		source: 'hdb_nodes',
		current: { active: existing?.active, staged: existing?.staged },
	};
}

const proposeSchema = Joi.object({
	database: Joi.string().required(),
});

export const DELEGATION_DRAIN_MS = DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS;
/**
 * How long `stage` spends draining before it reports what is left (harper-pro#856). A drain waits on
 * live critical sections, which are milliseconds in the normal case and bounded by the caller's own
 * lock lease; this is a reporting bound, not a safety one — whatever is still outstanding is returned,
 * and the operator falls back to `DELEGATION_DRAIN_MS` for those nodes.
 */
export const STAGE_DRAIN_BUDGET_MS = Number.isFinite(Number(process.env.HARPER_TEST_RECORD_LOCK_STAGE_DRAIN_MS))
	? Number(process.env.HARPER_TEST_RECORD_LOCK_STAGE_DRAIN_MS)
	: 10_000;

server.registerOperation?.({
	name: 'record_lock_propose_homes',
	execute: proposeHomes,
	httpMethod: 'POST',
	requiresSuperUser: true,
});
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
