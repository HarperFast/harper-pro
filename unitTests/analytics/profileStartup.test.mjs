import assert from 'node:assert';
import { time as timeProfiler } from '@datadog/pprof';
import { captureProfile, startAutomaticProfiling, userCodeFolders } from '#src/analytics/profile';

function optionsWith(values) {
	return { get: (path) => values[path.join('.')] };
}

describe('Analytics profiler startup gate', () => {
	before(() => {
		userCodeFolders.push(new URL('../testApp/', import.meta.url).toString());
	});
	// A non-positive delay stops the real profiler for good and clears the capture timer.
	afterEach(async () => {
		if (timeProfiler.isStarted()) await captureProfile(-1);
		assert.equal(timeProfiler.isStarted(), false);
	});

	for (const aggregatePeriod of [-1, 0]) {
		it(`does not start sampling when aggregatePeriod is ${aggregatePeriod}`, () => {
			assert.equal(startAutomaticProfiling(optionsWith({ aggregatePeriod })), false);
			assert.equal(timeProfiler.isStarted(), false);
		});
	}
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
	it('an explicit capture starts a stopped profiler and a terminal capture stops it', async () => {
		await captureProfile(10000);
		assert.equal(timeProfiler.isStarted(), true);
		await captureProfile(10000);
		assert.equal(timeProfiler.isStarted(), true);
		await captureProfile(-1);
		assert.equal(timeProfiler.isStarted(), false);
		await captureProfile(10000);
		assert.equal(timeProfiler.isStarted(), true);
	});
});
