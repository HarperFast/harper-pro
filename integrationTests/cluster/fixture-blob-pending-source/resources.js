// Test-only component: makes a DETERMINISTIC subset of blob files on the SOURCE read back as core's
// PENDING placeholder forever — the origin state behind the circular-503 wedge in harper-pro#432.
// Every source read of such a blob rejects with `BlobReadError('Blob pending replication …', 503)`;
// `sendBlobs` retries it in place (BLOB_SEND_RETRY_DELAYS_MS), then forwards `errorStatus: 503`,
// which the receiver classifies as TRANSIENT and holds. Each reconnect re-streams the same record
// and gets the same 503, so without an escalation budget the receiver's resume cursor is pinned
// indefinitely.
//
// Mechanism: let each blob write complete normally. Core opens the file with `autoClose: false` and
// finalizes the 8-byte header (type + size) with a positioned `fs.write` AFTER the stream's `finish`,
// so on `finish` this waits for that finalization (the size field leaving its UNKNOWN placeholder)
// and then overwrites the header's type bytes with PENDING_TYPE (0x00fe, core resources/blob.ts),
// remembering the original bytes. Keyed by fileId (the path basename), like
// fixture-blob-fail-source-read, so the selection is stable across every read/retry of the same file.
//
// Healing: once the file named by HARPER_TEST_BLOB_PENDING_HEAL_FILE exists, the original header
// bytes are restored on every stamped file and nothing further is stamped — the "source recovered"
// half of a repairability check. Install on the SOURCE node. Toggle on with
// HARPER_TEST_BLOB_PENDING_MODULUS=<positive int>: a blob is stamped when
// parseInt(fileId, 16) % modulus === 0, for at most HARPER_TEST_BLOB_PENDING_COUNT files (0 = all).
import { createRequire } from 'node:module';

const modulus = Number.parseInt(process.env.HARPER_TEST_BLOB_PENDING_MODULUS || '0', 10);
const maxStamped = Number.parseInt(process.env.HARPER_TEST_BLOB_PENDING_COUNT || '0', 10);
const healFile = process.env.HARPER_TEST_BLOB_PENDING_HEAL_FILE;
const HEADER_SIZE = 8;
const PENDING_HEADER_TYPE = Buffer.from([0x00, 0xfe]);
const FINALIZE_POLL_MS = 10;
const FINALIZE_POLL_ATTEMPTS = 500;

if (Number.isFinite(modulus) && modulus > 0) {
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const path = require('node:path');
	const realCreateWriteStream = fs.createWriteStream;
	const stamped = new Map(); // file path -> original header type bytes
	let claimed = 0;
	let healed = false;
	const shouldStamp = (p) => {
		if (typeof p !== 'string' || !p.includes('/blobs/')) return false;
		const id = Number.parseInt(path.basename(p), 16);
		return Number.isFinite(id) && id % modulus === 0;
	};
	const readHeader = (p) => {
		const fd = fs.openSync(p, 'r');
		try {
			const header = Buffer.alloc(HEADER_SIZE);
			const bytesRead = fs.readSync(fd, header, 0, HEADER_SIZE, 0);
			return bytesRead === HEADER_SIZE ? header : undefined;
		} finally {
			fs.closeSync(fd);
		}
	};
	const isFinalized = (header) => header !== undefined && !header.subarray(2).every((byte) => byte === 0xff);
	const rewriteHeaderType = (p, bytes) => {
		const fd = fs.openSync(p, 'r+');
		try {
			fs.writeSync(fd, bytes, 0, 2, 0);
		} finally {
			fs.closeSync(fd);
		}
	};
	const stampWhenFinalized = (p, attempt) => {
		if (healed) return;
		try {
			const header = readHeader(p);
			if (!isFinalized(header)) {
				if (attempt < FINALIZE_POLL_ATTEMPTS) setTimeout(stampWhenFinalized, FINALIZE_POLL_MS, p, attempt + 1).unref();
				else console.log('[blob-pending-source] stamp skipped for ' + p + ': header never finalized');
				return;
			}
			rewriteHeaderType(p, PENDING_HEADER_TYPE);
			stamped.set(p, header.subarray(0, 2));
			console.log('[blob-pending-source] stamped ' + p + ' as PENDING #' + stamped.size);
		} catch (err) {
			console.log('[blob-pending-source] stamp skipped for ' + p + ': ' + err.message);
		}
	};
	fs.createWriteStream = function patchedCreateWriteStream(p) {
		const stream = realCreateWriteStream.apply(this, arguments);
		if (!healed && shouldStamp(p) && (maxStamped === 0 || claimed < maxStamped)) {
			claimed++;
			stream.on('finish', () => stampWhenFinalized(p, 0));
		}
		return stream;
	};
	if (healFile) {
		const timer = setInterval(() => {
			if (!fs.existsSync(healFile)) return;
			healed = true;
			clearInterval(timer);
			let restored = 0;
			for (const [p, original] of stamped) {
				try {
					rewriteHeaderType(p, original);
					restored++;
				} catch (err) {
					console.log('[blob-pending-source] heal skipped for ' + p + ': ' + err.message);
				}
			}
			stamped.clear();
			console.log('[blob-pending-source] healed ' + restored + ' file(s)');
		}, 500);
		timer.unref();
	}
	console.log(
		'[blob-pending-source] installed; stamping /blobs/ files PENDING where parseInt(fileId,16) % ' +
			modulus +
			' === 0' +
			(maxStamped > 0 ? ' (at most ' + maxStamped + ')' : '') +
			(healFile ? '; heal file ' + healFile : '')
	);
}
