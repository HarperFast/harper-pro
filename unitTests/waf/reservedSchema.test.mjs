/**
 * Unit coverage for the wave-2 reserved rule-schema slots (waf/rules.ts) and the compiler's
 * reserved-but-unimplemented handling (waf/matcher.ts): shape validation of every new field, and
 * the DEFERRED (unsupportedRules, distinct from invalidRules) classification of valid-but-
 * unenforceable rules.
 */

import { expect } from 'chai';
import { validateRule } from '#src/waf/rules';
import { compileRules } from '#src/waf/matcher';

const BASE = { enabled: true, priority: 0, phase: 'request', action: 'block' };
const IP_MATCH = { ip: '10.0.0.1' };

describe('WAF reserved schema — validation', () => {
	it('accepts well-formed new match slots', () => {
		expect(validateRule({ ...BASE, id: 'ja4', match: { ja4: 't13d1516h2_...' } })).to.deep.equal([]);
		expect(validateRule({ ...BASE, id: 'ja4-arr', match: { ja4: ['a', 'b'] } })).to.deep.equal([]);
		expect(validateRule({ ...BASE, id: 'ja4h', match: { ja4h: 'ge11cn...' } })).to.deep.equal([]);
		expect(validateRule({ ...BASE, id: 'model', match: { model: { name: 'anomaly', threshold: 0.9 } } })).to.deep.equal(
			[]
		);
		expect(
			validateRule({ ...BASE, id: 'agent', match: { agent: { webBotAuth: 'verified', identity: 'gptbot' } } })
		).to.deep.equal([]);
	});

	it('rejects malformed new match slots', () => {
		expect(validateRule({ ...BASE, id: 'x', match: { ja4: '' } })).to.not.be.empty; // empty string
		expect(validateRule({ ...BASE, id: 'x', match: { ja4: 5 } })).to.not.be.empty; // wrong type
		expect(validateRule({ ...BASE, id: 'x', match: { model: 'nope' } })).to.not.be.empty; // not object
		expect(validateRule({ ...BASE, id: 'x', match: { model: { threshold: 'high' } } })).to.not.be.empty; // bad type
		expect(validateRule({ ...BASE, id: 'x', match: { agent: { webBotAuth: 'maybe' } } })).to.not.be.empty; // bad enum
		expect(validateRule({ ...BASE, id: 'x', match: { agent: { identity: 7 } } })).to.not.be.empty; // bad identity
	});

	it('accepts the widened action union (challenge/serve/drop are valid VALUES)', () => {
		for (const action of ['challenge', 'serve', 'drop']) {
			expect(validateRule({ ...BASE, id: 'a', action, match: IP_MATCH }), action).to.deep.equal([]);
		}
	});

	it('accepts well-formed new top-level slots', () => {
		expect(validateRule({ ...BASE, id: 's', shadow: true, match: IP_MATCH })).to.deep.equal([]);
		expect(
			validateRule({
				...BASE,
				id: 'act',
				activation: { nodes: ['n1'], regions: ['us'], tags: ['edge'] },
				match: IP_MATCH,
			})
		).to.deep.equal([]);
		expect(
			validateRule({
				...BASE,
				id: 'sc',
				scope: { clusters: ['c'], applications: ['a'], tenants: ['t'] },
				match: IP_MATCH,
			})
		).to.deep.equal([]);
		expect(
			validateRule({
				...BASE,
				id: 'pv',
				provenance: { origin: 'managed-feed', approver: 'kris', source: 'feed-x' },
				match: IP_MATCH,
			})
		).to.deep.equal([]);
		expect(
			validateRule({
				...BASE,
				id: 'rl',
				rateLimit: { key: ['ip', 'user'], limit: 100, windowMs: 60000 },
				match: IP_MATCH,
			})
		).to.deep.equal([]);
	});

	it('rejects malformed new top-level slots', () => {
		expect(validateRule({ ...BASE, id: 'x', shadow: 'yes', match: IP_MATCH })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', activation: { nodes: 'n1' }, match: IP_MATCH })).to.not.be.empty; // not array
		expect(validateRule({ ...BASE, id: 'x', activation: [], match: IP_MATCH })).to.not.be.empty; // not object
		expect(validateRule({ ...BASE, id: 'x', scope: { clusters: [5] }, match: IP_MATCH })).to.not.be.empty; // bad element
		expect(validateRule({ ...BASE, id: 'x', provenance: { origin: 'robot' }, match: IP_MATCH })).to.not.be.empty; // bad enum
		expect(validateRule({ ...BASE, id: 'x', rateLimit: { key: ['country'] }, match: IP_MATCH })).to.not.be.empty; // bad key
		expect(validateRule({ ...BASE, id: 'x', rateLimit: { limit: 'ten' }, match: IP_MATCH })).to.not.be.empty; // bad type
	});

	it('rejects an empty activation selector array (would silently disable the rule on every node)', () => {
		// activation GATES compilation: an empty nodes/regions/tags can never be satisfied, so the rule
		// would be a silent cluster-wide no-op — reject at validation instead (like match.ip/headers/query).
		expect(validateRule({ ...BASE, id: 'x', activation: { nodes: [] }, match: IP_MATCH })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', activation: { regions: [] }, match: IP_MATCH })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', activation: { tags: [] }, match: IP_MATCH })).to.not.be.empty;
		// scope is descriptive-only (does not gate), so an empty scope array stays allowed
		expect(validateRule({ ...BASE, id: 'ok', scope: { clusters: [] }, match: IP_MATCH })).to.deep.equal([]);
	});

	it('rejects non-finite / non-positive reserved numeric fields', () => {
		expect(validateRule({ ...BASE, id: 'x', rateLimit: { limit: NaN }, match: IP_MATCH })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', rateLimit: { limit: 0 }, match: IP_MATCH })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', rateLimit: { windowMs: -1 }, match: IP_MATCH })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', rateLimit: { windowMs: Infinity }, match: IP_MATCH })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', match: { model: { threshold: Infinity } } })).to.not.be.empty;
	});

	it('rejects a blockStatus outside the 4xx/5xx range (a block must not read as success)', () => {
		expect(validateRule({ ...BASE, id: 'x', blockStatus: 200, match: IP_MATCH })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', blockStatus: 302, match: IP_MATCH })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'x', blockStatus: 600, match: IP_MATCH })).to.not.be.empty;
		expect(validateRule({ ...BASE, id: 'ok', blockStatus: 503, match: IP_MATCH })).to.deep.equal([]);
	});
});

describe('WAF reserved schema — compiler deferral (decision a)', () => {
	it('defers a deferred-action rule to unsupportedRules (not invalidRules, not in matcher)', () => {
		const unsupported = [];
		const invalid = [];
		const matcher = compileRules([{ ...BASE, id: 'drop-rule', action: 'drop', match: IP_MATCH }], {
			onUnsupportedRule: (id, reasons) => unsupported.push([id, reasons]),
			onInvalidRule: (id) => invalid.push(id),
		});
		expect(matcher.ruleCount).to.equal(0);
		expect(matcher.unsupportedRules.has('drop-rule')).to.equal(true);
		expect(matcher.invalidRules.has('drop-rule')).to.equal(false);
		expect(unsupported).to.have.length(1);
		expect(unsupported[0][1][0]).to.include("action 'drop'");
		expect(invalid).to.be.empty;
	});

	it('defers ja4/ja4h/model/agent match rules', () => {
		for (const match of [{ ja4: 'x' }, { ja4h: 'x' }, { model: { name: 'm' } }, { agent: { webBotAuth: 'any' } }]) {
			const key = Object.keys(match)[0];
			const matcher = compileRules([{ ...BASE, id: key, match }]);
			expect(matcher.ruleCount, key).to.equal(0);
			expect(matcher.unsupportedRules.has(key), key).to.equal(true);
			expect(matcher.invalidRules.has(key), key).to.equal(false);
		}
	});

	it('defers a rateLimit rule (even with an otherwise-enforceable match)', () => {
		const matcher = compileRules([
			{ ...BASE, id: 'rl', rateLimit: { key: ['ip'], limit: 5, windowMs: 1000 }, match: IP_MATCH },
		]);
		expect(matcher.ruleCount).to.equal(0);
		expect(matcher.unsupportedRules.has('rl')).to.equal(true);
	});

	it('compiles + enforces a scope/provenance rule normally (reserved metadata, no deferral)', () => {
		const matcher = compileRules([
			{
				...BASE,
				id: 'meta',
				scope: { clusters: ['c'], tenants: ['t'] },
				provenance: { origin: 'agent-proposed' },
				match: { path: { exact: '/x' } },
			},
		]);
		expect(matcher.ruleCount).to.equal(1);
		expect(matcher.unsupportedRules.size).to.equal(0);
		const decision = matcher.evaluate({ ip: '1.1.1.1', method: 'GET', path: '/x', getHeader: () => undefined });
		expect(decision.action).to.equal('block');
		expect(decision.ruleIds).to.deep.equal(['meta']);
	});
});
