/**
 * Coverage for R4 (harper-pro#431): classifying every watchdog / recovery-net fire against the shared-memory
 * connection truth, and counting the result per mechanism so the later watchdog-demotion decision rests on
 * measured evidence rather than argument.
 *
 * `redundant` means truth already read the link down, so the truth-driven path had (or should have had) it
 * too; `load-bearing` means truth still read up, so that mechanism was the only layer that saw the problem.
 * `unknown` is the third state and the one that keeps the evidence honest: a fire from a connection that
 * does not OWN the (database, peer) subscription (an inbound server socket, a cache-miss retrieval
 * connection) is scored against a buffer describing a different link, so it counts in neither bucket.
 *
 * The counters are read-modify-write on an unsynchronized shared buffer, which is only safe because each
 * mechanism's slot pair has exactly one writer thread per (database, peer). The disjointness half of that
 * invariant is mechanical, so it is pinned here.
 */

import { expect } from 'chai';
import {
	FIRE_MECHANISMS,
	FIRE_COUNTER_BASE_POSITION,
	fireCounterPositions,
	classifyFire,
	recordFire,
	readFireCounters,
	formatFireClassification,
	LAST_ERROR_TIME_POSITION,
} from '#src/replication/replicationConnection';
import { REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/knownNodes';

const NOW = 1_700_000_000_000;
const truthUp = { connected: true, state: 2, lastLiveness: NOW - 1000 };
const truthDown = { connected: false, state: 0, lastLiveness: NOW - 200_000, errorCode: 1006 };
const newStatus = () => new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);

describe('fire counter slot map', () => {
	it('gives every mechanism a slot pair that no other mechanism shares', () => {
		const claimed = new Map();
		for (const mechanism of FIRE_MECHANISMS) {
			const { redundant, loadBearing } = fireCounterPositions(mechanism);
			for (const slot of [redundant, loadBearing]) {
				expect(claimed.has(slot), `slot ${slot} claimed by both ${claimed.get(slot)} and ${mechanism}`).to.equal(false);
				claimed.set(slot, mechanism);
			}
		}
		expect(claimed.size).to.equal(FIRE_MECHANISMS.length * 2);
	});

	it('starts past the status/truth fields and fits inside the buffer', () => {
		expect(FIRE_COUNTER_BASE_POSITION).to.be.greaterThan(LAST_ERROR_TIME_POSITION);
		for (const mechanism of FIRE_MECHANISMS) {
			const { redundant, loadBearing } = fireCounterPositions(mechanism);
			expect(redundant).to.be.at.least(FIRE_COUNTER_BASE_POSITION);
			expect(loadBearing).to.be.lessThan(REPLICATION_SHARED_STATUS_SLOTS);
		}
	});

	it('has no positions for an unrecognized mechanism', () => {
		expect(fireCounterPositions('not-a-mechanism')).to.equal(undefined);
	});

	it('names every mechanism that classifies a fire', () => {
		expect(Array.from(FIRE_MECHANISMS)).to.deep.equal([
			'receive-watchdog',
			'pause-stall',
			'copy-progress',
			'blob-gap',
			'copy-finalize',
			'subscription-setup',
			'wedge-reconcile',
			'receive-stall-net',
		]);
	});
});

describe('classifyFire', () => {
	it('reads a fire while truth already says down as redundant', () => {
		expect(classifyFire(truthDown, true)).to.equal('redundant');
	});

	it('reads a fire while truth still says up as load-bearing', () => {
		expect(classifyFire(truthUp, true)).to.equal('load-bearing');
	});

	it('reads a fire from a non-owning connection as unknown, whatever truth says', () => {
		expect(classifyFire(truthUp, false)).to.equal('unknown');
		expect(classifyFire(truthDown, false)).to.equal('unknown');
	});

	it('reads an unavailable truth as unknown rather than assuming load-bearing', () => {
		expect(classifyFire(undefined, true)).to.equal('unknown');
	});

	it('reads a buffer that has observed nothing at all as unknown, not redundant', () => {
		// deriveConnectionTruth reads an all-zero buffer as not-connected because that is the safe default
		// for the reconcile, but truth never saw this link. Scoring the fire as redundant would claim a
		// detection that did not happen — a watchdog can fire on a link that connected but never handshook.
		expect(classifyFire({ connected: false, state: 0, lastLiveness: 0 }, true)).to.equal('unknown');
	});

	it('still reads a recorded disconnect as redundant even with no liveness ever', () => {
		// A link that failed before it ever proved liveness HAS been observed down by truth.
		expect(
			classifyFire({ connected: false, state: 0, lastLiveness: 0, errorCode: 1006, errorTime: NOW - 5000 }, true)
		).to.equal('redundant');
	});
});

describe('recordFire', () => {
	it('counts a redundant and a load-bearing fire into separate slots of the same mechanism', () => {
		const status = newStatus();
		expect(recordFire(status, 'receive-watchdog', 'redundant')).to.deep.equal({ redundant: 1, loadBearing: 0 });
		expect(recordFire(status, 'receive-watchdog', 'redundant')).to.deep.equal({ redundant: 2, loadBearing: 0 });
		expect(recordFire(status, 'receive-watchdog', 'load-bearing')).to.deep.equal({ redundant: 2, loadBearing: 1 });
	});

	it('counts an unknown fire in neither bucket, so non-owner fires cannot bias the evidence', () => {
		const status = newStatus();
		expect(recordFire(status, 'receive-watchdog', 'unknown')).to.equal(undefined);
		expect(readFireCounters(status)).to.equal(undefined);
	});

	it('reports no counts for an unknown fire even when the owning link has totals', () => {
		// The totals belong to the connection that OWNS this (database, peer) subscription. Reporting them
		// beside an unknown fire would let a soak read another link's history as this fire's.
		const status = newStatus();
		recordFire(status, 'receive-watchdog', 'redundant');
		recordFire(status, 'receive-watchdog', 'load-bearing');
		expect(recordFire(status, 'receive-watchdog', 'unknown')).to.equal(undefined);
		expect(readFireCounters(status)).to.deep.equal({ 'receive-watchdog': { redundant: 1, loadBearing: 1 } });
	});

	it('keeps mechanisms independent', () => {
		const status = newStatus();
		recordFire(status, 'pause-stall', 'load-bearing');
		recordFire(status, 'wedge-reconcile', 'redundant');
		expect(readFireCounters(status)).to.deep.equal({
			'pause-stall': { redundant: 0, loadBearing: 1 },
			'wedge-reconcile': { redundant: 1, loadBearing: 0 },
		});
	});

	it('records nothing without a buffer or for an unrecognized mechanism', () => {
		expect(recordFire(undefined, 'receive-watchdog', 'redundant')).to.equal(undefined);
		expect(recordFire(newStatus(), 'not-a-mechanism', 'redundant')).to.equal(undefined);
	});

	it('refuses a buffer too short to hold the pair rather than reporting a fabricated count', () => {
		// An out-of-range Float64Array write is a silent no-op, so without the length guard this would
		// report NaN/0 counts that never persisted.
		const short = new Float64Array(16);
		expect(recordFire(short, 'receive-stall-net', 'redundant')).to.equal(undefined);
		expect(readFireCounters(short)).to.equal(undefined);
	});

	it('touches only its own two slots', () => {
		const status = newStatus();
		recordFire(status, 'copy-progress', 'load-bearing');
		const { redundant, loadBearing } = fireCounterPositions('copy-progress');
		for (let slot = 0; slot < status.length; slot++)
			if (slot !== redundant && slot !== loadBearing) expect(status[slot], `slot ${slot}`).to.equal(0);
	});
});

describe('readFireCounters', () => {
	it('omits mechanisms that have never fired, so a healthy link reports nothing', () => {
		expect(readFireCounters(newStatus())).to.equal(undefined);
	});

	it('reports every mechanism that has fired', () => {
		const status = newStatus();
		for (const mechanism of FIRE_MECHANISMS) recordFire(status, mechanism, 'load-bearing');
		expect(Object.keys(readFireCounters(status))).to.deep.equal(Array.from(FIRE_MECHANISMS));
	});

	it('reports nothing without a buffer', () => {
		expect(readFireCounters(undefined)).to.equal(undefined);
	});
});

describe('formatFireClassification', () => {
	it('carries the mechanism, the class and the running counts', () => {
		expect(formatFireClassification('receive-watchdog', 'redundant', { redundant: 3, loadBearing: 1 })).to.equal(
			'fire={mechanism: receive-watchdog, class: redundant, redundant: 3, loadBearing: 1}'
		);
	});

	it('drops the counts when there are none to report', () => {
		expect(formatFireClassification('blob-gap', 'unknown')).to.equal('fire={mechanism: blob-gap, class: unknown}');
	});
});
