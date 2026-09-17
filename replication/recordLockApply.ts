/**
 * One operator call that applies a record-lock home map across the whole cluster (harper-pro#862),
 * given an explicitly supplied list of expected nodes: survey every named node, refuse on any
 * incompleteness, stage everywhere, activate immediately when every node proves quiescence, and
 * report per node. See RECORD_LOCK_HOMES_DESIGN.md → "Applying a home map across the cluster".
 *
 * The list is stated, never derived: `homeMap()` iterates its own `active.homes`, so a set with a
 * participant missing is two arbiters rather than a refusal, and no digest can detect the omission.
 * Naming the set is what turns "ask every node" into a complete check and unreachable into a hard
 * failure — which is why this may orchestrate where the rejected per-node derivation could not.
 *
 * Every hop to a peer is `record_lock_transition`, accepted from a node principal only and
 * re-validated on the receiving node before it writes; the operator's credentials never leave the
 * node they were presented to, and the relaying node never authorizes policy.
 */
import Joi from 'joi';
import { setTimeout as delay } from 'node:timers/promises';
import { server } from '../core/server/Server.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import { validateBySchema } from '../core/validation/validationWrapper.js';
import { handleHDBError, hdbErrors, ClientError } from '../core/utility/errors/hdbError.js';
import * as logger from '../core/utility/logging/harper_logger.js';
import type { QuiesceResult } from '../core/resources/recordLockCoordinator.ts';
import {
	DELEGATION_DRAIN_MS,
	MIN_DRAIN_BACKSTOP_MS,
	STAGE_DRAIN_BUDGET_MS,
	activateGeneration,
	canonicalizeHomes,
	currentRow,
	digestOf,
	planStage,
	provesQuiescence,
	stageGeneration,
	validateGenerationInput,
	type RecordLockGenerationState,
	type RecordLockHomesRow,
} from './recordLockHomes.ts';
import { principalNodeName, sendRecordLockOperation } from './recordLockRpc.ts';
const { HTTP_STATUS_CODES } = hdbErrors;

export const APPLY_OPERATION = 'record_lock_apply_homes';
export const TRANSITION_OPERATION = 'record_lock_transition';

/** A survey or activate is one row read or write on the peer; a stage also runs the #856 drain. */
export const HOP_TIMEOUT_MS = 15_000;
export const STAGE_HOP_TIMEOUT_MS = STAGE_DRAIN_BUDGET_MS + HOP_TIMEOUT_MS;
/** Hops in flight at once per phase; `quiesce` may name 256 nodes and each hop may open a socket. */
export const HOP_CONCURRENCY = 16;

export type TransitionAction = 'survey' | 'stage' | 'activate';

export interface TransitionOperation {
	operation: typeof TRANSITION_OPERATION;
	database: string;
	action: TransitionAction;
	generation?: number;
	homes?: string[];
	quiesce?: string[];
	digest?: string;
}

export interface SurveyReply {
	node: string;
	active?: RecordLockGenerationState;
	staged?: RecordLockGenerationState;
	highestActedOn: number;
}
export interface StageReply {
	staged: RecordLockGenerationState;
	quiesced: QuiesceResult | { error: string };
}
export interface ActivateReply {
	active: RecordLockGenerationState;
}

export interface NodeReport {
	role: 'home' | 'departing';
	survey?: {
		active?: RecordLockGenerationState;
		staged?: RecordLockGenerationState;
		highestActedOn?: number;
		error?: string;
	};
	stage?: {
		action: 'already-active' | 'noop' | 'staged' | 'failed';
		quiesced?: QuiesceResult | { error: string };
		proven?: boolean;
		error?: string;
	};
	activate?: { action: 'activated' | 'noop' | 'skipped' | 'failed'; error?: string };
}

export interface ApplyReport {
	database: string;
	homes: string[];
	quiesce: string[];
	generation?: number;
	digest?: string;
	/**
	 * `refused`: nothing was written. `incomplete`: a hop failed after staging began; re-run the same
	 * call. `staged`: every node is staged and refusing locks but not every one proved quiescence;
	 * wait `retryAfterMs` from receiving this response, then re-run with `generation` and
	 * `drained: true`. `activated`: done.
	 */
	outcome: 'refused' | 'incomplete' | 'staged' | 'activated';
	reason?: string;
	/** The drain interval, measured by the operator from receiving this response; never a node's clock. */
	retryAfterMs?: number;
	nodes: Record<string, NodeReport>;
}

/** A refusal still carries the whole report: the operations API sends an object `http_resp_msg` verbatim. */
export class ApplyRefusedError extends Error {
	statusCode: number;
	http_resp_msg: ApplyReport & { error: string };
	constructor(report: ApplyReport, statusCode: number) {
		super(report.reason ?? report.outcome);
		this.statusCode = statusCode;
		this.http_resp_msg = { error: this.message, ...report };
	}
}

// ---- the survey decision -------------------------------------------------------------------------

export type SurveyPlan =
	| { action: 'refuse'; status: number; reason: string }
	| {
			action: 'proceed';
			generation: number;
			digest: string;
			/** Already active at exactly the target: skipped by stage, a noop for activate. */
			alreadyActive: Set<string>;
			/** Already staged at exactly the target: the stage hop is the idempotent noop, which still drains. */
			alreadyStaged: Set<string>;
	  };

function floorOf(reply: SurveyReply): number {
	return Math.max(reply.active?.generation ?? 0, reply.staged?.generation ?? 0, reply.highestActedOn ?? 0);
}

function sameSet(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function stateKey(state: RecordLockGenerationState | undefined): string | undefined {
	return state && `${state.generation}:${state.digest}`;
}

export function planSurvey(
	database: string,
	homes: string[],
	quiesce: string[],
	requestedGeneration: number | undefined,
	replies: Map<string, SurveyReply | { error: string }>
): SurveyPlan {
	const unreachable: string[] = [];
	const misnamed: string[] = [];
	const unlisted: string[] = [];
	const activeStates = new Map<string, string[]>();
	const stagedStates = new Map<string, string[]>();
	const rows = new Map<string, SurveyReply>();
	for (const node of quiesce) {
		const reply = replies.get(node);
		if (!reply || 'error' in reply) {
			unreachable.push(`${node} (${reply && 'error' in reply ? reply.error : 'no answer'})`);
			continue;
		}
		if (reply.node !== node) {
			misnamed.push(`${node} answered as ${reply.node}`);
			continue;
		}
		rows.set(node, reply);
		// A staged row no longer names the old ring (staging retracts `active`); its `quiesce` does.
		const members = [...(reply.active?.homes ?? []), ...(reply.staged?.homes ?? []), ...(reply.staged?.quiesce ?? [])];
		for (const member of members) if (!quiesce.includes(member)) unlisted.push(`${member} (in ${node}'s ring)`);
		const active = stateKey(reply.active);
		if (active) activeStates.set(active, [...(activeStates.get(active) ?? []), node]);
		const staged = stateKey(reply.staged);
		if (staged) stagedStates.set(staged, [...(stagedStates.get(staged) ?? []), node]);
	}
	if (unreachable.length > 0)
		return { action: 'refuse', status: 503, reason: `not every named node answered: ${unreachable.join(', ')}` };
	if (misnamed.length > 0)
		return {
			action: 'refuse',
			status: 409,
			reason: `a named node answered under another name: ${misnamed.join(', ')}`,
		};
	if (unlisted.length > 0)
		return {
			action: 'refuse',
			status: 409,
			reason: `nodes not in quiesce are members of a current ring and may still be granting: ${[...new Set(unlisted)].join(', ')}`,
		};
	const disagreement = (label: string, states: Map<string, string[]>) =>
		[...states].map(([state, nodes]) => `${label} ${state.replace(':', ' digest ')} on ${nodes.join(', ')}`).join('; ');
	if (activeStates.size > 1)
		return {
			action: 'refuse',
			status: 409,
			reason: `nodes disagree about the active generation: ${disagreement('active', activeStates)}`,
		};
	if (stagedStates.size > 1)
		return {
			action: 'refuse',
			status: 409,
			reason: `nodes disagree about the staged generation: ${disagreement('staged', stagedStates)}`,
		};

	let floor = 0;
	for (const reply of rows.values()) floor = Math.max(floor, floorOf(reply));
	let generation = requestedGeneration;
	if (generation === undefined) {
		// Resume an interrupted transition to this exact set rather than opening a new generation past
		// it; otherwise one past whatever any node has acted on. Only the number is derived here.
		let resumable = false;
		for (const reply of rows.values())
			for (const state of [reply.active, reply.staged])
				if (state?.generation === floor && sameSet(state.homes, homes)) resumable = true;
		generation = resumable ? floor : floor + 1;
	}
	const digest = digestOf(generation, homes);
	const alreadyActive = new Set<string>();
	const alreadyStaged = new Set<string>();
	for (const [node, reply] of rows) {
		if (reply.active?.generation === generation && reply.active.digest === digest) {
			alreadyActive.add(node);
			continue;
		}
		const row: RecordLockHomesRow = {
			database,
			active: reply.active,
			staged: reply.staged,
			highestActedOn: reply.highestActedOn ?? 0,
			fenced: [],
		};
		const plan = planStage(row, database, generation, homes, digest);
		if (plan.action === 'reject')
			return { action: 'refuse', status: 409, reason: `${node} would refuse to stage: ${plan.reason}` };
		if (plan.action === 'noop') alreadyStaged.add(node);
	}
	return { action: 'proceed', generation, digest, alreadyActive, alreadyStaged };
}

// ---- the activation decision ---------------------------------------------------------------------

export type ActivationPlan =
	{ activate: true; attested: string[] } | { activate: false; reason: string; retryAfterMs: number };

/**
 * `provesQuiescence` on every freshly staged node is the only thing that licenses activating without
 * the interval. `drained` is the operator's attestation that the interval has elapsed since the
 * response that reported these nodes staged — so it can only cover a node that was already staged
 * when this call surveyed it, never one this call staged: that node's authority under the old
 * generation has had no interval at all.
 */
export function planActivation(nodes: Record<string, NodeReport>, drained: boolean): ActivationPlan {
	const unproven: string[] = [];
	const fresh: string[] = [];
	for (const [node, report] of Object.entries(nodes)) {
		const stage = report.stage;
		if (!stage || stage.action === 'already-active' || stage.proven) continue;
		unproven.push(node);
		if (stage.action === 'staged') fresh.push(node);
	}
	if (unproven.length === 0) return { activate: true, attested: [] };
	if (drained && fresh.length === 0) return { activate: true, attested: unproven };
	const because = drained
		? `${fresh.join(', ')} were staged by this call, so the attested interval cannot have covered them`
		: `${unproven.join(', ')} could not prove quiescence`;
	return {
		activate: false,
		reason: `${because}; every node is staged and refusing cluster locks. Wait retryAfterMs from receiving this response, then re-run this call with this generation and drained: true`,
		retryAfterMs: DELEGATION_DRAIN_MS,
	};
}

// ---- the orchestrator ----------------------------------------------------------------------------

export interface TransitionPeers {
	send(node: string, operation: TransitionOperation): Promise<any>;
}

const applySchema = Joi.object({
	database: Joi.string().required(),
	homes: Joi.array().required(),
	quiesce: Joi.array().optional(),
	generation: Joi.number().optional(),
	drained: Joi.boolean().optional(),
});

function hopError(error: unknown): string {
	return (error as Error)?.message ?? String(error);
}

function withHopDeadline<T>(hop: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms).unref();
		hop.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

async function forEachNode(nodes: string[], task: (node: string) => Promise<void>): Promise<void> {
	let next = 0;
	const lanes = Array.from({ length: Math.min(HOP_CONCURRENCY, nodes.length) }, async () => {
		while (next < nodes.length) await task(nodes[next++]);
	});
	await Promise.all(lanes);
}

/** One apply at a time per database on this node; a second caller queues rather than racing the first's phases. */
const applyQueues = new Map<string, Promise<unknown>>();

/** A test hook: fail after every node is staged and before any is activated, to exercise the retry contract. */
const FAIL_BEFORE_ACTIVATE = process.env.HARPER_TEST_RECORD_LOCK_APPLY_FAIL_BEFORE_ACTIVATE === '1';

export async function applyHomes(request: any, peers: TransitionPeers = productionPeers): Promise<ApplyReport> {
	const validation = validateBySchema(request, applySchema);
	if (validation)
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	const { database } = request;
	validateGenerationInput(request.generation ?? 1, request.homes);
	if (request.drained === true && request.generation === undefined)
		throw new ClientError(
			'drained: true attests a wait for a specific transition; pass the generation it reported',
			400
		);
	const homes = canonicalizeHomes(request.homes);
	let quiesce = homes;
	if (request.quiesce !== undefined) {
		validateGenerationInput(1, request.quiesce);
		quiesce = canonicalizeHomes([...request.quiesce, ...homes]);
		const missing = homes.filter((node) => !request.quiesce.includes(node));
		if (missing.length > 0)
			throw new ClientError(`quiesce must include every node in homes; missing ${missing.join(', ')}`, 400);
	}
	const prior = applyQueues.get(database) ?? Promise.resolve();
	const run = prior.then(() => runApply(request, database, homes, quiesce, peers));
	applyQueues.set(
		database,
		run.catch(() => {})
	);
	return run;
}

async function runApply(
	request: any,
	database: string,
	homes: string[],
	quiesce: string[],
	peers: TransitionPeers
): Promise<ApplyReport> {
	const report: ApplyReport = { database, homes, quiesce, outcome: 'refused', nodes: {} };
	for (const node of quiesce) report.nodes[node] = { role: homes.includes(node) ? 'home' : 'departing' };

	const replies = new Map<string, SurveyReply | { error: string }>();
	await forEachNode(quiesce, async (node) => {
		try {
			const reply = await withHopDeadline(
				peers.send(node, { operation: TRANSITION_OPERATION, database, action: 'survey' }),
				HOP_TIMEOUT_MS,
				`${node} survey`
			);
			replies.set(node, reply);
			report.nodes[node].survey = { active: reply.active, staged: reply.staged, highestActedOn: reply.highestActedOn };
		} catch (error) {
			const message = hopError(error);
			replies.set(node, { error: message });
			report.nodes[node].survey = { error: message };
		}
	});
	const survey = planSurvey(database, homes, quiesce, request.generation, replies);
	if (survey.action === 'refuse') {
		report.reason = survey.reason;
		throw new ApplyRefusedError(report, survey.status);
	}
	const { generation, digest } = survey;
	report.generation = generation;
	report.digest = digest;

	let failed = false;
	await forEachNode(quiesce, async (node) => {
		const entry = report.nodes[node];
		if (survey.alreadyActive.has(node)) {
			entry.stage = { action: 'already-active' };
			return;
		}
		try {
			const reply: StageReply = await withHopDeadline(
				peers.send(node, {
					operation: TRANSITION_OPERATION,
					database,
					action: 'stage',
					generation,
					homes,
					quiesce,
					digest,
				}),
				STAGE_HOP_TIMEOUT_MS,
				`${node} stage`
			);
			entry.stage = {
				action: survey.alreadyStaged.has(node) ? 'noop' : 'staged',
				quiesced: reply.quiesced,
				proven: provesQuiescence(reply.quiesced),
			};
			entry.survey = { ...entry.survey, staged: reply.staged };
		} catch (error) {
			failed = true;
			entry.stage = { action: 'failed', error: hopError(error) };
		}
	});
	if (failed) {
		report.outcome = 'incomplete';
		report.reason = 'staging did not complete on every node; nothing was activated. Re-run this call';
		throw new ApplyRefusedError(report, 503);
	}
	if (FAIL_BEFORE_ACTIVATE) {
		report.outcome = 'incomplete';
		report.reason = 'injected failure between stage and activate (HARPER_TEST_RECORD_LOCK_APPLY_FAIL_BEFORE_ACTIVATE)';
		throw new ApplyRefusedError(report, 503);
	}
	const activation = planActivation(report.nodes, request.drained === true);
	if (activation.activate === false) {
		report.outcome = 'staged';
		report.reason = activation.reason;
		report.retryAfterMs = activation.retryAfterMs;
		return report;
	}
	if (activation.attested.length > 0)
		logger.warn?.(
			`Record lock home map for ${database}: activating generation ${generation} on the operator's attestation that the drain interval elapsed; ${activation.attested.join(', ')} could not prove quiescence`
		);
	// `planActivate` refuses an activate that lands within `MIN_DRAIN_BACKSTOP_MS` of that node's own
	// stage; a proven drain on an idle node returns well inside it. Measured here from the last stage
	// response, which is after every node's own `stagedAt`.
	if (Object.values(report.nodes).some((entry) => entry.stage?.action === 'staged')) await delay(MIN_DRAIN_BACKSTOP_MS);
	await forEachNode(quiesce, async (node) => {
		const entry = report.nodes[node];
		if (entry.role === 'departing') {
			entry.activate = { action: 'skipped' };
			return;
		}
		try {
			await withHopDeadline(
				peers.send(node, { operation: TRANSITION_OPERATION, database, action: 'activate', generation, homes, digest }),
				HOP_TIMEOUT_MS,
				`${node} activate`
			);
			entry.activate = { action: entry.stage?.action === 'already-active' ? 'noop' : 'activated' };
		} catch (error) {
			failed = true;
			entry.activate = { action: 'failed', error: hopError(error) };
		}
	});
	if (failed) {
		report.outcome = 'incomplete';
		report.reason = 'activation did not complete on every node in homes. Re-run this call';
		throw new ApplyRefusedError(report, 503);
	}
	report.outcome = 'activated';
	logger.info?.(`Record lock home map for ${database}: applied generation ${generation} on ${homes.join(', ')}`);
	return report;
}

// ---- the peer-callable hop ---------------------------------------------------------------------

const transitionSchema = Joi.object({
	database: Joi.string().required(),
	action: Joi.string().valid('survey', 'stage', 'activate').required(),
	generation: Joi.number().optional(),
	homes: Joi.array().optional(),
	quiesce: Joi.array().optional(),
	digest: Joi.string().optional(),
});

/**
 * The relayed proposal is checked against this node's own facts before anything is written: the
 * generation and sets through the shared validator, the digest by recomputing it, this node's place in
 * the transition (staged only as a named participant, activated only as a member of the new ring), and
 * its own row through the same `planStage` / `planActivate` decisions the per-node operator calls run.
 */
export async function executeTransitionLocally(request: any): Promise<SurveyReply | StageReply | ActivateReply> {
	const validation = validateBySchema(request, transitionSchema);
	if (validation)
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	const { database, action } = request;
	const self = getThisNodeName();
	if (!self) throw new ClientError('this node has no resolved node name', 503);
	if (action === 'survey') {
		const row = await currentRow(database);
		return { node: self, active: row?.active, staged: row?.staged, highestActedOn: row?.highestActedOn ?? 0 };
	}
	validateGenerationInput(request.generation, request.homes);
	const homes = canonicalizeHomes(request.homes);
	const digest = digestOf(request.generation, homes);
	if (request.digest !== digest)
		throw new ClientError(
			`the relayed digest does not match generation ${request.generation} over ${homes.join(', ')}`,
			409
		);
	if (action === 'stage') {
		validateGenerationInput(request.generation, request.quiesce);
		const quiesce = canonicalizeHomes([...request.quiesce, ...homes]);
		if (!quiesce.includes(self)) throw new ClientError(`${self} is not named in this transition's quiesce set`, 409);
		return stageGeneration({ database, generation: request.generation, homes, quiesce });
	}
	if (!homes.includes(self)) throw new ClientError(`${self} is not a member of generation ${request.generation}`, 409);
	return activateGeneration({ database, generation: request.generation, homes });
}

export async function executeTransition(request: any) {
	if (!principalNodeName(request))
		throw new ClientError('record lock transitions are accepted from cluster nodes only', 403);
	return executeTransitionLocally(request);
}

const productionPeers: TransitionPeers = {
	send(node, operation) {
		if (node === getThisNodeName()) return executeTransitionLocally(operation);
		return sendRecordLockOperation(node, operation.database, operation);
	},
};

server.registerOperation?.({
	name: APPLY_OPERATION,
	execute: (request: any) => applyHomes(request),
	httpMethod: 'POST',
	requiresSuperUser: true,
});
server.registerOperation?.({ name: TRANSITION_OPERATION, execute: executeTransition, httpMethod: 'POST' });
