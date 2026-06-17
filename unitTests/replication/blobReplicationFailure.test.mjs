/**
 * Coverage for the blob-replication divergence signal (harper-pro#386).
 *
 * Background: on the receive side a blob save can fail (e.g. the disrupted catch-up stream behind
 * #368). The record still commits, so the socket stays `connected: true`, but the blob bytes are not
 * durably stored and the resume cursor holds (`hasBlobGap`). On a SUSTAINED failing link a peer can
 * silently diverge toward unrecoverable loss while the only signal is per-blob `error` log spam an
 * operator would not notice. `recordBlobReplicationFailure` writes that divergence into the per-peer
 * shared status (the same Float64Array `cluster_status` reads) as a cumulative count plus the time of
 * the most recent failure, so it becomes an observable metric.
 *
 * The helper is a deterministic pure function (mirrors `isBlobStreamTimedOut`): the production caller
 * is the blob-save `.catch` in `receiveBlobs`, which passes `getSharedStatus()` and `Date.now()`.
 */

import { expect } from 'chai';
import {
	recordBlobReplicationFailure,
	shouldLogSustainedBlobDivergence,
	markSourceBlobUnavailable,
	isUnrecoverableSourceBlobError,
	isPermanentSourceBlobErrorCode,
	BLOB_FAILURE_COUNT_POSITION,
	LAST_BLOB_FAILURE_TIME_POSITION,
	BACK_PRESSURE_RATIO_POSITION,
} from '#src/replication/replicationConnection';

// The shared status buffer is 128 bytes = 16 Float64 slots (see getReplicationSharedStatus).
const newSharedStatus = () => new Float64Array(16);

describe('recordBlobReplicationFailure — blob divergence metric (#386)', () => {
	it('bumps the cumulative count and returns the new count', () => {
		const status = newSharedStatus();
		expect(recordBlobReplicationFailure(status, 1_000)).to.equal(1);
		expect(recordBlobReplicationFailure(status, 2_000)).to.equal(2);
		expect(recordBlobReplicationFailure(status, 3_000)).to.equal(3);
		expect(status[BLOB_FAILURE_COUNT_POSITION]).to.equal(3);
	});

	it('stamps the most-recent failure time on each call', () => {
		const status = newSharedStatus();
		recordBlobReplicationFailure(status, 1_000);
		expect(status[LAST_BLOB_FAILURE_TIME_POSITION]).to.equal(1_000);
		recordBlobReplicationFailure(status, 5_000);
		expect(status[LAST_BLOB_FAILURE_TIME_POSITION]).to.equal(5_000); // overwrites, not accumulates
	});

	it('does not touch the other (status) slots', () => {
		const status = newSharedStatus();
		status[BACK_PRESSURE_RATIO_POSITION] = 0.42; // a neighbouring status field
		recordBlobReplicationFailure(status, 1_000);
		expect(status[BACK_PRESSURE_RATIO_POSITION]).to.equal(0.42);
	});

	it('is a safe no-op when the shared status is not yet allocated', () => {
		expect(recordBlobReplicationFailure(undefined, 1_000)).to.equal(0);
	});

	it('a healthy link reports zero failures and no failure time', () => {
		const status = newSharedStatus();
		expect(status[BLOB_FAILURE_COUNT_POSITION]).to.equal(0);
		expect(status[LAST_BLOB_FAILURE_TIME_POSITION]).to.equal(0); // asDate(0) === undefined in cluster_status
	});
});

describe('shouldLogSustainedBlobDivergence — one-per-connection escalation latch (#386)', () => {
	const THRESHOLD = 5;

	it('does not escalate below the threshold', () => {
		for (let count = 1; count < THRESHOLD; count++) {
			expect(shouldLogSustainedBlobDivergence(count, THRESHOLD, false)).to.equal(false);
		}
	});

	it('escalates exactly when the count first reaches the threshold', () => {
		expect(shouldLogSustainedBlobDivergence(THRESHOLD, THRESHOLD, false)).to.equal(true);
	});

	it('does not escalate again once already logged, even past the threshold', () => {
		expect(shouldLogSustainedBlobDivergence(THRESHOLD, THRESHOLD, true)).to.equal(false);
		expect(shouldLogSustainedBlobDivergence(THRESHOLD + 100, THRESHOLD, true)).to.equal(false);
	});

	it('models the call-site loop: fires once, on the threshold-crossing failure only', () => {
		let logged = false;
		const firedAt = [];
		for (let count = 1; count <= THRESHOLD + 3; count++) {
			if (shouldLogSustainedBlobDivergence(count, THRESHOLD, logged)) {
				logged = true;
				firedAt.push(count);
			}
		}
		expect(firedAt).to.deep.equal([THRESHOLD]); // single fire, at the crossing
	});
});

describe('isUnrecoverableSourceBlobError — source-missing vs local/transient classification (#403)', () => {
	it('treats an error marked by markSourceBlobUnavailable as unrecoverable', () => {
		const err = markSourceBlobUnavailable(new Error('Blob error: ENOENT ... from peerA'));
		expect(isUnrecoverableSourceBlobError(err)).to.equal(true);
	});

	it('markSourceBlobUnavailable returns the same error instance (so it can wrap a throw/destroy arg)', () => {
		const err = new Error('boom');
		expect(markSourceBlobUnavailable(err)).to.equal(err);
	});

	it('does NOT treat a plain local/transient save error as unrecoverable', () => {
		// The receiver-side injected ENOENT (fixture-blob-fail-transient / -injector) is a local fault:
		// it is never marked, so it must keep holding the cursor (hasBlobGap), not advance past.
		const localEnoent = new Error("ENOENT: no such file or directory, open '/.../blobs/0/0/3e0'");
		localEnoent.code = 'ENOENT';
		expect(isUnrecoverableSourceBlobError(localEnoent)).to.equal(false);
	});

	it('is false for non-error / nullish values', () => {
		expect(isUnrecoverableSourceBlobError(null)).to.equal(false);
		expect(isUnrecoverableSourceBlobError(undefined)).to.equal(false);
		expect(isUnrecoverableSourceBlobError('Blob error: ...')).to.equal(false);
		expect(isUnrecoverableSourceBlobError({})).to.equal(false);
		expect(isUnrecoverableSourceBlobError({ sourceBlobUnavailable: false })).to.equal(false);
	});
});

describe('isPermanentSourceBlobErrorCode — only ENOENT is a permanent source absence (#403)', () => {
	it('treats ENOENT (evicted/expired blob) as permanent → advance past', () => {
		expect(isPermanentSourceBlobErrorCode('ENOENT')).to.equal(true);
	});

	it('treats transient sender faults as NOT permanent → hold the gap and retry on reconnect', () => {
		// The crux of the cross-model-review blocker: a transient source read fault must not be skipped.
		for (const code of ['EIO', 'EMFILE', 'EACCES', 'EBUSY', 'ETIMEDOUT']) {
			expect(isPermanentSourceBlobErrorCode(code), code).to.equal(false);
		}
	});

	it('treats a missing code (older sender that does not forward one) as NOT permanent — safe hold default', () => {
		expect(isPermanentSourceBlobErrorCode(undefined)).to.equal(false);
		expect(isPermanentSourceBlobErrorCode(null)).to.equal(false);
		expect(isPermanentSourceBlobErrorCode('')).to.equal(false);
	});
});
