/**
 * Unit coverage for canonicalizePath (waf/matcher.ts) — the request/rule path normalizer that
 * puts requests and rule literals into one matching space so encoding/traversal evasions can't
 * slip past a path rule. Covers each transform (bounded percent-decode, dot-segment resolution,
 * duplicate-slash collapse), double-encoding, malformed-escape safety, and the deliberate
 * non-case-folding exclusion.
 */

import { expect } from 'chai';
import { canonicalizePath } from '#src/waf/matcher';

describe('WAF canonicalizePath', () => {
	it('percent-decodes a single pass', () => {
		expect(canonicalizePath('/admin%2Fsecret')).to.equal('/admin/secret');
		expect(canonicalizePath('/a%2eb')).to.equal('/a.b');
	});
	it('decodes double-encoding within the bounded pass count', () => {
		// %2561 -> %61 -> a
		expect(canonicalizePath('/%2561dmin')).to.equal('/admin');
		// %252e%252e -> %2e%2e -> .. (then dot-segment resolution)
		expect(canonicalizePath('/x/%252e%252e/y')).to.equal('/y');
	});
	it('stops at 2 decode passes (does not decode triple-encoding fully)', () => {
		// %25252e -> %252e -> %2e  (after 2 passes it is still %2e, not '.')
		expect(canonicalizePath('/%25252e')).to.equal('/%2e');
	});
	it('resolves . and .. dot segments (RFC 3986 §5.2.4)', () => {
		expect(canonicalizePath('/a/./b')).to.equal('/a/b');
		expect(canonicalizePath('/a/b/../c')).to.equal('/a/c');
		expect(canonicalizePath('/./admin')).to.equal('/admin');
		expect(canonicalizePath('/admin/../admin')).to.equal('/admin');
	});
	it('does not climb above the root on excess ..', () => {
		expect(canonicalizePath('/../../admin')).to.equal('/admin');
		expect(canonicalizePath('/a/../../b')).to.equal('/b');
	});
	it('collapses runs of slashes into one, preserving the leading slash', () => {
		expect(canonicalizePath('//admin')).to.equal('/admin');
		expect(canonicalizePath('/a///b//c')).to.equal('/a/b/c');
		expect(canonicalizePath('///')).to.equal('/');
	});
	it('combines decode + dot-segment + slash-collapse on a compound evasion', () => {
		expect(canonicalizePath('//admin%2F..%2Fadmin')).to.equal('/admin');
		expect(canonicalizePath('/api%2F%2e%2e%2Finternal')).to.equal('/internal');
	});
	it('never throws on a malformed percent-escape; keeps the last good value', () => {
		expect(() => canonicalizePath('/%')).to.not.throw();
		expect(canonicalizePath('/%')).to.equal('/%');
		expect(() => canonicalizePath('/%zz')).to.not.throw();
		expect(canonicalizePath('/%zz')).to.equal('/%zz');
		// a valid decode that then exposes a malformed escape: first pass yields '/%', which stays
		expect(canonicalizePath('/%25')).to.equal('/%');
	});
	it('preserves case (deliberate non-case-folding exclusion)', () => {
		expect(canonicalizePath('/Admin/SECRET')).to.equal('/Admin/SECRET');
	});
	it('leaves an already-canonical path unchanged', () => {
		expect(canonicalizePath('/api/products/42')).to.equal('/api/products/42');
	});
});
