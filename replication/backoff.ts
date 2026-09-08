/**
 * The one backoff schedule replication retries use; the adopting sites and their parameters are in
 * `DESIGN.md` under "Backoff discipline".
 *
 * Full jitter (uniform over the whole window) is the default because decorrelating a fleet's retries
 * matters more than a tight worst-case delay on these cold error paths. `minMs` preserves a site's
 * independent lower bound while jittering the rest of the window.
 *
 * `budgetMs` is a deadline read off an injected monotonic clock, not a sum of requested sleeps: a
 * resolver hang or an event-loop stall must not extend a bounded grace period past what it advertises.
 * `maxAttempts` is the bound that still holds when the clock does not advance.
 */

export interface BackoffOptions {
	initialMs: number;
	maxMs: number;
	minMs?: number;
	factor?: number;
	jitter?: 'full' | 'none';
	budgetMs?: number;
	maxAttempts?: number;
	random?: () => number;
	now?: () => number;
}

export interface Backoff {
	nextDelay(): number | undefined;
	reset(): void;
	readonly attempts: number;
	readonly ceiling: number;
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
	function isExhausted(currentTime: number): boolean {
		if (maxAttempts !== undefined && attempts >= maxAttempts) return true;
		return deadline !== undefined && currentTime >= deadline;
	}

	return {
		get attempts() {
			return attempts;
		},
		get ceiling() {
			return ceilingFor(attempts);
		},
		get exhausted() {
			return isExhausted(now());
		},
		nextDelay() {
			const currentTime = now();
			if (isExhausted(currentTime)) return undefined;
			const ceiling = ceilingFor(attempts);
			attempts++;
			let delay = jitter === 'none' ? ceiling : minMs + Math.floor(random() * (ceiling - minMs));
			if (deadline !== undefined) delay = Math.min(delay, deadline - currentTime);
			return delay;
		},
		reset() {
			attempts = 0;
			if (budgetMs !== undefined) deadline = now() + budgetMs;
		},
	};
}
