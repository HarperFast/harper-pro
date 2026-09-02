/**
 * The one backoff schedule replication retries use; the adopting sites and their parameters are in
 * `DESIGN.md` under "Backoff discipline".
 *
 * Full jitter (uniform over the whole window) is the default because decorrelating a fleet's retries
 * matters more than a tight worst-case delay on these cold error paths. `'equal'` (the top half of the
 * window) is for a site whose invariant is a *rate* bound rather than a latency bound: only a
 * ceiling-relative floor keeps the minimum interval proportional as the ceiling escalates. `minMs` is
 * the fixed-floor variant, for a site with a lower bound of its own.
 *
 * `budgetMs` is a deadline read off an injected monotonic clock, not a sum of requested sleeps: a
 * resolver hang or an event-loop stall must not extend a bounded grace period past what it advertises.
 * `maxAttempts` is the bound that still holds when the clock does not advance.
 */

export interface BackoffOptions {
	/** Ceiling for the first attempt; doubles (or `factor`s) from there. */
	initialMs: number;
	/** Upper bound on the ceiling. */
	maxMs: number;
	/** Lower bound on every returned delay. Defaults to 0 (pure full jitter). */
	minMs?: number;
	factor?: number;
	/** 'full': uniform over [minMs, ceiling). 'equal': uniform over the top half. 'none': the ceiling. */
	jitter?: 'full' | 'equal' | 'none';
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
			const floor = jitter === 'equal' ? Math.max(minMs, ceiling / 2) : minMs;
			let delay = jitter === 'none' ? ceiling : floor + Math.floor(random() * (ceiling - floor));
			if (deadline !== undefined) delay = Math.max(0, Math.min(delay, deadline - now()));
			return delay;
		},
		reset() {
			attempts = 0;
			if (budgetMs !== undefined) deadline = now() + budgetMs;
		},
	};
}
