import { createBackoff, type Backoff } from './backoff.ts';

// Shared-status slots (`REPLICATION_SHARED_STATUS_SLOTS` in knownNodes.ts); since and retry-at are epoch ms.
export const STUCK_COPY_STATE_POSITION = 32;
export const STUCK_COPY_COUNT_POSITION = 33;
export const STUCK_COPY_SINCE_POSITION = 34;
export const STUCK_COPY_RETRY_AT_POSITION = 35;

export const STUCK_COPY_RETRYING = 1;
export const STUCK_COPY_HELD = 2;
const STATE_NAMES = ['', 'retrying', 'held'] as const;
const NO_PROGRESS_REASON = 'the copy made no durable progress from its start position';

export const COPY_STALL_HOLD_MIN_MS = 60_000;
export const COPY_STALL_HOLD_MAX_MS = 15 * 60_000;

export type StuckCopyTransition = {
	from: number;
	to: number;
	count: number;
	holdMs?: number;
	quiet?: boolean;
};

/**
 * The receiving leg's view of a copy that does not finish (harper-pro#1235): attempts started from one position
 * with no durable progress between them. Lives on the leg's `NodeReplicationConnection`, which outlives its
 * sockets. Only durable progress resets the attempt count; a session that stays open without starting a copy
 * clears what was reported.
 */
export class CopyStallTracker {
	attempts = 0;
	startKey: string | undefined;
	state = 0;
	count = 0;
	since = 0;
	retryAt = 0;
	limit: number;
	hold: Backoff;
	status: Float64Array | undefined;
	now: () => number;
	// a close holds the leg only for what its own session did
	private sessionStarted = false;

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
		this.sessionStarted = false;
		if (!this.retryAt) return;
		this.retryAt = 0;
		this.publish();
	}

	noteCopyStart(startKey: string): StuckCopyTransition | undefined {
		this.sessionStarted = true;
		if (startKey !== this.startKey) {
			this.attempts = 1;
			this.startKey = startKey;
			return this.state || this.hold.attempts ? this.clear() : undefined;
		}
		this.attempts++;
		return this.enter(this.state === STUCK_COPY_HELD ? STUCK_COPY_HELD : STUCK_COPY_RETRYING, this.attempts);
	}

	noteCursorPersisted(cursorKey: string): StuckCopyTransition | undefined {
		if (cursorKey !== this.startKey) return this.noteDurableProgress();
	}

	noteDurableProgress(): StuckCopyTransition | undefined {
		if (!this.attempts && this.startKey === undefined && !this.state && !this.hold.attempts) return;
		this.attempts = 0;
		this.startKey = undefined;
		return this.clear();
	}

	// an idle leg may never deliver the durable progress that otherwise clears its state
	noteSessionQuiet(): StuckCopyTransition | undefined {
		if (this.sessionStarted || !this.state) return;
		// only what is reported: a copy can start after this, and only progress resets the count or the hold
		const from = this.state;
		this.state = this.count = this.since = this.retryAt = 0;
		this.publish();
		return { from, to: 0, count: 0, quiet: true };
	}

	/** The leg's socket closed: how long its reconnect must wait, 0 for the ordinary schedule. */
	noteClosed(): { holdMs: number; transition?: StuckCopyTransition } {
		const exhausted = this.sessionStarted && this.attempts >= this.limit;
		this.sessionStarted = false;
		if (!exhausted) return { holdMs: 0 };
		const holdMs = this.hold.nextDelay() ?? COPY_STALL_HOLD_MAX_MS;
		this.retryAt = this.now() + holdMs;
		const transition = this.enter(STUCK_COPY_HELD, this.attempts);
		this.publish();
		if (transition) transition.holdMs = holdMs;
		return { holdMs, transition };
	}

	attachStatus(status: Float64Array | undefined): void {
		this.status = status;
		this.publish();
	}

	private enter(state: number, count: number): StuckCopyTransition | undefined {
		const from = this.state;
		if (from !== state) this.since = this.now();
		this.state = state;
		this.count = count;
		this.publish();
		return from !== state ? { from, to: state, count } : undefined;
	}

	private clear(): StuckCopyTransition | undefined {
		const from = this.state;
		this.hold.reset();
		this.state = this.count = this.since = this.retryAt = 0;
		this.publish();
		return from ? { from, to: 0, count: 0 } : undefined;
	}

	// readers on other threads key off the state slot, so a change clears it first and sets it last
	private publish(): void {
		const status = this.status;
		if (!status) return;
		const changed = status[STUCK_COPY_STATE_POSITION] !== this.state;
		if (changed) status[STUCK_COPY_STATE_POSITION] = 0;
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
		reason: NO_PROGRESS_REASON,
		count: status[STUCK_COPY_COUNT_POSITION],
		since: new Date(status[STUCK_COPY_SINCE_POSITION]).toISOString(),
		...(retryAt > 0 ? { retryAt: new Date(retryAt).toISOString() } : {}),
	};
}

export function describeStuckCopy(transition: StuckCopyTransition): string {
	switch (transition.to) {
		case STUCK_COPY_RETRYING:
			return `copy is retrying from the same position (attempt ${transition.count}): ${NO_PROGRESS_REASON}`;
		case STUCK_COPY_HELD:
			return `copy stopped after ${transition.count} attempts from one position; retrying in ${Math.round((transition.holdMs ?? 0) / 1000)}s: ${NO_PROGRESS_REASON}`;
		default:
			return transition.quiet
				? 'no copy started this session; cleared the stuck-copy report'
				: 'copy is progressing again';
	}
}
