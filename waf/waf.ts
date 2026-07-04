/**
 * WAF (Web Application Firewall) component — prototype.
 *
 * Registers an HTTP middleware as early as possible in the chain (`before: 'authentication'`)
 * that evaluates request-phase rules from the `system.hdb_waf_rules` table against a compiled,
 * immutable matcher (see matcher.ts). Rule changes are picked up via a real-time table
 * subscription; recompiles are debounced and the matcher reference is swapped atomically.
 *
 * Uses the extension API (start/startOnMainThread) like the other harper-pro builtins
 * (replication, licensing): the table must be defined on the main thread too so the
 * operations API can validate writes against it, and startOnMainThread is the only
 * main-thread hook — the new Plugin API (handleApplication) is worker-only.
 *
 * Root-config enablement (harperdb-config.yaml):
 *   waf:
 *     enabled: true          # default true when the waf block is present
 *     scoreThreshold: 10     # accumulated score at which score-action rules block
 *     debounceMs: 100        # recompile debounce for rule-change bursts
 *     logRateLimit: 100      # max match log lines per rule per interval (O3)
 *     logRateIntervalMs: 60000
 *
 * The component itself is wired into HARPER_BUILTIN_COMPONENTS in bin/harper.js.
 *
 * Robustness invariants (adversarial review):
 * - the worker start hook subscribes BEFORE the initial scan so a rule committed in the scan
 *   window still triggers a recompile (O5/O7);
 * - the initial compile can't throw out of start() — on failure the middleware still registers
 *   (pass-through) and a backoff retry runs (O2);
 * - the middleware wraps evaluate() and FAILS OPEN on any internal error (O1);
 * - match logging is rate-limited per rule to prevent a log-flood DoS (O3).
 *
 * Prototype scope notes / known limitations:
 * - phase 'requestBody' rules are not evaluated (future work: needs body access after the
 *   body-parsing point in the chain, without forcing body reads for non-matching requests).
 * - client ip is the socket peer address (request.ip); X-Forwarded-For is NOT trusted. In the
 *   standard Symphony-over-UDS topology Harper recovers the real client ip via PROXY protocol,
 *   so socket-ip rules are correct there today; explicit XFF trust is the future-work case (O6).
 * - the WAF middleware registers only in the worker `start` hook, so it covers worker HTTP/REST/
 *   app ports, NOT the main-thread operations-API port (that surface is governed by role perms).
 * - request path is canonicalized before matching (bounded percent-decode, dot-segment
 *   resolution, duplicate-slash collapse) so encoding/traversal evasions are defeated; it is NOT
 *   case-folded (case-sensitive paths are legitimate app semantics). See canonicalizePath and
 *   WafRequestInfo.path in matcher.ts (M6).
 * - rules live in `system.hdb_waf_rules` (same pattern as replication's hdb_nodes): generic CRUD
 *   on system tables is forbidden by core, so management goes through dedicated super_user-only
 *   operations (ruleOperations.ts); system tables replicate cluster-wide by default.
 */

import { loggerWithTag } from '../core/utility/logging/harper_logger.js';
import { canonicalizePath, compileRules, type WafMatcher, type WafRequestInfo } from './matcher.ts';
import { makeWafRuleOperations } from './ruleOperations.ts';
import type { WafRule } from './rules.ts';

export const WAF_RULE_TABLE = 'hdb_waf_rules';
export const WAF_RULE_DATABASE = 'system';

const logger = loggerWithTag('waf');

interface WafComponentOptions {
	server: any;
	ensureTable(definition: any): any;
	enabled?: boolean;
	scoreThreshold?: number;
	debounceMs?: number;
	/** Max WAF match log lines per rule per interval (O3, default 100). */
	logRateLimit?: number;
	/** Log rate-limit window in ms (default 60000). */
	logRateIntervalMs?: number;
	[key: string]: any;
}

/** Minimal status → reason-phrase map for the opaque block response (O4). */
const STATUS_TEXT: Record<number, string> = {
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	405: 'Method Not Allowed',
	406: 'Not Acceptable',
	422: 'Unprocessable Entity',
	429: 'Too Many Requests',
};

/**
 * Per-rule log rate limiter (O3): caps match log lines per rule per interval to prevent an
 * attacker-driven log flood via a broad rule, emitting a single suppressed-count summary per
 * interval instead. `shouldLog` also returns any pending summary text to flush.
 */
class LogRateLimiter {
	#limit: number;
	#intervalMs: number;
	#windows = new Map<string | number, { windowStart: number; count: number; suppressed: number }>();

	constructor(limit: number, intervalMs: number) {
		this.#limit = limit;
		this.#intervalMs = intervalMs;
	}

	/** Returns { allow, summary? }: allow=true to emit this line; summary is a flush line if any. */
	consume(ruleId: string | number, now: number): { allow: boolean; summary?: string } {
		let window = this.#windows.get(ruleId);
		if (window === undefined || now - window.windowStart >= this.#intervalMs) {
			const summary =
				window && window.suppressed > 0
					? `WAF rule ${ruleId} suppressed ${window.suppressed} additional match log lines in the last ${Math.round(this.#intervalMs / 1000)}s`
					: undefined;
			this.#windows.set(ruleId, { windowStart: now, count: 1, suppressed: 0 });
			return { allow: true, summary };
		}
		if (window.count < this.#limit) {
			window.count++;
			return { allow: true };
		}
		window.suppressed++;
		return { allow: false };
	}
}

const TABLE_DEFINITION = {
	table: WAF_RULE_TABLE,
	database: WAF_RULE_DATABASE,
	attributes: [
		{ name: 'id', isPrimaryKey: true },
		{ name: 'enabled' },
		{ name: 'priority' },
		{ name: 'phase' },
		{ name: 'description' },
		{ name: 'match' },
		{ name: 'action' },
		{ name: 'score' },
		{ name: 'blockStatus' },
	],
};

let currentMatcher: WafMatcher | null = null;

/** Reusable per-worker request-info adapter; evaluate() is fully synchronous so this is safe. */
const requestInfo: WafRequestInfo & {
	headers: { get(name: string): string | string[] | undefined; keys?(): Iterable<string> } | null;
} = {
	ip: undefined,
	method: '',
	path: '',
	query: undefined,
	headers: null,
	getHeader(name: string) {
		return this.headers!.get(name);
	},
	headerNames() {
		// RequestHeaders.keys() returns the already-lower-cased node header names
		return this.headers!.keys?.();
	},
};

/**
 * Main-thread init: define the rule table and register the dedicated management operations
 * (the operations API only runs on the main thread in v5.1+). Generic CRUD operations cannot
 * touch system tables, so add/alter/drop/list_waf_rule(s) are the management surface — see
 * ruleOperations.ts for the authorization model.
 */
export function startOnMainThread(options: WafComponentOptions) {
	if (options.enabled === false) return;
	const WafRuleTable = options.ensureTable(TABLE_DEFINITION);
	const operations = makeWafRuleOperations(WafRuleTable);
	options.server.registerOperation?.({ name: 'add_waf_rule', execute: operations.addWafRule, httpMethod: 'POST' });
	options.server.registerOperation?.({ name: 'alter_waf_rule', execute: operations.alterWafRule, httpMethod: 'POST' });
	options.server.registerOperation?.({ name: 'drop_waf_rule', execute: operations.dropWafRule, httpMethod: 'POST' });
	options.server.registerOperation?.({ name: 'list_waf_rules', execute: operations.listWafRules, httpMethod: 'GET' });
}

/** Per-worker teardown state, cleared by stop() (O8). */
let stopWorker: (() => void) | null = null;

/**
 * Worker init: subscribe for changes FIRST, then compile from the initial scan, then register the
 * request middleware. NOTE: the middleware only registers on worker HTTP/REST/app ports; the
 * main-thread operations-API port is not covered (rules manage that surface via role permissions).
 */
export function start(options: WafComponentOptions) {
	if (options.enabled === false) {
		logger.info?.('WAF disabled by configuration');
		return;
	}
	stop(); // idempotent: tear down any prior worker instance (reload) before starting fresh
	currentMatcher = null; // start from pass-through until the initial compile lands
	const scoreThreshold = options.scoreThreshold ?? 10;
	const debounceMs = options.debounceMs ?? 100;
	const rateLimiter = new LogRateLimiter(options.logRateLimit ?? 100, options.logRateIntervalMs ?? 60_000);
	const WafRuleTable = options.ensureTable(TABLE_DEFINITION);

	function readAllRules(): WafRule[] {
		// primaryStore.getRange is the established pattern for a full scan outside a request
		// context (see replication/knownNodes.ts); undecodable rows are skipped.
		const rules: WafRule[] = [];
		for (const { value } of WafRuleTable.primaryStore.getRange({})) {
			if (value) rules.push(value as WafRule);
		}
		return rules;
	}

	function recompile() {
		const rules = readAllRules();
		const matcher = compileRules(rules, {
			scoreThreshold,
			onInvalidRule(ruleId, problems) {
				logger.warn?.(`WAF rule ${ruleId} skipped: ${problems.join('; ')}`);
			},
		});
		currentMatcher = matcher; // atomic reference swap; in-flight evaluations keep the old one
		logger.debug?.(`WAF compiled ${matcher.ruleCount} rules (${matcher.invalidRules.size} invalid)`);
	}

	// --- lifecycle flags/timers (O8: cleared by stop) ---
	let stopped = false;
	let recompileTimer: NodeJS.Timeout | null = null;
	let initialRetryTimer: NodeJS.Timeout | null = null;

	const scheduleRecompile = () => {
		if (recompileTimer || stopped) return;
		recompileTimer = setTimeout(() => {
			recompileTimer = null;
			if (stopped) return;
			try {
				recompile();
			} catch (error) {
				logger.error?.('WAF rule recompile failed; keeping previous matcher', error);
			}
		}, debounceMs);
		recompileTimer.unref?.();
	};

	// O5/O7: subscribe BEFORE the initial scan so a rule committed during the scan window still
	// fires an event (queued behind the async subscribe) and triggers a debounced recompile.
	// The events processed before the initial recompile completes only schedule recompiles, so no
	// event is lost even though the first scan reads slightly later.
	(async () => {
		while (!stopped) {
			try {
				const events = await WafRuleTable.subscribe({ omitCurrent: true });
				if (stopped) break;
				for await (const event of events) {
					if (stopped) break;
					if (event?.type === 'end_txn') continue;
					scheduleRecompile();
				}
				if (!stopped) logger.warn?.('WAF rule subscription ended; resubscribing');
			} catch (error) {
				if (stopped) break;
				logger.error?.('WAF rule subscription failed; retrying', error);
			}
			if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000).unref?.());
		}
	})();

	// O2: the initial compile must not throw out of start() (that would skip middleware
	// registration and silently pass ALL traffic on this worker with no retry). On failure keep
	// the null/empty matcher (pass-through) and retry with backoff, symmetric with the debounced
	// keep-previous-on-error path.
	const initialCompileWithRetry = (attempt: number) => {
		if (stopped) return;
		try {
			recompile();
		} catch (error) {
			const delay = Math.min(1000 * 2 ** attempt, 30_000);
			logger.error?.(`WAF initial rule compile failed; passing traffic through, retrying in ${delay}ms`, error);
			initialRetryTimer = setTimeout(() => {
				initialRetryTimer = null;
				initialCompileWithRetry(attempt + 1);
			}, delay);
			initialRetryTimer.unref?.();
		}
	};
	initialCompileWithRetry(0);

	// --- request-phase middleware, as early in the chain as possible ---
	// `before: 'authentication'` orders it ahead of the core auth middleware (named after its
	// component, see TRUSTED_RESOURCE_PLUGINS); runFirst additionally front-loads it among
	// unconstrained entries. Deliberately NOT async: the non-matching path must not allocate a
	// promise per request. Registered unconditionally (O2) even if the initial compile failed.
	options.server.http(
		(request: any, nextHandler: (request: any) => any) => {
			const matcher = currentMatcher;
			if (matcher === null || matcher.isEmpty) return nextHandler(request);
			let decision;
			try {
				const url: string = request.url;
				const queryStart = url.indexOf('?');
				requestInfo.ip = request.ip;
				requestInfo.method = request.method;
				requestInfo.path = canonicalizePath(queryStart === -1 ? url : url.slice(0, queryStart));
				requestInfo.query = queryStart === -1 ? undefined : url.slice(queryStart + 1);
				requestInfo.headers = request.headers;
				decision = matcher.evaluate(requestInfo);
			} catch (error) {
				// O1: FAIL OPEN on an internal WAF error — availability beats filtering. Rate-limit
				// the error log under the '__internal__' pseudo-rule so a systemic throw can't flood.
				const { allow } = rateLimiter.consume('__internal__', Date.now());
				if (allow) logger.error?.('WAF evaluation error; failing open (request allowed)', error);
				return nextHandler(request);
			} finally {
				requestInfo.headers = null; // never retain the request's headers past this call
			}
			if (decision === null) return nextHandler(request);
			const now = Date.now();
			if (decision.action === 'block') {
				const { allow, summary } = rateLimiter.consume(decision.ruleIds[0], now);
				if (summary) logger.info?.(summary);
				if (allow)
					logger.info?.(
						`WAF blocked ${request.method} ${requestInfo.path} from ${request.ip} (rules: ${decision.ruleIds.join(', ')}${decision.score !== undefined ? `, score ${decision.score}` : ''})`
					);
				// Enforcement short-circuits, telemetry must not: log-action rules that also matched
				// this request are still recorded (rate-limited) even though the request is blocked.
				const logRuleIds = decision.matchedLogRuleIds;
				if (logRuleIds !== undefined) {
					const logGate = rateLimiter.consume(logRuleIds[0], now);
					if (logGate.summary) logger.warn?.(logGate.summary);
					if (logGate.allow)
						logger.warn?.(
							`WAF rule match (log) ${request.method} ${requestInfo.path} from ${request.ip} (rules: ${logRuleIds.join(', ')}) [request blocked by ${decision.ruleIds.join(', ')}]`
						);
				}
				// O4: opaque body (no ruleIds to the client — server log only), correct reason
				// phrase for the status, explicit JSON content type. Never touches request.body.
				const status = decision.status;
				return {
					status,
					headers: new Headers({ 'Content-Type': 'application/json' }),
					body: JSON.stringify({ error: STATUS_TEXT[status] ?? 'Forbidden' }),
				};
			}
			// action 'log': record and continue (rate-limited per rule)
			const { allow, summary } = rateLimiter.consume(decision.ruleIds[0], now);
			if (summary) logger.warn?.(summary);
			if (allow)
				logger.warn?.(
					`WAF rule match (log) ${request.method} ${requestInfo.path} from ${request.ip} (rules: ${decision.ruleIds.join(', ')})`
				);
			return nextHandler(request);
		},
		{ name: 'waf', before: 'authentication', runFirst: true }
	);
	logger.info?.('WAF middleware registered (request phase)');

	// O8: teardown for component reload — break the subscription loop and clear pending timers so
	// they don't leak across reloads.
	stopWorker = () => {
		stopped = true;
		if (recompileTimer) clearTimeout(recompileTimer);
		if (initialRetryTimer) clearTimeout(initialRetryTimer);
		recompileTimer = null;
		initialRetryTimer = null;
	};
}

/** Worker teardown hook (O8): stops the subscription loop and clears timers. */
export function stop() {
	stopWorker?.();
	stopWorker = null;
}

/** Test hook: returns the live matcher (or null when no rules are loaded). */
export function getCurrentMatcher(): WafMatcher | null {
	return currentMatcher;
}
