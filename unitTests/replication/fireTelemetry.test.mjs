/**
 * Coverage for the W1 T1 (harper-pro#431) fire-telemetry formatters: `formatTruthSnapshot` (the truth
 * snapshot appended to every watchdog / reconcile-net fire log) and `describePriorSignals` (which
 * earlier layers already engaged on the entry). These strings are what the watchdog-demotion soak
 * greps, so the tests pin the shape: an unavailable buffer reads distinctly ('truth=unavailable'), a
 * never-alive link reads 'never' rather than a bogus epoch age, ages are in whole seconds, and an
 * untouched entry reads 'prior=none' so sole-detector fires are trivially queryable.
 */

import { expect } from 'chai';
import { formatTruthSnapshot } from '#src/replication/replicationConnection';
import { describePriorSignals } from '#src/replication/subscriptionManager';

const NOW = 10_000_000;

describe('formatTruthSnapshot', () => {
	it('reads truth=unavailable without a buffer', () => {
		expect(formatTruthSnapshot(undefined, NOW)).to.equal('truth=unavailable');
	});

	it('formats a connected link with liveness age in seconds', () => {
		expect(formatTruthSnapshot({ connected: true, state: 2, lastLiveness: NOW - 12_000 }, NOW)).to.equal(
			'truth={connected: true, state: 2, liveness: 12s ago}'
		);
	});

	it('reads liveness: never for a buffer that has not reported life', () => {
		expect(formatTruthSnapshot({ connected: false, state: 0, lastLiveness: 0 }, NOW)).to.equal(
			'truth={connected: false, state: 0, liveness: never}'
		);
	});

	it('includes the last close code when present', () => {
		expect(
			formatTruthSnapshot({ connected: false, state: 0, lastLiveness: NOW - 90_000, errorCode: 1006 }, NOW)
		).to.equal('truth={connected: false, state: 0, liveness: 90s ago, lastCloseCode: 1006}');
	});
});

describe('describePriorSignals', () => {
	it('reads prior=none for an untouched entry (sole-detector fire)', () => {
		expect(describePriorSignals({}, NOW)).to.equal('prior=none');
	});

	it('reports the last recovery mechanism with age', () => {
		expect(describePriorSignals({ lastRecovery: { mechanism: 'wedge-reconcile', at: NOW - 30_000 } }, NOW)).to.equal(
			'prior={wedge-reconcile 30s ago}'
		);
	});

	it('reports the last truth correction with direction and age', () => {
		expect(describePriorSignals({ lastTruthCorrection: { direction: 'down', at: NOW - 5_000 } }, NOW)).to.equal(
			'prior={truth-corrected-down 5s ago}'
		);
	});

	it('reports both, recovery first', () => {
		expect(
			describePriorSignals(
				{
					lastRecovery: { mechanism: 'receive-stall-net', at: NOW - 60_000 },
					lastTruthCorrection: { direction: 'up', at: NOW - 10_000 },
				},
				NOW
			)
		).to.equal('prior={receive-stall-net 60s ago; truth-corrected-up 10s ago}');
	});
});
