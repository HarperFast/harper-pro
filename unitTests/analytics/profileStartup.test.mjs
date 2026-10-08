import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { time as timeProfiler } from '@datadog/pprof';
import { setAnalyticsEnabled } from '#src/core/resources/analytics/write';
import {
	captureProfile,
	markProfilerSampling,
	PROFILER_SAMPLING_METRIC,
	startAutomaticProfiling,
	userCodeFolders,
} from '#src/analytics/profile';

function optionsWith(values) {
	return { get: (path) => values[path.join('.')] };
}

describe('Analytics profiler startup gate', () => {
	before(() => {
		userCodeFolders.push(new URL('../testApp/', import.meta.url).toString());
	});
	afterEach(async () => {
		// A terminal capture also cancels a sampling window that has not opened yet.
		await captureProfile(-1);
		assert.equal(timeProfiler.isStarted(), false);
	});

	for (const aggregatePeriod of [-1, 0]) {
		it(`does not start sampling when aggregatePeriod is ${aggregatePeriod}`, () => {
			assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod })), false);
			assert.equal(timeProfiler.isStarted(), false);
		});
	}
	it('does not start sampling when aggregatePeriod is not a number', () => {
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 'soon' })), false);
		assert.equal(timeProfiler.isStarted(), false);
	});
	it('does not start sampling when profiling is disabled', () => {
		assert.equal(startAutomaticProfiling(optionsWith({ profiling: false, aggregatePeriod: 60 })), false);
		assert.equal(timeProfiler.isStarted(), false);
	});
	it('starts sampling for a positive period, and a repeat call keeps the one profiler', () => {
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 60 })), true);
		assert.equal(timeProfiler.isStarted(), true);
		assert.equal(startAutomaticProfiling(optionsWith({})), true);
		assert.equal(timeProfiler.isStarted(), true);
	});
	it('stops a running profiler when automatic profiling is disabled later', async () => {
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 60 })), true);
		assert.equal(timeProfiler.isStarted(), true);
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: -1 })), false);
		assert.equal(timeProfiler.isStarted(), false);
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 60 })), true);
		assert.equal(startAutomaticProfiling(optionsWith({ profiling: false, aggregatePeriod: 60 })), false);
		assert.equal(timeProfiler.isStarted(), false);
	});
	it('reconciles the started flag when a terminal stop finds the profiler already stopped', async () => {
		await captureProfile(10000);
		assert.equal(timeProfiler.isStarted(), true);
		timeProfiler.stop();
		await captureProfile(-1);
		assert.equal(timeProfiler.isStarted(), false);
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 60 })), true);
		assert.equal(timeProfiler.isStarted(), true);
	});
	it('an explicit capture starts a stopped profiler and a terminal capture stops it', async () => {
		await captureProfile(10000);
		assert.equal(timeProfiler.isStarted(), true);
		await captureProfile(-1);
		assert.equal(timeProfiler.isStarted(), false);
		await captureProfile(-1);
		assert.equal(timeProfiler.isStarted(), false);
		await captureProfile(10000);
		assert.equal(timeProfiler.isStarted(), true);
	});
	it('samples across the two startup captures and stops after the second', async () => {
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 0.1 })), true);
		await sleep(150);
		assert.equal(timeProfiler.isStarted(), true);
		await sleep(250);
		assert.equal(timeProfiler.isStarted(), false);
	});
	it('samples only in the one-period window before a capture', async () => {
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 0.2 })), true);
		await captureProfile(600);
		assert.equal(timeProfiler.isStarted(), false);
		await sleep(200);
		assert.equal(timeProfiler.isStarted(), false);
		await sleep(300);
		assert.equal(timeProfiler.isStarted(), true);
		await sleep(300);
		assert.equal(timeProfiler.isStarted(), false);
	});
	it('cancels a sampling window that has not opened when profiling is disabled', async () => {
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 0.1 })), true);
		await captureProfile(300);
		assert.equal(timeProfiler.isStarted(), false);
		assert.equal(startAutomaticProfiling(optionsWith({ profiling: false, aggregatePeriod: 0.1 })), false);
		await sleep(400);
		assert.equal(timeProfiler.isStarted(), false);
	});
});

describe('Analytics profiler sampling marker', () => {
	// Core's own report flushes call the same listener and would consume the state these tests read.
	before(() => setAnalyticsEnabled(false));
	after(() => setAnalyticsEnabled(true));
	afterEach(async () => {
		await captureProfile(-1);
	});

	it('flags the reports whose utilization sample overlapped the sampler', async () => {
		markProfilerSampling([]);
		const idle = [];
		markProfilerSampling(idle);
		assert.deepEqual(idle, []);

		await captureProfile(10000);
		await sleep(30);
		const during = [];
		markProfilerSampling(during);
		assert.equal(during.length, 1);
		assert.equal(during[0].metric, PROFILER_SAMPLING_METRIC);
		assert.equal(during[0].count, 1);
		assert.ok(during[0].total >= 25, `sampled ${during[0].total}ms`);

		await sleep(30);
		await captureProfile(-1);
		const after = [];
		markProfilerSampling(after);
		assert.equal(after.length, 1);
		assert.ok(after[0].total >= 25, `sampled ${after[0].total}ms`);

		const later = [];
		markProfilerSampling(later);
		assert.deepEqual(later, []);
	});
	it('reports the sampled time once when sampling stopped before the report', async () => {
		await captureProfile(10000);
		await sleep(30);
		await captureProfile(-1);
		const first = [];
		markProfilerSampling(first);
		assert.equal(first.length, 1);
		assert.ok(first[0].total >= 25, `sampled ${first[0].total}ms`);
		const second = [];
		markProfilerSampling(second);
		assert.deepEqual(second, []);
	});
});
