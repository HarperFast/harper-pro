/**
 * Unit coverage for per-rule WAF telemetry (waf/matcher.ts): hit counters + last-matched, kept
 * in a module-level map keyed by rule id so counters survive the matcher reference swap on every
 * recompile. Covers: matched rules increment (any action), non-matched rules stay absent, and the
 * counter keeps climbing for the same id across a recompile.
 */

import { expect } from 'chai';
import { compileRules, getRuleStats, resetRuleStats, pruneRuleStats } from '#src/waf/matcher';

const BASE = { enabled: true, priority: 0, phase: 'request', action: 'block' };

function makeRequest(overrides = {}) {
	return {
		ip: '203.0.113.7',
		method: 'GET',
		path: '/api/products/42',
		query: undefined,
		getHeader: () => undefined,
		...overrides,
	};
}

describe('WAF per-rule telemetry', () => {
	beforeEach(() => resetRuleStats());

	it('increments hitCount and sets lastMatched for matched rules, of any action', () => {
		const before = Date.now();
		const matcher = compileRules([
			{ ...BASE, id: 'blk', action: 'block', match: { path: { exact: '/admin' } } },
			{ ...BASE, id: 'lg', action: 'log', match: { path: { prefix: '/internal/' } } },
			{ ...BASE, id: 'never', match: { path: { exact: '/nope' } } },
		]);
		matcher.evaluate(makeRequest({ path: '/admin' }));
		matcher.evaluate(makeRequest({ path: '/admin' }));
		matcher.evaluate(makeRequest({ path: '/internal/x' }));

		const stats = getRuleStats();
		expect(stats.get('blk').hitCount).to.equal(2);
		expect(stats.get('blk').lastMatched).to.be.at.least(before);
		expect(stats.get('lg').hitCount).to.equal(1);
		// a rule that never matched has no entry
		expect(stats.has('never')).to.equal(false);
	});

	it('counts a sub-threshold score-rule match as a hit even without a decision', () => {
		const matcher = compileRules(
			[{ ...BASE, id: 'sc', action: 'score', score: 2, match: { path: { prefix: '/s/' } } }],
			{ scoreThreshold: 10 }
		);
		// score 2 < 10 → evaluate returns null, but the rule still matched
		expect(matcher.evaluate(makeRequest({ path: '/s/x' }))).to.equal(null);
		expect(getRuleStats().get('sc').hitCount).to.equal(1);
	});

	it('does not touch stats on the no-candidate path', () => {
		const matcher = compileRules([{ ...BASE, id: 'x', match: { path: { exact: '/admin' } } }]);
		matcher.evaluate(makeRequest({ path: '/somewhere-else' }));
		expect(getRuleStats().size).to.equal(0);
	});

	it('persists counters across a recompile (same id keeps climbing)', () => {
		const first = compileRules([{ ...BASE, id: 'dup', match: { path: { exact: '/admin' } } }]);
		first.evaluate(makeRequest({ path: '/admin' }));
		expect(getRuleStats().get('dup').hitCount).to.equal(1);

		// simulate a rule-change recompile: a brand-new matcher for the same rule id
		const second = compileRules([{ ...BASE, id: 'dup', match: { path: { exact: '/admin' } } }]);
		second.evaluate(makeRequest({ path: '/admin' }));
		expect(getRuleStats().get('dup').hitCount).to.equal(2);
	});

	it('counts a shadow (would-block) match as a hit — hitCount is a match counter, not a block counter', () => {
		const matcher = compileRules([{ ...BASE, id: 'sh', shadow: true, match: { path: { exact: '/admin' } } }]);
		// shadow rule never enforces, but the match still counts
		matcher.evaluate(makeRequest({ path: '/admin' }));
		expect(getRuleStats().get('sh').hitCount).to.equal(1);
	});

	it('counts a monitor-mode match as a hit', () => {
		const matcher = compileRules([{ ...BASE, id: 'mon', match: { path: { exact: '/admin' } } }], { mode: 'monitor' });
		matcher.evaluate(makeRequest({ path: '/admin' }));
		expect(getRuleStats().get('mon').hitCount).to.equal(1);
	});

	it('pruneRuleStats drops telemetry for ids no longer in the rule set (dropped rule + id reuse)', () => {
		const matcher = compileRules([
			{ ...BASE, id: 'keep', match: { path: { exact: '/admin' } } },
			{ ...BASE, id: 'gone', match: { path: { exact: '/gone' } } },
		]);
		matcher.evaluate(makeRequest({ path: '/admin' }));
		matcher.evaluate(makeRequest({ path: '/gone' }));
		expect(getRuleStats().get('keep').hitCount).to.equal(1);
		expect(getRuleStats().get('gone').hitCount).to.equal(1);

		// operator drops 'gone': the next recompile's live-id set no longer contains it
		pruneRuleStats(new Set(['keep']));
		expect(getRuleStats().has('gone')).to.equal(false); // stale counter removed
		expect(getRuleStats().get('keep').hitCount).to.equal(1); // surviving rule untouched
	});

	it('exposes the same stats map via matcher.getStats()', () => {
		const matcher = compileRules([{ ...BASE, id: 'g', match: { path: { exact: '/admin' } } }]);
		matcher.evaluate(makeRequest({ path: '/admin' }));
		expect(matcher.getStats()).to.equal(getRuleStats());
		expect(matcher.getStats().get('g').hitCount).to.equal(1);
	});
});
