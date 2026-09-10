/**
 * Unit coverage for compileSafeRegex (security/safeRegex.ts) — the RE2-backed compiler for
 * regex whose source is operator- or attacker-influenced. This is the safe substrate that the WAF
 * (and any future untrusted-regex call site) compiles through instead of `new RegExp(...)`.
 *
 * The suite pins the two properties that justify the native dependency: (1) linear-time matching,
 * so a catastrophic-backtracking pattern that hangs `RegExp` returns immediately here (ReDoS
 * immunity), and (2) the deliberate contract that RE2-unsupported features (backreferences,
 * lookaround) are reported as compile errors rather than silently downgraded. Loading the module
 * at all also exercises that the re2 native binary resolves on the CI matrix.
 */

import { expect } from 'chai';
import { compileSafeRegex } from '#src/security/safeRegex';

describe('compileSafeRegex', () => {
	it('compiles a valid pattern into a working matcher', () => {
		const errors = [];
		const re = compileSafeRegex('^/api/', 'test', errors);
		expect(errors).to.deep.equal([]);
		expect(re).to.not.equal(undefined);
		expect(re.test('/api/users')).to.equal(true);
		expect(re.test('/public')).to.equal(false);
	});

	it('is immune to catastrophic backtracking (ReDoS)', () => {
		const errors = [];
		// `(a+)+$` against a long non-matching input is the canonical ReDoS trigger: the built-in
		// RegExp explores exponentially many partitions and hangs for seconds-to-minutes. RE2
		// evaluates it in linear time, so this must complete near-instantly.
		const re = compileSafeRegex('(a+)+$', 'redos', errors);
		expect(errors).to.deep.equal([]);
		const input = 'a'.repeat(50_000) + '!';
		const start = process.hrtime.bigint();
		const matched = re.test(input);
		const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
		expect(matched).to.equal(false);
		// Generous ceiling: linear-time RE2 finishes in well under a millisecond; RegExp would not
		// return within the test timeout. The bound only needs to distinguish linear from explosive.
		expect(elapsedMs).to.be.lessThan(250);
	});

	it('rejects backreferences (unsupported in linear-time RE2) as a compile error', () => {
		const errors = [];
		const re = compileSafeRegex('(a)\\1', 'backref', errors);
		expect(re).to.equal(undefined);
		expect(errors).to.have.lengthOf(1);
		expect(errors[0]).to.include('backref');
	});

	it('rejects lookaround as a compile error', () => {
		const errors = [];
		const re = compileSafeRegex('foo(?=bar)', 'lookahead', errors);
		expect(re).to.equal(undefined);
		expect(errors).to.have.lengthOf(1);
		expect(errors[0]).to.include('lookahead');
	});

	it('rejects invalid regex syntax as a compile error', () => {
		const errors = [];
		const re = compileSafeRegex('(unclosed', 'syntax', errors);
		expect(re).to.equal(undefined);
		expect(errors).to.have.lengthOf(1);
		expect(errors[0]).to.include('syntax');
	});
});
