/**
 * Per-worker tracker of in-flight replication blob *sends*, used to gracefully drain them before an
 * http worker shuts down during a restart (deploy reload, rolling restart).
 *
 * A worker restart that tears down a blob send mid-stream leaves the peer receiver's copy diverged
 * until it re-requests the blob (harper-pro#527 handles the receiver side). To avoid interrupting a
 * transfer that is about to finish, the worker's shutdown path drains sends that are still making
 * progress — bounded by an absolute deadline. `sendBlobs` registers each send, marks progress every
 * time bytes are written to the socket, and unregisters on completion; core's shutdown drain
 * ({@link ../core/components/shutdownDrain.ts}) polls {@link isDrainComplete} until every remaining
 * send has either finished, stalled (no bytes for {@link STALL_MS}), or the deadline has passed.
 *
 * Reset-on-bytes is the point: a healthy large transfer that keeps flowing is never treated as
 * stalled and is allowed to finish (up to the deadline); only a send that goes silent is abandoned.
 *
 * State is module-local, so it is naturally per-worker (each worker is a fresh module realm).
 */

/** A send that goes this long without writing bytes is considered stalled and no longer drained. */
export const STALL_MS = Math.max(0, Number(process.env.HARPER_BLOB_SEND_DRAIN_STALL_MS) || 0) || 5000;
/** How often the drain re-checks whether the remaining sends have finished or stalled. */
export const POLL_MS = 250;

export interface BlobSendProgress {
	lastProgressAt: number;
}

const activeSends = new Set<BlobSendProgress>();

// Set once the worker begins draining for shutdown, so no NEW sends are started while we drain (a
// worker still listening could otherwise keep registering fresh sends and hold the drain open to the
// ceiling). In-flight sends continue; skipped ones are re-requested by the peer on reconnect (fix (1)).
let draining = false;

/** Whether the worker has begun draining sends for shutdown (new sends should not be started). */
export function isDrainingBlobSends(): boolean {
	return draining;
}

/** Start tracking a blob send. Returns a handle to mark progress on and to end. */
export function registerBlobSend(): BlobSendProgress {
	const entry: BlobSendProgress = { lastProgressAt: Date.now() };
	activeSends.add(entry);
	return entry;
}

/** Mark that bytes were just written for this send — must stay cheap, it runs per chunk. */
export function noteBlobSendProgress(entry: BlobSendProgress): void {
	entry.lastProgressAt = Date.now();
}

/** Stop tracking a finished (or failed) blob send. */
export function endBlobSend(entry: BlobSendProgress): void {
	activeSends.delete(entry);
}

/** Whether any blob send is currently in flight. */
export function hasActiveBlobSends(): boolean {
	return activeSends.size > 0;
}

/**
 * Whether any blob send is currently making progress (wrote bytes within the stall window). This —
 * not merely "active" — gates the shutdown-deadline extension: an already-stalled send is worth
 * nothing to drain, so it must not push the force-kill backstops out to the ceiling.
 */
export function hasProgressingBlobSends(stallMs: number = STALL_MS): boolean {
	const now = Date.now();
	for (const entry of activeSends) {
		if (isSendProgressing(entry.lastProgressAt, now, stallMs)) return true;
	}
	return false;
}

/** A send is still worth waiting on if it wrote bytes within the stall window. */
export function isSendProgressing(lastProgressAt: number, now: number, stallMs: number): boolean {
	return now - lastProgressAt < stallMs;
}

/**
 * The drain is complete when the deadline has passed, or when no remaining send is still progressing
 * (all have finished or stalled). An empty set is trivially complete.
 */
export function isDrainComplete(
	lastProgressTimes: Iterable<number>,
	now: number,
	stallMs: number,
	deadlineMs: number
): boolean {
	if (now >= deadlineMs) return true;
	for (const lastProgressAt of lastProgressTimes) {
		if (isSendProgressing(lastProgressAt, now, stallMs)) return false;
	}
	return true;
}

/**
 * Resolve once every in-flight blob send has finished, stalled, or the absolute `deadlineMs` (epoch
 * timestamp) has passed — whichever comes first. Polls rather than waiting event-driven; this only
 * runs on the shutdown path, so the small poll cost is irrelevant and the logic stays trivially
 * testable.
 */
export function drainBlobSends(
	deadlineMs: number,
	stallMs: number = STALL_MS,
	pollMs: number = POLL_MS
): Promise<void> {
	draining = true; // quiesce: stop starting new sends for the rest of this worker's life
	return new Promise<void>((resolve) => {
		const check = () => {
			const now = Date.now();
			const times: number[] = [];
			for (const entry of activeSends) times.push(entry.lastProgressAt);
			if (isDrainComplete(times, now, stallMs, deadlineMs)) {
				resolve();
				return;
			}
			setTimeout(check, Math.min(pollMs, Math.max(0, deadlineMs - now))).unref();
		};
		check();
	});
}

/** Test-only: drop all tracked sends so unit tests start from a clean per-module state. */
export function _resetBlobSendDrainForTest(): void {
	activeSends.clear();
	draining = false;
}
