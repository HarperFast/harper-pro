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
import {
	unconfirmedSendStallReason,
	withinUnconfirmedSendGrace,
	unconfirmedSendExemptionHolds,
	decodeDropResyncAllowed,
	decodeDropResyncEpisodeCount,
	UNCONFIRMED_SEND_MAX_GRACE_MS,
	DECODE_DROP_RESYNC_EPISODE_MS,
} from '#src/replication/replicationConnection';

const THRESHOLD = 20 * 60_000;
const NOW = 1_000_000_000;
const STALE = NOW - THRESHOLD; // exactly one threshold ago
const FRESH = NOW - 1_000;

// A healthy leg: the peer owes us nothing, the send path is current, and the peer is a build that
// re-confirms once its blobs go durable.
function healthy(overrides = {}) {
	return { unconfirmedSince: 0, sendProgressAt: FRESH, peerConfirmsBlobDrain: true, ...overrides };
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
		expect(reason(healthy({ sendProgressAt: 0 }))).to.equal(undefined);
	});

	it('withholds the peer-side shape from a peer that never re-confirms after a blob drain', () => {
		// Every build before harper-pro#810 confirms a blob-carrying commit once, clamped to its pre-blob
		// watermark, and never revises it — so on a rolling upgrade an upgraded sender would read a healthy,
		// fully durable, quiet leg as stalled and close it every threshold.
		expect(reason(healthy({ unconfirmedSince: STALE, peerConfirmsBlobDrain: false }))).to.equal(undefined);
	});

	it('still flags a stopped send path against such a peer: that shape reads only our own send path', () => {
		expect(reason(healthy({ sendProgressAt: STALE, peerConfirmsBlobDrain: false }))).to.equal('send-path-stopped');
	});

	it('reports the peer-side stall first when both shapes are true, without re-reading the range', () => {
		// Both are recovered the same way, but the reason lands in the fire log, so pin which one is named —
		// and the cheaper check must short-circuit the storage read.
		let probes = 0;
		expect(
			reason(healthy({ unconfirmedSince: STALE, sendProgressAt: STALE }), () => {
				probes++;
				return true;
			})
		).to.equal('peer-not-confirming');
		expect(probes).to.equal(0);
	});
});

describe('decodeDropResyncAllowed', () => {
	const INTERVAL = 5 * 60_000;

	it('allows the first resync on a connection', () => {
		expect(decodeDropResyncAllowed(0, 0, NOW, INTERVAL)).to.equal(true);
	});

	it('suppresses a second resync inside the interval', () => {
		// The trigger is the whole residual decode-failure bucket, not only the structure forks a
		// resubscribe repairs, so an undecodable record this build can never decode would otherwise close
		// on every frame carrying that table.
		expect(decodeDropResyncAllowed(NOW - INTERVAL + 1, 1, NOW, INTERVAL)).to.equal(false);
	});

	it('allows another once the interval has elapsed', () => {
		expect(decodeDropResyncAllowed(NOW - INTERVAL, 1, NOW, INTERVAL)).to.equal(true);
	});

	it('stops entirely once the budget is spent, however long ago the last one was', () => {
		// A frequency bound alone leaves an unrepairable fault rebuilding the subscription forever, which is
		// worse than the plain skip-and-advance it replaces.
		expect(decodeDropResyncAllowed(NOW - 10 * INTERVAL, 3, NOW, INTERVAL, 3)).to.equal(false);
	});
});

describe('withinUnconfirmedSendGrace', () => {
	it('holds the clock open while the peer genuinely cannot act', () => {
		expect(withinUnconfirmedSendGrace(NOW - 1_000, NOW)).to.equal(true);
	});

	it('releases it once the grace budget is spent, so the exemption itself is bounded', () => {
		// The cap has to end the EXEMPTION, not only the clock: a session that keeps one blob in the send
		// pipeline, or never leaves back-pressure, would otherwise skip the stall check on every tick for
		// the life of the connection and the wedge this net exists to catch would be invisible again.
		expect(withinUnconfirmedSendGrace(NOW - UNCONFIRMED_SEND_MAX_GRACE_MS, NOW)).to.equal(false);
	});

	it('is not open for an episode that never started', () => {
		expect(withinUnconfirmedSendGrace(0, NOW)).to.equal(false);
	});
});

describe('decodeDropResyncEpisodeCount', () => {
	it('carries the count forward inside one episode', () => {
		expect(decodeDropResyncEpisodeCount(NOW - DECODE_DROP_RESYNC_EPISODE_MS + 1, 3, NOW)).to.equal(3);
	});

	it('starts a fresh episode once the gap exceeds the window, restoring the budget', () => {
		// A lifetime budget turns "this decode class is unrepairable" into "this peer can never be repaired
		// again": three separate forks genuinely repaired over months would silently drop every record of
		// that table on the fourth, forever, until the process restarts.
		expect(decodeDropResyncEpisodeCount(NOW - DECODE_DROP_RESYNC_EPISODE_MS, 3, NOW)).to.equal(0);
		expect(decodeDropResyncAllowed(NOW - DECODE_DROP_RESYNC_EPISODE_MS, 0, NOW, 5 * 60_000, 3)).to.equal(true);
	});

	it('keeps a spent budget spent while the drops keep coming, however long the fault runs', () => {
		// The episode measures DROPS, not allowed resyncs. Keyed off the last resync instead, a decode class
		// no resubscribe repairs would have its rejected drops age the clock out and be handed three more
		// reconnects every hour, forever — the churn the budget exists to stop.
		expect(decodeDropResyncEpisodeCount(NOW - 1_000, 3, NOW)).to.equal(3);
		expect(decodeDropResyncAllowed(NOW - 10 * DECODE_DROP_RESYNC_EPISODE_MS, 3, NOW, 5 * 60_000, 3)).to.equal(false);
	});

	it('leaves a peer that has never dropped a record alone', () => {
		expect(decodeDropResyncEpisodeCount(0, 0, NOW)).to.equal(0);
	});
});

describe('unconfirmedSendExemptionHolds', () => {
	const GRACE = UNCONFIRMED_SEND_MAX_GRACE_MS;

	it('holds with no ceiling while the send path is still moving data', () => {
		// The case the cap got wrong: a blob big enough to outlast any fixed grace is still putting chunks
		// on the wire, which is the healthy leg this net exists to protect. Long past the grace, still held.
		expect(unconfirmedSendExemptionHolds(NOW - 1_000, NOW - 10 * GRACE, NOW, THRESHOLD)).to.equal(true);
	});

	it('releases once the exemption itself stops progressing and the grace is spent', () => {
		// Blobs registered as sending that have stopped producing chunks: a wedge wearing the exemption's
		// clothes, and the only thing the cap is meant to bound.
		expect(unconfirmedSendExemptionHolds(NOW - THRESHOLD, NOW - GRACE, NOW, THRESHOLD)).to.equal(false);
	});

	it('falls back to the time grace when the sender has nothing to show yet', () => {
		// The peer cannot act and this sender has not moved data either — the window the grace covers.
		expect(unconfirmedSendExemptionHolds(0, NOW - 1_000, NOW, THRESHOLD)).to.equal(true);
		expect(unconfirmedSendExemptionHolds(0, NOW - GRACE, NOW, THRESHOLD)).to.equal(false);
	});
});
