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
 *     enabled: true        # default true when the waf block is present
 *     scoreThreshold: 10   # accumulated score at which score-action rules block
 *     debounceMs: 100      # recompile debounce for rule-change bursts
 *
 * The component itself is wired into HARPER_BUILTIN_COMPONENTS in bin/harper.js.
 *
 * Prototype scope notes:
 * - phase 'requestBody' rules are not evaluated (future work: needs body access after the
 *   body-parsing point in the chain, without forcing body reads for non-matching requests).
 * - client ip is the socket address (request.ip); X-Forwarded-For trust is future work.
 * - rules live in `system.hdb_waf_rules` (same pattern as replication's hdb_nodes): the system
 *   schema is excluded from non-super_user permission translation, so only super_user can
 *   manage rules via the operations API, and system tables replicate cluster-wide by default
 *   (not in NON_REPLICATING_SYSTEM_TABLES).
 */

import { loggerWithTag } from '../core/utility/logging/harper_logger.js';
import { compileRules, type WafMatcher, type WafRequestInfo } from './matcher.ts';
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
	[key: string]: any;
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

/** Worker init: compile rules, subscribe for changes, and register the request middleware. */
export function start(options: WafComponentOptions) {
	if (options.enabled === false) {
		logger.info?.('WAF disabled by configuration');
		return;
	}
	const scoreThreshold = options.scoreThreshold ?? 10;
	const debounceMs = options.debounceMs ?? 100;
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

	recompile();

	// --- live updates: subscribe to the rule table, debounce bursts, recompile, swap ---
	let recompileTimer: NodeJS.Timeout | null = null;
	const scheduleRecompile = () => {
		if (recompileTimer) return;
		recompileTimer = setTimeout(() => {
			recompileTimer = null;
			try {
				recompile();
			} catch (error) {
				logger.error?.('WAF rule recompile failed; keeping previous matcher', error);
			}
		}, debounceMs);
		recompileTimer.unref?.();
	};
	(async () => {
		// restart loop: a subscription can end (e.g. table reload); resubscribe and keep going
		while (true) {
			try {
				const events = await WafRuleTable.subscribe({ omitCurrent: true });
				for await (const event of events) {
					if (event?.type === 'end_txn') continue;
					scheduleRecompile();
				}
				logger.warn?.('WAF rule subscription ended; resubscribing');
			} catch (error) {
				logger.error?.('WAF rule subscription failed; retrying', error);
			}
			await new Promise((resolve) => setTimeout(resolve, 1000).unref?.());
		}
	})();

	// --- request-phase middleware, as early in the chain as possible ---
	// `before: 'authentication'` orders it ahead of the core auth middleware (named after its
	// component, see TRUSTED_RESOURCE_PLUGINS); runFirst additionally front-loads it among
	// unconstrained entries. Deliberately NOT async: the non-matching path must not allocate a
	// promise per request.
	options.server.http(
		(request: any, nextHandler: (request: any) => any) => {
			const matcher = currentMatcher;
			if (matcher === null || matcher.isEmpty) return nextHandler(request);
			const url: string = request.url;
			const queryStart = url.indexOf('?');
			requestInfo.ip = request.ip;
			requestInfo.method = request.method;
			requestInfo.path = queryStart === -1 ? url : url.slice(0, queryStart);
			requestInfo.query = queryStart === -1 ? undefined : url.slice(queryStart + 1);
			requestInfo.headers = request.headers;
			const decision = matcher.evaluate(requestInfo);
			requestInfo.headers = null; // don't retain the request beyond this call
			if (decision === null) return nextHandler(request);
			if (decision.action === 'block') {
				logger.info?.(
					`WAF blocked ${request.method} ${requestInfo.path} from ${request.ip} (rules: ${decision.ruleIds.join(', ')}${decision.score !== undefined ? `, score ${decision.score}` : ''})`
				);
				// respond without touching request.body
				return {
					status: decision.status,
					body: JSON.stringify({ error: 'Forbidden', rules: decision.ruleIds }),
				};
			}
			// action 'log': record and continue
			logger.warn?.(
				`WAF rule match (log) ${request.method} ${requestInfo.path} from ${request.ip} (rules: ${decision.ruleIds.join(', ')})`
			);
			return nextHandler(request);
		},
		{ name: 'waf', before: 'authentication', runFirst: true }
	);
	logger.info?.('WAF middleware registered (request phase)');
}

/** Test hook: returns the live matcher (or null when no rules are loaded). */
export function getCurrentMatcher(): WafMatcher | null {
	return currentMatcher;
}
