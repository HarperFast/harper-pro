// Test-only component: monkey-patches `fs.createWriteStream` so that, after the first
// `HARPER_TEST_BLOB_FAIL_SKIP` write attempts targeting the blob storage tree succeed,
// the next `HARPER_TEST_BLOB_FAIL_COUNT` attempts fail asynchronously with ENOENT, and
// every attempt after that succeeds. This models a *transient* receive-side blob save
// fault that strikes mid-stream (after replication has already established a durable
// resume cursor) and then clears — the kind a correct receiver must recover from by
// resyncing from that cursor rather than silently advancing past the record.
//
// The SKIP window matters: a fault on the very first save means no resume cursor has
// been persisted yet, so there is nothing to resync from — not the case this guards.
// A count window (not "fail once per path") is used because blob fileIds are node-local
// sequence ids, so each save — including the resync's re-stream — lands at a new path;
// the originals fail inside the window, the re-streamed copies fall outside it and
// succeed. Companion to fixture-blob-fail-injector (permanent, every Nth). Toggle on
// with HARPER_TEST_BLOB_FAIL_COUNT=<positive int> (and optional HARPER_TEST_BLOB_FAIL_SKIP).
import { createRequire } from 'node:module';

const failCount = Number.parseInt(process.env.HARPER_TEST_BLOB_FAIL_COUNT || '0', 10);
// Two equivalent ways to express the success window before failures begin:
//   HARPER_TEST_BLOB_FAIL_SKIP   — number of initial /blobs/ saves to let succeed.
//   HARPER_TEST_BLOB_FAIL_START  — 1-based index of the first save to fail (== SKIP + 1).
// START takes precedence when set (used by blobGapDeadlock.test.mjs); SKIP is the original
// knob (used by replicationBlobResyncOnFailure.test.mjs).
const failStart = process.env.HARPER_TEST_BLOB_FAIL_START;
const failSkip =
	failStart !== undefined
		? Math.max(0, Number.parseInt(failStart, 10) - 1)
		: Number.parseInt(process.env.HARPER_TEST_BLOB_FAIL_SKIP || '0', 10);
if (Number.isFinite(failCount) && failCount > 0) {
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const { Writable } = require('node:stream');
	const realCreateWriteStream = fs.createWriteStream;
	let seen = 0;
	let failed = 0;
	fs.createWriteStream = function patchedCreateWriteStream(path) {
		if (typeof path === 'string' && path.includes('/blobs/')) {
			seen++;
			if (seen > failSkip && failed < failCount) {
				failed++;
				const stream = new Writable({
					write(_chunk, _enc, cb) {
						cb(new Error('test-injected: stream torn down'));
					},
				});
				stream.fd = null;
				process.nextTick(() => {
					const err = new Error("ENOENT: no such file or directory, open '" + path + "'");
					err.code = 'ENOENT';
					err.errno = -2;
					err.syscall = 'open';
					err.path = path;
					stream.emit('error', err);
				});
				console.log('[blob-fail-transient] failing save ' + seen + ' (' + failed + '/' + failCount + ') ' + path);
				return stream;
			}
		}
		return realCreateWriteStream.apply(this, arguments);
	};
	console.log('[blob-fail-transient] installed; failing ' + failCount + ' /blobs/ save(s) after the first ' + failSkip);
}
