/**
 * WAF rule document shape and validation.
 *
 * Rules are operator-supplied documents stored in the `system.hdb_waf_rules` table. Validation
 * runs at compile time (see matcher.ts) so a bad rule is skipped with a log rather than taking
 * down the request path.
 */

// parseCidr lives in matcher.ts (co-located with the parsers it shares); the import creates a
// benign runtime cycle — both symbols are function declarations only called at runtime, never at
// module init. Cyclic deps are acceptable per Harper conventions.
import { parseCidr } from './matcher.ts';

export type WafStringOp = 'equals' | 'contains' | 'prefix' | 'regex' | 'exists';

export interface WafNamedValueMatch {
	/** Header or query-parameter name (headers are case-insensitive). */
	name: string;
	op: WafStringOp;
	/** Required for every op except 'exists'. */
	value?: string;
}

export interface WafPathMatch {
	prefix?: string;
	exact?: string;
	regex?: string;
}

export interface WafRuleMatch {
	/** IPv4/IPv6 address(es), CIDR notation supported. */
	ip?: string | string[];
	/** HTTP methods (upper-cased on compile). */
	method?: string[];
	path?: WafPathMatch;
	headers?: WafNamedValueMatch[];
	query?: WafNamedValueMatch[];
	// --- reserved match slots (wave 2): validated + persisted, deferred by the v1 engine (see matcher.ts). ---
	/** JA4 TLS client fingerprint(s). Deferred: needs the TLS-fingerprint plane. */
	ja4?: string | string[];
	/** JA4H HTTP fingerprint(s). Deferred. */
	ja4h?: string | string[];
	/** Model-scored classification (e.g. an anomaly/bot model). Deferred: needs the intelligence plane. */
	model?: { name?: string; threshold?: number };
	/** Verified-agent / web-bot-auth match. Deferred: needs the agent-identity plane. */
	agent?: { webBotAuth?: 'verified' | 'unverified' | 'any'; identity?: string | string[] };
}

export interface WafRule {
	id: string;
	enabled: boolean;
	/** Lower number = evaluated first when resolving actions. */
	priority: number;
	/** Only 'request' is evaluated today; 'requestBody' rules are skipped (future work). */
	phase: 'request' | 'requestBody';
	description?: string;
	match: WafRuleMatch;
	action: 'block' | 'log' | 'score' | 'challenge' | 'serve' | 'drop';
	/** Score contribution when action is 'score'. */
	score?: number;
	/** Response status when action is 'block' (default 403). */
	blockStatus?: number;
	/**
	 * When true the rule NEVER enforces — a match is surfaced as a "would-block" preview for
	 * telemetry only (wave 2). Implemented; see matcher.ts evaluate().
	 */
	shadow?: boolean;
	/**
	 * Per-node arming: the rule compiles into this node's matcher only when node identity satisfies
	 * all present selectors (wave 2). Implemented; see CompileOptions.nodeIdentity in matcher.ts.
	 */
	activation?: { nodes?: string[]; regions?: string[]; tags?: string[] };
	/**
	 * Reserved metadata (wave 2): validated + persisted, NOT enforced. In v1 ALL node gating is done
	 * by `activation`; `scope` is descriptive metadata only and does NOT cause deferral or affect
	 * matching. (This intentionally refines the earlier "scope.clusters honored" idea.)
	 */
	scope?: { clusters?: string[]; applications?: string[]; tenants?: string[] };
	/**
	 * Reserved metadata (wave 2): validated + persisted, NOT enforced. Records how the rule was
	 * authored; does NOT cause deferral or affect matching.
	 */
	provenance?: { origin?: 'human' | 'managed-feed' | 'agent-proposed'; approver?: string; source?: string };
	/**
	 * Reserved slot (wave 2): validated + persisted, deferred by the v1 engine (needs the rate-limit
	 * plane). A rule that specifies rateLimit is compiled OUT and reported as deferred.
	 */
	rateLimit?: { key?: ('ip' | 'ja4' | 'session' | 'agent' | 'user')[]; limit?: number; windowMs?: number };
}

const VALID_OPS = new Set<string>(['equals', 'contains', 'prefix', 'regex', 'exists']);
const VALID_ACTIONS = new Set<string>(['block', 'log', 'score', 'challenge', 'serve', 'drop']);
const VALID_PHASES = new Set<string>(['request', 'requestBody']);
const VALID_PROVENANCE_ORIGINS = new Set<string>(['human', 'managed-feed', 'agent-proposed']);
const VALID_RATELIMIT_KEYS = new Set<string>(['ip', 'ja4', 'session', 'agent', 'user']);
const VALID_WEBBOTAUTH = new Set<string>(['verified', 'unverified', 'any']);

/**
 * Compile a rule-supplied regex source, returning undefined (with an error pushed) when invalid.
 * TODO(production): operator-supplied patterns must be compiled with RE2 (linear-time) instead of
 * JS RegExp to prevent ReDoS — a hostile pattern like (a+)+$ here can stall the event loop.
 */
export function compileRuleRegex(source: string, where: string, errors: string[]): RegExp | undefined {
	try {
		return new RegExp(source);
	} catch (error) {
		errors.push(`${where}: invalid regex ${JSON.stringify(source)}: ${(error as Error).message}`);
		return undefined;
	}
}

function validateNamedValueMatches(list: WafNamedValueMatch[], where: string, errors: string[]) {
	if (!Array.isArray(list)) {
		errors.push(`${where}: must be an array`);
		return;
	}
	for (const entry of list) {
		if (!entry || typeof entry.name !== 'string' || entry.name.length === 0) {
			errors.push(`${where}: entry is missing a name`);
			continue;
		}
		if (!VALID_OPS.has(entry.op)) {
			errors.push(`${where}[${entry.name}]: unknown op ${JSON.stringify(entry.op)}`);
			continue;
		}
		if (entry.op !== 'exists') {
			// M9: a non-exists op needs a non-empty value; '' would match every request.
			if (typeof entry.value !== 'string' || entry.value.length === 0)
				errors.push(`${where}[${entry.name}]: op ${entry.op} requires a non-empty string value`);
			else if (entry.op === 'regex') compileRuleRegex(entry.value, `${where}[${entry.name}]`, errors);
		}
	}
}

/** Validates a string-or-string[] slot: every value must be a non-empty string. */
function validateStringOrArray(value: unknown, where: string, errors: string[]) {
	const list = Array.isArray(value) ? value : [value];
	if (list.length === 0) errors.push(`${where}: must not be empty`);
	for (const entry of list) {
		if (typeof entry !== 'string' || entry.length === 0) errors.push(`${where}: must be a non-empty string`);
	}
}

/** Validates an activation/scope-style slot: an object whose present sub-fields are string arrays. */
function validateStringArrayObject(value: unknown, where: string, fields: string[], errors: string[]) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		errors.push(`${where}: must be an object`);
		return;
	}
	for (const field of fields) {
		const sub = (value as Record<string, unknown>)[field];
		if (sub == null) continue;
		if (!Array.isArray(sub) || sub.some((entry) => typeof entry !== 'string'))
			errors.push(`${where}.${field}: must be an array of strings`);
	}
}

/** Validates the new (wave 2) reserved match slots (ja4/ja4h/model/agent). */
function validateReservedMatch(match: WafRuleMatch, errors: string[]) {
	if (match.ja4 != null) validateStringOrArray(match.ja4, 'match.ja4', errors);
	if (match.ja4h != null) validateStringOrArray(match.ja4h, 'match.ja4h', errors);
	if (match.model != null) {
		if (typeof match.model !== 'object' || Array.isArray(match.model)) errors.push('match.model: must be an object');
		else {
			if (match.model.name != null && typeof match.model.name !== 'string')
				errors.push('match.model.name: must be a string');
			if (match.model.threshold != null && typeof match.model.threshold !== 'number')
				errors.push('match.model.threshold: must be a number');
		}
	}
	if (match.agent != null) {
		if (typeof match.agent !== 'object' || Array.isArray(match.agent)) errors.push('match.agent: must be an object');
		else {
			if (match.agent.webBotAuth != null && !VALID_WEBBOTAUTH.has(match.agent.webBotAuth))
				errors.push(`match.agent.webBotAuth: unknown value ${JSON.stringify(match.agent.webBotAuth)}`);
			if (match.agent.identity != null) validateStringOrArray(match.agent.identity, 'match.agent.identity', errors);
		}
	}
}

/** Validates the new (wave 2) reserved top-level slots (shadow/activation/scope/provenance/rateLimit). */
function validateReservedRule(rule: WafRule, errors: string[]) {
	if (rule.shadow != null && typeof rule.shadow !== 'boolean') errors.push('shadow: must be a boolean');
	if (rule.activation != null)
		validateStringArrayObject(rule.activation, 'activation', ['nodes', 'regions', 'tags'], errors);
	if (rule.scope != null)
		validateStringArrayObject(rule.scope, 'scope', ['clusters', 'applications', 'tenants'], errors);
	if (rule.provenance != null) {
		if (typeof rule.provenance !== 'object' || Array.isArray(rule.provenance))
			errors.push('provenance: must be an object');
		else {
			if (rule.provenance.origin != null && !VALID_PROVENANCE_ORIGINS.has(rule.provenance.origin))
				errors.push(`provenance.origin: unknown value ${JSON.stringify(rule.provenance.origin)}`);
			if (rule.provenance.approver != null && typeof rule.provenance.approver !== 'string')
				errors.push('provenance.approver: must be a string');
			if (rule.provenance.source != null && typeof rule.provenance.source !== 'string')
				errors.push('provenance.source: must be a string');
		}
	}
	if (rule.rateLimit != null) {
		if (typeof rule.rateLimit !== 'object' || Array.isArray(rule.rateLimit))
			errors.push('rateLimit: must be an object');
		else {
			if (rule.rateLimit.key != null) {
				if (!Array.isArray(rule.rateLimit.key) || rule.rateLimit.key.some((k) => !VALID_RATELIMIT_KEYS.has(k)))
					errors.push('rateLimit.key: must be an array of ip/ja4/session/agent/user');
			}
			if (rule.rateLimit.limit != null && typeof rule.rateLimit.limit !== 'number')
				errors.push('rateLimit.limit: must be a number');
			if (rule.rateLimit.windowMs != null && typeof rule.rateLimit.windowMs !== 'number')
				errors.push('rateLimit.windowMs: must be a number');
		}
	}
}

/**
 * Validates a rule document. Returns an empty array when the rule is usable; otherwise a list of
 * human-readable problems (the rule is skipped by the compiler).
 *
 * NOTE: "usable" means the SHAPE is well-formed — it does NOT mean the v1 engine will enforce it.
 * A rule can validate cleanly yet use a reserved/unimplemented feature (challenge/serve/drop action,
 * a ja4/ja4h/model/agent match, or rateLimit); those are compiled OUT and reported as DEFERRED, not
 * invalid. See compileRules / unsupportedRules in matcher.ts.
 */
export function validateRule(rule: WafRule): string[] {
	const errors: string[] = [];
	if (!rule || typeof rule !== 'object') return ['rule is not an object'];
	if (rule.id == null) errors.push('missing id');
	// M8: type-check enabled / priority so the "usable" verdict matches the compiler's expectations.
	if (rule.enabled != null && typeof rule.enabled !== 'boolean') errors.push('enabled must be a boolean');
	if (rule.priority != null && typeof rule.priority !== 'number') errors.push('priority must be a number');
	if (!VALID_PHASES.has(rule.phase)) errors.push(`unknown phase ${JSON.stringify(rule.phase)}`);
	if (!VALID_ACTIONS.has(rule.action)) errors.push(`unknown action ${JSON.stringify(rule.action)}`);
	if (rule.action === 'score' && typeof rule.score !== 'number') errors.push('action "score" requires a numeric score');
	if (
		rule.blockStatus != null &&
		(typeof rule.blockStatus !== 'number' || rule.blockStatus < 100 || rule.blockStatus > 599)
	)
		errors.push('blockStatus must be a valid HTTP status');
	const match = rule.match;
	if (!match || typeof match !== 'object') {
		errors.push('missing match');
		return errors;
	}
	const hasCondition =
		match.ip != null ||
		match.method != null ||
		match.path != null ||
		match.headers != null ||
		match.query != null ||
		// reserved match slots count as a condition so a ja4/ja4h/model/agent-only rule validates
		// (shape ok) and is DEFERRED by the compiler rather than rejected as "no condition".
		match.ja4 != null ||
		match.ja4h != null ||
		match.model != null ||
		match.agent != null;
	if (!hasCondition) errors.push('match must specify at least one condition');
	if (match.ip != null) {
		for (const cidr of Array.isArray(match.ip) ? match.ip : [match.ip]) {
			// M2/M8: validate by actually parsing so validateRule and the compiler agree (rejects
			// '10.0.0.0/', '/0x10', bad addresses instead of silently compiling to /0 "block all").
			if (typeof cidr !== 'string' || cidr.length === 0 || parseCidr(cidr) === null)
				errors.push(`match.ip: invalid address or CIDR ${JSON.stringify(cidr)}`);
		}
	}
	if (match.method != null) {
		if (!Array.isArray(match.method) || match.method.length === 0 || match.method.some((m) => typeof m !== 'string'))
			errors.push('match.method must be a non-empty array of strings');
	}
	if (match.path != null) {
		const { prefix, exact, regex } = match.path;
		if (prefix == null && exact == null && regex == null)
			errors.push('match.path must specify prefix, exact, or regex');
		// M9: reject empty match strings — they would match every request.
		if (prefix != null && (typeof prefix !== 'string' || prefix.length === 0))
			errors.push('match.path.prefix must be a non-empty string');
		if (exact != null && (typeof exact !== 'string' || exact.length === 0))
			errors.push('match.path.exact must be a non-empty string');
		if (regex != null) {
			if (typeof regex !== 'string' || regex.length === 0) errors.push('match.path.regex must be a non-empty string');
			else compileRuleRegex(regex, 'match.path.regex', errors);
		}
	}
	if (match.headers != null) validateNamedValueMatches(match.headers, 'match.headers', errors);
	if (match.query != null) validateNamedValueMatches(match.query, 'match.query', errors);
	validateReservedMatch(match, errors);
	validateReservedRule(rule, errors);
	return errors;
}
