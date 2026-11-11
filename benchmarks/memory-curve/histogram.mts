/**
 * Mergeable log-linear latency histogram in integer microseconds. Values below 128 µs are exact;
 * above, each power of two is split into 64 buckets, so a reported quantile is within 1/64 (1.6%)
 * of the true value. Worker histograms are summed before quantiles are read, never averaged.
 */

const SUB_BUCKETS = 64;
const LINEAR_LIMIT = 2 * SUB_BUCKETS;
const MAX_SHIFT = 32;
export const BUCKET_COUNT = LINEAR_LIMIT + MAX_SHIFT * SUB_BUCKETS;

export function bucketIndex(micros: number): number {
	const value = Math.max(0, Math.floor(micros));
	if (value < LINEAR_LIMIT) return value;
	let shift = Math.floor(Math.log2(value)) - 6;
	let mantissa = Math.floor(value / 2 ** shift);
	if (mantissa >= LINEAR_LIMIT) mantissa = Math.floor(value / 2 ** ++shift);
	else if (mantissa < SUB_BUCKETS) mantissa = Math.floor(value / 2 ** --shift);
	if (shift > MAX_SHIFT) return BUCKET_COUNT - 1;
	return LINEAR_LIMIT + (shift - 1) * SUB_BUCKETS + (mantissa - SUB_BUCKETS);
}

/** The [low, high) microsecond range a bucket covers. */
export function bucketRange(index: number): [number, number] {
	if (index < LINEAR_LIMIT) return [index, index + 1];
	const shift = Math.floor((index - LINEAR_LIMIT) / SUB_BUCKETS) + 1;
	const mantissa = ((index - LINEAR_LIMIT) % SUB_BUCKETS) + SUB_BUCKETS;
	return [mantissa * 2 ** shift, (mantissa + 1) * 2 ** shift];
}

export interface HistogramJSON {
	counts: Record<string, number>;
	count: number;
	sumMicros: number;
	minMicros: number;
	maxMicros: number;
}

export class LatencyHistogram {
	readonly counts = new Float64Array(BUCKET_COUNT);
	count = 0;
	sumMicros = 0;
	minMicros = Infinity;
	maxMicros = 0;

	record(micros: number): void {
		this.counts[bucketIndex(micros)]++;
		this.count++;
		this.sumMicros += micros;
		if (micros < this.minMicros) this.minMicros = micros;
		if (micros > this.maxMicros) this.maxMicros = micros;
	}

	merge(other: LatencyHistogram): void {
		for (let i = 0; i < BUCKET_COUNT; i++) this.counts[i] += other.counts[i];
		this.count += other.count;
		this.sumMicros += other.sumMicros;
		if (other.minMicros < this.minMicros) this.minMicros = other.minMicros;
		if (other.maxMicros > this.maxMicros) this.maxMicros = other.maxMicros;
	}

	/** Nearest-rank quantile, reported as its bucket's midpoint and clamped to the observed range. */
	quantile(q: number): number | null {
		if (this.count === 0) return null;
		const rank = Math.max(1, Math.ceil(q * this.count));
		let cumulative = 0;
		for (let i = 0; i < BUCKET_COUNT; i++) {
			cumulative += this.counts[i];
			if (cumulative >= rank) {
				const [low, high] = bucketRange(i);
				return Math.min(this.maxMicros, Math.max(this.minMicros, (low + high) / 2));
			}
		}
		return this.maxMicros;
	}

	toJSON(): HistogramJSON {
		const counts: Record<string, number> = {};
		for (let i = 0; i < BUCKET_COUNT; i++) if (this.counts[i] > 0) counts[i] = this.counts[i];
		return {
			counts,
			count: this.count,
			sumMicros: this.sumMicros,
			minMicros: this.count === 0 ? 0 : this.minMicros,
			maxMicros: this.maxMicros,
		};
	}

	static fromJSON(json: HistogramJSON): LatencyHistogram {
		const histogram = new LatencyHistogram();
		for (const [index, count] of Object.entries(json.counts)) histogram.counts[Number(index)] = count;
		histogram.count = json.count;
		histogram.sumMicros = json.sumMicros;
		histogram.minMicros = json.count === 0 ? Infinity : json.minMicros;
		histogram.maxMicros = json.maxMicros;
		return histogram;
	}
}

export interface LatencySummary {
	count: number;
	meanMs: number | null;
	p50Ms: number | null;
	p99Ms: number | null;
	p999Ms: number | null;
	maxMs: number | null;
}

export function summarize(histogram: LatencyHistogram): LatencySummary {
	const ms = (micros: number | null): number | null => (micros === null ? null : micros / 1000);
	return {
		count: histogram.count,
		meanMs: histogram.count === 0 ? null : histogram.sumMicros / histogram.count / 1000,
		p50Ms: ms(histogram.quantile(0.5)),
		p99Ms: ms(histogram.quantile(0.99)),
		p999Ms: ms(histogram.quantile(0.999)),
		maxMs: histogram.count === 0 ? null : histogram.maxMicros / 1000,
	};
}
