// Test-only component: monkey-patches `fs.createWriteStream` so that a bounded *window* of
// receive-side blob saves fail asynchronously with ENOENT, then it stops failing. This models a
// TRANSIENT blob gap (e.g. a brief disk/path hiccup): after the window the node SHOULD recover and
// converge. It is the trigger for the blob-gap deadlock repro (blobGapDeadlock.test.mjs): a save
// failure tears down a receive-side blob stream mid-stream, while other blobs are still in flight
// and the apply queue is over its high-water mark — the precondition for the receive/apply circular
// wait fixed by handling BLOB_CHUNK frames off the serialized message chain.
//
// Distinct from fixture-blob-fail-injector (which fails every Nth save forever, for the
// containment regression). Here we fail saves number [START, START+COUNT) and then never again.
//
// Env:
//   HARPER_TEST_BLOB_FAIL_START  — 1-based index of the first /blobs/ save to fail (default 8)
//   HARPER_TEST_BLOB_FAIL_COUNT  — how many consecutive saves to fail (default 6); 0 disables
import { createRequire } from 'node:module';

const start = Number.parseInt(process.env.HARPER_TEST_BLOB_FAIL_START || '8', 10);
const count = Number.parseInt(process.env.HARPER_TEST_BLOB_FAIL_COUNT || '6', 10);
if (Number.isFinite(count) && count > 0) {
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const { Writable } = require('node:stream');
	const realCreateWriteStream = fs.createWriteStream;
	let counter = 0;
	let failed = 0;
	fs.createWriteStream = function patchedCreateWriteStream(path) {
		if (typeof path === 'string' && path.includes('/blobs/')) {
			counter++;
			if (counter >= start && failed < count) {
				failed++;
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
				console.log('[blob-fail-transient] failing save #' + counter + ' (' + failed + '/' + count + ')');
				return stream;
			}
		}
		return realCreateWriteStream.apply(this, arguments);
	};
	console.log(
		'[blob-fail-transient] installed; failing /blobs/ saves #' +
			start +
			'..#' +
			(start + count - 1) +
			' then recovering'
	);
}
