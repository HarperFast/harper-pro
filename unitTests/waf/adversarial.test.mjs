/**
 * Regression coverage for the adversarial-review findings on the WAF matcher (harper-pro#517).
 * Each case pins a verified exploit so it cannot regress. Finding ids match the review (M1–M9).
 */

import { expect } from 'chai';
import { compileRules, parseCidr } from '#src/waf/matcher';
import { validateRule } from '#src/waf/rules';

const BASE = { enabled: true, priority: 0, phase: 'request', action: 'block' };

function makeRequest(overrides = {}) {
	const headers = new Map(Object.entries(overrides.headers ?? { host: 'api.example.com' }));
	return {
		ip: '203.0.113.7',
		method: 'GET',
		path: '/',
		query: undefined,
		getHeader: (name) => headers.get(name.toLowerCase()),
		headerNames: () => headers.keys(),
		...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'headers')),
	};
}

describe('M1 — a rejected rule must not corrupt a following valid rule (stale ruleIndex reuse)', () => {
	it('bad-ip+valid-path rule does not alias its staged path index onto the next valid rule', () => {
		const matcher = compileRules([
			// invalid: 'garbage' is not a parseable CIDR → rejected at the validity gate
			{ ...BASE, id: 'bad', action: 'log', match: { ip: 'garbage', path: { exact: '/foo' } } },
			{ ...BASE, id: 'goodblock', action: 'block', match: { path: { exact: '/bar' } } },
		]);
		expect(matcher.ruleCount).to.equal(1);
		// the exploit: /foo was wrongly blocked because 'bad's staged pathExact('/foo') aliased goodblock
		expect(matcher.evaluate(makeRequest({ path: '/foo' }))).to.equal(null);
		// goodblock only matches its own path
		expect(matcher.evaluate(makeRequest({ path: '/bar' })).ruleIds).to.deep.equal(['goodblock']);
	});
});

describe('M2 — trailing-slash / non-canonical CIDR must be rejected, not compiled to /0', () => {
	it("'10.0.0.0/' is invalid and does not block an unrelated address", () => {
		expect(parseCidr('10.0.0.0/')).to.equal(null);
		expect(validateRule({ ...BASE, id: 'x', match: { ip: '10.0.0.0/' } })).to.not.be.empty;
		const matcher = compileRules([{ ...BASE, id: 'blockall', match: { ip: '10.0.0.0/' } }]);
		expect(matcher.ruleCount).to.equal(0);
		expect(matcher.evaluate(makeRequest({ ip: '8.8.8.8' }))).to.equal(null);
	});
	it('rejects Number()-coercion leniency in the bit string', () => {
		expect(parseCidr('10.0.0.0/0x10')).to.equal(null);
		expect(parseCidr('10.0.0.0/1e1')).to.equal(null);
		expect(parseCidr('10.0.0.0/ 8')).to.equal(null);
		expect(parseCidr('10.0.0.0/8')).to.not.equal(null); // canonical still works
	});
});

describe('M3 — RE2-unsupported regex (backreference/lookaround) is rejected, not silently matched', () => {
	// path.regex compiles through the RE2-backed compileRuleRegex, whose linear-time guarantee is
	// what removes the ReDoS surface here (a hostile `(a+)+$` cannot stall the event loop). The
	// price of that guarantee is that RE2 cannot evaluate backreferences or lookaround, so a rule
	// using them is rejected as invalid — the same treatment as malformed syntax. This replaces the
	// old JS-RegExp combined-alternation gate (and its backreference-safety carve-out), which no
	// longer exists: every path-regex is a linear-time RE2 matched by a plain scan.
	it('a backreference path.regex is rejected as invalid and never matches', () => {
		const matcher = compileRules([{ ...BASE, id: 'backref', action: 'block', match: { path: { regex: '/(z)\\1' } } }]);
		expect(matcher.ruleCount).to.equal(0);
		expect(matcher.invalidRules.has('backref')).to.equal(true);
		expect(matcher.evaluate(makeRequest({ path: '/zz' }))).to.equal(null);
	});
	it('a lookaround path.regex is rejected as invalid', () => {
		const matcher = compileRules([
			{ ...BASE, id: 'lookahead', action: 'block', match: { path: { regex: '/admin(?=/)' } } },
		]);
		expect(matcher.ruleCount).to.equal(0);
		expect(matcher.invalidRules.has('lookahead')).to.equal(true);
	});
	it('rejecting an unsupported-regex rule does not disarm a sibling valid rule', () => {
		const matcher = compileRules([
			{ ...BASE, id: 'backref', action: 'log', match: { path: { regex: '/(z)\\1' } } },
			{ ...BASE, id: 'goodblock', action: 'block', match: { path: { regex: '\\.(php|asp)$' } } },
		]);
		expect(matcher.ruleCount).to.equal(1);
		expect(matcher.invalidRules.has('backref')).to.equal(true);
		expect(matcher.evaluate(makeRequest({ path: '/legacy/index.php' })).ruleIds).to.deep.equal(['goodblock']);
	});
	it('is immune to catastrophic backtracking on a hostile path.regex (ReDoS)', () => {
		const matcher = compileRules([{ ...BASE, id: 'evil', action: 'block', match: { path: { regex: '(a+)+$' } } }]);
		expect(matcher.ruleCount).to.equal(1);
		const start = process.hrtime.bigint();
		const decision = matcher.evaluate(makeRequest({ path: '/' + 'a'.repeat(50_000) + '!' }));
		const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
		expect(decision).to.equal(null); // trailing '!' → no match; RE2 returns in linear time
		expect(elapsedMs).to.be.lessThan(250);
	});
});

describe('M4 — evaluate() must never throw on malformed requestInfo', () => {
	const matcher = compileRules([
		{ ...BASE, id: 'ip', match: { ip: '10.0.0.0/8' } },
		{ ...BASE, id: 'path', match: { path: { prefix: '/x/' } } },
		{ ...BASE, id: 'hdr', match: { headers: [{ name: 'X-Test', op: 'exists' }] } },
	]);
	it('does not throw with ip:null', () => {
		expect(() => matcher.evaluate(makeRequest({ ip: null }))).to.not.throw();
		expect(matcher.evaluate(makeRequest({ ip: null, path: '/x/1' })).ruleIds).to.deep.equal(['path']);
	});
	it('does not throw with a missing / non-string path', () => {
		expect(() => matcher.evaluate(makeRequest({ path: undefined }))).to.not.throw();
		expect(() => matcher.evaluate(makeRequest({ path: 12345 }))).to.not.throw();
		expect(matcher.evaluate(makeRequest({ path: undefined }))).to.equal(null);
	});
	it('never throws across a fuzz of malformed requestInfos', () => {
		const malformed = [
			{ ip: null, method: undefined, path: undefined, query: null, getHeader: () => undefined },
			{ ip: 12, method: 42, path: {}, query: [], getHeader: () => 5 },
			{ ip: '::ffff:', method: 'GET', path: '', query: '', getHeader: () => undefined },
			{ ip: 'not-an-ip', method: 'GET', path: '/x/', query: undefined, getHeader: () => undefined },
			{}, // completely empty
		];
		for (const request of malformed) {
			expect(() => matcher.evaluate(request), JSON.stringify(request)).to.not.throw();
		}
	});
});

describe('M7 — multi-header rule matches with a mixed-case header name', () => {
	it('anchor + residual both match case-insensitively', () => {
		const matcher = compileRules([
			{
				...BASE,
				id: 'combo',
				match: {
					headers: [
						{ name: 'X-Kind', op: 'equals', value: 'probe' },
						{ name: 'X-Stage', op: 'equals', value: 'two' },
					],
				},
			},
		]);
		// request supplies differently-cased header names; getHeader lowercases on lookup
		const decision = matcher.evaluate(makeRequest({ headers: { 'x-kind': 'probe', 'x-stage': 'two' } }));
		expect(decision.ruleIds).to.deep.equal(['combo']);
	});
});

describe('M9 — empty match strings are rejected (they would match everything)', () => {
	it('rejects empty path prefix/exact/regex', () => {
		expect(validateRule({ ...BASE, id: 'x', match: { path: { prefix: '' } } })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', match: { path: { exact: '' } } })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', match: { path: { regex: '' } } })).to.not.be.empty;
	});
	it('rejects empty header/query values for non-exists ops', () => {
		expect(validateRule({ ...BASE, id: 'x', match: { headers: [{ name: 'h', op: 'contains', value: '' }] } })).to.not.be
			.empty;
		expect(validateRule({ ...BASE, id: 'x', match: { query: [{ name: 'q', op: 'prefix', value: '' }] } })).to.not.be
			.empty;
	});
	it('an empty-prefix rule does not compile into a block-everything matcher', () => {
		const matcher = compileRules([{ ...BASE, id: 'evil', match: { path: { prefix: '' } } }]);
		expect(matcher.ruleCount).to.equal(0);
		expect(matcher.evaluate(makeRequest({ path: '/anything' }))).to.equal(null);
	});
});

describe('M8 — enabled/priority are type-checked', () => {
	it('rejects non-boolean enabled and non-number priority', () => {
		expect(validateRule({ ...BASE, id: 'x', enabled: 'yes', match: { path: { exact: '/a' } } })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', priority: 'high', match: { path: { exact: '/a' } } })).to.not.be.empty;
	});
});
