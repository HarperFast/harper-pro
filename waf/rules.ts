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
	action: 'block' | 'log' | 'score';
	/** Score contribution when action is 'score'. */
	score?: number;
	/** Response status when action is 'block' (default 403). */
	blockStatus?: number;
}

const VALID_OPS = new Set<string>(['equals', 'contains', 'prefix', 'regex', 'exists']);
const VALID_ACTIONS = new Set<string>(['block', 'log', 'score']);
const VALID_PHASES = new Set<string>(['request', 'requestBody']);

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

/**
 * Validates a rule document. Returns an empty array when the rule is usable; otherwise a list of
 * human-readable problems (the rule is skipped by the compiler).
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
		match.ip != null || match.method != null || match.path != null || match.headers != null || match.query != null;
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
	return errors;
}
