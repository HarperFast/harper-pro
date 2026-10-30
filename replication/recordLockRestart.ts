/**
 * A restarted record-lock home's way out of its §4.3 quarantine: instead of waiting out
 * `DELEGATION_LEASE_MS + skew` for the delegations its previous incarnations issued, the home asks
 * every member of the agreed ring to recall every delegation it holds from this node below the
 * current incarnation and attests the incarnation to core's coordinators
 * (`ClusterLockTransport.quiescedIncarnation`) once every member has answered.
 *
 * Completeness is over `homes[]` of the map the round started under, never over who answered. An
 * answer counts only if it echoes the incarnation and generation it was asked for, so an older peer
 * that rejects the operation, a silent peer, or a reply about another incarnation leaves the round
 * incomplete and core's timer in force.
 *
 * Every attempt probes first and recalls second. A member that is recalled gives up delegations it
 * could otherwise have kept serving from until their lease ran out, so while a round cannot complete
 * — a member down, or one on a build without the operation — nobody should be drained for nothing:
 * the recall is sent only once every member has answered the probe, which drains nothing.
 *
 * A round that fails is retried for as long as this thread coordinates the database and the
 * incarnation is unattested: a table coordinator built later still benefits from the attestation,
 * which is why the retries do not stop at the timer.
 *
 * Runs on the coordinating thread only. Pure over its dependencies.
 */
import type { LockHomeMap } from '../core/resources/recordLockCoordinator.ts';
import { createBackoff, type Backoff } from './backoff.ts';

export const RECALL_INCARNATION_OPERATION = 'record_lock_recall_incarnation';
/**
 * One attempt's bound per member. Far below a delegation lease: a member draining a lock that is still
 * held answers only once the holder unlocks, and a retry joins that same drain, so a short bound costs
 * a retry rather than a lost answer.
 */
export const INCARNATION_RECALL_BUDGET_MS = 20_000;
const PROBE_BUDGET_MS = 5_000;
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export interface RestartRecallDeps {
	thisNodeName(): string;
	/** This thread's current coordination incarnation, 0 while unknown. */
	homeIncarnation(): number;
	/** Whether no earlier incarnation of this node ever existed, so there is nothing to recall. */
	isFirstIncarnation(): boolean;
	ownsDatabase(database: string): boolean;
	homeMap(database: string): LockHomeMap | undefined;
	send(node: string, database: string, operation: RecallIncarnationOperation, timeoutMs: number): Promise<any>;
	/** This node's own sweep; the home is a ring member too. */
	recallLocally(database: string, home: string, generation: number, belowIncarnation: number): Promise<void>;
	/** This thread's delegate epoch for the database (§4.5), or undefined while unknown. */
	delegateEpoch?(database: string): number | undefined;
	/**
	 * Record a member's echoed epoch as that member's floor here, and retire its older grants
	 * (`retireDelegateEpoch`): a home whose owner thread was replaced rebuilds the floors it lost from the
	 * members' own answers. Awaited before the answer counts; a failure leaves the member unanswered and
	 * the round retries (§4.5).
	 */
	retireLocally?(database: string, delegate: string, belowEpoch: number): void | Promise<unknown>;
	setTimer?(callback: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
	random?(): number;
	warn?(message: string, detail?: unknown): void;
	debug?(message: string, detail?: unknown): void;
}

export interface RecallIncarnationOperation {
	operation: typeof RECALL_INCARNATION_OPERATION;
	database: string;
	generation: number;
	/** The caller's current incarnation; the member recalls everything the caller issued below it. */
	incarnation: number;
	deadlineMs: number;
	/** Answer whether the recall could be served, without serving it. */
	probe?: true;
	/**
	 * The caller's delegate epoch for the database (§4.5). In the recall phase the member retires the
	 * caller's grants below it and answers `retired`; the probe carries it too, so a member can refuse a
	 * malformed one before anything is drained.
	 */
	delegateEpoch?: number;
}

export interface RestartRecallStatus {
	incarnation: number;
	state: 'pending' | 'attested';
	attempts: number;
	/** Members the last attempt got no acceptable answer from (pending only). */
	unanswered: string[];
	lastError?: string;
}

export interface RestartRecall {
	/** Start, or restart, the round for a database this thread coordinates. */
	schedule(database: string): void;
	/** Ownership lost or the database released: stop retrying and forget the attestation. */
	cancel(database: string): void;
	/** `ClusterLockTransport.quiescedIncarnation` for the database. */
	quiescedIncarnation(database: string): number | undefined;
	/**
	 * `ClusterLockTransport.restartRecovering` for the database: this incarnation's round is in flight,
	 * or waiting to run again with nobody having refused it, so its quarantine may end at any moment.
	 */
	recovering(database: string): boolean;
	status(database: string): RestartRecallStatus | undefined;
}

interface DatabaseRound {
	attested?: number;
	attempts: number;
	/** The question the running attempt is asking, while one runs. */
	running?: { incarnation: number; generation: number };
	/** A `schedule` for a different question landed while an attempt was running: ask again when it settles. */
	rerun: boolean;
	retryTimer?: unknown;
	backoff: Backoff;
	unanswered: string[];
	lastError?: string;
	/** The incarnation the current or last attempt asked for. */
	incarnation: number;
}

/** The shape every answer must have; anything else is "did not answer" and keeps the timer. */
export function isCompleteAnswer(
	reply: unknown,
	incarnation: number,
	generation: number,
	confirmation: 'recalled' | 'probed' = 'recalled'
): boolean {
	return (
		typeof reply === 'object' &&
		reply !== null &&
		(reply as any)[confirmation] === true &&
		(reply as any).incarnation === incarnation &&
		(reply as any).generation === generation
	);
}

function isEpoch(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

export function createRestartRecall(deps: RestartRecallDeps): RestartRecall {
	const rounds = new Map<string, DatabaseRound>();
	const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms).unref());
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

	function roundFor(database: string): DatabaseRound {
		let round = rounds.get(database);
		if (!round)
			rounds.set(
				database,
				(round = {
					attempts: 0,
					rerun: false,
					backoff: createBackoff({ initialMs: RETRY_INITIAL_MS, maxMs: RETRY_MAX_MS, random: deps.random }),
					unanswered: [],
					incarnation: 0,
				})
			);
		return round;
	}

	function stopRetry(round: DatabaseRound): void {
		if (round.retryTimer !== undefined) clearTimer(round.retryTimer);
		round.retryTimer = undefined;
	}

	function retryLater(database: string, round: DatabaseRound): void {
		stopRetry(round);
		round.retryTimer = setTimer(() => {
			round.retryTimer = undefined;
			attempt(database).catch((error) => deps.warn?.(`Record lock restart recall for ${database} failed`, error));
		}, round.backoff.nextDelay() ?? RETRY_MAX_MS);
	}

	/** One phase of an attempt over every member; a rejection names the member it came from. */
	async function askEveryMember(
		database: string,
		members: string[],
		ask: (member: string) => Promise<void>
	): Promise<{ unanswered: string[]; lastError?: string }> {
		const outcomes = await Promise.allSettled(members.map(ask));
		const unanswered: string[] = [];
		let lastError: string | undefined;
		outcomes.forEach((outcome, index) => {
			if (outcome.status === 'fulfilled') return;
			unanswered.push(members[index]);
			lastError = `${members[index]}: ${(outcome.reason as Error)?.message ?? outcome.reason}`;
		});
		return { unanswered, lastError };
	}

	async function attempt(database: string): Promise<void> {
		const round = roundFor(database);
		if (round.running) {
			const incarnation = deps.homeIncarnation();
			const generation = deps.homeMap(database)?.generation;
			if (round.running.incarnation !== incarnation || round.running.generation !== generation) round.rerun = true;
			return;
		}
		stopRetry(round);
		if (!deps.ownsDatabase(database)) return;
		const incarnation = deps.homeIncarnation();
		if (!(Number.isSafeInteger(incarnation) && incarnation > 0)) return retryLater(database, round);
		round.incarnation = incarnation;
		if (round.attested === incarnation) return;
		if (deps.isFirstIncarnation()) {
			// Nothing was ever issued below the first incarnation, and core already waives the timer.
			round.attested = incarnation;
			round.unanswered = [];
			return;
		}
		const homeMap = deps.homeMap(database);
		const epoch = deps.delegateEpoch?.(database);
		if (!homeMap) {
			round.lastError = 'no agreed home map yet';
			return retryLater(database, round);
		}
		const self = deps.thisNodeName();
		const { generation } = homeMap;
		const members = [...homeMap.homes];
		if (!members.includes(self)) {
			// Not a home for any key, so no incarnation of this node ever issued a delegation to recall.
			round.attested = incarnation;
			round.unanswered = [];
			return;
		}
		const peers = members.filter((member) => member !== self);
		const operation = (probe: boolean): RecallIncarnationOperation => ({
			operation: RECALL_INCARNATION_OPERATION,
			database,
			generation,
			incarnation,
			deadlineMs: INCARNATION_RECALL_BUDGET_MS,
			...(probe ? { probe: true as const } : {}),
			...(isEpoch(epoch) ? { delegateEpoch: epoch } : {}),
		});
		// A member's answer carries its own epoch; recorded as its floor here whether or not the round
		// completes, since the fact it states does not depend on the other members.
		const recorded = new Set<string>();
		const noteEpoch = async (member: string, reply: any) => {
			if (!isEpoch(reply?.delegateEpoch) || recorded.has(`${member}:${reply.delegateEpoch}`)) return;
			// A floor that could not be recorded leaves the member unanswered: attesting past it would let a
			// delayed request from that member's dead epoch be admitted here.
			await deps.retireLocally?.(database, member, reply.delegateEpoch);
			recorded.add(`${member}:${reply.delegateEpoch}`);
		};
		round.running = { incarnation, generation };
		round.rerun = false;
		round.attempts++;
		let outcome = await askEveryMember(database, peers, async (member) => {
			const reply = await deps.send(member, database, operation(true), PROBE_BUDGET_MS);
			if (!isCompleteAnswer(reply, incarnation, generation, 'probed'))
				throw new Error(`${member} cannot serve a recall for incarnation ${incarnation}`);
			await noteEpoch(member, reply);
		});
		// The question must still be live between the two phases: a round cancelled, replaced or moved on
		// during the probes must not drain anybody for answers it is about to throw away.
		const stillAsked = () =>
			rounds.get(database) === round &&
			!round.rerun &&
			deps.ownsDatabase(database) &&
			deps.homeIncarnation() === incarnation &&
			deps.homeMap(database)?.generation === generation;
		if (outcome.unanswered.length === 0 && stillAsked())
			outcome = await askEveryMember(database, members, async (member) => {
				if (member === self) return deps.recallLocally(database, self, generation, incarnation);
				const reply = await deps.send(member, database, operation(false), INCARNATION_RECALL_BUDGET_MS);
				if (!isCompleteAnswer(reply, incarnation, generation))
					throw new Error(`${member} did not confirm the recall for incarnation ${incarnation}`);
				await noteEpoch(member, reply);
			});
		round.running = undefined;
		// Cancelled, or replaced by a later round, while the answers were in flight: they belong to nobody.
		if (rounds.get(database) !== round) return;
		const changed = outcome.lastError !== round.lastError;
		round.unanswered = outcome.unanswered;
		round.lastError = outcome.lastError;
		// What the answers were about must still be what this thread coordinates under: an incarnation
		// bump or a generation change during the round makes them answers to another question.
		if (outcome.unanswered.length === 0 && stillAsked()) {
			round.attested = incarnation;
			round.backoff.reset();
			return;
		}
		if (outcome.lastError) {
			const log = changed ? deps.warn : deps.debug;
			log?.(`Record lock restart recall for ${database} is incomplete; retrying`, outcome.lastError);
		}
		if (!deps.ownsDatabase(database)) return;
		if (round.rerun) return attempt(database);
		retryLater(database, round);
	}

	return {
		schedule(database) {
			if (!deps.ownsDatabase(database)) return;
			roundFor(database).backoff.reset();
			attempt(database).catch((error) => deps.warn?.(`Record lock restart recall for ${database} failed`, error));
		},
		cancel(database) {
			const round = rounds.get(database);
			if (!round) return;
			stopRetry(round);
			rounds.delete(database);
		},
		quiescedIncarnation(database) {
			const round = rounds.get(database);
			if (!round || round.attested === undefined || !deps.ownsDatabase(database)) return undefined;
			return round.attested === deps.homeIncarnation() ? round.attested : undefined;
		},
		recovering(database) {
			const round = rounds.get(database);
			if (!round || !deps.ownsDatabase(database)) return false;
			if (round.attested === deps.homeIncarnation()) return false;
			// Running, or between attempts that no member has refused: a mapless first attempt, or a
			// transient error, is retried shortly. A member that could not answer is not "soon".
			return round.running !== undefined || round.unanswered.length === 0;
		},
		status(database) {
			const round = rounds.get(database);
			if (!round) return undefined;
			const incarnation = deps.homeIncarnation();
			const attested = round.attested !== undefined && round.attested === incarnation;
			const status: RestartRecallStatus = {
				incarnation: attested ? round.attested! : round.incarnation || incarnation,
				state: attested ? 'attested' : 'pending',
				attempts: round.attempts,
				unanswered: attested ? [] : round.unanswered,
			};
			if (!attested && round.lastError) status.lastError = round.lastError;
			return status;
		},
	};
}
