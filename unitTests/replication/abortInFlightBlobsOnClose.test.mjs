/**
 * Coverage for aborting in-flight blob receives when a replication connection closes
 * (harper-pro#385/#386 family — deploy_component worker-restart blob divergence).
 *
 * Background: a component deploy triggers `Restarting http_workers`, which tears down the sending
 * worker mid-blob and closes the replication WS. Before this fix the receiver left each half-written
 * blob stream in `blobsInFlight` for core's source-idle watchdog to reap `blobTimeout`
 * (REPLICATION_BLOBTIMEOUT — up to 15 min) later; only then did it stamp a PENDING stub, so the
 * diverged blob lingered for the whole timeout before the reconnect could re-request it (observed live
 * as a week-old 62-byte PENDING stub).
 *
 * `abortInFlightBlobsOnClose` destroys every in-flight receive immediately on close with a plain Error.
 * `receiveBlobs`'s `.catch` classifies that as TRANSIENT (not `sourceBlobUnavailable`, not a permanent
 * source error), so it sets `hasBlobGap` → the resume cursor clamps at the last durable transaction →
 * the reconnect re-streams the blob promptly rather than after the full timeout.
 */

import { expect } from 'chai';
import {
	abortInFlightBlobsOnClose,
	isReplicationConnectionClosedError,
	isUnrecoverableSourceBlobError,
	isPermanentSourceBlobErrorCode,
} from '#src/replication/replicationConnection';

const makeStream = () => {
	const stream = { destroyedWith: undefined };
	stream.destroy = (error) => {
		stream.destroyedWith = error;
	};
	return stream;
};

describe('abortInFlightBlobsOnClose — re-request in-flight blobs on connection close', () => {
	it('destroys every in-flight stream, empties the map, and returns the count', () => {
		const a = makeStream();
		const b = makeStream();
		const blobsInFlight = new Map([
			['blob-a', a],
			['blob-b', b],
		]);

		const aborted = abortInFlightBlobsOnClose(blobsInFlight, 'peer-node');

		expect(aborted).to.equal(2);
		expect(blobsInFlight.size).to.equal(0);
		expect(a.destroyedWith).to.be.an('error');
		expect(b.destroyedWith).to.be.an('error');
	});

	it('destroys with a TRANSIENT error so the receiver clamps + re-requests (not advance-past)', () => {
		const stream = makeStream();
		abortInFlightBlobsOnClose(new Map([['blob-1', stream]]), 'peer-node');

		const err = stream.destroyedWith;
		// Must NOT be classified as an unrecoverable/permanent source-missing error — otherwise
		// receiveBlobs would advance the resume cursor past the blob (permanent divergence) instead of
		// clamping and re-streaming on reconnect.
		expect(isUnrecoverableSourceBlobError(err)).to.equal(false);
		expect(isPermanentSourceBlobErrorCode(err.code, err.statusCode)).to.equal(false);
	});

	it('marks the error as a connection-closed interruption (quiet transient, not a divergence)', () => {
		const stream = makeStream();
		abortInFlightBlobsOnClose(new Map([['blob-1', stream]]), 'peer-node');
		// receiveBlobs keys on this to clamp + re-request WITHOUT logging an error or bumping the
		// divergence metric — routine on every deploy-driven worker restart.
		expect(isReplicationConnectionClosedError(stream.destroyedWith)).to.equal(true);
		// A plain error (any other save fault) is NOT treated as a connection-closed interruption.
		expect(isReplicationConnectionClosedError(new Error('some other save fault'))).to.equal(false);
		expect(isReplicationConnectionClosedError(undefined)).to.equal(false);
	});

	it('names the peer and blob id in the error for diagnosability', () => {
		const stream = makeStream();
		abortInFlightBlobsOnClose(new Map([['blob-xyz', stream]]), 'us-west1-node');
		expect(stream.destroyedWith.message).to.contain('us-west1-node');
		expect(stream.destroyedWith.message).to.contain('blob-xyz');
	});

	it('invokes onAbort for each blob id (in-flight marker cleanup parity with the sweep)', () => {
		const unregistered = [];
		const blobsInFlight = new Map([
			['blob-a', makeStream()],
			['blob-b', makeStream()],
		]);
		abortInFlightBlobsOnClose(blobsInFlight, 'peer-node', (id) => unregistered.push(id));
		expect(unregistered).to.have.members(['blob-a', 'blob-b']);
	});

	it('preserves a completed-but-unconnected stream (writableEnded — chunks outran its record)', () => {
		// A fully-received blob waiting for its transaction record must survive close: an in-flight handler
		// can still attach and save it. Destroying it would discard received bytes (Codex P2).
		const completed = makeStream();
		completed.writableEnded = true;
		const stillReceiving = makeStream();
		const blobsInFlight = new Map([
			['done', completed],
			['receiving', stillReceiving],
		]);

		const aborted = abortInFlightBlobsOnClose(blobsInFlight, 'peer-node');

		expect(aborted).to.equal(1); // only the still-receiving stream
		expect(completed.destroyedWith).to.equal(undefined); // preserved
		expect(blobsInFlight.has('done')).to.equal(true);
		expect(stillReceiving.destroyedWith).to.be.an('error');
		expect(blobsInFlight.has('receiving')).to.equal(false);
	});

	it('releases the in-flight marker for a preserved writableEnded stream without destroying or dropping it (cb1kenobi review, harper-pro#527)', () => {
		// If the preserved stream's record never arrives, nothing else ever unregisters its
		// registerBlobReceiveInFlight marker (receiveBlobs's .finally never runs for a stream it never
		// touched, and blobsTimer is already cleared on close) — a permanent leak that pins
		// isBlobReceiveInFlight true (503-forever reads of that blob) until process restart. onAbort must
		// still fire for it even though it is not counted as "aborted" and stays in the map.
		const unregistered = [];
		const completed = makeStream();
		completed.writableEnded = true;
		const blobsInFlight = new Map([['done', completed]]);

		const aborted = abortInFlightBlobsOnClose(blobsInFlight, 'peer-node', (id) => unregistered.push(id));

		expect(aborted).to.equal(0); // preserved, not counted as an abort
		expect(completed.destroyedWith).to.equal(undefined); // still preserved
		expect(blobsInFlight.has('done')).to.equal(true); // still preserved
		expect(unregistered).to.have.members(['done']); // but its marker was released
	});

	it('is a no-op (returns 0) when nothing is in flight', () => {
		const blobsInFlight = new Map();
		expect(abortInFlightBlobsOnClose(blobsInFlight, 'peer-node')).to.equal(0);
		expect(blobsInFlight.size).to.equal(0);
	});

	it('tolerates a stream without a destroy method', () => {
		const blobsInFlight = new Map([['blob-1', {}]]);
		expect(() => abortInFlightBlobsOnClose(blobsInFlight, 'peer-node')).to.not.throw();
		expect(blobsInFlight.size).to.equal(0);
	});
});
