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

export const STUCK_COPY_NO_PROGRESS = 1;
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

export type StuckCopyTransition = { from: number; to: number; count: number; reason: number; holdMs?: number };

/**
 * The receiving leg's view of a copy that does not finish (harper-pro#1235, #1231): attempts started from one
 * position with no durable progress between them, and refusals of a copy this node cannot accept. Lives on the
 * leg's `NodeReplicationConnection`, which outlives its sockets. Only durable progress resets the attempt
 * count; a refusal also clears once a later session has stayed open without one.
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

	/** A copy began from `startKey` (a structural cursor key, or `fresh`). */
	noteCopyStart(startKey: string): StuckCopyTransition | undefined {
		this.attempts = startKey === this.startKey ? this.attempts + 1 : 1;
		this.startKey = startKey;
		if (this.attempts < 2 || this.state === STUCK_COPY_REFUSED) return;
		return this.enter(
			this.state === STUCK_COPY_HELD ? STUCK_COPY_HELD : STUCK_COPY_RETRYING,
			STUCK_COPY_NO_PROGRESS,
			this.attempts
		);
	}

	noteRefusal(reason: number): StuckCopyTransition | undefined {
		return this.enter(STUCK_COPY_REFUSED, reason, this.state === STUCK_COPY_REFUSED ? this.count + 1 : 1);
	}

	/** A copy cursor was persisted; one at the position the attempt started from is not progress. */
	noteCursorPersisted(cursorKey: string): StuckCopyTransition | undefined {
		if (cursorKey !== this.startKey) return this.noteDurableProgress();
	}

	/** Copy rows or replicated writes became durable on this leg. */
	noteDurableProgress(): StuckCopyTransition | undefined {
		this.attempts = 0;
		this.startKey = undefined;
		return this.clear();
	}

	/** A later session stayed open long enough without a refusal. */
	noteRefusalLapsed(): StuckCopyTransition | undefined {
		if (this.state === STUCK_COPY_REFUSED) return this.clear();
	}

	/**
	 * The leg's socket closed: how long its reconnect must wait, 0 for the ordinary schedule. A refusal, or the
	 * `limit`-th attempt from one position, holds it on a backoff of its own that doubles per held failure.
	 */
	noteClosed(): { holdMs: number; transition?: StuckCopyTransition } {
		const exhausted = this.attempts >= this.limit && this.state !== STUCK_COPY_REFUSED;
		if (!exhausted && this.state !== STUCK_COPY_REFUSED) return { holdMs: 0 };
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
		if (from !== state) this.since = this.now();
		this.state = state;
		this.reason = reason;
		this.count = count;
		this.publish();
		return from === state ? undefined : { from, to: state, count, reason };
	}

	private clear(): StuckCopyTransition | undefined {
		const from = this.state;
		this.hold.reset();
		this.state = this.reason = this.count = this.since = this.retryAt = 0;
		this.publish();
		return from ? { from, to: 0, count: 0, reason: 0 } : undefined;
	}

	// readers on other threads key off the state slot, so it is cleared first and set last
	private publish(): void {
		const status = this.status;
		if (!status) return;
		status[STUCK_COPY_STATE_POSITION] = 0;
		status[STUCK_COPY_REASON_POSITION] = this.reason;
		status[STUCK_COPY_COUNT_POSITION] = this.count;
		status[STUCK_COPY_SINCE_POSITION] = this.since;
		status[STUCK_COPY_RETRY_AT_POSITION] = this.state ? this.retryAt : 0;
		status[STUCK_COPY_STATE_POSITION] = this.state;
	}
}

/** The structural start position of a copy: its persisted resume cursor, or `fresh` when there is none. */
export function copyStartKey(
	cursor: { copyStartTime?: unknown; currentTable?: unknown; afterKey?: unknown } | undefined,
	encode: (value: unknown) => Uint8Array
): string {
	if (!cursor) return 'fresh';
	return Buffer.from(encode([cursor.copyStartTime, cursor.currentTable, cursor.afterKey])).toString('base64');
}

/** `cluster_status`'s view of a leg's stuck copy, or undefined when there is none. */
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
			return `refused a copy this node cannot accept; reconnects are held: ${reason}`;
		default:
			return 'copy is progressing again';
	}
}
