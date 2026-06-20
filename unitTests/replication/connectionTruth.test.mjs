/**
 * Coverage for `deriveConnectionTruth` — the pure derivation of authoritative connection state from the
 * per-(db, peer) shared-memory status buffer (W1 / harper-pro#431). The main thread reads this as the
 * source of truth for whether an outbound subscription link is up, replacing sole reliance on the
 * edge-triggered worker→main mirror that desyncs on an open-but-idle wedge (#289/#233).
 *
 * The invariant under test: `connected` requires BOTH a CONNECTED state AND fresh liveness, so a worker
 * that died or wedged without writing DOWN reads as not-connected once its liveness goes stale.
 */

import { expect } from 'chai';
import {
	deriveConnectionTruth,
	CONNECTION_STATE_POSITION,
	LAST_LIVENESS_TIME_POSITION,
	LAST_ERROR_CODE_POSITION,
	LAST_ERROR_TIME_POSITION,
	CONNECTION_STATE_DOWN,
	CONNECTION_STATE_CONNECTED,
	LIVENESS_STALE_MS,
} from '#src/replication/replicationConnection';

const NOW = 1_000_000_000;

function makeStatus({ state = 0, liveness = 0, errorCode = 0, errorTime = 0 } = {}) {
	const status = new Float64Array(16);
	status[CONNECTION_STATE_POSITION] = state;
	status[LAST_LIVENESS_TIME_POSITION] = liveness;
	status[LAST_ERROR_CODE_POSITION] = errorCode;
	status[LAST_ERROR_TIME_POSITION] = errorTime;
	return status;
}

describe('deriveConnectionTruth', () => {
	it('is connected when state is CONNECTED and liveness is fresh', () => {
		const truth = deriveConnectionTruth(makeStatus({ state: CONNECTION_STATE_CONNECTED, liveness: NOW - 1000 }), NOW);
		expect(truth.connected).to.equal(true);
		expect(truth.state).to.equal(CONNECTION_STATE_CONNECTED);
	});

	it('is NOT connected when liveness is stale, even if state still reads CONNECTED (wedge safety net)', () => {
		const truth = deriveConnectionTruth(
			makeStatus({ state: CONNECTION_STATE_CONNECTED, liveness: NOW - LIVENESS_STALE_MS - 1 }),
			NOW
		);
		expect(truth.connected).to.equal(false);
	});

	it('treats liveness exactly at the stale threshold as stale (strict freshness)', () => {
		const truth = deriveConnectionTruth(
			makeStatus({ state: CONNECTION_STATE_CONNECTED, liveness: NOW - LIVENESS_STALE_MS }),
			NOW
		);
		expect(truth.connected).to.equal(false);
	});

	it('is NOT connected when state is DOWN even with fresh liveness', () => {
		const truth = deriveConnectionTruth(makeStatus({ state: CONNECTION_STATE_DOWN, liveness: NOW - 1000 }), NOW);
		expect(truth.connected).to.equal(false);
	});

	it('is NOT connected when liveness has never been written (lastLiveness 0)', () => {
		const truth = deriveConnectionTruth(makeStatus({ state: CONNECTION_STATE_CONNECTED, liveness: 0 }), NOW);
		expect(truth.connected).to.equal(false);
		expect(truth.lastLiveness).to.equal(0);
	});

	it('surfaces the last error code and time when set', () => {
		const truth = deriveConnectionTruth(
			makeStatus({ state: CONNECTION_STATE_DOWN, liveness: NOW - 5000, errorCode: 1006, errorTime: NOW - 5000 }),
			NOW
		);
		expect(truth.errorCode).to.equal(1006);
		expect(truth.errorTime).to.equal(NOW - 5000);
	});

	it('omits error fields when unset (zero)', () => {
		const truth = deriveConnectionTruth(makeStatus({ state: CONNECTION_STATE_CONNECTED, liveness: NOW }), NOW);
		expect(truth.errorCode).to.equal(undefined);
		expect(truth.errorTime).to.equal(undefined);
	});
});
