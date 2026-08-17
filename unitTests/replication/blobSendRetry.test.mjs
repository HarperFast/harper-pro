/**
 * Coverage for the sender-side blob-read retry classification (harper-pro#683).
 *
 * Background: when a source blob read fails, `sendBlobs` forwards the error to the receiver in the
 * finishing BLOB_CHUNK. The receiver advances past PERMANENT classes (ENOENT/404/500, #403/#429)
 * but a TRANSIENT class latches its `hasBlobGap` — which never clears for the life of the
 * connection and pins the resume cursor (#683). The dominant transient class in the field is the
 * source failing to read its own PENDING placeholder (a rolling population left by concurrent
 * replication receives, #481) — a fault that measurably self-heals at the source within seconds.
 * So before forwarding a 503, `sendBlobs` now retries the read in place (only while nothing has
 * been sent yet); `isRetriableSourceBlobReadError` is the classifier gating that retry.
 */

import { expect } from 'chai';
import {
	isRetriableSourceBlobReadError,
	isPermanentSourceBlobErrorCode,
	shouldRetrySourceBlobRead,
	BLOB_SEND_RETRY_DELAYS_MS,
} from '#src/replication/replicationConnection';

describe('isRetriableSourceBlobReadError (#683)', () => {
	it('classifies a 503 read fault (pending replication / mid-write) as retriable', () => {
		const error = Object.assign(new Error('Blob pending replication for /blobs/x'), { statusCode: 503 });
		expect(isRetriableSourceBlobReadError(error)).to.equal(true);
	});

	it('does not classify the permanent statuses as retriable — they must forward immediately', () => {
		for (const statusCode of [404, 500]) {
			const error = Object.assign(new Error('gone'), { statusCode });
			expect(isRetriableSourceBlobReadError(error)).to.equal(false);
			// and the receiver-side taxonomy agrees these are the advance-past classes (#403/#429)
			expect(isPermanentSourceBlobErrorCode(undefined, statusCode)).to.equal(true);
		}
	});

	it('does not classify local fs faults or status-less errors as retriable', () => {
		expect(isRetriableSourceBlobReadError(Object.assign(new Error('io'), { code: 'EIO' }))).to.equal(false);
		expect(isRetriableSourceBlobReadError(Object.assign(new Error('gone'), { code: 'ENOENT' }))).to.equal(false);
		expect(isRetriableSourceBlobReadError(new Error('Blob send chunk timeout after 900000ms'))).to.equal(false);
	});

	it('is safe on non-object inputs', () => {
		expect(isRetriableSourceBlobReadError(null)).to.equal(false);
		expect(isRetriableSourceBlobReadError(undefined)).to.equal(false);
		expect(isRetriableSourceBlobReadError('503')).to.equal(false);
	});
});

describe('shouldRetrySourceBlobRead — the sendBlobs retry gate (#683)', () => {
	const retriable = Object.assign(new Error('Blob pending replication'), { statusCode: 503 });
	const base = { error: retriable, sentAnyChunk: false, wsClosed: false, draining: false, attempt: 0 };

	it('retries a 503 read fault while nothing has been sent and the connection is healthy', () => {
		expect(shouldRetrySourceBlobRead(base)).to.equal(true);
		expect(shouldRetrySourceBlobRead({ ...base, attempt: BLOB_SEND_RETRY_DELAYS_MS.length - 1 })).to.equal(true);
	});

	it('never retries once a chunk is on the wire — the receiver holds partial state', () => {
		expect(shouldRetrySourceBlobRead({ ...base, sentAnyChunk: true })).to.equal(false);
	});

	it('never retries on a closed connection or while draining for worker shutdown', () => {
		expect(shouldRetrySourceBlobRead({ ...base, wsClosed: true })).to.equal(false);
		expect(shouldRetrySourceBlobRead({ ...base, draining: true })).to.equal(false);
	});

	it('stops after the delay schedule is exhausted', () => {
		expect(shouldRetrySourceBlobRead({ ...base, attempt: BLOB_SEND_RETRY_DELAYS_MS.length })).to.equal(false);
	});

	it('never retries a non-503 error regardless of the other state', () => {
		expect(
			shouldRetrySourceBlobRead({ ...base, error: Object.assign(new Error('gone'), { statusCode: 404 }) })
		).to.equal(false);
		expect(shouldRetrySourceBlobRead({ ...base, error: new Error('Blob send chunk timeout after 900000ms') })).to.equal(
			false
		);
	});
});

describe('BLOB_SEND_RETRY_DELAYS_MS (#683)', () => {
	it('escalates and stays well inside the blob timeout window', () => {
		for (let i = 1; i < BLOB_SEND_RETRY_DELAYS_MS.length; i++) {
			expect(BLOB_SEND_RETRY_DELAYS_MS[i]).to.be.greaterThan(BLOB_SEND_RETRY_DELAYS_MS[i - 1]);
		}
		const total = BLOB_SEND_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
		// The whole retry budget must be negligible against REPLICATION_BLOBTIMEOUT (900s default):
		// a retrying send holds one of the MAX_OUTSTANDING_BLOBS_BEING_SENT slots while it waits.
		expect(total).to.be.lessThan(10_000);
	});
});
