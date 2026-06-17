// Test-only component: monkey-patches `fs.open` so that read-mode (`'r'`) opens of a DETERMINISTIC
// subset of blob files ALWAYS fail with `ENOENT` — modelling blobs that are GONE AT THE SOURCE (e.g.
// evicted/expired on an expiration cache table). When the replication SENDER tries to read such a blob
// to stream it (`sendBlobs` -> `blob.stream()` -> blob.ts read path's `fs.open(path, 'r', cb)`), the
// read fails; `sendBlobs` catches it and forwards a BLOB_CHUNK `error` marker carrying `errorCode:
// 'ENOENT'`, which is the trigger for the receive-side "source-reported permanent unavailable" branch
// under test (receiveBlobs -> markSourceBlobUnavailable/isUnrecoverableSourceBlobError -> advance the
// resume cursor past it instead of holding `hasBlobGap` forever). See harper-pro#403.
//
// Why a deterministic subset (by fileId) rather than "every Nth open": blob.ts's read path RETRIES on
// ENOENT (up to 1000×) while the blob might still be mid-write, so a counter that fails only one open
// per blob lets the retry succeed and the error never reaches `sendBlobs`. Keying the failure to the
// fileId (the path basename) makes EVERY open of those blobs fail — retries included — so the ENOENT
// deterministically propagates. The selected blobs are permanently unsendable; the rest replicate.
//
// Distinct from fixture-blob-fail-transient / fixture-blob-fail-injector, which patch the RECEIVER's
// `createWriteStream` to model a LOCAL save fault (which must keep HOLDING the cursor, not advance).
// Install on the SOURCE node. Toggle on with HARPER_TEST_BLOB_READ_FAIL_MODULUS=<positive int>: a blob
// is failed when parseInt(fileId, 16) % modulus === 0 (e.g. 5 fails ~1 in 5 blobs).
import { createRequire } from 'node:module';

const modulus = Number.parseInt(process.env.HARPER_TEST_BLOB_READ_FAIL_MODULUS || '0', 10);
if (Number.isFinite(modulus) && modulus > 0) {
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const path = require('node:path');
	const realOpen = fs.open;
	let failedReads = 0;
	const shouldFail = (p) => {
		if (typeof p !== 'string' || !p.includes('/blobs/')) return false;
		const fileId = path.basename(p);
		const id = Number.parseInt(fileId, 16);
		return Number.isFinite(id) && id % modulus === 0;
	};
	fs.open = function patchedOpen(p, flags, mode, cb) {
		// fs.open signatures: (path, cb) | (path, flags, cb) | (path, flags, mode, cb). Normalize so we
		// can inspect flags and find the callback regardless of arity.
		const callback = typeof cb === 'function' ? cb : typeof mode === 'function' ? mode : flags;
		const readMode = flags === 'r' || flags === undefined; // default flag is 'r'
		if (readMode && typeof callback === 'function' && shouldFail(p)) {
			const err = new Error("ENOENT: no such file or directory, open '" + p + "'");
			err.code = 'ENOENT';
			err.errno = -2;
			err.syscall = 'open';
			err.path = p;
			console.log('[blob-fail-source-read] failing read open #' + ++failedReads + ' ' + p);
			process.nextTick(() => callback(err));
			return;
		}
		return realOpen.apply(this, arguments);
	};
	console.log(
		'[blob-fail-source-read] installed; failing /blobs/ reads where parseInt(fileId,16) % ' + modulus + ' === 0'
	);
}
