/**
 * `record_lock_apply_homes` (harper-pro#862): one operator call that drives the §4.3 transition across
 * an explicitly supplied node list, over the node-principal hop `record_lock_transition`. See
 * RECORD_LOCK_HOMES_DESIGN.md → "Applying a home map across the cluster".
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

export interface HopTimeouts {
	/** A survey or activate is one row read or write on the peer. */
	hopMs: number;
	/** A stage also runs the #856 drain on the peer. */
	stageMs: number;
}
export const DEFAULT_HOP_TIMEOUTS: HopTimeouts = { hopMs: 15_000, stageMs: STAGE_DRAIN_BUDGET_MS + 15_000 };
/** `quiesce` may name 256 nodes and each hop may open a socket. */
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

export interface NodeSurvey {
	active?: RecordLockGenerationState;
	staged?: RecordLockGenerationState;
	highestActedOn?: number;
	error?: string;
}

export interface NodeReport {
	role: 'home' | 'departing';
	survey?: NodeSurvey;
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
	/** `staged`: every node is staged and refusing locks; wait `retryAfterMs`, then re-run with `generation` and `drained: true`. */
	outcome: 'refused' | 'incomplete' | 'staged' | 'activated';
	reason?: string;
	/** The drain interval, measured by the operator from receiving this response, never from a node clock. */
	retryAfterMs?: number;
	nodes: Record<string, NodeReport>;
	/** The node that took this call, when it is not itself in `quiesce`: read, never written. */
	initiator?: { node: string; survey: NodeSurvey };
}

/** The operations API sends an object `http_resp_msg` as the body, so a refusal still reports every node. */
export class ApplyRefusedError extends Error {
	statusCode: number;
	http_resp_msg: ApplyReport & { error: string };
	constructor(report: ApplyReport, statusCode: number) {
		super(report.reason ?? report.outcome);
		this.statusCode = statusCode;
		this.http_resp_msg = { error: this.message, ...report };
	}
}

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

function ringMembers(reply: SurveyReply): string[] {
	return [...(reply.active?.homes ?? []), ...(reply.staged?.homes ?? []), ...(reply.staged?.quiesce ?? [])];
}

/**
 * Pure over the survey replies. `observer` is the initiating node's own row when that node is not in
 * `quiesce`: it is never written, but a ring it serves that the list does not cover is the same
 * omission as a peer's.
 */
export function planSurvey(
	database: string,
	homes: string[],
	quiesce: string[],
	requestedGeneration: number | undefined,
	replies: Map<string, SurveyReply | { error: string }>,
	observer?: { node: string; reply: SurveyReply | { error: string } }
): SurveyPlan {
	const unreachable: string[] = [];
	const misnamed: string[] = [];
	const unlisted: string[] = [];
	const unrecorded: string[] = [];
	const activeStates = new Map<string, string[]>();
	const rows = new Map<string, SurveyReply>();
	if (observer) {
		if ('error' in observer.reply)
			return {
				action: 'refuse',
				status: 503,
				reason: `${observer.node} could not read its own row: ${observer.reply.error}`,
			};
		for (const member of ringMembers(observer.reply))
			if (!quiesce.includes(member)) unlisted.push(`${member} (in ${observer.node}'s ring, the node taking this call)`);
	}
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
		if (reply.staged && !reply.staged.quiesce) unrecorded.push(node);
		for (const member of ringMembers(reply))
			if (!quiesce.includes(member)) unlisted.push(`${member} (in ${node}'s ring)`);
		const active = reply.active && `${reply.active.generation}:${reply.active.digest}`;
		if (active) activeStates.set(active, [...(activeStates.get(active) ?? []), node]);
	}
	if (unreachable.length > 0)
		return { action: 'refuse', status: 503, reason: `not every named node answered: ${unreachable.join(', ')}` };
	if (misnamed.length > 0)
		return {
			action: 'refuse',
			status: 409,
			reason: `a named node answered under another name: ${misnamed.join(', ')}`,
		};
	if (unrecorded.length > 0)
		return {
			action: 'refuse',
			status: 409,
			reason: `${unrecorded.join(', ')} hold a staged generation with no recorded participant set, so the ring they stopped serving cannot be checked against this list; re-stage the same generation and homes on them with quiesce (record_lock_stage_generation) first`,
		};
	if (unlisted.length > 0)
		return {
			action: 'refuse',
			status: 409,
			reason: `nodes not in quiesce are members of a current ring and may still be granting: ${[...new Set(unlisted)].join(', ')}`,
		};
	if (activeStates.size > 1)
		return {
			action: 'refuse',
			status: 409,
			reason: `nodes disagree about the active generation: ${[...activeStates].map(([state, nodes]) => `${state.replace(':', ' digest ')} on ${nodes.join(', ')}`).join('; ')}`,
		};

	let floor = 0;
	for (const reply of rows.values()) floor = Math.max(floor, floorOf(reply));
	let generation = requestedGeneration;
	if (generation === undefined) {
		// Resume an interrupted transition to this exact set rather than opening a new generation past it.
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
		const plan = planStage(row, database, generation, homes, digest, Date.now(), quiesce);
		if (plan.action === 'reject')
			return { action: 'refuse', status: 409, reason: `${node} would refuse to stage: ${plan.reason}` };
		if (plan.action === 'noop') alreadyStaged.add(node);
	}
	return { action: 'proceed', generation, digest, alreadyActive, alreadyStaged };
}

export type ActivationPlan =
	{ activate: true; attested: string[] } | { activate: false; reason: string; retryAfterMs: number };

/**
 * `provesQuiescence` on every freshly staged node is the only thing that licenses activating without
 * the interval. `drained` attests that the interval has elapsed since the response that reported the
 * nodes staged, so it can cover only a node already staged when this call surveyed it — never one this
 * call staged, whose old authority has had no interval at all.
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

export interface TransitionPeers {
	self(): string | undefined;
	/** Runs `operation` on `node`, locally for this node, and must settle within `timeoutMs`. */
	send(node: string, operation: TransitionOperation, timeoutMs: number): Promise<any>;
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

/** One apply at a time per database on this worker; the per-node planners keep a concurrent apply elsewhere safe. */
const applyQueues = new Map<string, Promise<unknown>>();

const FAIL_BEFORE_ACTIVATE = process.env.HARPER_TEST_RECORD_LOCK_APPLY_FAIL_BEFORE_ACTIVATE === '1';

export async function applyHomes(
	request: any,
	peers: TransitionPeers = productionPeers,
	timeouts: HopTimeouts = DEFAULT_HOP_TIMEOUTS
): Promise<ApplyReport> {
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
	const run = prior.then(() => runApply(request, database, homes, quiesce, peers, timeouts));
	const queued = run
		.catch(() => {})
		.finally(() => {
			if (applyQueues.get(database) === queued) applyQueues.delete(database);
		});
	applyQueues.set(database, queued);
	return run;
}

async function runApply(
	request: any,
	database: string,
	homes: string[],
	quiesce: string[],
	peers: TransitionPeers,
	timeouts: HopTimeouts
): Promise<ApplyReport> {
	const report: ApplyReport = { database, homes, quiesce, outcome: 'refused', nodes: {} };
	for (const node of quiesce) report.nodes[node] = { role: homes.includes(node) ? 'home' : 'departing' };
	const hop = (node: string, operation: TransitionOperation, ms: number) =>
		withHopDeadline(peers.send(node, operation, ms), ms, `${node} ${operation.action}`);
	const survey = async (node: string): Promise<SurveyReply | { error: string }> => {
		try {
			return await hop(node, { operation: TRANSITION_OPERATION, database, action: 'survey' }, timeouts.hopMs);
		} catch (error) {
			return { error: hopError(error) };
		}
	};
	const surveyed = (reply: SurveyReply | { error: string }): NodeSurvey =>
		'error' in reply
			? { error: reply.error }
			: { active: reply.active, staged: reply.staged, highestActedOn: reply.highestActedOn };

	const replies = new Map<string, SurveyReply | { error: string }>();
	await forEachNode(quiesce, async (node) => {
		const reply = await survey(node);
		replies.set(node, reply);
		report.nodes[node].survey = surveyed(reply);
	});
	const self = peers.self();
	let observer: { node: string; reply: SurveyReply | { error: string } } | undefined;
	if (self && !quiesce.includes(self)) {
		observer = { node: self, reply: await survey(self) };
		report.initiator = { node: self, survey: surveyed(observer.reply) };
	}
	const plan = planSurvey(database, homes, quiesce, request.generation, replies, observer);
	if (plan.action === 'refuse') {
		report.reason = plan.reason;
		throw new ApplyRefusedError(report, plan.status);
	}
	const { generation, digest } = plan;
	report.generation = generation;
	report.digest = digest;

	let failed = false;
	await forEachNode(quiesce, async (node) => {
		const entry = report.nodes[node];
		if (plan.alreadyActive.has(node)) {
			entry.stage = { action: 'already-active' };
			return;
		}
		try {
			const reply: StageReply = await hop(
				node,
				{ operation: TRANSITION_OPERATION, database, action: 'stage', generation, homes, quiesce, digest },
				timeouts.stageMs
			);
			entry.stage = {
				action: plan.alreadyStaged.has(node) ? 'noop' : 'staged',
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
	// `planActivate` refuses an activate within MIN_DRAIN_BACKSTOP_MS of that node's own stage.
	if (Object.values(report.nodes).some((entry) => entry.stage?.action === 'staged')) await delay(MIN_DRAIN_BACKSTOP_MS);
	await forEachNode(quiesce, async (node) => {
		const entry = report.nodes[node];
		if (entry.role === 'departing') {
			entry.activate = { action: 'skipped' };
			return;
		}
		try {
			await hop(
				node,
				{ operation: TRANSITION_OPERATION, database, action: 'activate', generation, homes, digest },
				timeouts.hopMs
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
 * digest is recomputed, this node must be named in `quiesce` to stage and in `homes` to activate, and
 * the per-node planners decide against its own row.
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
	self: getThisNodeName,
	send(node, operation, timeoutMs) {
		if (node === getThisNodeName()) return executeTransitionLocally(operation);
		return sendRecordLockOperation(node, operation.database, operation, timeoutMs);
	},
};

server.registerOperation?.({
	name: APPLY_OPERATION,
	execute: (request: any) => applyHomes(request),
	httpMethod: 'POST',
	requiresSuperUser: true,
});
server.registerOperation?.({ name: TRANSITION_OPERATION, execute: executeTransition, httpMethod: 'POST' });
