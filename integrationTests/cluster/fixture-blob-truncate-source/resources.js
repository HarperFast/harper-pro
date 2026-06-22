// Test-only component: makes a DETERMINISTIC subset of blob files on the SOURCE end up
// TRUNCATED on disk — the header still records the full (uncompressed) size, but the body is
// short. This models a confidently-incomplete source blob (e.g. a partial write that a self-
// consistent header no longer matches), distinct from a MISSING one (fixture-blob-fail-source-read,
// which models ENOENT). It is the source state behind harper-pro#429 and harper#1424.
//
// Mechanism: we let each blob write complete normally, then on the write stream's `close` we
// `truncateSync` the file to KEEP_BYTES (header + a little body). When the replication SENDER later
// reads such a blob to stream it (`sendBlobs` -> `blob.stream()`), core (harper#1425) sees the body
// fall short of the header's declared size after the writer has finished and rejects with a
// `BlobReadError('Blob is incomplete', 500)` — NOT an ENOENT. `sendBlobs` forwards that as a
// BLOB_CHUNK `error` marker carrying `errorStatus: 500`, which is the trigger for the receive-side
// permanent-classification branch under test: `isPermanentSourceBlobErrorCode(_, 500)` ->
// `markSourceBlobUnavailable` -> advance the resume cursor past it (harper-pro#429), rather than
// holding `hasBlobGap` forever and wedging the connection.
//
// Why a deterministic subset (by fileId, like fixture-blob-fail-source-read): a counter-based choice
// races with blob.ts's read-retry-while-being-written loop. Keying the truncation to the fileId (the
// path basename) makes EVERY read of those blobs see the same short file, so the 500 deterministically
// propagates. The selected blobs are permanently un-sendable as complete; the rest replicate normally.
//
// Distinct from fixture-blob-fail-transient / fixture-blob-fail-injector, which patch the RECEIVER's
// `createWriteStream` to model a LOCAL save fault (which must keep HOLDING the cursor, not advance).
// Install on the SOURCE node. Toggle on with HARPER_TEST_BLOB_TRUNCATE_MODULUS=<positive int>: a blob
// file is truncated when parseInt(fileId, 16) % modulus === 0 (e.g. 5 truncates ~1 in 5 blobs).
import { createRequire } from 'node:module';

const modulus = Number.parseInt(process.env.HARPER_TEST_BLOB_TRUNCATE_MODULUS || '0', 10);
// Keep the 8-byte header plus a little body, so the file still has a valid, full-size header but a body
// that is clearly short of it — the "confidently incomplete" state, not "too small to hold a header".
const KEEP_BYTES = Number.parseInt(process.env.HARPER_TEST_BLOB_TRUNCATE_KEEP || '1024', 10);

if (Number.isFinite(modulus) && modulus > 0) {
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const path = require('node:path');
	const realCreateWriteStream = fs.createWriteStream;
	let truncated = 0;
	const shouldTruncate = (p) => {
		if (typeof p !== 'string' || !p.includes('/blobs/')) return false;
		const fileId = path.basename(p);
		const id = Number.parseInt(fileId, 16);
		return Number.isFinite(id) && id % modulus === 0;
	};
	fs.createWriteStream = function patchedCreateWriteStream(p) {
		const stream = realCreateWriteStream.apply(this, arguments);
		if (shouldTruncate(p)) {
			// Truncate AFTER the write has fully flushed and closed, so the header (written first, full
			// size) survives and only the body is cut. Reads then see header.size > on-disk body length.
			stream.on('close', () => {
				try {
					const { size } = fs.statSync(p);
					if (size > KEEP_BYTES) {
						fs.truncateSync(p, KEEP_BYTES);
						console.log(
							'[blob-truncate-source] truncated ' + p + ' from ' + size + ' to ' + KEEP_BYTES + ' bytes #' + ++truncated
						);
					}
				} catch (err) {
					console.log('[blob-truncate-source] truncate skipped for ' + p + ': ' + err.message);
				}
			});
		}
		return stream;
	};
	console.log(
		'[blob-truncate-source] installed; truncating /blobs/ files where parseInt(fileId,16) % ' +
			modulus +
			' === 0 to ' +
			KEEP_BYTES +
			' bytes'
	);
}
