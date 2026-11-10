import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKET_COUNT, LatencyHistogram, bucketIndex, bucketRange, summarize } from './histogram.mts';
import { seededUniform } from './keys.mts';

describe('bucketIndex / bucketRange', () => {
	it('places every value inside its bucket range', () => {
		const values = [0, 1, 127, 128, 129, 255, 256, 1000, 4095, 4096, 65_535, 1_000_000, 2 ** 26 - 1, 6e7];
		for (const value of values) {
			const index = bucketIndex(value);
			assert.ok(index >= 0 && index < BUCKET_COUNT);
			const [low, high] = bucketRange(index);
			assert.ok(value >= low && value < high, `${value} not in [${low}, ${high}) of bucket ${index}`);
		}
	});

	it('keeps bucket widths within 1/64 of their lower bound above the linear range', () => {
		for (let index = 128; index < 1000; index++) {
			const [low, high] = bucketRange(index);
			assert.ok((high - low) / low <= 1 / 64 + 1e-12);
			assert.equal(bucketIndex(low), index);
			assert.equal(bucketIndex(high - 1), index);
		}
	});
});

describe('LatencyHistogram', () => {
	it('reports quantiles within 1.6% of exact nearest-rank values', () => {
		const random = seededUniform(3);
		const histogram = new LatencyHistogram();
		const samples: number[] = [];
		for (let i = 0; i < 50_000; i++) {
			const micros = Math.floor(200 * Math.exp(random() * 8));
			samples.push(micros);
			histogram.record(micros);
		}
		samples.sort((a, b) => a - b);
		for (const q of [0.5, 0.9, 0.99, 0.999]) {
			const exact = samples[Math.ceil(q * samples.length) - 1];
			const reported = histogram.quantile(q)!;
			assert.ok(Math.abs(reported - exact) / exact <= 1 / 64, `q${q}: ${reported} vs ${exact}`);
		}
		assert.ok(histogram.quantile(1)! <= samples[samples.length - 1]);
	});

	it('merges to the same result as recording into one histogram', () => {
		const random = seededUniform(5);
		const whole = new LatencyHistogram();
		const parts = [new LatencyHistogram(), new LatencyHistogram(), new LatencyHistogram()];
		for (let i = 0; i < 30_000; i++) {
			const micros = Math.floor(random() * 100_000);
			whole.record(micros);
			parts[i % 3].record(micros);
		}
		const merged = new LatencyHistogram();
		for (const part of parts) merged.merge(part);
		assert.deepEqual(Array.from(merged.counts), Array.from(whole.counts));
		assert.equal(merged.count, whole.count);
		assert.equal(merged.minMicros, whole.minMicros);
		assert.equal(merged.maxMicros, whole.maxMicros);
		for (const q of [0.5, 0.99, 0.999]) assert.equal(merged.quantile(q), whole.quantile(q));
	});

	it('round-trips through JSON', () => {
		const histogram = new LatencyHistogram();
		for (const micros of [5, 500, 5000, 50_000]) histogram.record(micros);
		const copy = LatencyHistogram.fromJSON(JSON.parse(JSON.stringify(histogram.toJSON())));
		assert.deepEqual(Array.from(copy.counts), Array.from(histogram.counts));
		assert.equal(copy.quantile(0.5), histogram.quantile(0.5));
		assert.equal(copy.maxMicros, 50_000);
	});

	it('summarizes an empty histogram as unavailable, not zero', () => {
		const summary = summarize(new LatencyHistogram());
		assert.equal(summary.count, 0);
		assert.equal(summary.p99Ms, null);
		assert.equal(summary.meanMs, null);
		assert.equal(LatencyHistogram.fromJSON(new LatencyHistogram().toJSON()).quantile(0.5), null);
	});
});
