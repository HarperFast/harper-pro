// Test-only component: after /ArmBlobFaultInjector is called, monkey-patches data-database
// /blobs/ saves so every save is SLOW (each write callback deferred by
// HARPER_TEST_BLOB_SLOW_MS) and selected saves FAIL asynchronously with ENOENT
// (HARPER_TEST_BLOB_FAIL_SAVES: `<record>:<n>` fails that record's n-th fresh save,
// `<record>:repair` fails its first in-place repair save).
//
// The slowness keeps blob saves continuously in flight during a base copy — the field condition
// copyGapCursorBanking.test.mjs (harper-pro#699) needs: fast local saves drain between frames,
// which lets a copy bank by luck through blob-quiescent instants that never occur in production.
//
// Faults are selected by record, not by a global save ordinal: the base copy's post-walk log tail
// can re-deliver records the walk already copied, and an ordinal schedule cannot tell those extra
// saves from the walk's. A record is only identifiable from its payload, whose first byte arrives on
// the stream's second write (core's writeBlobWithStream writes the 8-byte size header first, then
// pipes the body), so the header write is held back until then and a failure is raised before any
// byte reaches the file.
//
// Patches the CJS module object via `createRequire` (ESM namespaces are frozen); Harper's dist
// code resolves `createWriteStream` off the live module object at call time.
import { createRequire } from 'node:module';

const failSaves = new Set(
	(process.env.HARPER_TEST_BLOB_FAIL_SAVES || '')
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean)
);
const slowMs = Number.parseInt(process.env.HARPER_TEST_BLOB_SLOW_MS || '0', 10);
let armed = false;
let attempts = new Map();
if (failSaves.size > 0 || (Number.isFinite(slowMs) && slowMs > 0)) {
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const realCreateWriteStream = fs.createWriteStream;
	fs.createWriteStream = function patchedCreateWriteStream(path) {
		if (armed && typeof path === 'string' && path.includes('/blobs/data/')) {
			const isRepair = path.endsWith('.repair');
			// Return the REAL stream (saveBlob reads fd/bytesWritten off it) with only write() patched.
			const real = realCreateWriteStream.apply(this, arguments);
			const realWrite = real.write.bind(real);
			const realEnd = real.end.bind(real);
			let writes = 0;
			let header;
			let recordSeed = -1;
			const flushHeader = () => {
				if (!header) return;
				realWrite(...header);
				header = undefined;
			};
			real.end = function () {
				flushHeader();
				return realEnd(...arguments);
			};
			real.write = function (chunk, enc, cb) {
				writes++;
				if (writes === 1) {
					// The size header: held until the record is known, so a failed save leaves an empty
					// file (the receiver stamps it PENDING), never a partial one.
					header = [chunk, enc, cb];
					return false;
				}
				if (writes === 2) {
					// The fixture payload's first byte is (seed*131)&0xff — invert (131*43≡1 mod 256).
					recordSeed = chunk?.length ? (chunk[0] * 43) & 0xff : -1;
					const counters = attempts.get(recordSeed) ?? { fresh: 0, repair: 0 };
					attempts.set(recordSeed, counters);
					const attempt = isRepair
						? ++counters.repair === 1 && `${recordSeed}:repair`
						: `${recordSeed}:${++counters.fresh}`;
					if (attempt && failSaves.has(attempt)) {
						console.log('[blob-fail-slow-injector] failing save ' + attempt + ' ' + path);
						const err = new Error("ENOENT: no such file or directory, open '" + path + "'");
						err.code = 'ENOENT';
						err.errno = -2;
						err.syscall = 'open';
						err.path = path;
						const heldHeaderCallback = header[2];
						header = undefined;
						process.nextTick(() => {
							real.emit('error', err);
							heldHeaderCallback?.(err);
							cb?.(err);
						});
						return false;
					}
					console.log('[blob-save-start] ' + path + ' record=' + recordSeed);
					flushHeader();
					const accepted = realWrite(chunk, enc, cb);
					if (slowMs <= 0) return accepted;
					// The first payload chunk reports backpressure and a manual 'drain' releases the pipe
					// after slowMs, so every save is held in flight across frames without reordering data.
					setTimeout(() => real.emit('drain'), slowMs);
					return false;
				}
				return realWrite(chunk, enc, cb);
			};
			const done = (label) => () =>
				console.log(
					'[blob-save-' + label + '] ' + path + ' record=' + recordSeed + ' bytes=' + (real.bytesWritten ?? -1)
				);
			real.on('finish', done('done'));
			real.on('error', done('error'));
			return real;
		}
		return realCreateWriteStream.apply(this, arguments);
	};
	console.log(
		'[blob-fail-slow-injector] installed; waiting to arm; slowMs=' +
			slowMs +
			' failing data /blobs/ saves ' +
			[...failSaves].join(',')
	);
}

export class ArmBlobFaultInjector extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		attempts = new Map();
		armed = true;
		console.log('[blob-fail-slow-injector] armed');
		return { armed, failSaves: [...failSaves] };
	}
}

export class LargeLocationImage extends Resource {
	async get(target) {
		target.checkPermission = false;
		const record = await databases.data.LargeLocation.get(Number(target.id));
		if (!record?.image) return new Response(null, { status: 404 });
		return new Response(record.image, { headers: { 'Content-Type': 'application/octet-stream' } });
	}
}
