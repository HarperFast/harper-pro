/**
 * Unit coverage for the compiled WAF matcher (waf/matcher.ts) — pure module, no Harper runtime.
 *
 * Covers: block/log/score action resolution, CIDR matching (IPv4 intervals, IPv4-mapped
 * addresses, IPv6 exact + prefix), path exact/prefix/regex, header ops, query params, method
 * anchoring, priority ordering, enabled/phase filtering, invalid-rule skipping (bad regex),
 * and atomic recompile-swap semantics.
 */

import { expect } from 'chai';
import { canonicalizePath, compileRules, parseCidr, parseIpv4, parseIpv6, parseQueryString } from '#src/waf/matcher';
import { validateRule } from '#src/waf/rules';

const BASE = { enabled: true, priority: 0, phase: 'request', action: 'block' };

function makeRequest(overrides = {}) {
	const headers = new Map(
		Object.entries({
			'host': 'api.example.com',
			'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
			'accept': 'application/json',
			'accept-encoding': 'gzip, br',
			'content-type': 'application/json',
			...(overrides.headers ?? {}),
		})
	);
	return {
		ip: '203.0.113.7',
		method: 'GET',
		path: '/api/products/42',
		query: undefined,
		getHeader: (name) => headers.get(name.toLowerCase()),
		...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'headers')),
	};
}

describe('WAF ip parsing', () => {
	it('parses IPv4', () => {
		expect(parseIpv4('0.0.0.0')).to.equal(0);
		expect(parseIpv4('255.255.255.255')).to.equal(0xffffffff);
		expect(parseIpv4('10.1.2.3')).to.equal((10 << 24) + (1 << 16) + (2 << 8) + 3);
		expect(parseIpv4('256.0.0.1')).to.equal(-1);
		expect(parseIpv4('1.2.3')).to.equal(-1);
		expect(parseIpv4('a.b.c.d')).to.equal(-1);
		expect(parseIpv4('1.2.3.4.5')).to.equal(-1);
	});
	it('rejects IPv4 octets with leading zeros (parse-ambiguity / SSRF bypass)', () => {
		expect(parseIpv4('010.0.0.1')).to.equal(-1);
		expect(parseIpv4('00.0.0.0')).to.equal(-1);
		expect(parseIpv4('1.2.3.01')).to.equal(-1);
		expect(parseCidr('010.0.0.1')).to.equal(null);
		// a lone '0' octet is still valid — the guard only fires on a 2nd digit after a leading 0
		expect(parseIpv4('10.0.0.1')).to.equal((10 << 24) + 1);
		expect(parseIpv4('0.0.0.0')).to.equal(0);
		expect(parseIpv4('127.0.0.1')).to.equal((127 << 24) + 1);
	});
	it('parses IPv6 including compressed and IPv4-mapped forms', () => {
		expect(parseIpv6('::1')).to.equal(1n);
		expect(parseIpv6('::')).to.equal(0n);
		expect(parseIpv6('2001:db8::1')).to.equal((0x2001n << 112n) | (0xdb8n << 96n) | 1n);
		expect(parseIpv6('::ffff:1.2.3.4')).to.equal((0xffffn << 32n) | 0x01020304n);
		expect(parseIpv6('not-an-ip')).to.equal(null);
		expect(parseIpv6('1:2:3:4:5:6:7:8:9')).to.equal(null);
	});
	it('rejects IPv6 groups with non-hex garbage (parseInt trailing-garbage guard)', () => {
		expect(parseIpv6('2001:db8::12g4')).to.equal(null);
		expect(parseCidr('2001:db8::12g4')).to.equal(null);
	});
});

describe('WAF query-string parsing', () => {
	it('decodes name and value independently so one bad escape does not corrupt the other', () => {
		// bad VALUE escape: name still decodes, value stays raw (never throws)
		const a = parseQueryString('a%20b=%ZZ');
		expect(a.get('a b')).to.equal('%ZZ');
		// bad NAME escape: value still decodes, name stays raw (never throws)
		const b = parseQueryString('%ZZ=b%20c');
		expect(b.get('%ZZ')).to.equal('b c');
	});
});

describe('WAF matcher — CIDR / ip rules', () => {
	const matcher = compileRules([
		{ ...BASE, id: 'v4-cidr', match: { ip: '192.168.0.0/16' } },
		{ ...BASE, id: 'v4-single', match: { ip: '198.51.100.9' }, blockStatus: 429 },
		{ ...BASE, id: 'v4-multi', match: { ip: ['10.0.0.0/8', '172.16.0.0/12'] } },
		{ ...BASE, id: 'v6-exact', match: { ip: '2001:db8::dead' } },
		{ ...BASE, id: 'v6-prefix', match: { ip: '2001:db8:1::/48' } },
	]);
	it('blocks an ip inside a CIDR', () => {
		const decision = matcher.evaluate(makeRequest({ ip: '192.168.44.5' }));
		expect(decision).to.deep.equal({ action: 'block', status: 403, ruleIds: ['v4-cidr'] });
	});
	it('honors blockStatus on a single-address rule', () => {
		expect(matcher.evaluate(makeRequest({ ip: '198.51.100.9' })).status).to.equal(429);
		expect(matcher.evaluate(makeRequest({ ip: '198.51.100.8' }))).to.equal(null);
	});
	it('matches any CIDR of a multi-CIDR rule', () => {
		expect(matcher.evaluate(makeRequest({ ip: '10.200.1.1' })).ruleIds).to.deep.equal(['v4-multi']);
		expect(matcher.evaluate(makeRequest({ ip: '172.31.0.1' })).ruleIds).to.deep.equal(['v4-multi']);
		expect(matcher.evaluate(makeRequest({ ip: '172.32.0.1' }))).to.equal(null);
	});
	it('matches an IPv4-mapped IPv6 request address against IPv4 rules', () => {
		expect(matcher.evaluate(makeRequest({ ip: '::ffff:192.168.1.1' })).ruleIds).to.deep.equal(['v4-cidr']);
	});
	it('matches IPv6 exact and prefix rules', () => {
		expect(matcher.evaluate(makeRequest({ ip: '2001:db8::dead' })).ruleIds).to.deep.equal(['v6-exact']);
		expect(matcher.evaluate(makeRequest({ ip: '2001:db8:1:2::3' })).ruleIds).to.deep.equal(['v6-prefix']);
		expect(matcher.evaluate(makeRequest({ ip: '2001:db8:2::1' }))).to.equal(null);
	});
	it('does not match when the request has no ip', () => {
		expect(matcher.evaluate(makeRequest({ ip: undefined }))).to.equal(null);
	});
});

describe('WAF matcher — path rules', () => {
	const matcher = compileRules([
		{ ...BASE, id: 'exact', match: { path: { exact: '/admin' } } },
		{ ...BASE, id: 'prefix', action: 'log', match: { path: { prefix: '/internal/' } } },
		{ ...BASE, id: 'regex', match: { path: { regex: '\\.(php|asp)$' } } },
	]);
	it('matches exact paths only', () => {
		expect(matcher.evaluate(makeRequest({ path: '/admin' })).ruleIds).to.deep.equal(['exact']);
		expect(matcher.evaluate(makeRequest({ path: '/admin/x' }))).to.equal(null);
		expect(matcher.evaluate(makeRequest({ path: '/admi' }))).to.equal(null);
	});
	it('matches path prefixes', () => {
		const decision = matcher.evaluate(makeRequest({ path: '/internal/metrics' }));
		expect(decision.action).to.equal('log');
		expect(decision.ruleIds).to.deep.equal(['prefix']);
		expect(matcher.evaluate(makeRequest({ path: '/internal' }))).to.equal(null);
	});
	it('matches path regexes', () => {
		expect(matcher.evaluate(makeRequest({ path: '/legacy/index.php' })).ruleIds).to.deep.equal(['regex']);
		expect(matcher.evaluate(makeRequest({ path: '/legacy/index.html' }))).to.equal(null);
	});
	it('attributes exactly the right rules through the combined regex pre-gate (>1 regex rule)', () => {
		// 3 regex rules arm the combined-alternation pre-gate; attribution must stay per-rule
		const gated = compileRules([
			{ ...BASE, id: 'php', match: { path: { regex: '\\.php$' } } },
			{ ...BASE, id: 'legacy', action: 'log', match: { path: { regex: '^/legacy/' } } },
			{ ...BASE, id: 'trace', match: { path: { regex: '/trace/[0-9]+$' } } },
		]);
		const both = gated.evaluate(makeRequest({ path: '/legacy/index.php' }));
		expect(both.ruleIds).to.deep.equal(['php']);
		expect(both.matchedLogRuleIds).to.deep.equal(['legacy']);
		expect(gated.evaluate(makeRequest({ path: '/app/trace/42' })).ruleIds).to.deep.equal(['trace']);
		expect(gated.evaluate(makeRequest({ path: '/app/safe' }))).to.equal(null);
	});
});

describe('WAF matcher — path canonicalization (bypass defense)', () => {
	// The middleware canonicalizes the request path before evaluate() (see waf.ts); mirror that
	// here so these tests exercise the same normalized-space contract end-to-end.
	const matcher = compileRules([
		{ ...BASE, id: 'exact', match: { path: { exact: '/admin' } } },
		{ ...BASE, id: 'prefix', action: 'log', match: { path: { prefix: '/api' } } },
	]);
	const evalPath = (rawPath) => matcher.evaluate(makeRequest({ path: canonicalizePath(rawPath) }));

	it('still matches the plain canonical path', () => {
		expect(evalPath('/admin').ruleIds).to.deep.equal(['exact']);
		expect(evalPath('/api/products').ruleIds).to.deep.equal(['prefix']);
	});
	it('closes encoded-slash / dot-segment / duplicate-slash bypasses of an exact rule', () => {
		// %2F decodes to '/', so encoded-slash traversal resolves back to the rule path
		expect(evalPath('/admin%2F..%2Fadmin').ruleIds).to.deep.equal(['exact']);
		expect(evalPath('/./admin').ruleIds).to.deep.equal(['exact']);
		expect(evalPath('//admin').ruleIds).to.deep.equal(['exact']);
		expect(evalPath('/admin/../admin').ruleIds).to.deep.equal(['exact']);
	});
	it('closes double-encoding bypasses (%2561 -> a)', () => {
		expect(evalPath('/%2561dmin').ruleIds).to.deep.equal(['exact']);
	});
	it('closes bypasses of a prefix rule', () => {
		expect(evalPath('/%61pi/x').ruleIds).to.deep.equal(['prefix']); // %61 -> 'a'
		expect(evalPath('//api//x').ruleIds).to.deep.equal(['prefix']);
		expect(evalPath('/x/../api/y').ruleIds).to.deep.equal(['prefix']);
	});
	it('canonicalizes authored rule literals too (encoded/dotted rule path)', () => {
		const m = compileRules([
			{ ...BASE, id: 'enc-exact', match: { path: { exact: '/adm%69n' } } }, // %69 -> 'i' -> '/admin'
			{ ...BASE, id: 'dot-prefix', action: 'log', match: { path: { prefix: '/a/../b/' } } }, // -> '/b/'
		]);
		expect(m.evaluate(makeRequest({ path: canonicalizePath('/admin') })).ruleIds).to.deep.equal(['enc-exact']);
		expect(m.evaluate(makeRequest({ path: canonicalizePath('/b/thing') })).ruleIds).to.deep.equal(['dot-prefix']);
	});
});

describe('WAF matcher — header, query, and method rules', () => {
	const matcher = compileRules([
		{ ...BASE, id: 'ua-contains', match: { headers: [{ name: 'User-Agent', op: 'contains', value: 'sqlmap' }] } },
		{ ...BASE, id: 'hdr-exists', action: 'log', match: { headers: [{ name: 'X-Debug', op: 'exists' }] } },
		{ ...BASE, id: 'hdr-prefix', match: { headers: [{ name: 'Authorization', op: 'prefix', value: 'Negotiate' }] } },
		{ ...BASE, id: 'hdr-regex', match: { headers: [{ name: 'X-Api-Version', op: 'regex', value: '^v[0-9]$' }] } },
		{
			...BASE,
			id: 'hdr-combo',
			match: {
				headers: [
					{ name: 'X-Kind', op: 'equals', value: 'probe' },
					{ name: 'X-Stage', op: 'equals', value: 'two' },
				],
			},
		},
		{ ...BASE, id: 'query-rule', match: { query: [{ name: 'cmd', op: 'contains', value: ';' }] } },
		{ ...BASE, id: 'method-rule', match: { method: ['TRACE', 'TRACK'] } },
		{ ...BASE, id: 'method-path', match: { method: ['DELETE'], path: { prefix: '/api/' } } },
	]);
	it('matches header ops (contains, exists, prefix, regex)', () => {
		expect(matcher.evaluate(makeRequest({ headers: { 'user-agent': 'sqlmap/1.7' } })).ruleIds).to.deep.equal([
			'ua-contains',
		]);
		expect(matcher.evaluate(makeRequest({ headers: { 'x-debug': '1' } })).ruleIds).to.deep.equal(['hdr-exists']);
		expect(matcher.evaluate(makeRequest({ headers: { authorization: 'Negotiate abc' } })).ruleIds).to.deep.equal([
			'hdr-prefix',
		]);
		expect(matcher.evaluate(makeRequest({ headers: { authorization: 'Bearer abc' } }))).to.equal(null);
		expect(matcher.evaluate(makeRequest({ headers: { 'x-api-version': 'v2' } })).ruleIds).to.deep.equal(['hdr-regex']);
		expect(matcher.evaluate(makeRequest({ headers: { 'x-api-version': 'v22' } }))).to.equal(null);
	});
	it('requires all header conditions of a rule (anchor + residual)', () => {
		expect(matcher.evaluate(makeRequest({ headers: { 'x-kind': 'probe' } }))).to.equal(null);
		expect(matcher.evaluate(makeRequest({ headers: { 'x-kind': 'probe', 'x-stage': 'two' } })).ruleIds).to.deep.equal([
			'hdr-combo',
		]);
	});
	it('matches query parameter rules only when a query string is present', () => {
		expect(matcher.evaluate(makeRequest({ query: 'cmd=ls%3Bcat' })).ruleIds).to.deep.equal(['query-rule']);
		expect(matcher.evaluate(makeRequest({ query: 'cmd=ls' }))).to.equal(null);
		expect(matcher.evaluate(makeRequest())).to.equal(null);
	});
	it('matches method rules, including method+path combos', () => {
		expect(matcher.evaluate(makeRequest({ method: 'TRACE' })).ruleIds).to.deep.equal(['method-rule']);
		expect(matcher.evaluate(makeRequest({ method: 'DELETE', path: '/api/products/1' })).ruleIds).to.deep.equal([
			'method-path',
		]);
		expect(matcher.evaluate(makeRequest({ method: 'DELETE', path: '/other' }))).to.equal(null);
	});
});

describe('WAF matcher — actions, scoring, priority', () => {
	it('accumulates score rules and blocks at the threshold', () => {
		const matcher = compileRules(
			[
				{ ...BASE, id: 's1', action: 'score', score: 4, match: { path: { prefix: '/x/' } } },
				{ ...BASE, id: 's2', action: 'score', score: 4, match: { method: ['GET'] } },
				{ ...BASE, id: 's3', action: 'score', score: 4, match: { headers: [{ name: 'X-Odd', op: 'exists' }] } },
			],
			{ scoreThreshold: 10 }
		);
		// two score rules: 8 < 10 → no decision
		expect(matcher.evaluate(makeRequest({ path: '/x/1' }))).to.equal(null);
		// three score rules: 12 >= 10 → block listing contributing rules
		const decision = matcher.evaluate(makeRequest({ path: '/x/1', headers: { 'x-odd': 'y' } }));
		expect(decision.action).to.equal('block');
		expect(decision.score).to.equal(12);
		expect(decision.ruleIds).to.have.members(['s1', 's2', 's3']);
	});
	it('resolves actions in priority order (lower priority number first)', () => {
		const matcher = compileRules([
			{ ...BASE, id: 'late-block', priority: 5, match: { path: { prefix: '/p/' } } },
			{ ...BASE, id: 'early-log', priority: 1, action: 'log', match: { path: { prefix: '/p/' } } },
		]);
		// block still wins overall
		expect(matcher.evaluate(makeRequest({ path: '/p/a' })).action).to.equal('block');
		const logFirst = compileRules([
			{ ...BASE, id: 'b', priority: 5, action: 'log', match: { path: { prefix: '/p/' } } },
			{ ...BASE, id: 'a', priority: 1, action: 'log', match: { path: { prefix: '/p/' } } },
		]);
		expect(logFirst.evaluate(makeRequest({ path: '/p/a' })).ruleIds).to.deep.equal(['a', 'b']);
	});
	it('records ALL matched log rules on a block decision (enforcement short-circuits, telemetry does not)', () => {
		const matcher = compileRules([
			{ ...BASE, id: 'log-before', priority: 1, action: 'log', match: { path: { prefix: '/p/' } } },
			{ ...BASE, id: 'blocker', priority: 5, match: { path: { prefix: '/p/' } } },
			{ ...BASE, id: 'log-after', priority: 9, action: 'log', match: { path: { prefix: '/p/' } } },
		]);
		const decision = matcher.evaluate(makeRequest({ path: '/p/a' }));
		expect(decision.action).to.equal('block');
		expect(decision.status).to.equal(403);
		expect(decision.ruleIds).to.deep.equal(['blocker']);
		// log rules both before AND after the block (by priority) are surfaced for recording
		expect(decision.matchedLogRuleIds).to.deep.equal(['log-before', 'log-after']);
		// no allocation / no field when no log rules matched
		const blockOnly = compileRules([{ ...BASE, id: 'only', match: { path: { prefix: '/p/' } } }]);
		expect(blockOnly.evaluate(makeRequest({ path: '/p/a' }))).to.not.have.property('matchedLogRuleIds');
	});
	it('records matched log rules on a score-threshold block too', () => {
		const matcher = compileRules(
			[
				{ ...BASE, id: 'watch', priority: 1, action: 'log', match: { path: { prefix: '/p/' } } },
				{ ...BASE, id: 's1', priority: 2, action: 'score', score: 6, match: { path: { prefix: '/p/' } } },
				{ ...BASE, id: 's2', priority: 3, action: 'score', score: 6, match: { method: ['GET'] } },
			],
			{ scoreThreshold: 10 }
		);
		const decision = matcher.evaluate(makeRequest({ path: '/p/a' }));
		expect(decision.action).to.equal('block');
		expect(decision.ruleIds).to.deep.equal(['s1', 's2']);
		expect(decision.matchedLogRuleIds).to.deep.equal(['watch']);
	});
	it('skips disabled and requestBody-phase rules', () => {
		const matcher = compileRules([
			{ ...BASE, id: 'off', enabled: false, match: { path: { prefix: '/p/' } } },
			{ ...BASE, id: 'body-phase', phase: 'requestBody', match: { path: { prefix: '/p/' } } },
		]);
		expect(matcher.isEmpty).to.equal(true);
		expect(matcher.evaluate(makeRequest({ path: '/p/a' }))).to.equal(null);
	});
	it('skips invalid rules (bad regex) and reports them', () => {
		const skipped = [];
		const matcher = compileRules(
			[
				{ ...BASE, id: 'bad-re', match: { path: { regex: '(' } } },
				{ ...BASE, id: 'good', match: { path: { exact: '/ok' } } },
			],
			{ onInvalidRule: (id, problems) => skipped.push([id, problems]) }
		);
		expect(matcher.ruleCount).to.equal(1);
		expect(matcher.invalidRules.has('bad-re')).to.equal(true);
		expect(skipped.length).to.equal(1);
		expect(matcher.evaluate(makeRequest({ path: '/ok' })).ruleIds).to.deep.equal(['good']);
	});
});

describe('WAF matcher — recompile swap', () => {
	it('produces independent immutable matchers so a reference swap is atomic', () => {
		const first = compileRules([{ ...BASE, id: 'r1', match: { path: { exact: '/one' } } }]);
		const second = compileRules([{ ...BASE, id: 'r2', match: { path: { exact: '/two' } } }]);
		// simulate the component's reference swap
		let live = first;
		expect(live.evaluate(makeRequest({ path: '/one' })).ruleIds).to.deep.equal(['r1']);
		live = second;
		expect(live.evaluate(makeRequest({ path: '/one' }))).to.equal(null);
		expect(live.evaluate(makeRequest({ path: '/two' })).ruleIds).to.deep.equal(['r2']);
		// the old matcher keeps answering for in-flight evaluations
		expect(first.evaluate(makeRequest({ path: '/one' })).ruleIds).to.deep.equal(['r1']);
	});
});

describe('WAF rule validation', () => {
	it('accepts a well-formed rule', () => {
		expect(validateRule({ ...BASE, id: 'ok', match: { ip: '10.0.0.0/8' } })).to.deep.equal([]);
	});
	it('rejects rules with no condition, bad ops, or bad status', () => {
		expect(validateRule({ ...BASE, id: 'x', match: {} })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', match: { headers: [{ name: 'h', op: 'nope' }] } })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', blockStatus: 99, match: { ip: '10.0.0.1' } })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', action: 'score', match: { ip: '10.0.0.1' } })).to.not.be.empty;
	});
	it('rejects non-finite numeric fields (NaN/Infinity poison scoring and sort order)', () => {
		// score: NaN would make totalScore NaN, so `NaN >= scoreThreshold` never blocks
		expect(validateRule({ ...BASE, id: 'x', action: 'score', score: NaN, match: { ip: '10.0.0.1' } })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', action: 'score', score: Infinity, match: { ip: '10.0.0.1' } })).to.not.be
			.empty;
		expect(validateRule({ ...BASE, id: 'x', action: 'score', score: '5', match: { ip: '10.0.0.1' } })).to.not.be.empty;
		// priority: NaN makes the sort comparator return NaN, leaving enforcement order unspecified
		expect(validateRule({ ...BASE, id: 'x', priority: NaN, match: { ip: '10.0.0.1' } })).to.not.be.empty;
		// blockStatus: NaN comparisons are always false, so the old `< 400 || > 599` range check
		// silently let it through; Infinity was already caught by `> 599`, kept here for parity
		expect(validateRule({ ...BASE, id: 'x', blockStatus: NaN, match: { ip: '10.0.0.1' } })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', blockStatus: Infinity, match: { ip: '10.0.0.1' } })).to.not.be.empty;
		// finite values still validate
		expect(validateRule({ ...BASE, id: 'x', action: 'score', score: 5, match: { ip: '10.0.0.1' } })).to.deep.equal([]);
	});
	it('rejects empty match arrays (anchored-yet-dead rules that never match)', () => {
		expect(validateRule({ ...BASE, id: 'x', match: { ip: [] } })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', match: { headers: [] } })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', match: { query: [] } })).to.not.be.empty;
	});
});
