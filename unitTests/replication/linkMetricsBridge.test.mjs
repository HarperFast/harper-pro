/**
 * Coverage for R3 (harper-pro#431): `copyLinkMetricsToEntry`, the orchestrator-side bridge that carries the
 * two link-quality signals the owning worker writes into shared memory (LATENCY on pong,
 * BACK_PRESSURE_RATIO on its 30s cadence) onto the main-thread entry, where adaptive routing (W5/#218) will
 * read them. The reconcile calls this from the same buffer read it derives truth from.
 *
 * The asymmetry these tests pin: `latency` is only copied when the buffer carries one, because 0 means "no
 * pong yet" and copying it would replace the value the connect edge already mirrored with a false instant
 * reading; `backPressureRatio` is copied unconditionally, because 0 is its meaningful "no back-pressure" value.
 */

import { expect } from 'chai';
import { copyLinkMetricsToEntry } from '#src/replication/subscriptionManager';
import { LATENCY_POSITION, BACK_PRESSURE_RATIO_POSITION } from '#src/replication/replicationConnection';
import { REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/knownNodes';

function makeStatus({ latency = 0, backPressure = 0 } = {}) {
	const status = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
	status[LATENCY_POSITION] = latency;
	status[BACK_PRESSURE_RATIO_POSITION] = backPressure;
	return status;
}

describe('copyLinkMetricsToEntry', () => {
	it('copies both signals onto the entry', () => {
		const entry = {};
		copyLinkMetricsToEntry(entry, makeStatus({ latency: 12.5, backPressure: 0.25 }));
		expect(entry.latency).to.equal(12.5);
		expect(entry.backPressureRatio).to.equal(0.25);
	});

	it('keeps the entry latency the connect edge mirrored when the buffer has no pong reading yet', () => {
		const entry = { latency: 8 };
		copyLinkMetricsToEntry(entry, makeStatus({ latency: 0, backPressure: 0.5 }));
		expect(entry.latency).to.equal(8);
		expect(entry.backPressureRatio).to.equal(0.5);
	});

	it('copies a zero back-pressure ratio, since zero is the meaningful "no back-pressure" reading', () => {
		const entry = { backPressureRatio: 0.9 };
		copyLinkMetricsToEntry(entry, makeStatus({ backPressure: 0 }));
		expect(entry.backPressureRatio).to.equal(0);
	});

	it('agrees with the backPressurePercent view clusterStatus reports from the same slot', () => {
		const entry = {};
		const status = makeStatus({ backPressure: 0.42 });
		copyLinkMetricsToEntry(entry, status);
		expect(entry.backPressureRatio * 100).to.equal(status[BACK_PRESSURE_RATIO_POSITION] * 100);
	});

	it('reads only its own two slots, so nothing else on the buffer is disturbed', () => {
		const status = makeStatus({ latency: 3, backPressure: 0.1 });
		const before = Array.from(status);
		copyLinkMetricsToEntry({}, status);
		expect(Array.from(status)).to.deep.equal(before);
	});
});
