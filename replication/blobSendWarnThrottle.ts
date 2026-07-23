/**
 * Throttled-warning helpers for making blob *send* starvation/decline diagnosable from default
 * (warn) logs — see `sendBlobs` in replicationConnection.ts. Two silent paths motivated this:
 *
 *   - A send parked on the outstanding-sends concurrency cap (`MAX_OUTSTANDING_BLOBS_BEING_SENT`)
 *     was invisible; a stuck predecessor send saturating the cap could starve successors with no
 *     trace in production logs (which run at warn, not debug).
 *   - A send declined outright (socket closed, or a shutdown drain in progress) only logged at
 *     debug, even though the peer now depends on re-requesting the blob to converge.
 *
 * Both are noisy on a burst (many blobs parking or declining around the same event), so both share
 * the throttled-aggregate pattern already used for blob send errors: emit at most once per window,
 * folding the count suppressed since the last emitted line into the next one.
 */

/** A parked send warns once it has waited this long without acquiring a send slot. */
const parkWarnMs = Number(process.env.HARPER_BLOB_SEND_PARK_WARN_MS);
export const PARK_WARN_MS =
	process.env.HARPER_BLOB_SEND_PARK_WARN_MS != null && !Number.isNaN(parkWarnMs) ? Math.max(0, parkWarnMs) : 5000;

/** Minimum gap between throttled warn lines of the same kind. */
export const WARN_THROTTLE_MS = 5000;

export interface ThrottleState {
	lastWarnAt: number;
	suppressedCount: number;
}

/** Fresh throttle state — first call always emits (lastWarnAt starts at -Infinity). */
export function createThrottleState(): ThrottleState {
	return { lastWarnAt: -Infinity, suppressedCount: 0 };
}

/**
 * Decide whether to emit a throttled warning now, folding in how many were suppressed since the
 * last one actually emitted. Mutates `state` in place so callers of the same throttle bucket just
 * check `.emit` and don't have to thread the state back out themselves.
 */
export function decideThrottledWarn(
	state: ThrottleState,
	now: number,
	throttleMs: number = WARN_THROTTLE_MS
): { emit: boolean; suppressedCount: number } {
	if (now - state.lastWarnAt >= throttleMs) {
		const suppressedCount = state.suppressedCount;
		state.lastWarnAt = now;
		state.suppressedCount = 0;
		return { emit: true, suppressedCount };
	}
	state.suppressedCount++;
	return { emit: false, suppressedCount: state.suppressedCount };
}
