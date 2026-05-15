// Test-only component: monkey-patches `fs.createWriteStream` so that every Nth call
// targeting the blob storage tree fails asynchronously with `ENOENT`. Drives the
// receive-side blob save path in `replication/replicationConnection.ts:receiveBlobs`
// into its rejection branch on demand. Used by `blobSaveRejectionContainment.test.mjs`.
//
// We patch the CJS module object obtained via `createRequire` rather than mutating
// an ESM namespace (which is frozen). Harper's dist code uses `require('node:fs')`,
// so the live property is what `createWriteStream` callers look up at call time.
// Toggle on with `HARPER_TEST_BLOB_FAIL_INTERVAL=<positive int>`.
import { createRequire } from 'node:module';

const interval = Number.parseInt(process.env.HARPER_TEST_BLOB_FAIL_INTERVAL || '0', 10);
if (Number.isFinite(interval) && interval > 0) {
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const { Writable } = require('node:stream');
	const realCreateWriteStream = fs.createWriteStream;
	let counter = 0;
	fs.createWriteStream = function patchedCreateWriteStream(path) {
		if (typeof path === 'string' && path.includes('/blobs/')) {
			counter++;
			if (counter % interval === 0) {
				// Emit ENOENT on next tick so the caller's listeners are wired first —
				// matches how real createWriteStream surfaces fs.open failures.
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
				return stream;
			}
		}
		return realCreateWriteStream.apply(this, arguments);
	};
	// One-line marker so tests can assert the patch actually installed.
	// Plain console.log goes to the test runner via the harness's log redirect.
	console.log('[blob-fail-injector] installed; failing every ' + interval + 'th /blobs/ createWriteStream');
}
