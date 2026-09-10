/**
 * Compiled WAF rule matcher.
 *
 * `compileRules` takes the full rule list and produces an immutable matcher optimized for the
 * 99% case: a request that matches nothing. Each rule is anchored on its most selective
 * condition and only that condition is indexed; remaining conditions are verified by a residual
 * predicate once the anchor hits. A non-matching request therefore costs a handful of index
 * probes (binary searches / Map lookups) regardless of rule count, and allocates nothing.
 *
 * Index structures:
 * - IPv4 CIDRs → sorted integer intervals (start/end/prefix-max-end typed arrays, binary search)
 * - IPv6      → exact-match Set + linear masked-prefix list (BigInt pairs, rare path)
 * - path.exact  → Map
 * - path.prefix → character trie (evaluation cost O(path length), independent of rule count)
 * - path.regex  → combined-alternation pre-gate regex, then a linear scan only when the gate hits
 * - headers     → Map keyed by header name (only headers that rules mention are inspected)
 * - query       → parsed once per evaluate, only when query rules exist and a query string is present
 * - method      → Map, last-resort anchor
 *
 * Live updates swap the whole matcher reference atomically (see waf.ts); nothing in here mutates
 * after compile.
 */

import RE2 from 're2';
import { type WafRule, type WafNamedValueMatch, validateRule, compileRuleRegex } from './rules.ts';

export interface WafRequestInfo {
	ip: string | undefined;
	method: string;
	/**
	 * Pathname only (no query string). CALLER CONTRACT (M6): the caller passes the path already
	 * run through canonicalizePath() — percent-decoded (bounded), dot-segment-resolved, and with
	 * duplicate slashes collapsed — so encoding-based evasion (%2e%2e, //, /./, /../, double-
	 * encoding) is defeated before matching. It is NOT case-folded (case-sensitive paths are
	 * legitimate app semantics). Rule path.exact/path.prefix literals are canonicalized at compile
	 * time so rules and requests share one normalized space; path.regex patterns are authored
	 * against this canonicalized form (a regex cannot be canonicalized).
	 */
	path: string;
	/** Raw query string without the leading '?', or undefined. */
	query?: string;
	getHeader(name: string): string | string[] | undefined;
	/**
	 * Lower-cased header names of the request. Optional: when provided and the rule set
	 * references many distinct header names, the matcher iterates the request's headers
	 * (~12) instead of every rule-referenced name.
	 */
	headerNames?(): Iterable<string> | undefined;
}

export interface WafDecision {
	action: 'block' | 'log';
	/** HTTP status for block decisions. */
	status: number;
	/** Rule ids that produced this decision, in priority order. */
	ruleIds: (string | number)[];
	/** Accumulated score when the decision came from score rules. */
	score?: number;
	/**
	 * On a block decision: ids of log-action rules that ALSO matched this request. Enforcement
	 * short-circuits, telemetry must not — the middleware records these even though the request
	 * is rejected. Absent when no log rules matched (no allocation on that path).
	 */
	matchedLogRuleIds?: (string | number)[];
	/**
	 * "Would-block" preview ids from the SHADOW track (wave 2): rules with shadow:true that matched
	 * (or, in monitor mode, every rule that would have blocked). Shadow rules never enforce; these
	 * are surfaced for telemetry/preview only. On a real block they ride along; when only shadow
	 * would-block exists the decision is a pass-through (action 'log', status 0) carrying these.
	 * Absent when no shadow would-block exists (no allocation on that path).
	 */
	shadowRuleIds?: (string | number)[];
}

interface CompiledRule {
	id: string | number;
	priority: number;
	// only enforceable actions reach compilation; challenge/serve/drop are deferred (see compileRules).
	action: 'block' | 'log' | 'score';
	score: number;
	blockStatus: number;
	/** When true this rule never enforces — it only produces a would-block preview (wave 2 shadow). */
	shadow: boolean;
	/** Conditions not covered by the anchor index; null when the anchor is the whole rule. */
	residual: ((request: WafRequestInfo) => boolean) | null;
}

interface Ipv6Prefix {
	value: bigint;
	mask: bigint;
	ruleIndex: number;
}

interface HeaderCheck {
	op: WafNamedValueMatch['op'];
	value: string;
	regex?: RegExp;
	ruleIndex: number;
}

interface PathTrieNode {
	children: Map<number, PathTrieNode> | null;
	ruleIndexes: number[] | null;
}

export interface WafRuleStat {
	hitCount: number;
	/** Date.now() of the most recent match, or 0 if never matched. */
	lastMatched: number;
}

export interface WafMatcher {
	/**
	 * True when the matcher can never produce a decision; callers can skip evaluate(). Set when
	 * there are no compiled rules OR the global mode is 'off' (kill switch, pass-through).
	 */
	isEmpty: boolean;
	ruleCount: number;
	/** Rules that failed validation (malformed shape), for reporting. Keyed by rule id (stringified). */
	invalidRules: Map<string, string[]>;
	/**
	 * Rules that are VALID (shape ok) but use a feature the v1 engine cannot honor (challenge/serve/
	 * drop action, a ja4/ja4h/model/agent match, or rateLimit). Compiled OUT and reported here as
	 * DEFERRED — kept DISTINCT from invalidRules so a "deferred" count never masquerades as a
	 * malformed-rule count (decision a: skip-with-warning, never silently under-enforce). Keyed by
	 * rule id (stringified) → reasons.
	 */
	unsupportedRules: Map<string, string[]>;
	evaluate(request: WafRequestInfo): WafDecision | null;
	/** Per-rule hit telemetry (same map as getRuleStats), for convenience off the matcher. */
	getStats(): ReadonlyMap<string, WafRuleStat>;
}

/**
 * Per-rule hit telemetry, keyed by String(rule.id). Module-level so it PERSISTS across recompiles:
 * the matcher object is swapped on every rule change (see waf.ts), but a rule's counters must
 * survive the swap and keep climbing by id. These are per-worker, process-lifetime counters;
 * cross-worker aggregation / main-thread surfacing rides on the #518 analytics work (out of scope).
 */
const ruleStats = new Map<string, WafRuleStat>();

/** Per-rule hit telemetry (read-only), keyed by String(rule.id). Persists across recompiles. */
export function getRuleStats(): ReadonlyMap<string, WafRuleStat> {
	return ruleStats;
}

/** Clears all per-rule telemetry (test hook). */
export function resetRuleStats(): void {
	ruleStats.clear();
}

/**
 * Prunes telemetry for rule ids no longer present in the rule set (called after each successful
 * recompile — see waf.ts). Without this the module-level map grows for the process lifetime as ids
 * churn, and a dropped-then-readded id would inherit the old rule's counters (false telemetry).
 * `liveIds` holds String(rule.id) for every currently-persisted rule.
 */
export function pruneRuleStats(liveIds: ReadonlySet<string>): void {
	for (const key of ruleStats.keys()) {
		if (!liveIds.has(key)) ruleStats.delete(key);
	}
}

const DEFAULT_BLOCK_STATUS = 403;

/**
 * RFC 3986 §5.2.4 remove_dot_segments: resolves `.` and `..` in a path so /a/./b→/a/b and
 * /a/b/../c→/a/c, without touching the network. Operates on the whole path (no scheme/authority).
 *
 * A trailing `.`/`..` segment preserves the boundary slash (the RFC "complete path segment" rule):
 * /admin/.→/admin/, /admin/x/..→/admin/, /admin/..→/, /a/b/.→/a/b/. This matters because a rule
 * literal /admin/ has no dot segment to resolve, so dropping the trailing slash here would make
 * /admin/. never match it. Interior dots are unaffected (/a/./b→/a/b, /a/b/../c→/a/c). The
 * duplicate-slash collapse is folded in (empty interior segments are skipped) so callers need no
 * separate pass; the single leading-slash marker is preserved.
 */
function removeDotSegments(path: string): string {
	const output: string[] = [''];
	const segments = path.split('/');
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const isLast = i === segments.length - 1;
		if (segment === '.') {
			// a trailing '.' resolves to the current directory: keep the boundary slash
			if (isLast) output.push('');
			continue;
		}
		if (segment === '..') {
			// pop the previous real segment, but never past the leading-slash marker
			if (output.length > 1) output.pop();
			// a trailing '..' leaves us at the parent directory: keep the boundary slash
			if (isLast) output.push('');
			continue;
		}
		// skip empty interior segments (collapses duplicate slashes) but keep the leading marker (index
		// 0) and a genuine trailing slash (the last segment, empty because the path ended in '/')
		if (segment === '' && !isLast) continue;
		output.push(segment);
	}
	// output[0] is the leading-slash marker; join reintroduces every '/'
	return output.join('/') || '/';
}

/**
 * Canonicalizes a request/rule path into one normalized matching space so encoding- and
 * traversal-based evasions (/admin%2F, /./admin, //admin, /admin/../admin, double-encoding) can't
 * slip past a path rule. Steps, in order:
 *   1. bounded iterative percent-decoding — up to 2 decodeURIComponent passes, or until the string
 *      stops changing; a malformed-escape throw stops decoding and keeps the last good value.
 *   2. RFC 3986 §5.2.4 remove_dot_segments (resolve `.` and `..`, folding in duplicate-slash collapse).
 * A leading `/` is preserved. Deliberately NOT case-folded: case-sensitive paths are legitimate
 * app semantics and lowercasing would cause false matches. A future per-rule case-insensitive
 * option is the extension point for callers that want case-folded matching.
 */
export function canonicalizePath(path: string): string {
	// Fast path: a path with no percent-escape, no duplicate slash, and no dot segment is already
	// canonical, so return it with zero allocation — this is the 99% case and it preserves the
	// matcher's allocation-free non-candidate path. A legit segment containing '/.' (e.g.
	// '/.well-known') harmlessly takes the slow path and still canonicalizes to itself.
	if (path.indexOf('%') === -1 && path.indexOf('//') === -1 && path.indexOf('/.') === -1) return path;
	// 1. bounded iterative percent-decoding
	let decoded = path;
	for (let pass = 0; pass < 2; pass++) {
		if (decoded.indexOf('%') === -1) break;
		let next: string;
		try {
			next = decodeURIComponent(decoded);
		} catch {
			break; // malformed escape: keep the last successfully-decoded value, never throw out
		}
		if (next === decoded) break;
		decoded = next;
	}
	// 2. resolve dot segments (duplicate-slash collapse is folded into this single pass)
	return removeDotSegments(decoded);
}

/** Parses a dotted-quad IPv4 address to an unsigned 32-bit integer, or -1 when not IPv4. */
export function parseIpv4(ip: string): number {
	let value = 0;
	let octet = 0;
	let digits = 0;
	let dots = 0;
	for (let i = 0; i < ip.length; i++) {
		const code = ip.charCodeAt(i);
		if (code === 46) {
			if (digits === 0) return -1;
			value = value * 256 + octet;
			octet = 0;
			digits = 0;
			dots++;
			if (dots > 3) return -1;
		} else if (code >= 48 && code <= 57) {
			// reject leading zeros (010.0.0.1) — parse ambiguity/SSRF-bypass; net.isIPv4 rejects them too.
			// A lone '0' octet still parses; the guard only fires on a 2nd digit after a leading 0.
			if (digits === 1 && octet === 0) return -1;
			octet = octet * 10 + (code - 48);
			if (octet > 255 || ++digits > 3) return -1;
		} else {
			return -1;
		}
	}
	if (dots !== 3 || digits === 0) return -1;
	return (value * 256 + octet) >>> 0;
}

/** Parses an IPv6 address into a single 128-bit BigInt, or null when unparseable. */
export function parseIpv6(ip: string): bigint | null {
	const zoneIndex = ip.indexOf('%');
	if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);
	const doubleColon = ip.indexOf('::');
	let headParts: string[];
	let tailParts: string[];
	if (doubleColon !== -1) {
		headParts = doubleColon === 0 ? [] : ip.slice(0, doubleColon).split(':');
		const tail = ip.slice(doubleColon + 2);
		tailParts = tail === '' ? [] : tail.split(':');
	} else {
		headParts = ip.split(':');
		tailParts = [];
	}
	const parts = [...headParts, ...tailParts];
	// Expand a trailing IPv4-mapped quad (e.g. ::ffff:1.2.3.4)
	const last = parts[parts.length - 1];
	if (last && last.includes('.')) {
		const v4 = parseIpv4(last);
		if (v4 === -1) return null;
		parts.pop();
		parts.push(((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16));
		if (doubleColon === -1 && parts.length !== 8) return null;
	}
	const missing = 8 - parts.length;
	if (doubleColon === -1 && missing !== 0) return null;
	if (doubleColon !== -1 && missing < 0) return null;
	let result = 0n;
	let consumed = 0;
	for (let i = 0; i < parts.length; i++) {
		// insert the zero run at the double-colon position
		if (doubleColon !== -1 && i === headParts.length) {
			for (let z = 0; z < missing; z++) {
				result = result << 16n;
				consumed++;
			}
		}
		const part = parts[i];
		// parseInt(part, 16) tolerates trailing garbage ('123g' → 0x123); require strictly hex digits.
		if (part.length === 0 || part.length > 4 || !/^[0-9a-fA-F]+$/.test(part)) return null;
		const group = parseInt(part, 16);
		if (Number.isNaN(group) || group < 0 || group > 0xffff) return null;
		result = (result << 16n) | BigInt(group);
		consumed++;
	}
	if (doubleColon !== -1 && headParts.length === parts.length) {
		// zero run at the very end
		for (let z = 0; z < missing; z++) {
			result = result << 16n;
			consumed++;
		}
	}
	if (consumed !== 8) return null;
	return result;
}

const IPV6_ALL_ONES = (1n << 128n) - 1n;

/**
 * Strips an IPv4-mapped IPv6 form ("::ffff:1.2.3.4") down to the IPv4 literal.
 * Null-safe (M4): a non-string ip yields '' (parses as neither v4 nor v6 → no match).
 * TODO(M5, when XFF trust lands): only the canonical lowercase "::ffff:" form is stripped;
 * handle the full ::ffff:0:0/96 range (uppercase hex, "::ffff:0102:0304") once untrusted,
 * non-canonical client-supplied addresses can reach here.
 */
function normalizeIp(ip: string): string {
	if (typeof ip !== 'string') return '';
	if (ip.startsWith('::ffff:') && ip.indexOf('.') !== -1) return ip.slice(7);
	return ip;
}

function lowerBound(haystack: Float64Array, length: number, needle: number): number {
	let low = 0;
	let high = length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (haystack[mid] <= needle) low = mid + 1;
		else high = mid;
	}
	return low; // first index with start > needle
}

function checkStringOp(candidate: string, check: HeaderCheck): boolean {
	switch (check.op) {
		case 'exists':
			return true;
		case 'equals':
			return candidate === check.value;
		case 'contains':
			return candidate.includes(check.value);
		case 'prefix':
			return candidate.startsWith(check.value);
		case 'regex':
			return check.regex!.test(candidate);
	}
	return false;
}

function checkHeaderValue(value: string | string[] | undefined, check: HeaderCheck): boolean {
	if (value === undefined) return false;
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (checkStringOp(entry, check)) return true;
		}
		return false;
	}
	return checkStringOp(value, check);
}

type ResidualCheck = (request: WafRequestInfo) => boolean;

type ParsedCidr =
	{ kind: 'v4'; start: number; end: number } | { kind: 'v6'; value: bigint; mask: bigint; bits: number };

/** Matches a plain base-10 non-negative integer with no sign, whitespace, or radix prefix. */
const CANONICAL_BITS = /^[0-9]+$/;

export function parseCidr(cidr: string): ParsedCidr | null {
	if (typeof cidr !== 'string') return null;
	let address = cidr;
	let bits = -1;
	const slash = cidr.indexOf('/');
	if (slash !== -1) {
		address = cidr.slice(0, slash);
		const bitsStr = cidr.slice(slash + 1);
		// Reject '' ('10.0.0.0/' → NaN→0 → /0 "block everything"), whitespace, and the
		// Number()-coercion leniency ('/0x10', '/1e1'). Require a plain base-10 integer (M2).
		if (!CANONICAL_BITS.test(bitsStr)) return null;
		bits = Number(bitsStr);
		if (!Number.isInteger(bits) || bits < 0) return null;
	}
	const v4 = parseIpv4(address);
	if (v4 !== -1) {
		if (bits === -1) bits = 32;
		if (bits > 32) return null;
		const span = bits === 0 ? 0xffffffff : 2 ** (32 - bits) - 1;
		const start = bits === 0 ? 0 : (v4 & ~span) >>> 0;
		return { kind: 'v4', start, end: (start + span) >>> 0 };
	}
	const v6 = parseIpv6(address);
	if (v6 === null) return null;
	if (bits === -1) bits = 128;
	if (bits > 128) return null;
	const mask = bits === 0 ? 0n : (IPV6_ALL_ONES << BigInt(128 - bits)) & IPV6_ALL_ONES;
	return { kind: 'v6', value: v6 & mask, mask, bits };
}

function makePathResidual(path: NonNullable<WafRule['match']['path']>, errors: string[]): ResidualCheck | undefined {
	// Canonicalize authored literals so rule and (already-canonicalized) request paths share one
	// normalized space; path.regex is authored against the canonical form (a regex can't be
	// canonicalized) — see WafRequestInfo.path (M6).
	const exact = path.exact == null ? undefined : canonicalizePath(path.exact);
	const prefix = path.prefix == null ? undefined : canonicalizePath(path.prefix);
	let regex: RegExp | undefined;
	if (path.regex != null) {
		regex = compileRuleRegex(path.regex, 'match.path.regex', errors);
		if (!regex) return undefined;
	}
	const regexRef = regex;
	return (request) =>
		(exact == null || request.path === exact) &&
		(prefix == null || request.path.startsWith(prefix)) &&
		(regexRef == null || regexRef.test(request.path));
}

function makeMethodResidual(methods: string[]): ResidualCheck {
	if (methods.length === 1) {
		const method = methods[0].toUpperCase();
		return (request) => request.method === method;
	}
	const set = new Set(methods.map((m) => m.toUpperCase()));
	return (request) => set.has(request.method);
}

function makeHeaderResidual(headers: WafNamedValueMatch[], errors: string[]): ResidualCheck | undefined {
	const checks: { name: string; check: HeaderCheck }[] = [];
	for (const entry of headers) {
		let regex: RegExp | undefined;
		if (entry.op === 'regex') {
			regex = compileRuleRegex(entry.value!, `match.headers[${entry.name}]`, errors);
			if (!regex) return undefined;
		}
		// M7: lowercase to match the anchor path (which lowercases). WafRequestInfo.getHeader is
		// contractually case-insensitive, but lowercasing here keeps multi-header rules correct even
		// against a case-sensitive getHeader.
		checks.push({
			name: entry.name.toLowerCase(),
			check: { op: entry.op, value: entry.value ?? '', regex, ruleIndex: -1 },
		});
	}
	return (request) => {
		if (typeof request.getHeader !== 'function') return false; // M4: malformed request → no match
		for (const { name, check } of checks) {
			if (!checkHeaderValue(request.getHeader(name), check)) return false;
		}
		return true;
	};
}

/** Parses `a=1&b=2` into a Map; multiple values for a name are kept as an array. */
export function parseQueryString(query: string): Map<string, string | string[]> {
	const result = new Map<string, string | string[]>();
	for (const pair of query.split('&')) {
		if (pair.length === 0) continue;
		const eq = pair.indexOf('=');
		let name: string;
		let value: string;
		if (eq === -1) {
			name = pair;
			value = '';
		} else {
			name = pair.slice(0, eq);
			value = pair.slice(eq + 1);
		}
		// Decode name and value independently: a malformed escape in one must not leave the other in a
		// mixed decoded/raw state. Each keeps its raw form on failure.
		try {
			name = decodeURIComponent(name.replaceAll('+', ' '));
		} catch {
			// keep the raw name when percent-decoding fails
		}
		try {
			value = decodeURIComponent(value.replaceAll('+', ' '));
		} catch {
			// keep the raw value when percent-decoding fails
		}
		const existing = result.get(name);
		if (existing === undefined) result.set(name, value);
		else if (Array.isArray(existing)) existing.push(value);
		else result.set(name, [existing, value]);
	}
	return result;
}

function makeQueryResidual(query: WafNamedValueMatch[], errors: string[]): ResidualCheck | undefined {
	const checks: { name: string; check: HeaderCheck }[] = [];
	for (const entry of query) {
		let regex: RegExp | undefined;
		if (entry.op === 'regex') {
			regex = compileRuleRegex(entry.value!, `match.query[${entry.name}]`, errors);
			if (!regex) return undefined;
		}
		checks.push({ name: entry.name, check: { op: entry.op, value: entry.value ?? '', regex, ruleIndex: -1 } });
	}
	return (request) => {
		if (request.query === undefined || request.query.length === 0) return false;
		const params = parseQueryString(request.query);
		for (const { name, check } of checks) {
			if (!checkHeaderValue(params.get(name), check)) return false;
		}
		return true;
	};
}

function combineResiduals(residuals: ResidualCheck[]): ResidualCheck | null {
	if (residuals.length === 0) return null;
	if (residuals.length === 1) return residuals[0];
	return (request) => {
		for (const residual of residuals) {
			if (!residual(request)) return false;
		}
		return true;
	};
}

export interface CompileOptions {
	/** Total accumulated score at which score-action rules produce a block. */
	scoreThreshold?: number;
	/** Called once per malformed (invalid) rule with a reason (defaults to silent). */
	onInvalidRule?(ruleId: string, problems: string[]): void;
	/**
	 * Called once per VALID-but-DEFERRED rule (wave 2): a rule whose shape is fine but that uses a
	 * feature this engine cannot honor, so it is compiled OUT rather than partially enforced. Kept
	 * separate from onInvalidRule so callers can report the two counts distinctly.
	 */
	onUnsupportedRule?(ruleId: string, reasons: string[]): void;
	/**
	 * Global enforcement mode (wave 2, decision b): 'enforce' = normal; 'monitor' = compile normally
	 * but treat EVERY rule as shadow (nothing enforces, would-blocks are surfaced); 'off' = return a
	 * pass-through matcher (kill switch). Defaults to 'enforce'.
	 */
	mode?: 'enforce' | 'monitor' | 'off';
	/**
	 * This node's identity for activation gating (wave 2, decision c). A rule with an `activation`
	 * selector compiles into the matcher only when this identity satisfies it. Absent identity means
	 * only rules WITHOUT node/region/tag constraints they can't meet are armed (see isArmedOnNode).
	 */
	nodeIdentity?: { name?: string; region?: string; tags?: string[] };
}

const DEFERRED_ACTIONS = new Set<string>(['challenge', 'serve', 'drop']);

/**
 * Reasons a VALID rule is DEFERRED (compiled out, not enforced) by the v1 engine — see decision a.
 * Returns an empty array when the rule uses only v1-enforceable features. A deferred rule is never
 * partially enforced: any single deferred feature removes the whole rule from the matcher.
 * NOTE: scope and provenance are reserved METADATA in v1 — validated + persisted, NOT enforced, and
 * deliberately do NOT cause deferral (a rule with scope/provenance still compiles and enforces).
 */
function deferralReasons(rule: WafRule): string[] {
	const reasons: string[] = [];
	if (DEFERRED_ACTIONS.has(rule.action)) reasons.push(`action '${rule.action}' is not enforced in this version`);
	const match = rule.match;
	if (match) {
		if (match.ja4 != null) reasons.push('match.ja4 is not enforced in this version');
		if (match.ja4h != null) reasons.push('match.ja4h is not enforced in this version');
		if (match.model != null) reasons.push('match.model is not enforced in this version');
		if (match.agent != null) reasons.push('match.agent is not enforced in this version');
	}
	if (rule.rateLimit != null) reasons.push('rateLimit is not enforced in this version');
	return reasons;
}

/**
 * Activation gating (wave 2, decision c): a rule is ARMED on this node iff, for each present
 * selector, the node identity matches — nodes by name, regions by region, tags by intersection.
 * Absent activation → armed everywhere. A present selector the node can't satisfy (e.g. an
 * activation.nodes list when this node has no name) leaves the rule NOT armed here.
 */
function isArmedOnNode(rule: WafRule, identity: NonNullable<CompileOptions['nodeIdentity']>): boolean {
	const activation = rule.activation;
	if (activation == null) return true;
	if (activation.nodes != null && (identity.name == null || !activation.nodes.includes(identity.name))) return false;
	if (activation.regions != null && (identity.region == null || !activation.regions.includes(identity.region)))
		return false;
	if (activation.tags != null) {
		const nodeTags = identity.tags;
		if (nodeTags == null || !activation.tags.some((tag) => nodeTags.includes(tag))) return false;
	}
	return true;
}

/**
 * Compiles the full rule list into an immutable matcher. Disabled, non-request-phase, and invalid
 * (malformed) rules are excluded (invalid ones reported via options.onInvalidRule + invalidRules).
 * VALID-but-DEFERRED rules (reserved/unimplemented features) are also excluded but reported
 * separately via options.onUnsupportedRule + unsupportedRules (decision a). Rules gated OUT by
 * activation on this node are silently omitted (not counted as invalid or unsupported).
 * When options.mode is 'off' a pass-through (isEmpty) matcher is returned immediately (kill switch).
 */
export function compileRules(rules: WafRule[], options: CompileOptions = {}): WafMatcher {
	const scoreThreshold = options.scoreThreshold ?? 10;
	const mode = options.mode ?? 'enforce';
	const monitorMode = mode === 'monitor';
	const nodeIdentity = options.nodeIdentity ?? {};
	const invalidRules = new Map<string, string[]>();
	const unsupportedRules = new Map<string, string[]>();

	// mode 'off' is the kill switch: return a pass-through matcher so evaluate() short-circuits. We
	// still classify rules for the logging summary (which reads invalid/unsupported counts) but skip
	// all index building, since nothing is ever evaluated.
	if (mode === 'off') {
		for (const rule of rules) {
			if (!rule || rule.enabled === false || rule.phase !== 'request') continue;
			const problems = validateRule(rule);
			if (problems.length > 0) {
				invalidRules.set(String(rule.id), problems);
				options.onInvalidRule?.(String(rule.id), problems);
				continue;
			}
			const reasons = deferralReasons(rule);
			if (reasons.length > 0) {
				unsupportedRules.set(String(rule.id), reasons);
				options.onUnsupportedRule?.(String(rule.id), reasons);
			}
		}
		return {
			isEmpty: true,
			ruleCount: 0,
			invalidRules,
			unsupportedRules,
			evaluate: () => null,
			getStats: getRuleStats,
		};
	}

	const compiled: CompiledRule[] = [];

	// Anchor index builders
	const v4Intervals: { start: number; end: number; ruleIndex: number }[] = [];
	const v6Exact = new Map<string, number[]>(); // BigInt.toString() key → rule indexes
	const v6Prefixes: Ipv6Prefix[] = [];
	const pathExact = new Map<string, number[]>();
	const prefixEntries: { prefix: string; ruleIndex: number }[] = [];
	const pathRegexes: { regex: RegExp; ruleIndex: number }[] = [];
	const headerAnchors = new Map<string, HeaderCheck[]>();
	const queryChecks: { name: string; check: HeaderCheck }[] = [];
	const methodAnchors = new Map<string, number[]>();

	for (const rule of rules) {
		if (!rule || rule.enabled === false) continue;
		if (rule.phase !== 'request') continue; // requestBody phase: future work
		const problems = validateRule(rule);
		if (problems.length > 0) {
			invalidRules.set(String(rule.id), problems);
			options.onInvalidRule?.(String(rule.id), problems);
			continue;
		}
		// DEFERRED (decision a): the rule is valid but uses a feature the v1 engine can't honor.
		// Compile it OUT and report it as unsupported — distinct from invalid — never partially enforce.
		const deferred = deferralReasons(rule);
		if (deferred.length > 0) {
			unsupportedRules.set(String(rule.id), deferred);
			options.onUnsupportedRule?.(String(rule.id), deferred);
			continue;
		}
		// Activation gating (decision c): a rule not armed on THIS node is compiled out silently —
		// it's simply not-for-this-node, so it is neither invalid nor unsupported here.
		if (!isArmedOnNode(rule, nodeIdentity)) continue;
		const match = rule.match;
		const errors: string[] = [];
		const residuals: ResidualCheck[] = [];
		const ruleIndex = compiled.length;

		// Stage-then-commit (M1): all index insertions are collected into locals here and merged
		// into the shared structures ONLY after the validity gate below passes. This preserves the
		// invariant that a rejected rule's ruleIndex (== compiled.length, unchanged since we don't
		// push to `compiled`) is never aliased by stale entries when the NEXT valid rule reuses it.
		const staged = {
			v4: [] as { start: number; end: number }[],
			v6Exact: [] as bigint[],
			v6Prefix: [] as { value: bigint; mask: bigint }[],
			pathExact: undefined as string | undefined,
			pathPrefix: undefined as string | undefined,
			pathRegex: undefined as RegExp | undefined,
			header: undefined as { name: string; check: Omit<HeaderCheck, 'ruleIndex'> } | undefined,
			query: undefined as { name: string; check: Omit<HeaderCheck, 'ruleIndex'> } | undefined,
			methods: undefined as string[] | undefined,
		};

		// Anchor preference: ip > path.exact > path.prefix > path.regex > header > query > method.
		// The anchor's own condition is baked into its index; everything else goes to residuals.
		let anchored = false;

		if (match.ip != null) {
			let allParsed = true;
			for (const cidr of Array.isArray(match.ip) ? match.ip : [match.ip]) {
				const parsed = parseCidr(cidr);
				if (!parsed) {
					allParsed = false;
					errors.push(`match.ip: unparseable address or CIDR ${JSON.stringify(cidr)}`);
					break;
				}
				if (parsed.kind === 'v4') staged.v4.push({ start: parsed.start, end: parsed.end });
				else if (parsed.bits === 128) staged.v6Exact.push(parsed.value);
				else staged.v6Prefix.push({ value: parsed.value, mask: parsed.mask });
			}
			if (allParsed) anchored = true;
		}
		if (!anchored && match.path != null) {
			if (match.path.exact != null) {
				// canonicalize the authored literal so it shares the request path's normalized space (M6)
				staged.pathExact = canonicalizePath(match.path.exact);
				const residualPath = { ...match.path, exact: undefined };
				if (residualPath.prefix != null || residualPath.regex != null) {
					const residual = makePathResidual(residualPath, errors);
					if (residual) residuals.push(residual);
				}
				anchored = true;
			} else if (match.path.prefix != null) {
				staged.pathPrefix = canonicalizePath(match.path.prefix);
				if (match.path.regex != null) {
					const residual = makePathResidual({ regex: match.path.regex }, errors);
					if (residual) residuals.push(residual);
				}
				anchored = true;
			} else if (match.path.regex != null) {
				const regex = compileRuleRegex(match.path.regex, 'match.path.regex', errors);
				if (regex) {
					staged.pathRegex = regex;
					anchored = true;
				}
			}
		} else if (anchored && match.path != null) {
			const residual = makePathResidual(match.path, errors);
			if (residual) residuals.push(residual);
		}

		if (!anchored && match.headers != null && match.headers.length > 0) {
			// anchor on the first header condition; the rest go to residuals
			const [first, ...rest] = match.headers;
			let regex: RegExp | undefined;
			if (first.op === 'regex') regex = compileRuleRegex(first.value!, `match.headers[${first.name}]`, errors);
			if (first.op !== 'regex' || regex) {
				staged.header = { name: first.name.toLowerCase(), check: { op: first.op, value: first.value ?? '', regex } };
				if (rest.length > 0) {
					const residual = makeHeaderResidual(rest, errors);
					if (residual) residuals.push(residual);
				}
				anchored = true;
			}
		} else if (anchored && match.headers != null && match.headers.length > 0) {
			const residual = makeHeaderResidual(match.headers, errors);
			if (residual) residuals.push(residual);
		}

		if (!anchored && match.query != null && match.query.length > 0) {
			// anchor on the first query condition (checked against the once-per-request parsed
			// params); any further query conditions become a residual
			const [first, ...rest] = match.query;
			let regex: RegExp | undefined;
			if (first.op === 'regex') regex = compileRuleRegex(first.value!, `match.query[${first.name}]`, errors);
			if (first.op !== 'regex' || regex) {
				staged.query = { name: first.name, check: { op: first.op, value: first.value ?? '', regex } };
				if (rest.length > 0) {
					const residual = makeQueryResidual(rest, errors);
					if (residual) residuals.push(residual);
				}
				anchored = true;
			}
		} else if (anchored && match.query != null && match.query.length > 0) {
			const residual = makeQueryResidual(match.query, errors);
			if (residual) residuals.push(residual);
		}

		if (!anchored && match.method != null && match.method.length > 0) {
			staged.methods = match.method.map((m) => m.toUpperCase());
			anchored = true;
		} else if (anchored && match.method != null && match.method.length > 0) {
			residuals.push(makeMethodResidual(match.method));
		}

		if (!anchored || errors.length > 0) {
			const allProblems = errors.length > 0 ? errors : ['no indexable condition'];
			invalidRules.set(String(rule.id), allProblems);
			options.onInvalidRule?.(String(rule.id), allProblems);
			continue; // ruleIndex is NOT consumed — no staged entry was committed
		}

		// ---- commit: the rule is valid, merge staged index entries under ruleIndex ----
		for (const range of staged.v4) v4Intervals.push({ start: range.start, end: range.end, ruleIndex });
		for (const value of staged.v6Exact) {
			const key = value.toString();
			let list = v6Exact.get(key);
			if (!list) v6Exact.set(key, (list = []));
			list.push(ruleIndex);
		}
		for (const prefix of staged.v6Prefix) v6Prefixes.push({ value: prefix.value, mask: prefix.mask, ruleIndex });
		if (staged.pathExact !== undefined) {
			let list = pathExact.get(staged.pathExact);
			if (!list) pathExact.set(staged.pathExact, (list = []));
			list.push(ruleIndex);
		}
		if (staged.pathPrefix !== undefined) prefixEntries.push({ prefix: staged.pathPrefix, ruleIndex });
		if (staged.pathRegex !== undefined) pathRegexes.push({ regex: staged.pathRegex, ruleIndex });
		if (staged.header !== undefined) {
			let list = headerAnchors.get(staged.header.name);
			if (!list) headerAnchors.set(staged.header.name, (list = []));
			list.push({ ...staged.header.check, ruleIndex });
		}
		if (staged.query !== undefined)
			queryChecks.push({ name: staged.query.name, check: { ...staged.query.check, ruleIndex } });
		if (staged.methods !== undefined) {
			for (const method of staged.methods) {
				let list = methodAnchors.get(method);
				if (!list) methodAnchors.set(method, (list = []));
				list.push(ruleIndex);
			}
		}

		compiled.push({
			id: rule.id,
			priority: rule.priority ?? 0,
			// deferred actions (challenge/serve/drop) were filtered above, so only enforceable actions remain
			action: rule.action as CompiledRule['action'],
			score: rule.score ?? 0,
			blockStatus: rule.blockStatus ?? DEFAULT_BLOCK_STATUS,
			// monitor mode makes EVERY rule behave as shadow (decision b); otherwise honor per-rule shadow.
			shadow: monitorMode || rule.shadow === true,
			residual: combineResiduals(residuals),
		});
	}

	// ---- Freeze indexes into evaluation-friendly forms ----

	// IPv4 intervals: sorted by start, with a prefix-max of end values so overlapping/nested CIDRs
	// are still found by walking left from the binary-search position until prefixMaxEnd < ip.
	v4Intervals.sort((a, b) => a.start - b.start || a.end - b.end);
	const v4Count = v4Intervals.length;
	const v4Starts = new Float64Array(v4Count);
	const v4Ends = new Float64Array(v4Count);
	const v4PrefixMaxEnd = new Float64Array(v4Count);
	const v4RuleIndexes = new Int32Array(v4Count);
	let runningMax = -1;
	for (let i = 0; i < v4Count; i++) {
		v4Starts[i] = v4Intervals[i].start;
		v4Ends[i] = v4Intervals[i].end;
		v4RuleIndexes[i] = v4Intervals[i].ruleIndex;
		if (v4Intervals[i].end > runningMax) runningMax = v4Intervals[i].end;
		v4PrefixMaxEnd[i] = runningMax;
	}

	// Path prefix trie (character-level)
	const prefixTrieRoot: PathTrieNode | null = prefixEntries.length > 0 ? { children: null, ruleIndexes: null } : null;
	for (const { prefix, ruleIndex } of prefixEntries) {
		let node = prefixTrieRoot!;
		for (let i = 0; i < prefix.length; i++) {
			const code = prefix.charCodeAt(i);
			if (node.children === null) node.children = new Map();
			let child = node.children.get(code);
			if (!child) node.children.set(code, (child = { children: null, ruleIndexes: null }));
			node = child;
		}
		(node.ruleIndexes ??= []).push(ruleIndex);
	}

	// Combined-alternation pre-gate: one RE2 test decides whether ANY path-regex rule can match, so
	// the 99% (non-matching) path costs a single ~55ns DFA walk — flat in pattern count — instead of
	// a per-rule scan (each RE2 `.test()` pays an N-API + UTF-8 conversion toll, ~35ns/pattern).
	// Unlike the JS-RegExp version of this gate, no backreference carve-out is needed: RE2 rejects
	// backreferences at individual compile, so alternation can never renumber a group into a false
	// negative. (`RE2.Set` was measured and rejected: its many-match NFA is ~20× slower per test.)
	// The combined program can exceed RE2's size budget — fall back to the plain scan, never fail.
	let pathRegexGate: RE2 | null = null;
	if (pathRegexes.length > 1) {
		try {
			pathRegexGate = new RE2(pathRegexes.map(({ regex }) => `(?:${regex.source})`).join('|'));
		} catch {
			pathRegexGate = null;
		}
	}

	const hasV6Rules = v6Exact.size > 0 || v6Prefixes.length > 0;
	const hasPathRules = pathExact.size > 0 || prefixTrieRoot !== null || pathRegexes.length > 0;
	// With many distinct rule-referenced header names, probing each of them per request is the
	// dominant cost; walking the request's own (~12) header names instead flips it to O(request).
	const invertHeaderIteration = headerAnchors.size > 16;
	const ruleCount = compiled.length;
	const isEmpty = ruleCount === 0;

	// Scratch buffer reused across evaluate() calls (a matcher is used by one worker thread).
	// Sized to the total index-entry count, not the rule count: a multi-CIDR rule contributes an
	// interval per CIDR and all of them can fire for one ip. Only fills on the slow path.
	let totalAnchorEntries = v4Count + v6Prefixes.length + prefixEntries.length + pathRegexes.length + queryChecks.length;
	for (const list of v6Exact.values()) totalAnchorEntries += list.length;
	for (const list of pathExact.values()) totalAnchorEntries += list.length;
	for (const list of headerAnchors.values()) totalAnchorEntries += list.length;
	for (const list of methodAnchors.values()) totalAnchorEntries += list.length;
	const candidateBuffer = new Int32Array(totalAnchorEntries);

	function evaluate(request: WafRequestInfo): WafDecision | null {
		if (isEmpty) return null;
		let candidateCount = 0;

		// --- ip anchor ---
		// M4: treat null / non-string ip the same as absent so evaluate() can never throw on
		// malformed requestInfo (it runs pre-auth; a throw would 500 all traffic).
		const rawIp = request.ip;
		if (typeof rawIp === 'string' && (v4Count > 0 || hasV6Rules)) {
			const ip = normalizeIp(rawIp);
			const v4value = parseIpv4(ip);
			if (v4value !== -1) {
				if (v4Count > 0) {
					let i = lowerBound(v4Starts, v4Count, v4value) - 1;
					while (i >= 0 && v4PrefixMaxEnd[i] >= v4value) {
						if (v4Ends[i] >= v4value) candidateBuffer[candidateCount++] = v4RuleIndexes[i];
						i--;
					}
				}
			} else if (hasV6Rules) {
				const v6value = parseIpv6(ip);
				if (v6value !== null) {
					const exactList = v6Exact.get(v6value.toString());
					if (exactList) for (const ruleIndex of exactList) candidateBuffer[candidateCount++] = ruleIndex;
					for (const prefix of v6Prefixes) {
						if ((v6value & prefix.mask) === prefix.value) candidateBuffer[candidateCount++] = prefix.ruleIndex;
					}
				}
			}
		}

		// --- path anchors ---
		// M4: a missing / non-string path skips all path indexes rather than throwing.
		const path = request.path;
		if (typeof path === 'string' && hasPathRules) {
			if (pathExact.size > 0) {
				const exactList = pathExact.get(path);
				if (exactList) for (const ruleIndex of exactList) candidateBuffer[candidateCount++] = ruleIndex;
			}
			if (prefixTrieRoot !== null) {
				let node: PathTrieNode | null = prefixTrieRoot;
				for (let i = 0; node !== null && i <= path.length; i++) {
					if (node.ruleIndexes !== null) {
						for (const ruleIndex of node.ruleIndexes) candidateBuffer[candidateCount++] = ruleIndex;
					}
					if (i === path.length || node.children === null) break;
					node = node.children.get(path.charCodeAt(i)) ?? null;
				}
			}
			// Per-rule attribution scan, gated by the combined pre-gate (one native test on the
			// no-match path); every pattern is a linear-time RE2, so a gate hit cannot blow up.
			if (pathRegexes.length > 0 && (pathRegexGate === null || pathRegexGate.test(path))) {
				for (let i = 0; i < pathRegexes.length; i++) {
					if (pathRegexes[i].regex.test(path)) candidateBuffer[candidateCount++] = pathRegexes[i].ruleIndex;
				}
			}
		}

		// --- header anchors ---
		// M4 defense-in-depth: a malformed request without a getHeader function must not throw.
		if (headerAnchors.size > 0 && typeof request.getHeader === 'function') {
			const requestNames = invertHeaderIteration ? request.headerNames?.() : undefined;
			if (requestNames !== undefined) {
				// large anchor map: walk the request's own header names, probe the map per name
				for (const name of requestNames) {
					const checks = headerAnchors.get(name);
					if (checks === undefined) continue;
					const value = request.getHeader(name);
					for (const check of checks) {
						if (checkHeaderValue(value, check)) candidateBuffer[candidateCount++] = check.ruleIndex;
					}
				}
			} else {
				// small anchor map: probe only the headers that rules mention (no allocation)
				for (const [name, checks] of headerAnchors) {
					const value = request.getHeader(name);
					if (value === undefined) continue;
					for (const check of checks) {
						if (checkHeaderValue(value, check)) candidateBuffer[candidateCount++] = check.ruleIndex;
					}
				}
			}
		}

		// --- query anchor: parse the query string once, then run every check against it ---
		if (queryChecks.length > 0 && request.query !== undefined && request.query.length > 0) {
			const params = parseQueryString(request.query);
			for (let i = 0; i < queryChecks.length; i++) {
				const entry = queryChecks[i];
				if (checkHeaderValue(params.get(entry.name), entry.check))
					candidateBuffer[candidateCount++] = entry.check.ruleIndex;
			}
		}

		// --- method anchor ---
		if (methodAnchors.size > 0) {
			const methodList = methodAnchors.get(request.method);
			if (methodList) for (const ruleIndex of methodList) candidateBuffer[candidateCount++] = ruleIndex;
		}

		if (candidateCount === 0) return null; // the 99% path: no allocation above this line

		// --- residual verification + action resolution (slow path) ---
		let matched: CompiledRule[] | null = null;
		let seen: Set<number> | null = candidateCount > 1 ? new Set() : null;
		for (let i = 0; i < candidateCount; i++) {
			const ruleIndex = candidateBuffer[i];
			if (seen !== null) {
				if (seen.has(ruleIndex)) continue;
				seen.add(ruleIndex);
			}
			const rule = compiled[ruleIndex];
			if (rule.residual !== null && !rule.residual(request)) continue;
			(matched ??= []).push(rule);
		}
		if (matched === null) return null;
		if (matched.length > 1) matched.sort((a, b) => a.priority - b.priority);

		// Per-rule telemetry: every rule in the final matched set counts as a hit regardless of
		// action (block/log/score). Shadow rules and monitor-mode matches count too: hitCount is a
		// MATCH counter, not a block counter (intended — a shadow/monitor "would-block" is still a
		// match). Only reached when matched !== null, so the 99% no-candidate path stays allocation-
		// free. Entries are created lazily, keyed by String(rule.id).
		// TODO: per-rule latency attribution would need a hot-path timestamp diff; skipped as not
		// free — hitCount + lastMatched are the telemetry contract here.
		const hitTime = Date.now();
		for (const rule of matched) {
			const key = String(rule.id);
			const stat = ruleStats.get(key);
			if (stat === undefined) ruleStats.set(key, { hitCount: 1, lastMatched: hitTime });
			else {
				stat.hitCount++;
				stat.lastMatched = hitTime;
			}
		}

		// Resolution. `log` is orthogonal to shadow — a log rule NEVER enforces, so shadow/monitor
		// must not suppress it: every matched log rule is collected into the real logIds regardless of
		// the shadow flag (handled first, below). Only ENFORCING actions (block/score) go through the
		// REAL-vs-SHADOW split: the REAL track is today's exact logic (first block wins, score
		// accumulates to threshold); the SHADOW track (rules with shadow:true, which in monitor mode is
		// EVERY block/score rule — see the compile step) mirrors that resolution but produces ONLY a
		// would-block preview id list, never contributing to the real score or causing a real block.
		// Net for monitor mode: would-block previews for block/score PLUS normal log output — the
		// intended visibility-adding dry-run. Enforcement short-circuits, telemetry does not: log rules
		// from the WHOLE matched set are surfaced (matchedLogRuleIds) even after a block wins.
		let totalScore = 0;
		let logIds: (string | number)[] | null = null;
		let blockDecision: WafDecision | null = null;
		const scoreIds: (string | number)[] = [];
		// shadow-track accumulators (mirror the real ones)
		let shadowScore = 0;
		let shadowBlockIds: (string | number)[] | null = null; // would-block preview (first shadow block wins)
		const shadowScoreIds: (string | number)[] = [];
		for (const rule of matched) {
			// log is orthogonal to shadow/monitor — always collect it (never suppressed, never a block)
			if (rule.action === 'log') {
				(logIds ??= []).push(rule.id);
				continue;
			}
			if (rule.shadow) {
				// SHADOW track: mirror block/score resolution into a would-block list only.
				if (shadowBlockIds !== null) continue; // shadow would-block already decided
				if (rule.action === 'block') {
					shadowBlockIds = [rule.id];
				} else {
					shadowScore += rule.score;
					shadowScoreIds.push(rule.id);
					if (shadowScore >= scoreThreshold) shadowBlockIds = shadowScoreIds.slice();
				}
				continue;
			}
			// REAL track (unchanged logic)
			if (blockDecision !== null) continue; // enforcement decided; only telemetry collection remains
			if (rule.action === 'block') {
				blockDecision = { action: 'block', status: rule.blockStatus, ruleIds: [rule.id] };
			} else {
				totalScore += rule.score;
				scoreIds.push(rule.id);
				if (totalScore >= scoreThreshold) {
					blockDecision = { action: 'block', status: DEFAULT_BLOCK_STATUS, ruleIds: scoreIds, score: totalScore };
				}
			}
		}
		if (blockDecision !== null) {
			if (logIds !== null) blockDecision.matchedLogRuleIds = logIds;
			if (shadowBlockIds !== null) blockDecision.shadowRuleIds = shadowBlockIds;
			return blockDecision;
		}
		// No real block. If a shadow would-block exists, return a pass-through (action 'log', status 0)
		// carrying the preview so the middleware logs the would-block without enforcing.
		if (shadowBlockIds !== null) {
			const decision: WafDecision = {
				action: 'log',
				status: 0,
				ruleIds: logIds ?? [],
				shadowRuleIds: shadowBlockIds,
			};
			if (totalScore > 0) decision.score = totalScore;
			return decision;
		}
		if (logIds !== null) {
			return { action: 'log', status: 0, ruleIds: logIds, score: totalScore > 0 ? totalScore : undefined };
		}
		return null; // only sub-threshold (real and shadow) score rules matched
	}

	return { isEmpty, ruleCount, invalidRules, unsupportedRules, evaluate, getStats: getRuleStats };
}
