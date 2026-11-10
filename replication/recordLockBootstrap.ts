/**
 * The automatic first home-map generation (harper-pro#853): in `replication.recordLocks`'s `auto` mode,
 * the first cluster `lock()` on a database with no home map establishes generation 1 over the
 * replicating set, through the same `record_lock_transition` survey/stage/activate hops and per-node
 * planners `record_lock_apply_homes` uses. See RECORD_LOCK_HOMES_DESIGN.md "Generation 1 without an
 * operator".
 */
import { ClientError } from '../core/utility/errors/hdbError.js';
import {
	MIN_DRAIN_BACKSTOP_MS,
	canonicalizeHomes,
	digestOf,
	homesMembership,
	type FenceEntry,
	type RecordLockGenerationState,
} from './recordLockHomes.ts';
import {
	TRANSITION_OPERATION,
	forEachNode,
	hopError,
	productionPeers,
	withHopDeadline,
	withTransitionQueue,
	type SurveyReply,
	type TransitionOperation,
	type TransitionPeers,
} from './recordLockApply.ts';
import type { RecordLockMode } from './recordLockConfig.ts';

const MAX_NODES = 256;
const MAX_NODE_NAME_LENGTH = 256;
const MODES: ReadonlySet<string> = new Set(['auto', 'operator', 'off']);

/** What a home-map row allows the automatic first generation to do with it. */
export type HomesRowClass = 'empty' | 'first-staged' | 'first-active' | 'other';

interface RowShape {
	active?: RecordLockGenerationState;
	staged?: RecordLockGenerationState;
	highestActedOn?: number;
	fenced?: FenceEntry[];
}

/**
 * `empty`: no home-map history at all. `first-*`: generation 1 staged or active and nothing else, which
 * `planStage` only ever writes on an empty row. `other`: anything an operator transition left.
 */
export function classifyHomesRow(row: RowShape | undefined): HomesRowClass {
	if (!row) return 'empty';
	if (Array.isArray(row.fenced) && row.fenced.length > 0) return 'other';
	const acted = row.highestActedOn ?? 0;
	if (!row.active && !row.staged) return acted === 0 ? 'empty' : 'other';
	if (row.active && row.staged) return 'other';
	const state = (row.active ?? row.staged)!;
	if (state.generation !== 1 || acted !== 1) return 'other';
	return row.active ? 'first-active' : 'first-staged';
}

function validNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NODES) return undefined;
	for (const name of value)
		if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NODE_NAME_LENGTH) return undefined;
	return canonicalizeHomes(value);
}

/** A generation state off the wire, kept only if its digest is the one its own generation and homes give. */
function validState(value: unknown): RecordLockGenerationState | undefined | false {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'object') return false;
	const { generation, homes, digest } = value as RecordLockGenerationState;
	if (!(typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0)) return false;
	const canonical = validNames(homes);
	if (!canonical || canonical.length !== homes.length || typeof digest !== 'string') return false;
	if (digestOf(generation, canonical) !== digest) return false;
	return { generation, homes: canonical, digest };
}

interface CheckedReply {
	node: string;
	mode: RecordLockMode;
	view: string[];
	rowClass: HomesRowClass;
	/** Its generation-1 state, staged or active. */
	first?: RecordLockGenerationState;
}

function checkReply(node: string, reply: SurveyReply): CheckedReply | string {
	if (reply.node !== node) return `answered as ${String(reply.node)}`;
	if (typeof reply.recordLocks !== 'string' || !MODES.has(reply.recordLocks))
		return 'did not report its record lock mode (a build without the automatic first generation)';
	const view = validNames(reply.view);
	if (!view) return 'did not report a valid replicating set';
	const active = validState(reply.active);
	const staged = validState(reply.staged);
	if (active === false || staged === false) return 'reported a malformed home map';
	const highestActedOn = reply.highestActedOn;
	if (!(typeof highestActedOn === 'number' && Number.isSafeInteger(highestActedOn) && highestActedOn >= 0))
		return 'reported a malformed generation floor';
	if (reply.fenced !== undefined && !Array.isArray(reply.fenced)) return 'reported a malformed fence list';
	const rowClass = classifyHomesRow({ active, staged, highestActedOn, fenced: reply.fenced });
	return { node, mode: reply.recordLocks as RecordLockMode, view, rowClass, first: active ?? staged };
}

export type BootstrapPlan =
	| { action: 'refuse'; reason: string }
	| {
			action: 'proceed';
			kind: 'fresh' | 'resume';
			homes: string[];
			digest: string;
			/** Members to stage: everyone not already active at the target. */
			stage: string[];
			/** Some member is, or is about to be, staged, so `planActivate`'s backstop must elapse first. */
			awaitBackstop: boolean;
	  };

function sameSet(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Pure over the survey of `candidates` (this node, its replicating peers, and any generation-1 set its
 * own row holds). Fresh: every node answered with no history, at least two take part, none is
 * operator-managed, no surveyed node replicates with anyone outside `candidates`, and every participant's
 * own replicating set is exactly `candidates`. Resume: exactly one generation-1 set exists, this node is
 * in it, and every member answered staged, active or with no history.
 */
export function planBootstrap(
	self: string,
	candidates: string[],
	replies: Map<string, SurveyReply | { error: string }>
): BootstrapPlan {
	const checked = new Map<string, CheckedReply>();
	const unanswered: string[] = [];
	for (const node of candidates) {
		const reply = replies.get(node);
		if (!reply || 'error' in reply) {
			unanswered.push(`${node} (${reply && 'error' in reply ? reply.error : 'no answer'})`);
			continue;
		}
		const result = checkReply(node, reply);
		if (typeof result === 'string') unanswered.push(`${node} (${result})`);
		else checked.set(node, result);
	}
	const withHistory = [...checked.values()].filter((reply) => reply.rowClass === 'other').map((reply) => reply.node);
	if (withHistory.length > 0)
		return {
			action: 'refuse',
			reason: `${withHistory.join(', ')} already hold home-map history beyond an automatic first generation, so the next generation is an operator's (record_lock_apply_homes)`,
		};
	const firstSets = new Map<string, string[]>();
	for (const reply of checked.values()) if (reply.first) firstSets.set(reply.first.digest, reply.first.homes);
	if (firstSets.size > 1)
		return {
			action: 'refuse',
			reason: `nodes hold different first generations (${[...firstSets.values()].map((homes) => homes.join(', ')).join(' | ')}); an operator reconciles them (record_lock_apply_homes)`,
		};
	if (firstSets.size === 1) {
		const [[digest, homes]] = [...firstSets];
		if (!homes.includes(self))
			return {
				action: 'refuse',
				reason: `the first home map (${homes.join(', ')}) does not include ${self}; an operator adds it with record_lock_apply_homes`,
			};
		const missing = homes.filter((member) => !checked.has(member));
		if (missing.length > 0)
			return {
				action: 'refuse',
				reason: `not every member of the first home map answered: ${unanswered.filter((entry) => missing.some((member) => entry.startsWith(`${member} (`))).join(', ') || missing.join(', ')}`,
			};
		const unable = homes.filter((member) => checked.get(member)!.mode !== 'auto');
		if (unable.length > 0)
			return {
				action: 'refuse',
				reason: `${unable.join(', ')} no longer take part in the automatic first generation (replication.recordLocks is set or off there)`,
			};
		return {
			action: 'proceed',
			kind: 'resume',
			homes,
			digest,
			stage: homes.filter((member) => checked.get(member)!.rowClass !== 'first-active'),
			awaitBackstop: homes.some((member) => checked.get(member)!.rowClass !== 'first-active'),
		};
	}
	if (unanswered.length > 0) return { action: 'refuse', reason: `not every node answered: ${unanswered.join(', ')}` };
	const participants = candidates.filter((node) => checked.get(node)!.mode !== 'off');
	const operated = participants.filter((node) => checked.get(node)!.mode === 'operator');
	if (operated.length > 0)
		return {
			action: 'refuse',
			reason: `${operated.join(', ')} set replication.recordLocks: true, so their home maps are published by an operator (record_lock_apply_homes)`,
		};
	if (!participants.includes(self) || participants.length < 2)
		return { action: 'refuse', reason: 'no other node replicating this database takes part in cluster record locks' };
	for (const reply of checked.values()) {
		const outside = reply.view.filter((node) => !candidates.includes(node));
		if (outside.length > 0)
			return {
				action: 'refuse',
				reason: `${reply.node} replicates with ${outside.join(', ')}, which ${self} does not, so the replicating set is not agreed yet`,
			};
	}
	const disagreeing = participants.filter((node) => !sameSet(checked.get(node)!.view, candidates));
	if (disagreeing.length > 0)
		return {
			action: 'refuse',
			reason: `${disagreeing.join(', ')} do not yet replicate with every node ${self} does, so the replicating set is not agreed yet`,
		};
	return {
		action: 'proceed',
		kind: 'fresh',
		homes: participants,
		digest: digestOf(1, participants),
		stage: participants,
		awaitBackstop: true,
	};
}

export interface BootstrapTimeouts {
	/** A survey or activate is one row read or write on the peer. */
	hopMs: number;
	/** A stage also runs the #856 drain on the peer, which is immediate where nothing was ever granted. */
	stageMs: number;
	/** The whole attempt, queue wait included. */
	attemptMs: number;
}
export const DEFAULT_BOOTSTRAP_TIMEOUTS: BootstrapTimeouts = { hopMs: 4_000, stageMs: 8_000, attemptMs: 25_000 };

export type BootstrapOutcome =
	| { outcome: 'activated'; homes: string[] }
	| { outcome: 'refused'; reason: string }
	| { outcome: 'failed'; reason: string; planned: boolean }
	| { outcome: 'cancelled' };

export interface BootstrapRunOptions {
	peers?: TransitionPeers;
	timeouts?: BootstrapTimeouts;
	/** The generation-1 set this node's own row holds, so its members are surveyed whatever `hdb_nodes` says now. */
	ownSet?: string[];
	/** False once a newer attempt or a release superseded this one; checked before each phase. */
	current?: () => boolean;
	/** Called once the survey admitted the attempt, before anything is written. */
	onPlanned?: () => void;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

const unrefSleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms).unref();
	});

export async function runBootstrap(database: string, options: BootstrapRunOptions = {}): Promise<BootstrapOutcome> {
	const peers = options.peers ?? productionPeers;
	const timeouts = options.timeouts ?? DEFAULT_BOOTSTRAP_TIMEOUTS;
	const current = options.current ?? (() => true);
	const now = options.now ?? (() => performance.now());
	const sleep = options.sleep ?? unrefSleep;
	const deadline = now() + timeouts.attemptMs;
	const remaining = (ms: number) => Math.max(1, Math.min(ms, deadline - now()));
	return withTransitionQueue(database, async (): Promise<BootstrapOutcome> => {
		if (!current()) return { outcome: 'cancelled' };
		if (deadline - now() <= 0)
			return { outcome: 'failed', reason: 'another home-map transition held the queue', planned: false };
		const self = peers.self();
		if (!self) return { outcome: 'failed', reason: 'this node has no resolved node name', planned: false };
		const candidates = canonicalizeHomes([
			self,
			...homesMembership().replicatingPeers(database),
			...(options.ownSet ?? []),
		]);
		if (candidates.length < 2)
			return {
				outcome: 'refused',
				reason: 'no other node replicating this database takes part in cluster record locks',
			};
		const hop = (node: string, operation: TransitionOperation, ms: number) => {
			const bound = remaining(ms);
			let sent: Promise<any>;
			try {
				sent = peers.send(node, operation, bound);
			} catch (error) {
				sent = Promise.reject(error);
			}
			return withHopDeadline(sent, bound, `${node} ${operation.action}`);
		};
		const replies = new Map<string, SurveyReply | { error: string }>();
		await forEachNode(candidates, async (node) => {
			try {
				replies.set(
					node,
					await hop(node, { operation: TRANSITION_OPERATION, database, action: 'survey' }, timeouts.hopMs)
				);
			} catch (error) {
				replies.set(node, { error: hopError(error) });
			}
		});
		const plan = planBootstrap(self, candidates, replies);
		if (plan.action === 'refuse') return { outcome: 'refused', reason: plan.reason };
		if (!current()) return { outcome: 'cancelled' };
		options.onPlanned?.();
		const { homes, digest } = plan;
		const failures: string[] = [];
		await forEachNode(plan.stage, async (node) => {
			try {
				await hop(
					node,
					{ operation: TRANSITION_OPERATION, database, action: 'stage', generation: 1, homes, quiesce: homes, digest },
					timeouts.stageMs
				);
			} catch (error) {
				failures.push(`${node} stage: ${hopError(error)}`);
			}
		});
		if (failures.length > 0) return { outcome: 'failed', reason: failures.join('; '), planned: true };
		if (!current()) return { outcome: 'cancelled' };
		// `planActivate` refuses an activate within MIN_DRAIN_BACKSTOP_MS of that node's own stage, which
		// may be an earlier attempt's.
		if (plan.awaitBackstop) await sleep(MIN_DRAIN_BACKSTOP_MS);
		if (!current()) return { outcome: 'cancelled' };
		await forEachNode(homes, async (node) => {
			try {
				await hop(
					node,
					{ operation: TRANSITION_OPERATION, database, action: 'activate', generation: 1, homes, digest },
					timeouts.hopMs
				);
			} catch (error) {
				failures.push(`${node} activate: ${hopError(error)}`);
			}
		});
		if (failures.length > 0) return { outcome: 'failed', reason: failures.join('; '), planned: true };
		return { outcome: 'activated', homes };
	});
}

// ---- the trigger: which `homeMap()` call starts an attempt, and what it answers meanwhile ------------

export const BOOTSTRAP_JITTER_MS = 500;
/** How long a node another attempt just staged waits for that attempt to activate it before resuming. */
export const BOOTSTRAP_FOLLOW_MS = 4_000;
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** A node already active at generation 1 is waiting on its peers' agreement, which core's ride-through covers. */
const RESUME_RETRY_MAX_MS = 5_000;

export interface BootstrapRowState {
	rowClass: HomesRowClass;
	/** The generation-1 set the row holds, staged or active. */
	firstSet?: string[];
}

export interface BootstrapTriggerDeps {
	automatic: boolean;
	/** This thread's classification of the row from its last successful read; undefined after a failed one. */
	rowState(database: string): BootstrapRowState | undefined;
	/** This node and its replicating peers for the database, read synchronously. */
	candidates(database: string): string[];
	run(database: string, options: BootstrapRunOptions): Promise<BootstrapOutcome>;
	now(): number;
	random(): number;
	setTimer(callback: () => void, ms: number): unknown;
	clearTimer(timer: unknown): void;
	log: { info?: (message: string) => void; warn?: (message: string) => void };
}

export interface BootstrapStatus {
	state: 'idle' | 'running' | 'waiting' | 'refused' | 'activated';
	reason?: string;
	retryInMs?: number;
}

interface TriggerState {
	token: number;
	running?: { token: number; planned: boolean };
	timer?: unknown;
	/** The last attempt's refusal, answered to callers as a 503 while no newer attempt has passed planning. */
	refusal?: string;
	lastLogged?: string;
	lastFailure?: string;
	retryAt: number;
	backoffMs: number;
	activated?: boolean;
}

export function bootstrapRefusedMessage(database: string): string {
	return `No agreed record lock home map for ${database}, and this node cannot establish one automatically (cluster_status reports why under recordLocks). An operator can apply one with record_lock_apply_homes; lock with { scope: 'node' } for a node-local lock`;
}

export function createBootstrapTrigger(deps: BootstrapTriggerDeps) {
	const states = new Map<string, TriggerState>();

	function settle(database: string, state: TriggerState, token: number, pristine: boolean, outcome: BootstrapOutcome) {
		if (states.get(database) !== state || state.token !== token) return;
		state.running = undefined;
		if (outcome.outcome === 'cancelled') return;
		if (outcome.outcome === 'activated') {
			state.refusal = state.lastFailure = undefined;
			state.backoffMs = 0;
			state.retryAt = 0;
			state.activated = true;
			deps.log.info?.(`Record lock home map for ${database}: established generation 1 on ${outcome.homes.join(', ')}`);
			return;
		}
		state.backoffMs = Math.min(
			pristine ? RETRY_MAX_MS : RESUME_RETRY_MAX_MS,
			state.backoffMs ? state.backoffMs * 2 : RETRY_INITIAL_MS
		);
		state.retryAt = deps.now() + state.backoffMs;
		state.lastFailure = outcome.reason;
		// A failure after the survey admitted the attempt is transient (a hop), not a reason to refuse callers.
		state.refusal = outcome.outcome === 'refused' || !outcome.planned ? outcome.reason : undefined;
		if (outcome.reason !== state.lastLogged) {
			state.lastLogged = outcome.reason;
			deps.log.warn?.(`Record lock home map for ${database} was not established automatically: ${outcome.reason}`);
		}
	}

	function start(database: string, state: TriggerState, row: BootstrapRowState): void {
		const token = ++state.token;
		const pristine = row.rowClass !== 'first-active';
		const running = { token, planned: false };
		state.running = running;
		state.activated = false;
		state.timer = deps.setTimer(
			() => {
				state.timer = undefined;
				if (states.get(database) !== state || state.token !== token) return;
				const now = deps.rowState(database);
				// Another node's attempt staged this one during the jitter: let it finish before resuming.
				if (row.rowClass === 'empty' && now?.rowClass === 'first-staged') {
					state.running = undefined;
					state.retryAt = deps.now() + BOOTSTRAP_FOLLOW_MS;
					return;
				}
				if (!now || now.rowClass === 'other' || (pristine && now.rowClass === 'first-active')) {
					state.running = undefined;
					return;
				}
				let attempt: Promise<BootstrapOutcome>;
				try {
					attempt = deps.run(database, {
						ownSet: now.firstSet,
						current: () => states.get(database) === state && state.token === token,
						onPlanned: () => {
							running.planned = true;
						},
					});
				} catch (error) {
					attempt = Promise.reject(error);
				}
				attempt.then(
					(outcome) => settle(database, state, token, pristine, outcome),
					(error) =>
						settle(database, state, token, pristine, {
							outcome: 'failed',
							reason: hopError(error),
							planned: running.planned,
						})
				);
			},
			Math.floor(deps.random() * BOOTSTRAP_JITTER_MS)
		);
	}

	return {
		/**
		 * Called by `homeMap()` when it has no map to answer. Starts or continues an attempt; throws the 503
		 * a caller should see instead of riding core's wait through a refusal it cannot outlast.
		 */
		missing(database: string): void {
			if (!deps.automatic) return;
			const row = deps.rowState(database);
			if (!row || row.rowClass === 'other') return;
			const pristine = row.rowClass !== 'first-active';
			let state = states.get(database);
			if (!state) states.set(database, (state = { token: 0, retryAt: 0, backoffMs: 0 }));
			const refuse = () => {
				if (pristine && state!.refusal !== undefined) throw new ClientError(bootstrapRefusedMessage(database), 503);
			};
			if (state.running) {
				if (!state.running.planned) refuse();
				return;
			}
			if (deps.now() < state.retryAt) return refuse();
			if (row.rowClass === 'empty' && deps.candidates(database).length < 2) {
				settle(database, state, state.token, true, {
					outcome: 'refused',
					reason: 'no other node replicating this database takes part in cluster record locks',
				});
				return refuse();
			}
			start(database, state, row);
			refuse();
		},
		status(database: string): BootstrapStatus | undefined {
			const state = states.get(database);
			if (!state) return undefined;
			const retryInMs = Math.max(0, Math.round(state.retryAt - deps.now()));
			if (state.running) return { state: 'running', reason: state.lastFailure };
			if (state.activated) return { state: 'activated' };
			if (state.refusal !== undefined) return { state: 'refused', reason: state.refusal, retryInMs };
			if (retryInMs > 0) return { state: 'waiting', reason: state.lastFailure, retryInMs };
			return { state: 'idle', reason: state.lastFailure };
		},
		release(database: string): void {
			const state = states.get(database);
			if (!state) return;
			state.token++;
			if (state.timer !== undefined) deps.clearTimer(state.timer);
			states.delete(database);
		},
	};
}
