/**
 * The sending session's own stall check (harper-pro#810).
 *
 * A subscription parked at connected:true + RECEIVING_STATUS_WAITING with no receive progress is
 * invisible to BOTH main-thread reconcile nets — findWedgedNodeUrls requires connected !== true and
 * isReceiveStalled requires RECEIVING_STATUS_RECEIVING — so it stayed wedged for ~21h in the field with
 * every health surface green. Relaxing the status check is not available either: WAITING with an old
 * lastReceivedTime is equally the signature of a healthy idle leg.
 *
 * Two clocks decide it, and both are about what the SENDER is owed rather than how long the session has
 * existed. `unconfirmedSince` starts when the peer first falls behind what we sent, so a base copy — which
 * emits no confirmable frame until it completes — gets a full threshold of grace from its final frame
 * rather than arriving with an already-expired clock. `sendProgressAt` stays current for a sender that is
 * skipping every record for this peer, walking a withheld stretch of a copy, or streaming blob chunks
 * while parked on drain; all of those produce no confirmations and would otherwise look stopped. The
 * range re-read is the last gate, and it is what keeps the check off a node that merely receives from a
 * third peer.
 */

import { expect } from 'chai';
import { unconfirmedSendStallReason } from '#src/replication/replicationConnection';

const THRESHOLD = 20 * 60_000;
const NOW = 1_000_000_000;
const STALE = NOW - THRESHOLD; // exactly one threshold ago
const FRESH = NOW - 1_000;

// A healthy leg: the peer owes us nothing and the send path is current.
function healthy(overrides = {}) {
	return { unconfirmedSince: 0, sendProgressAt: FRESH, ...overrides };
}

// `hasUnsentWork` stands in for the session's re-read of its own send range.
function reason(state, hasUnsentWork = () => true) {
	return unconfirmedSendStallReason(state, NOW, THRESHOLD, hasUnsentWork);
}

describe('unconfirmedSendStallReason', () => {
	it('is quiet for a healthy leg', () => {
		expect(reason(healthy())).to.equal(undefined);
	});

	it('flags a peer that has owed us a confirmation for the whole threshold', () => {
		expect(reason(healthy({ unconfirmedSince: STALE }))).to.equal('peer-not-confirming');
	});

	it('does not flag a peer that is merely slow: confirming something new restarts the clock', () => {
		expect(reason(healthy({ unconfirmedSince: NOW - THRESHOLD + 1 }))).to.equal(undefined);
	});

	it('does not flag a peer that owes us nothing, however long the session has run', () => {
		expect(reason(healthy({ unconfirmedSince: 0, sendProgressAt: FRESH }))).to.equal(undefined);
	});

	it('gives a base copy a full threshold from its first confirmable frame, not from session start', () => {
		// A copy emits no confirmable frame until COPY_COMPLETE. A clock seeded at subscription setup would
		// already be expired when that frame finally makes the peer owe us, and the next 30s back-pressure
		// tick would tear down a healthy multi-hour copy while its receiver was still draining.
		expect(reason(healthy({ unconfirmedSince: NOW - 1 }))).to.equal(undefined);
	});

	it('flags a send loop that has produced nothing while its own range still holds work', () => {
		// The diagnosed failure: a transaction-log iterator stopped at a corrupt frame. The loop drains an
		// already-done iterable on every wake, so nothing is sent, skipped or copied — but a fresh read of
		// the same range still finds the entries sitting behind it.
		expect(reason(healthy({ sendProgressAt: STALE }))).to.equal('send-path-stopped');
	});

	it('does not flag a quiet source: the send range holds nothing for this peer', () => {
		expect(reason(healthy({ sendProgressAt: STALE }), () => false)).to.equal(undefined);
	});

	it('does not re-read the send range while the send path is current', () => {
		// The re-read is storage work on a live connection, so a busy sender must never pay for it. A QUIET
		// leg does reach it — its progress clock is permanently stale — which is why the session caches a
		// "nothing to send" answer rather than re-probing every tick.
		let probes = 0;
		reason(healthy(), () => {
			probes++;
			return true;
		});
		expect(probes).to.equal(0);
	});

	it('does not flag a send path that is still advancing', () => {
		// Skipped records, withheld copy stretches and blob chunks all stamp progress and produce no
		// confirmation, so only this clock separates them from a stopped sender.
		expect(reason(healthy({ sendProgressAt: NOW - THRESHOLD / 2 }))).to.equal(undefined);
	});

	it('does not flag a session that has done nothing at all yet', () => {
		expect(reason({ unconfirmedSince: 0, sendProgressAt: 0 })).to.equal(undefined);
	});

	it('reports the peer-side stall first when both shapes are true, without re-reading the range', () => {
		// Both are recovered the same way, but the reason lands in the fire log, so pin which one is named —
		// and the cheaper check must short-circuit the storage read.
		let probes = 0;
		expect(
			reason({ unconfirmedSince: STALE, sendProgressAt: STALE }, () => {
				probes++;
				return true;
			})
		).to.equal('peer-not-confirming');
		expect(probes).to.equal(0);
	});
});
