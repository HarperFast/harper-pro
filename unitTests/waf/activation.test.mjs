/**
 * Unit coverage for wave-2 activation gating (waf/matcher.ts compileRules nodeIdentity):
 * a rule with an `activation` selector compiles into this node's matcher only when node identity
 * satisfies every present selector (nodes by name, regions by region, tags by intersection). Rules
 * gated out are silently omitted — neither invalid nor unsupported. Absent activation → armed
 * everywhere.
 */

import { expect } from 'chai';
import { compileRules } from '#src/waf/matcher';

const BASE = { enabled: true, priority: 0, phase: 'request', action: 'block' };
const MATCH = { path: { exact: '/x' } };

function makeRequest() {
	return { ip: '203.0.113.7', method: 'GET', path: '/x', getHeader: () => undefined };
}

function armed(rule, nodeIdentity) {
	const matcher = compileRules([rule], { nodeIdentity });
	// gated-out rules are neither invalid nor unsupported
	expect(matcher.invalidRules.size).to.equal(0);
	expect(matcher.unsupportedRules.size).to.equal(0);
	return matcher.ruleCount === 1 && matcher.evaluate(makeRequest()) !== null;
}

describe('WAF activation gating', () => {
	it('arms a rule everywhere when activation is absent', () => {
		expect(armed({ ...BASE, id: 'r', match: MATCH }, { name: 'anything' })).to.equal(true);
		expect(armed({ ...BASE, id: 'r', match: MATCH }, {})).to.equal(true);
	});

	it('gates by node name', () => {
		const rule = { ...BASE, id: 'r', activation: { nodes: ['node-a'] }, match: MATCH };
		expect(armed(rule, { name: 'node-a' })).to.equal(true);
		expect(armed(rule, { name: 'node-b' })).to.equal(false);
		expect(armed(rule, {})).to.equal(false); // no name → can't satisfy a nodes selector
	});

	it('gates by region', () => {
		const rule = { ...BASE, id: 'r', activation: { regions: ['us-east'] }, match: MATCH };
		expect(armed(rule, { name: 'n', region: 'us-east' })).to.equal(true);
		expect(armed(rule, { name: 'n', region: 'eu-west' })).to.equal(false);
	});

	it('gates by tag intersection', () => {
		const rule = { ...BASE, id: 'r', activation: { tags: ['edge', 'canary'] }, match: MATCH };
		expect(armed(rule, { name: 'n', tags: ['edge'] })).to.equal(true); // intersects on 'edge'
		expect(armed(rule, { name: 'n', tags: ['core'] })).to.equal(false);
		expect(armed(rule, { name: 'n', tags: [] })).to.equal(false);
		expect(armed(rule, { name: 'n' })).to.equal(false); // no tags → no intersection
	});

	it('requires ALL present selectors to match (AND semantics)', () => {
		const rule = { ...BASE, id: 'r', activation: { nodes: ['n1'], regions: ['us'], tags: ['edge'] }, match: MATCH };
		expect(armed(rule, { name: 'n1', region: 'us', tags: ['edge'] })).to.equal(true);
		expect(armed(rule, { name: 'n1', region: 'us', tags: ['core'] })).to.equal(false); // tag fails
		expect(armed(rule, { name: 'n2', region: 'us', tags: ['edge'] })).to.equal(false); // node fails
	});
});
