import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AffinePermutation, ZipfSampler, makeKeyIndexChooser, parseSkew, seededUniform } from './keys.mts';

function expectedZipf(n: number, s: number): number[] {
	const weights = Array.from({ length: n }, (_, i) => Math.pow(i + 1, -s));
	const total = weights.reduce((a, b) => a + b, 0);
	return weights.map((w) => w / total);
}

describe('ZipfSampler', () => {
	for (const s of [0.8, 1.0, 1.2]) {
		it(`matches the Zipf(${s}) probability mass over 1000 keys`, () => {
			const n = 1000;
			const draws = 400_000;
			const sampler = new ZipfSampler(n, s);
			const random = seededUniform(42 + s * 10);
			const counts = Array.from({ length: n }, () => 0);
			for (let i = 0; i < draws; i++) {
				const k = sampler.sample(random);
				assert.ok(k >= 1 && k <= n, `rank ${k} out of range`);
				counts[k - 1]++;
			}
			const expected = expectedZipf(n, s);
			// Chi-square over n - 1 = 999 degrees of freedom: mean 999, sd ~45; 1250 is ~5.6 sd out.
			let chiSquare = 0;
			for (let i = 0; i < n; i++) chiSquare += (counts[i] - expected[i] * draws) ** 2 / (expected[i] * draws);
			assert.ok(chiSquare < 1250, `chi-square ${chiSquare}`);
			for (let i = 0; i < 5; i++) {
				const relative = Math.abs(counts[i] / draws - expected[i]) / expected[i];
				assert.ok(relative < 0.03, `rank ${i + 1}: observed ${counts[i] / draws}, expected ${expected[i]}`);
			}
		});
	}

	it('handles a single key and exponents near 1', () => {
		const random = seededUniform(7);
		assert.equal(new ZipfSampler(1, 1).sample(random), 1);
		for (const s of [1 - 1e-9, 1 + 1e-9]) {
			const sampler = new ZipfSampler(100, s);
			for (let i = 0; i < 1000; i++) {
				const k = sampler.sample(random);
				assert.ok(Number.isInteger(k) && k >= 1 && k <= 100);
			}
		}
	});

	it('rejects invalid parameters', () => {
		assert.throws(() => new ZipfSampler(0, 1), RangeError);
		assert.throws(() => new ZipfSampler(10, 0), RangeError);
		assert.throws(() => new ZipfSampler(1.5, 1), RangeError);
	});
});

describe('AffinePermutation', () => {
	for (const n of [1, 2, 3, 10, 1000, 1024, 65_536, 99_991]) {
		it(`is a bijection on [0, ${n})`, () => {
			const permutation = new AffinePermutation(n);
			const seen = new Uint8Array(n);
			for (let r = 0; r < n; r++) {
				const index = permutation.map(r);
				assert.ok(index >= 0 && index < n);
				assert.equal(seen[index], 0, `index ${index} hit twice`);
				seen[index] = 1;
			}
		});
	}

	it('spreads adjacent ranks apart', () => {
		const permutation = new AffinePermutation(1_000_000);
		assert.ok(Math.abs(permutation.map(1) - permutation.map(0)) > 1000);
	});
});

describe('makeKeyIndexChooser', () => {
	it('keeps every index in range for each skew', () => {
		for (const skew of ['uniform', 'zipf-0.8', 'zipf-1', 'zipf-1.2']) {
			const chooser = makeKeyIndexChooser(skew, 5000, seededUniform(1));
			for (let i = 0; i < 20_000; i++) {
				const index = chooser.next();
				assert.ok(Number.isInteger(index) && index >= 0 && index < 5000, `${skew}: ${index}`);
			}
		}
	});

	it('parses skew names', () => {
		assert.deepEqual(parseSkew('uniform'), { kind: 'uniform' });
		assert.deepEqual(parseSkew('zipf-1.2'), { kind: 'zipf', exponent: 1.2 });
		assert.throws(() => parseSkew('zipf-0'), RangeError);
		assert.throws(() => parseSkew('zipfian'), RangeError);
	});
});

describe('seededUniform', () => {
	it('is deterministic and stays in [0, 1)', () => {
		const a = seededUniform(99);
		const b = seededUniform(99);
		for (let i = 0; i < 10_000; i++) {
			const value = a();
			assert.equal(value, b());
			assert.ok(value >= 0 && value < 1);
		}
	});
});
