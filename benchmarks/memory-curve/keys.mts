/**
 * Key choosers for the memory-curve benchmark: uniform, and Zipf(s) over exactly `n` keys for any
 * exponent s > 0 (YCSB's generator in core/benchmarks/ycsb/workload.mts is fixed at θ = 0.99 and
 * only valid for θ < 1). Popularity ranks are scattered over the key range by a bijective affine
 * permutation, so hot keys land in different SST blocks the way scrambled YCSB keys do, without the
 * collisions of hashing ranks modulo n.
 */

export type Uniform01 = () => number;

/** Draws integer ranks in [1, n] with P(k) ∝ k^-s (Hörmann & Derflinger rejection-inversion). */
export class ZipfSampler {
	readonly n: number;
	readonly exponent: number;
	private readonly hIntegralX1: number;
	private readonly hIntegralN: number;
	private readonly squeeze: number;

	constructor(n: number, exponent: number) {
		if (!Number.isInteger(n) || n < 1) throw new RangeError(`Zipf key count must be a positive integer, got ${n}`);
		if (!(exponent > 0)) throw new RangeError(`Zipf exponent must be > 0, got ${exponent}`);
		this.n = n;
		this.exponent = exponent;
		this.hIntegralX1 = this.hIntegral(1.5) - 1;
		this.hIntegralN = this.hIntegral(n + 0.5);
		this.squeeze = 2 - this.hIntegralInverse(this.hIntegral(2.5) - this.h(2));
	}

	sample(random: Uniform01): number {
		for (;;) {
			const u = this.hIntegralN + random() * (this.hIntegralX1 - this.hIntegralN);
			const x = this.hIntegralInverse(u);
			let k = Math.floor(x + 0.5);
			if (k < 1) k = 1;
			else if (k > this.n) k = this.n;
			if (k - x <= this.squeeze || u >= this.hIntegral(k + 0.5) - this.h(k)) return k;
		}
	}

	private h(x: number): number {
		return Math.exp(-this.exponent * Math.log(x));
	}

	private hIntegral(x: number): number {
		const logX = Math.log(x);
		return expm1OverX((1 - this.exponent) * logX) * logX;
	}

	private hIntegralInverse(x: number): number {
		let t = x * (1 - this.exponent);
		if (t < -1) t = -1;
		return Math.exp(log1pOverX(t) * x);
	}
}

// Both helpers stay finite at 0, which is what makes s = 1 work without a special case.
function log1pOverX(x: number): number {
	return Math.abs(x) > 1e-8 ? Math.log1p(x) / x : 1 - x * (0.5 - x * (1 / 3 - 0.25 * x));
}

function expm1OverX(x: number): number {
	return Math.abs(x) > 1e-8 ? Math.expm1(x) / x : 1 + x * 0.5 * (1 + (x / 3) * (1 + 0.25 * x));
}

function gcd(a: number, b: number): number {
	while (b !== 0) [a, b] = [b, a % b];
	return a;
}

/** Bijection on [0, n): rank r -> (multiplier * r + offset) mod n. */
export class AffinePermutation {
	readonly n: number;
	readonly multiplier: number;
	readonly offset: number;

	constructor(n: number) {
		// multiplier * r must stay an exact double.
		if (n * n >= Number.MAX_SAFE_INTEGER) throw new RangeError(`key count ${n} is too large for the permutation`);
		this.n = n;
		let multiplier = Math.max(1, Math.floor(n * 0.6180339887498949));
		while (gcd(multiplier, n) !== 1) multiplier++;
		this.multiplier = multiplier % n || 1;
		this.offset = Math.floor(n / 3);
	}

	map(rank: number): number {
		return (this.multiplier * rank + this.offset) % this.n;
	}
}

export interface KeyIndexChooser {
	next(): number;
}

export function parseSkew(skew: string): { kind: 'uniform' } | { kind: 'zipf'; exponent: number } {
	if (skew === 'uniform') return { kind: 'uniform' };
	const match = /^zipf-(\d+(?:\.\d+)?)$/.exec(skew);
	if (!match || !(Number(match[1]) > 0))
		throw new RangeError(`skew must be "uniform" or "zipf-<exponent>", got ${skew}`);
	return { kind: 'zipf', exponent: Number(match[1]) };
}

/** Index chooser over [0, keyCount) for a skew name such as `uniform` or `zipf-1.2`. */
export function makeKeyIndexChooser(skew: string, keyCount: number, random: Uniform01 = Math.random): KeyIndexChooser {
	const parsed = parseSkew(skew);
	if (parsed.kind === 'uniform') return { next: () => Math.floor(random() * keyCount) };
	const sampler = new ZipfSampler(keyCount, parsed.exponent);
	const permutation = new AffinePermutation(keyCount);
	return { next: () => permutation.map(sampler.sample(random) - 1) };
}

/** Seeded uniform [0, 1) source with 53 bits per draw (two 32-bit mulberry32 outputs). */
export function seededUniform(seed: number): Uniform01 {
	let state = seed >>> 0;
	const next32 = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (t ^ (t >>> 14)) >>> 0;
	};
	return () => ((next32() >>> 5) * 67108864 + (next32() >>> 6)) / 2 ** 53;
}
