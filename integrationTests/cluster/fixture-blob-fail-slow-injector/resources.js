// Test-only component: monkey-patches `fs.createWriteStream` so every /blobs/ save is SLOW
// (each write callback deferred by HARPER_TEST_BLOB_SLOW_MS) and every Nth save FAILS
// asynchronously with ENOENT (HARPER_TEST_BLOB_FAIL_INTERVAL, same as fixture-blob-fail-injector).
//
// The slowness keeps blob saves continuously in flight during a base copy — the field condition
// copyGapCursorBanking.test.mjs (harper-pro#699) needs: fast local saves drain between frames,
// which lets a copy bank by luck through blob-quiescent instants that never occur in production.
//
// Patches the CJS module object via `createRequire` (ESM namespaces are frozen); Harper's dist
// code resolves `createWriteStream` off the live module object at call time.
import { createRequire } from 'node:module';

const interval = Number.parseInt(process.env.HARPER_TEST_BLOB_FAIL_INTERVAL || '0', 10);
const slowMs = Number.parseInt(process.env.HARPER_TEST_BLOB_SLOW_MS || '0', 10);
if ((Number.isFinite(interval) && interval > 0) || (Number.isFinite(slowMs) && slowMs > 0)) {
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const { Writable } = require('node:stream');
	const realCreateWriteStream = fs.createWriteStream;
	let counter = 0;
	// Fault spacing is deterministic but APERIODIC (LCG jitter of ±3 around the interval). A fixed
	// `counter % interval` can phase-lock with a resumed copy whose per-cycle save count is a
	// multiple of the interval — every cycle then faults on its FIRST re-streamed save and no cycle
	// can bank progress, a test-harness livelock a real (supply-driven, non-periodic) fault
	// population does not exhibit.
	let seed = 1;
	let nextFailAt = interval;
	fs.createWriteStream = function patchedCreateWriteStream(path) {
		if (typeof path === 'string' && path.includes('/blobs/')) {
			counter++;
			if (interval > 0 && counter >= nextFailAt) {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				nextFailAt = counter + Math.max(2, interval - 3 + (seed % 7));
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
				console.log('[blob-fail-slow-injector] failing save ' + counter + ' ' + path);
				return stream;
			}
			if (slowMs > 0) {
				// Return the REAL stream (saveBlob reads fd/bytesWritten off it) with only write()
				// patched: the first chunk reports backpressure and releases a manual 'drain' after
				// slowMs, so every save is held in flight across frames without reordering data.
				const real = realCreateWriteStream.apply(this, arguments);
				const realWrite = real.write.bind(real);
				let writes = 0;
				let recordSeed = -1;
				real.write = function (chunk, enc, cb) {
					writes++;
					// write 1 is saveBlob's 8-byte header; write 2 starts the fixture payload, whose first
					// byte is (seed*131)&0xff — invert (131*43≡1 mod 256) to identify the record per save.
					if (writes === 2 && chunk?.length) {
						recordSeed = (chunk[0] * 43) & 0xff;
						console.log('[blob-save-start] ' + path + ' record=' + recordSeed);
					}
					const accepted = realWrite(chunk, enc, cb);
					if (writes > 1) return accepted;
					setTimeout(() => real.emit('drain'), slowMs);
					return false;
				};
				const done = (label) => () =>
					console.log(
						'[blob-save-' + label + '] ' + path + ' record=' + recordSeed + ' bytes=' + (real.bytesWritten ?? -1)
					);
				real.on('finish', done('done'));
				real.on('error', done('error'));
				return real;
			}
		}
		return realCreateWriteStream.apply(this, arguments);
	};
	console.log(
		'[blob-fail-slow-injector] installed; slowMs=' + slowMs + ' failing every ' + (interval || 0) + 'th /blobs/ save'
	);
}

export class LargeLocationImage extends Resource {
	async get(target) {
		target.checkPermission = false;
		const record = await databases.data.LargeLocation.get(Number(target.id));
		if (!record?.image) return new Response(null, { status: 404 });
		return new Response(record.image, { headers: { 'Content-Type': 'application/octet-stream' } });
	}
}
