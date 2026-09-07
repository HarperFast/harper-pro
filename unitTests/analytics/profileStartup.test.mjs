import { assert } from 'chai';
import sinon from 'sinon';
import { time as timeProfiler } from '@datadog/pprof';
import { captureProfile, startAutomaticProfiling, userCodeFolders } from '#src/analytics/profile';

function optionsWith(values) {
	return { get: (path) => values[path.join('.')] };
}
const EMPTY_PROFILE = { stringTable: { strings: [] }, function: [], location: [], sample: [] };

describe('Analytics profiler startup gate', () => {
	let start, stop;
	before(() => {
		userCodeFolders.push(new URL('../testApp/', import.meta.url).toString());
	});
	beforeEach(() => {
		start = sinon.stub(timeProfiler, 'start');
		stop = sinon.stub(timeProfiler, 'stop').returns(EMPTY_PROFILE);
	});
	afterEach(() => sinon.restore());

	// Ordered: the profiler is module-level state, so the cases that must not start it run first.
	for (const aggregatePeriod of [-1, 0]) {
		it(`does not start sampling when aggregatePeriod is ${aggregatePeriod}`, () => {
			assert.isFalse(startAutomaticProfiling(optionsWith({ aggregatePeriod })));
			assert.equal(start.callCount, 0);
		});
	}
	it('does not start sampling when profiling is disabled', () => {
		assert.isFalse(startAutomaticProfiling(optionsWith({ profiling: false, aggregatePeriod: 60 })));
		assert.equal(start.callCount, 0);
	});
	it('starts sampling once for a positive period, and only once', () => {
		assert.isTrue(startAutomaticProfiling(optionsWith({ aggregatePeriod: 60 })));
		assert.isTrue(startAutomaticProfiling(optionsWith({})));
		assert.equal(start.callCount, 1);
		assert.deepEqual(start.firstCall.args, [{ intervalMicros: 50000 }]);
	});
	it('an explicit capture restarts sampling and a terminal capture stops it', async () => {
		await captureProfile(10000);
		assert.deepEqual(stop.firstCall.args, [true]);
		// A non-positive delay captures (stop with restart) and then stops for good.
		await captureProfile(-1);
		assert.deepEqual(stop.args.slice(1), [[true], [false]]);
		assert.equal(start.callCount, 0);
		// After a terminal stop, the next explicit capture starts fresh instead of stopping a stopped profiler.
		await captureProfile(10000);
		assert.equal(start.callCount, 1);
		assert.equal(stop.callCount, 3);
	});
});
