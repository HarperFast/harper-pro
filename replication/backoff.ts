/**
 * The one backoff schedule replication retries use. Before harper-pro#327 every retry site rolled its
 * own pacing — flat delays at the subscription-setup scheduler, jitterless exponentials at the
 * connection and hdb_nodes-watcher layers — and a `grep` for jitter found none in production code, so
 * a fleet reacting to one event retried in lockstep and a fast failure loop retried at a fixed rate
 * forever.
 *
 * Full jitter (uniform over the whole window) rather than equal/decorrelated jitter: on these cold
 * error paths, spreading a fleet's retries matters more than a tight worst-case delay. `minMs` is the
 * escape hatch for sites where a near-zero draw would itself be harmful — the reconnect path
 * accumulates native TLS state per dial (harper-pro#339), so it floors the window rather than
 * accepting an occasional `setTimeout(0)` re-dial.
 *
 * `budgetMs` is a wall-clock deadline, not a sum of requested sleeps: a resolver hang or an
 * event-loop stall must not extend a bounded grace period past what it advertises (the send-auth
 * reprobe fails closed at its deadline, so an overrun delays enforcing a revocation). `maxAttempts`
 * is defense in depth for the same sites, and stands on its own when `now` never advances.
 */

export interface BackoffOptions {
	/** Ceiling for the first attempt; doubles (or `factor`s) from there. */
	initialMs: number;
	/** Upper bound on the ceiling. */
	maxMs: number;
	/** Lower bound on every returned delay. Defaults to 0 (pure full jitter). */
	minMs?: number;
	factor?: number;
	jitter?: 'full' | 'none';
	/** Wall-clock budget, measured from creation/`reset()`. Without it the schedule never exhausts. */
	budgetMs?: number;
	maxAttempts?: number;
	random?: () => number;
	/** Monotonic clock. Injected for tests; `Date.now` would let a wall-clock jump extend a budget. */
	now?: () => number;
}

export interface Backoff {
	/** The delay to wait before the next attempt, and advances the schedule. */
	nextDelay(): number;
	/** Back to the first attempt, and restarts the budget clock. Call on real progress, not on setup. */
	reset(): void;
	/** How many delays have been handed out since the last reset. */
	readonly attempts: number;
	/** The ceiling the next `nextDelay()` will draw under. */
	readonly ceiling: number;
	/** True once the budget deadline has passed or `maxAttempts` delays have been handed out. */
	readonly exhausted: boolean;
}

export function createBackoff(options: BackoffOptions): Backoff {
	const {
		initialMs,
		maxMs,
		minMs = 0,
		factor = 2,
		jitter = 'full',
		budgetMs,
		maxAttempts,
		random = Math.random,
		now = () => performance.now(),
	} = options;
	let attempts = 0;
	let deadline = budgetMs === undefined ? undefined : now() + budgetMs;

	function ceilingFor(attempt: number): number {
		return Math.max(minMs, Math.min(initialMs * factor ** attempt, maxMs));
	}

	return {
		get attempts() {
			return attempts;
		},
		get ceiling() {
			return ceilingFor(attempts);
		},
		get exhausted() {
			if (maxAttempts !== undefined && attempts >= maxAttempts) return true;
			return deadline !== undefined && now() >= deadline;
		},
		nextDelay() {
			const ceiling = ceilingFor(attempts);
			attempts++;
			let delay = jitter === 'full' ? minMs + Math.floor(random() * (ceiling - minMs)) : ceiling;
			if (deadline !== undefined) delay = Math.max(0, Math.min(delay, deadline - now()));
			return delay;
		},
		reset() {
			attempts = 0;
			if (budgetMs !== undefined) deadline = now() + budgetMs;
		},
	};
}
