import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { time as timeProfiler } from '@datadog/pprof';
import sinon from 'sinon';
import { addAnalyticsListener, recordAction, setAnalyticsEnabled } from '#src/core/resources/analytics/write';
import { get as envGet } from '#src/core/utility/environment/environmentManager';
import { CONFIG_PARAMS } from '#src/core/utility/hdbTerms';
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
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 0.5 })), true);
		await sleep(750);
		assert.equal(timeProfiler.isStarted(), true);
		await sleep(750);
		assert.equal(timeProfiler.isStarted(), false);
	});
	it('samples only in the one-period window before a capture', async () => {
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 0.5 })), true);
		await captureProfile(1500);
		assert.equal(timeProfiler.isStarted(), false);
		await sleep(500);
		assert.equal(timeProfiler.isStarted(), false);
		await sleep(750);
		assert.equal(timeProfiler.isStarted(), true);
		await sleep(750);
		assert.equal(timeProfiler.isStarted(), false);
	});
	it('opens the next window when the sampler fails to start at a window', async () => {
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
		const realStart = timeProfiler.start;
		let failures = 0;
		timeProfiler.start = (...args) => {
			if (failures-- > 0) throw new Error('simulated profiler start failure');
			return realStart.apply(timeProfiler, args);
		};
		try {
			assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 1 })), true);
			await captureProfile(3000);
			assert.equal(timeProfiler.isStarted(), false);
			failures = 1;
			await clock.tickAsync(2000);
			assert.equal(timeProfiler.isStarted(), false);
			await clock.tickAsync(1_000_000);
			assert.equal(timeProfiler.isStarted(), true);
			await clock.tickAsync(1000);
			assert.equal(timeProfiler.isStarted(), false);
		} finally {
			timeProfiler.start = realStart;
			clock.restore();
		}
	});
	it('captures one window after a failed stop left the sampler running', async () => {
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
		const realStop = timeProfiler.stop;
		let failures = 1;
		timeProfiler.stop = (...args) => {
			if (failures-- > 0) throw new Error('simulated profiler stop failure');
			return realStop.apply(timeProfiler, args);
		};
		try {
			assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 1 })), true);
			await captureProfile(3000);
			assert.equal(timeProfiler.isStarted(), true);
			await clock.tickAsync(999);
			assert.equal(timeProfiler.isStarted(), true);
			await clock.tickAsync(1);
			assert.equal(timeProfiler.isStarted(), false);
		} finally {
			timeProfiler.stop = realStop;
			clock.restore();
		}
	});
	it('logs when pprof reports that it found and restarted a wedged V8 event processor', async () => {
		const harperLogger = (await import('#src/core/utility/logging/harper_logger')).default;
		const warnings = [];
		const originalWarn = harperLogger.warn;
		const originalDetected = timeProfiler.v8ProfilerStuckEventLoopDetected;
		harperLogger.warn = (...args) => warnings.push(args.join(' '));
		timeProfiler.v8ProfilerStuckEventLoopDetected = () => 2;
		try {
			await captureProfile(10000);
			await captureProfile(-1);
			const found = warnings.find((line) => line.includes('event processor stuck'));
			assert.ok(found, `expected the detector warning, got: ${JSON.stringify(warnings)}`);
			assert.match(found, /level 2/);
		} finally {
			harperLogger.warn = originalWarn;
			timeProfiler.v8ProfilerStuckEventLoopDetected = originalDetected;
		}
	});

	it('keeps one sampled period per thousand when a period is longer than Node can time', async () => {
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
		const start = sinon.spy(timeProfiler, 'start');
		const stop = sinon.spy(timeProfiler, 'stop');
		// 25.5 days, longer than the 2^31-1 ms one timer can wait
		const period = 2_200_000_000;
		try {
			assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: period / 1000 })), true);
			await clock.tickAsync(period - 1000);
			assert.equal(stop.callCount, 0, 'no capture before the first period ends');
			await clock.tickAsync(2000);
			assert.equal(stop.callCount, 1, 'the first capture lands at one period');
			await clock.tickAsync(period);
			assert.equal(stop.callCount, 2, 'the second capture lands at two periods');
			assert.equal(timeProfiler.isStarted(), false, 'off after the two startup captures');
			const startsSoFar = start.callCount;
			await clock.tickAsync(120 * 86_400_000);
			assert.equal(start.callCount, startsSoFar, 'no window for 120 days: the next is a thousand periods out');
		} finally {
			start.restore();
			stop.restore();
			clock.restore();
		}
	});
	it('opens the window on time after a delay longer than Node can time', async () => {
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
		const maxTimeout = 2 ** 31 - 1;
		let start;
		try {
			assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 1 })), true);
			await captureProfile(3 * maxTimeout);
			assert.equal(timeProfiler.isStarted(), false);
			start = sinon.spy(timeProfiler, 'start');
			await clock.tickAsync(3 * maxTimeout - 1000 - 10);
			assert.equal(start.callCount, 0, 'no window opens during the wait');
			await clock.tickAsync(20);
			assert.equal(start.callCount, 1);
			assert.equal(timeProfiler.isStarted(), true, 'the window opens one period before the capture');
			await clock.tickAsync(1000);
			assert.equal(timeProfiler.isStarted(), false, 'and closes at the capture');
		} finally {
			start?.restore();
			clock.restore();
		}
	});
	it('stops a long wait when profiling is disabled partway through it', async () => {
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
		const maxTimeout = 2 ** 31 - 1;
		let start;
		try {
			assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 1 })), true);
			await captureProfile(3 * maxTimeout);
			await clock.tickAsync(maxTimeout + 1000);
			assert.equal(startAutomaticProfiling(optionsWith({ profiling: false, aggregatePeriod: 1 })), false);
			start = sinon.spy(timeProfiler, 'start');
			// inside the window an uncancelled wait would have opened at 3 * maxTimeout - 1000
			await clock.tickAsync(2 * maxTimeout - 1500);
			assert.equal(timeProfiler.isStarted(), false);
			await clock.tickAsync(maxTimeout);
			assert.equal(start.callCount, 0, 'no window opened after the cancel');
		} finally {
			start?.restore();
			clock.restore();
		}
	});
	it('cancels a sampling window that has not opened when profiling is disabled', async () => {
		assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod: 0.2 })), true);
		await captureProfile(600);
		assert.equal(timeProfiler.isStarted(), false);
		assert.equal(startAutomaticProfiling(optionsWith({ profiling: false, aggregatePeriod: 0.2 })), false);
		// inside the window an uncancelled schedule would open (400 ms), before its capture (600 ms)
		await sleep(500);
		assert.equal(timeProfiler.isStarted(), false);
		await sleep(300);
		assert.equal(timeProfiler.isStarted(), false);
	});
});

describe("Analytics profiler sampling marker in core's report flush", () => {
	before(() => setAnalyticsEnabled(true));
	after(async () => {
		await captureProfile(-1);
		setAnalyticsEnabled(envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) > -1);
	});

	it('is on the metrics core flushes with the report that overlapped the sampler', async () => {
		const flushed = [];
		addAnalyticsListener((metrics) => {
			if (metrics.some(({ metric }) => metric === 'marker-flush-probe'))
				flushed.push(metrics.map(({ metric }) => metric));
		});
		await captureProfile(-1);
		await captureProfile(10000);
		await sleep(60);
		recordAction(1, 'marker-flush-probe');
		const deadline = performance.now() + 5000;
		while (!flushed.length && performance.now() < deadline) await sleep(25);
		assert.equal(flushed.length, 1, 'core flushed the report carrying the probe');
		assert.ok(flushed[0].includes(PROFILER_SAMPLING_METRIC), JSON.stringify(flushed[0]));
	});
});

describe('Analytics profiler sampling marker', () => {
	// Core's own report flushes call the same listener and would consume the state these tests read.
	before(() => setAnalyticsEnabled(false));
	after(() => setAnalyticsEnabled(envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) > -1));
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
