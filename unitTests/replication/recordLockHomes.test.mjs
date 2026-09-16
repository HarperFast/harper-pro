/**
 * The pure decision logic behind the operator-agreed home map (harper-pro#825): canonicalization
 * and digest determinism, and the stage/activate state machine as a function of the row's current
 * state — checked without a real table, per RECORD_LOCK_HOMES_DESIGN.md's testing section (the
 * storage I/O around these functions is exercised by the cluster integration suite instead).
 */
import assert from 'node:assert';
import {
	canonicalizeHomes,
	digestOf,
	planActivate,
	planProposal,
	planStage,
	validateGenerationInput,
} from '#src/replication/recordLockHomes';

describe('canonicalizeHomes', () => {
	it('sorts and dedupes', () => {
		assert.deepStrictEqual(canonicalizeHomes(['b', 'a', 'b', 'a']), ['a', 'b']);
	});
});

describe('digestOf', () => {
	it('is deterministic for the same generation and set', () => {
		assert.strictEqual(digestOf(1, ['a', 'b']), digestOf(1, ['a', 'b']));
	});
	it('does not collide across a delimiter-ambiguous split — the gap an earlier draft had', () => {
		// ['A','B'] and ['A\0B'] would hash identically under a NUL-delimiter-joined scheme.
		assert.notStrictEqual(digestOf(1, ['A', 'B']), digestOf(1, ['A\0B']));
	});
	it('changes with the generation, independent of the home set', () => {
		assert.notStrictEqual(digestOf(1, ['a']), digestOf(2, ['a']));
	});
	it('changes with the home set, independent of the generation', () => {
		assert.notStrictEqual(digestOf(1, ['a']), digestOf(1, ['a', 'b']));
	});
	it("is order-independent only after canonicalization — the caller's job, not this function's", () => {
		// digestOf itself is positional; canonicalizeHomes is what makes operator-typed order irrelevant.
		assert.strictEqual(digestOf(1, canonicalizeHomes(['b', 'a'])), digestOf(1, canonicalizeHomes(['a', 'b'])));
	});
});

describe('validateGenerationInput', () => {
	it('accepts a positive integer generation and a bounded, non-empty homes array', () => {
		assert.doesNotThrow(() => validateGenerationInput(1, ['a']));
	});
	it('rejects a non-positive, non-integer, or unsafe generation', () => {
		for (const bad of [0, -1, 1.5, NaN, Infinity, '1'])
			assert.throws(() => validateGenerationInput(bad, ['a']), /generation must be a positive integer/);
	});
	it('rejects an empty, oversized, or malformed homes array', () => {
		assert.throws(() => validateGenerationInput(1, []), /non-empty array/);
		assert.throws(() => validateGenerationInput(1, 'a'), /non-empty array/);
		assert.throws(
			() =>
				validateGenerationInput(
					1,
					Array.from({ length: 257 }, (_, i) => `n${i}`)
				),
			/non-empty array/
		);
	});
	it('rejects an empty or oversized node name', () => {
		assert.throws(() => validateGenerationInput(1, ['']), /bounded node name/);
		assert.throws(() => validateGenerationInput(1, ['x'.repeat(257)]), /bounded node name/);
	});
});

describe('planStage', () => {
	const digest1 = digestOf(1, ['a', 'b']);
	const digest2 = digestOf(2, ['a', 'c']);
	const T = 1_000_000;

	it('stages the first generation for a database with no row yet, and records stagedAt', () => {
		const plan = planStage(undefined, 'db', 1, ['a', 'b'], digest1, T);
		assert.strictEqual(plan.action, 'write');
		assert.deepStrictEqual(plan.row.staged, { generation: 1, homes: ['a', 'b'], digest: digest1, stagedAt: T });
		assert.strictEqual(plan.row.active, undefined, 'no active generation to retract yet');
		assert.strictEqual(plan.row.highestActedOn, 1);
	});

	it('atomically retracts active in the same plan — no state where both are set', () => {
		const existing = {
			database: 'db',
			active: { generation: 1, homes: ['a'], digest: 'd1' },
			highestActedOn: 1,
			fenced: [],
		};
		const plan = planStage(existing, 'db', 2, ['a', 'c'], digest2, T);
		assert.strictEqual(plan.action, 'write');
		assert.strictEqual(plan.row.active, undefined, 'staging retracts active in the same write');
		assert.deepStrictEqual(plan.row.staged, { generation: 2, homes: ['a', 'c'], digest: digest2, stagedAt: T });
	});

	it('is idempotent for an identical re-stage — the original stagedAt is not the identity, digest and generation are', () => {
		const existing = {
			database: 'db',
			staged: { generation: 2, homes: ['a', 'c'], digest: digest2, stagedAt: T - 500 },
			highestActedOn: 1,
			fenced: [],
		};
		const plan = planStage(existing, 'db', 2, ['a', 'c'], digest2, T);
		assert.strictEqual(plan.action, 'noop');
		assert.deepStrictEqual(
			plan.staged,
			existing.staged,
			'returns the ORIGINAL staged entry, stagedAt included — a retry does not restart the drain clock'
		);
	});

	it('rejects a re-stage of the same generation with a different home set', () => {
		const existing = {
			database: 'db',
			staged: { generation: 2, homes: ['a', 'c'], digest: digest2 },
			highestActedOn: 1,
			fenced: [],
		};
		const plan = planStage(existing, 'db', 2, ['a', 'd'], digestOf(2, ['a', 'd']));
		assert.strictEqual(plan.action, 'reject');
		assert.match(plan.reason, /already staged with a different home set/);
	});

	it('refuses a generation at or below the floor — active, staged, or highestActedOn, whichever is highest', () => {
		const existing = { database: 'db', highestActedOn: 5, fenced: [] };
		const plan = planStage(existing, 'db', 5, ['a'], digestOf(5, ['a']));
		assert.strictEqual(plan.action, 'reject');
		assert.match(plan.reason, /not greater than 5/);
	});

	it('refuses a delayed stale stage after a newer one — highestActedOn, not just active/staged', () => {
		// A delayed retry for g+1 arriving after g+2 was already staged must not clobber it.
		const existing = {
			database: 'db',
			staged: { generation: 3, homes: ['a'], digest: digestOf(3, ['a']) },
			highestActedOn: 3,
			fenced: [],
		};
		const plan = planStage(existing, 'db', 2, ['a', 'b'], digestOf(2, ['a', 'b']));
		assert.strictEqual(plan.action, 'reject');
	});
});

describe('planActivate', () => {
	const digest1 = digestOf(1, ['a', 'b']);
	const T = 1_000_000;
	const MIN_DRAIN = 2_000;

	it('refuses activation with no staged generation at all', () => {
		const plan = planActivate(undefined, 'db', 1, digest1);
		assert.strictEqual(plan.action, 'reject');
		assert.match(plan.reason, /no matching staged generation/);
	});

	it('refuses activation of a generation that was not staged with this exact digest', () => {
		const existing = {
			database: 'db',
			staged: { generation: 1, homes: ['a', 'b'], digest: digest1, stagedAt: 0 },
			highestActedOn: 1,
			fenced: [],
		};
		const plan = planActivate(existing, 'db', 1, digestOf(1, ['a', 'c']), T, MIN_DRAIN);
		assert.strictEqual(plan.action, 'reject');
	});

	it('promotes staged to active, clearing staged, once past the backstop', () => {
		const existing = {
			database: 'db',
			staged: { generation: 1, homes: ['a', 'b'], digest: digest1, stagedAt: T - MIN_DRAIN },
			highestActedOn: 1,
			fenced: [],
		};
		const plan = planActivate(existing, 'db', 1, digest1, T, MIN_DRAIN);
		assert.strictEqual(plan.action, 'write');
		assert.deepStrictEqual(plan.row.active, existing.staged);
		assert.strictEqual(plan.row.staged, undefined);
	});

	it('is idempotent for a generation already active', () => {
		const existing = {
			database: 'db',
			active: { generation: 1, homes: ['a', 'b'], digest: digest1 },
			highestActedOn: 1,
			fenced: [],
		};
		const plan = planActivate(existing, 'db', 1, digest1, T, MIN_DRAIN);
		assert.strictEqual(plan.action, 'noop');
		assert.deepStrictEqual(plan.active, existing.active);
	});

	it('advances highestActedOn on activation, never regressing it', () => {
		const existing = {
			database: 'db',
			staged: { generation: 4, homes: ['a'], digest: digestOf(4, ['a']), stagedAt: T - MIN_DRAIN },
			highestActedOn: 9,
			fenced: [],
		};
		const plan = planActivate(existing, 'db', 4, digestOf(4, ['a']), T, MIN_DRAIN);
		assert.strictEqual(plan.action, 'write');
		assert.strictEqual(plan.row.highestActedOn, 9, 'never regresses below a higher floor');
	});

	it('refuses an activation that arrives implausibly soon after staging — the backstop, not the real safety mechanism', () => {
		const existing = {
			database: 'db',
			staged: { generation: 1, homes: ['a', 'b'], digest: digest1, stagedAt: T },
			highestActedOn: 0,
			fenced: [],
		};
		const tooSoon = planActivate(existing, 'db', 1, digest1, T + MIN_DRAIN - 1, MIN_DRAIN);
		assert.strictEqual(tooSoon.action, 'reject');
		assert.match(tooSoon.reason, /implausibly soon/);
		const justPast = planActivate(existing, 'db', 1, digest1, T + MIN_DRAIN, MIN_DRAIN);
		assert.strictEqual(justPast.action, 'write');
	});

	it('does not apply the backstop to a staged entry with no stagedAt (defensive only, should not occur in practice)', () => {
		const existing = {
			database: 'db',
			staged: { generation: 1, homes: ['a', 'b'], digest: digest1 },
			highestActedOn: 0,
			fenced: [],
		};
		const plan = planActivate(existing, 'db', 1, digest1, T, MIN_DRAIN);
		assert.strictEqual(plan.action, 'write');
	});
});

describe('planProposal', () => {
	const row = (over = {}) => ({ database: 'data', highestActedOn: 0, fenced: [], ...over });

	it('includes this node, sorts and dedupes, and starts at generation 1 on an untouched row', () => {
		const plan = planProposal('b', ['c', 'a', 'c'], undefined, 'data');
		assert.deepStrictEqual(plan.homes, ['a', 'b', 'c']);
		assert.strictEqual(plan.generation, 1);
		assert.strictEqual(plan.digest, digestOf(1, ['a', 'b', 'c']));
	});

	it('proposes one past the floor, so it serves a topology change too', () => {
		assert.strictEqual(planProposal('a', ['b'], row({ highestActedOn: 4 }), 'data').generation, 5);
		assert.strictEqual(
			planProposal('a', ['b'], row({ active: { generation: 7, homes: ['a'], digest: 'x' }, highestActedOn: 7 }), 'data')
				.generation,
			8
		);
		assert.strictEqual(
			planProposal('a', ['b'], row({ staged: { generation: 9, homes: ['a'], digest: 'x' }, highestActedOn: 9 }), 'data')
				.generation,
			10
		);
	});

	it("always warns that one node's view is not agreement", () => {
		const plan = planProposal('a', ['b'], undefined, 'data');
		assert.ok(
			plan.warnings.some((warning) => /not agreement/.test(warning)),
			plan.warnings.join(' | ')
		);
	});

	it('warns when this node sees no peers, since that would home every key on itself', () => {
		const alone = planProposal('a', [], undefined, 'data');
		assert.deepStrictEqual(alone.homes, ['a']);
		assert.ok(alone.warnings.some((warning) => /no replicating peers/.test(warning)));
		assert.ok(!planProposal('a', ['b'], undefined, 'data').warnings.some((w) => /no replicating peers/.test(w)));
	});

	it('warns when a generation is already staged here', () => {
		const staged = planProposal('a', ['b'], row({ staged: { generation: 3, homes: ['a'], digest: 'x' } }), 'data');
		assert.ok(staged.warnings.some((warning) => /already staged/.test(warning)));
	});

	it('quiesce is the union with the current ring, so a shrink still drains the node leaving', () => {
		const shrink = planProposal(
			'a',
			['b'],
			row({ active: { generation: 2, homes: ['a', 'b', 'c'], digest: 'x' }, highestActedOn: 2 }),
			'data'
		);
		assert.deepStrictEqual(shrink.homes, ['a', 'b']);
		assert.deepStrictEqual(shrink.quiesce, ['a', 'b', 'c'], 'c is leaving but must still be staged and drained');
		assert.ok(
			shrink.warnings.some((warning) => /^c leave(s)? the ring|c leave the ring/.test(warning)),
			shrink.warnings.join(' | ')
		);
	});

	it('quiesce equals homes when nothing is leaving, and covers a staged ring too', () => {
		assert.deepStrictEqual(planProposal('a', ['b'], undefined, 'data').quiesce, ['a', 'b']);
		const staged = planProposal('a', ['b'], row({ staged: { generation: 3, homes: ['a', 'z'], digest: 'x' } }), 'data');
		assert.deepStrictEqual(staged.quiesce, ['a', 'b', 'z']);
	});

	it('rejects a set larger than the bound, through the shared validator', () => {
		const many = Array.from({ length: 300 }, (_, i) => `n${i}`);
		assert.throws(() => planProposal('a', many, undefined, 'data'), /homes must be/);
	});
});
