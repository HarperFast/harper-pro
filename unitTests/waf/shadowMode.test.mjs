/**
 * Unit coverage for wave-2 shadow rules and global mode (waf/matcher.ts evaluate()):
 * - shadow:true rules never enforce but surface a would-block preview (shadowRuleIds);
 * - a real block alongside a shadow rule wins and carries the shadow preview;
 * - global mode 'off' is a pass-through kill switch; 'monitor' downgrades every block to would-block;
 *   'enforce' (and the default) blocks.
 */

import { expect } from 'chai';
import { compileRules } from '#src/waf/matcher';

const BASE = { enabled: true, priority: 0, phase: 'request', action: 'block' };

function makeRequest(overrides = {}) {
	const headers = new Map(Object.entries(overrides.headers ?? {}));
	return {
		ip: '203.0.113.7',
		method: 'GET',
		path: '/x',
		query: undefined,
		getHeader: (name) => headers.get(name.toLowerCase()),
		...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'headers')),
	};
}

describe('WAF shadow rules', () => {
	it('a shadow block rule surfaces a would-block but does not enforce', () => {
		const matcher = compileRules([{ ...BASE, id: 'sh', shadow: true, match: { path: { exact: '/x' } } }]);
		const decision = matcher.evaluate(makeRequest());
		expect(decision.action).to.equal('log'); // pass-through, not a block
		expect(decision.status).to.equal(0);
		expect(decision.ruleIds).to.deep.equal([]); // no real match
		expect(decision.shadowRuleIds).to.deep.equal(['sh']);
	});

	it('a real block alongside a shadow rule blocks and attaches the shadow preview', () => {
		const matcher = compileRules([
			{ ...BASE, id: 'real', priority: 5, match: { path: { exact: '/x' } } },
			{ ...BASE, id: 'sh', priority: 1, shadow: true, match: { path: { exact: '/x' } } },
		]);
		const decision = matcher.evaluate(makeRequest());
		expect(decision.action).to.equal('block');
		expect(decision.ruleIds).to.deep.equal(['real']);
		expect(decision.shadowRuleIds).to.deep.equal(['sh']);
	});

	it('a shadow rule never contributes to the real score total', () => {
		const matcher = compileRules(
			[
				{ ...BASE, id: 'real-s', action: 'score', score: 6, match: { path: { exact: '/x' } } },
				{ ...BASE, id: 'shadow-s', action: 'score', score: 6, shadow: true, match: { path: { exact: '/x' } } },
			],
			{ scoreThreshold: 10 }
		);
		// real 6 < 10 → no real block; shadow accumulates independently (6 < 10 too) → no would-block
		const decision = matcher.evaluate(makeRequest());
		expect(decision === null || decision.action !== 'block').to.equal(true);
	});

	it('shadow score rules cross the threshold independently to a would-block', () => {
		const matcher = compileRules(
			[
				{ ...BASE, id: 's1', action: 'score', score: 6, shadow: true, match: { path: { exact: '/x' } } },
				{ ...BASE, id: 's2', action: 'score', score: 6, shadow: true, match: { method: ['GET'] } },
			],
			{ scoreThreshold: 10 }
		);
		const decision = matcher.evaluate(makeRequest());
		expect(decision.action).to.equal('log');
		expect(decision.shadowRuleIds).to.have.members(['s1', 's2']);
	});
});

describe('WAF global mode', () => {
	const rules = [{ ...BASE, id: 'blocker', match: { path: { exact: '/x' } } }];

	it("mode 'off' is a pass-through kill switch (isEmpty, never blocks)", () => {
		const matcher = compileRules(rules, { mode: 'off' });
		expect(matcher.isEmpty).to.equal(true);
		expect(matcher.evaluate(makeRequest())).to.equal(null);
	});

	it("mode 'monitor' downgrades a matching block to a would-block", () => {
		const matcher = compileRules(rules, { mode: 'monitor' });
		const decision = matcher.evaluate(makeRequest());
		expect(decision.action).to.equal('log');
		expect(decision.shadowRuleIds).to.deep.equal(['blocker']);
	});

	it("mode 'enforce' (and the absent default) blocks", () => {
		expect(compileRules(rules, { mode: 'enforce' }).evaluate(makeRequest()).action).to.equal('block');
		expect(compileRules(rules).evaluate(makeRequest()).action).to.equal('block');
	});

	it("mode 'monitor' still emits log-action output (log is orthogonal to shadow)", () => {
		const matcher = compileRules(
			[
				{ ...BASE, id: 'blocker', priority: 2, match: { path: { exact: '/x' } } },
				{ ...BASE, id: 'watcher', priority: 1, action: 'log', match: { path: { exact: '/x' } } },
			],
			{ mode: 'monitor' }
		);
		const decision = matcher.evaluate(makeRequest());
		// block is downgraded to a would-block preview; the log rule is still logged (not suppressed)
		expect(decision.action).to.equal('log');
		expect(decision.ruleIds).to.deep.equal(['watcher']);
		expect(decision.shadowRuleIds).to.deep.equal(['blocker']);
	});

	it('a shadow:true log rule is still logged (log never suppressed by shadow)', () => {
		const matcher = compileRules([
			{ ...BASE, id: 'sl', action: 'log', shadow: true, match: { path: { exact: '/x' } } },
		]);
		const decision = matcher.evaluate(makeRequest());
		expect(decision.action).to.equal('log');
		expect(decision.ruleIds).to.deep.equal(['sl']);
		expect(decision).to.not.have.property('shadowRuleIds'); // a log rule produces no would-block
	});

	it("mode 'off' still classifies invalid/deferred rules for the summary log", () => {
		const matcher = compileRules(
			[
				{ ...BASE, id: 'bad', match: { path: { regex: '(' } } },
				{ ...BASE, id: 'deferred', action: 'drop', match: { path: { exact: '/y' } } },
			],
			{ mode: 'off' }
		);
		expect(matcher.isEmpty).to.equal(true);
		expect(matcher.invalidRules.has('bad')).to.equal(true);
		expect(matcher.unsupportedRules.has('deferred')).to.equal(true);
	});
});
