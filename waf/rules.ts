/**
 * WAF rule document shape and validation.
 *
 * Rules are operator-supplied documents stored in the `system.hdb_waf_rules` table. Validation
 * runs at compile time (see matcher.ts) so a bad rule is skipped with a log rather than taking
 * down the request path.
 */

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
		if (entry.op !== 'exists' && typeof entry.value !== 'string') {
			errors.push(`${where}[${entry.name}]: op ${entry.op} requires a string value`);
		}
		if (entry.op === 'regex' && typeof entry.value === 'string') {
			compileRuleRegex(entry.value, `${where}[${entry.name}]`, errors);
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
			if (typeof cidr !== 'string' || cidr.length === 0) errors.push(`match.ip: invalid entry ${JSON.stringify(cidr)}`);
		}
	}
	if (match.method != null) {
		if (!Array.isArray(match.method) || match.method.some((m) => typeof m !== 'string'))
			errors.push('match.method must be an array of strings');
	}
	if (match.path != null) {
		const { prefix, exact, regex } = match.path;
		if (prefix == null && exact == null && regex == null)
			errors.push('match.path must specify prefix, exact, or regex');
		if (regex != null) compileRuleRegex(regex, 'match.path.regex', errors);
	}
	if (match.headers != null) validateNamedValueMatches(match.headers, 'match.headers', errors);
	if (match.query != null) validateNamedValueMatches(match.query, 'match.query', errors);
	return errors;
}
