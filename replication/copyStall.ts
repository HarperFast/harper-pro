import { createBackoff, type Backoff } from './backoff.ts';
import {
	STUCK_COPY_STATE_POSITION,
	STUCK_COPY_REASON_POSITION,
	STUCK_COPY_COUNT_POSITION,
	STUCK_COPY_SINCE_POSITION,
	STUCK_COPY_RETRY_AT_POSITION,
} from './sharedStatusSlots.ts';

export const STUCK_COPY_RETRYING = 1;
export const STUCK_COPY_HELD = 2;
export const STUCK_COPY_REFUSED = 3;
const STATE_NAMES = ['', 'retrying', 'held', 'refused'] as const;

const STUCK_COPY_NO_PROGRESS = 1;
export const STUCK_COPY_OWNER_REFUSED = 2;
export const STUCK_COPY_ORIGIN_REFUSED = 3;
const REASONS = [
	'',
	'the copy made no durable progress from its start position',
	'Owned sharding slots require a complete co-owner or backup restore',
	'a sharded origin requires its origin or a complete co-owner',
];

export const COPY_STALL_HOLD_MIN_MS = 60_000;
export const COPY_STALL_HOLD_MAX_MS = 15 * 60_000;

export type StuckCopyTransition = {
	from: number;
	to: number;
	count: number;
	reason: number;
	holdMs?: number;
	quiet?: boolean;
};

/**
 * The receiving leg's view of a copy that does not finish (harper-pro#1235, #1231): attempts started from one
 * position with no durable progress between them, and refusals of a copy this node cannot accept. Lives on the
 * leg's `NodeReplicationConnection`, which outlives its sockets. Only durable progress resets the attempt
 * count; a session that stays open without starting or refusing a copy clears what was reported.
 */
export class CopyStallTracker {
	attempts = 0;
	startKey: string | undefined;
	state = 0;
	reason = 0;
	count = 0;
	since = 0;
	retryAt = 0;
	limit: number;
	hold: Backoff;
	status: Float64Array | undefined;
	now: () => number;
	// a close holds the leg only for what its own session did
	private sessionStarted = false;
	private sessionRefused = false;

	constructor(limit: number, options: { random?: () => number; now?: () => number } = {}) {
		this.limit = limit;
		this.now = options.now ?? Date.now;
		this.hold = createBackoff({
			initialMs: COPY_STALL_HOLD_MIN_MS,
			minMs: COPY_STALL_HOLD_MIN_MS,
			maxMs: COPY_STALL_HOLD_MAX_MS,
			random: options.random,
			now: this.now,
		});
	}

	noteOpened(): void {
		this.sessionStarted = this.sessionRefused = false;
		if (!this.retryAt) return;
		this.retryAt = 0;
		this.publish();
	}

	noteCopyStart(startKey: string): StuckCopyTransition | undefined {
		this.sessionStarted = true;
		if (startKey !== this.startKey) {
			this.attempts = 1;
			this.startKey = startKey;
			return this.state === STUCK_COPY_HELD || this.state === STUCK_COPY_RETRYING ? this.clear() : undefined;
		}
		this.attempts++;
		// a refused leg is settled at close, so repeated refusals do not flap through retrying
		if (this.state === STUCK_COPY_REFUSED) return;
		return this.enter(
			this.state === STUCK_COPY_HELD ? STUCK_COPY_HELD : STUCK_COPY_RETRYING,
			STUCK_COPY_NO_PROGRESS,
			this.attempts
		);
	}

	noteRefusal(reason: number): StuckCopyTransition | undefined {
		this.sessionRefused = true;
		return this.enter(STUCK_COPY_REFUSED, reason, this.state === STUCK_COPY_REFUSED ? this.count + 1 : 1);
	}

	noteCursorPersisted(cursorKey: string): StuckCopyTransition | undefined {
		if (cursorKey !== this.startKey) return this.noteDurableProgress();
	}

	noteDurableProgress(): StuckCopyTransition | undefined {
		if (!this.attempts && this.startKey === undefined && !this.state) return;
		this.attempts = 0;
		this.startKey = undefined;
		return this.clear();
	}

	// an idle leg may never deliver the durable progress that otherwise clears its state
	noteSessionQuiet(): StuckCopyTransition | undefined {
		if (this.sessionStarted || this.sessionRefused || !this.state) return;
		// only what is reported: a copy can start after this, and only progress resets the count or the hold
		const from = this.state;
		this.state = this.reason = this.count = this.since = this.retryAt = 0;
		this.publish();
		return { from, to: 0, count: 0, reason: 0, quiet: true };
	}

	/**
	 * The leg's socket closed: how long its reconnect must wait, 0 for the ordinary schedule. A session that
	 * reached the `limit`-th attempt from one position, or that an owner refused, holds the leg on a backoff of
	 * its own that doubles per held failure. An origin refusal follows a sharding map change that can clear
	 * within seconds, so it keeps the ordinary schedule.
	 */
	noteClosed(): { holdMs: number; transition?: StuckCopyTransition } {
		const refused = this.sessionRefused && this.reason === STUCK_COPY_OWNER_REFUSED;
		// a refusal reported earlier does not exempt a later accepted copy that fails at one position
		const exhausted = !this.sessionRefused && this.sessionStarted && this.attempts >= this.limit;
		let settled: StuckCopyTransition | undefined;
		if (this.state === STUCK_COPY_REFUSED && this.sessionStarted && !this.sessionRefused && !exhausted)
			settled =
				this.attempts >= 2 ? this.enter(STUCK_COPY_RETRYING, STUCK_COPY_NO_PROGRESS, this.attempts) : this.clear();
		this.sessionStarted = this.sessionRefused = false;
		if (!exhausted && !refused) return { holdMs: 0, transition: settled };
		const holdMs = this.hold.nextDelay() ?? COPY_STALL_HOLD_MAX_MS;
		this.retryAt = this.now() + holdMs;
		const transition = exhausted ? this.enter(STUCK_COPY_HELD, STUCK_COPY_NO_PROGRESS, this.attempts) : undefined;
		this.publish();
		if (transition) transition.holdMs = holdMs;
		return { holdMs, transition };
	}

	attachStatus(status: Float64Array | undefined): void {
		this.status = status;
		this.publish();
	}

	private enter(state: number, reason: number, count: number): StuckCopyTransition | undefined {
		const from = this.state;
		const changed = from !== state || this.reason !== reason;
		if (from !== state) this.since = this.now();
		this.state = state;
		this.reason = reason;
		this.count = count;
		this.publish();
		return changed ? { from, to: state, count, reason } : undefined;
	}

	private clear(): StuckCopyTransition | undefined {
		const from = this.state;
		this.hold.reset();
		this.state = this.reason = this.count = this.since = this.retryAt = 0;
		this.publish();
		return from ? { from, to: 0, count: 0, reason: 0 } : undefined;
	}

	// readers on other threads key off the state slot, so a change clears it first and sets it last
	private publish(): void {
		const status = this.status;
		if (!status) return;
		const changed = status[STUCK_COPY_STATE_POSITION] !== this.state;
		if (changed) status[STUCK_COPY_STATE_POSITION] = 0;
		status[STUCK_COPY_REASON_POSITION] = this.reason;
		status[STUCK_COPY_COUNT_POSITION] = this.count;
		status[STUCK_COPY_SINCE_POSITION] = this.since;
		status[STUCK_COPY_RETRY_AT_POSITION] = this.state ? this.retryAt : 0;
		if (changed) status[STUCK_COPY_STATE_POSITION] = this.state;
	}
}

export function copyStartKey(
	cursor: { copyStartTime?: unknown; currentTable?: unknown; afterKey?: unknown } | undefined,
	encode: (value: unknown) => Uint8Array
): string {
	if (!cursor) return 'fresh';
	return Buffer.from(encode([cursor.copyStartTime, cursor.currentTable, cursor.afterKey])).toString('base64');
}

export function readStuckCopy(
	status: Float64Array
): { state: string; reason: string; count: number; since: string; retryAt?: string } | undefined {
	const state = status[STUCK_COPY_STATE_POSITION];
	const name = STATE_NAMES[state];
	if (!name) return undefined;
	const retryAt = status[STUCK_COPY_RETRY_AT_POSITION];
	return {
		state: name,
		reason: REASONS[status[STUCK_COPY_REASON_POSITION]] ?? 'unknown',
		count: status[STUCK_COPY_COUNT_POSITION],
		since: new Date(status[STUCK_COPY_SINCE_POSITION]).toISOString(),
		...(retryAt > 0 ? { retryAt: new Date(retryAt).toISOString() } : {}),
	};
}

export function describeStuckCopy(transition: StuckCopyTransition): string {
	const reason = REASONS[transition.reason];
	switch (transition.to) {
		case STUCK_COPY_RETRYING:
			return `copy is retrying from the same position (attempt ${transition.count}): ${reason}`;
		case STUCK_COPY_HELD:
			return `copy stopped after ${transition.count} attempts from one position; retrying in ${Math.round((transition.holdMs ?? 0) / 1000)}s: ${reason}`;
		case STUCK_COPY_REFUSED:
			return transition.reason === STUCK_COPY_OWNER_REFUSED
				? `refused a copy this node cannot accept; reconnects are held: ${reason}`
				: `refused a copy this node cannot accept; reconnecting on the ordinary schedule: ${reason}`;
		default:
			return transition.quiet
				? 'no copy started this session; cleared the stuck-copy report'
				: 'copy is progressing again';
	}
}
