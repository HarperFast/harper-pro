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
