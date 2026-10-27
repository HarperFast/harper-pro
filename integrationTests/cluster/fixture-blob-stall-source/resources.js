// Test-only component. Installed on the SOURCE with HARPER_TEST_BLOB_STALL_ARM_FILE set, it stalls the
// replication send of one record's blob mid-body: once the arm file exists, the first read of a
// /blobs/data/ file whose payload belongs to HARPER_TEST_BLOB_STALL_RECORD reports only its first
// payload KiB, and the next read on that descriptor never calls back. The receiver gets part of the
// body and no terminal chunk, so its receive stays in flight until the link closes. The arm file is removed when the stall
// engages, so the restarted source sends normally.
//
// Selected by payload, not file id: the payload's first byte is (seed*131)&0xff
// (fixture-large-blob-deterministic), inverted with 131*43≡1 mod 256. Patches the CJS module object
// via `createRequire`; Harper's dist code resolves `fs.read` off it at call time.
//
// Also serves /LargeLocationImage/<id> on every node: the record's referenced blob bytes, or the read
// error's status and message (a PENDING stub answers 503).
import { createRequire } from 'node:module';

const armFile = process.env.HARPER_TEST_BLOB_STALL_ARM_FILE;
const stallRecord = Number.parseInt(process.env.HARPER_TEST_BLOB_STALL_RECORD || '0', 10);
const HEADER_SIZE = 8;
const DELIVERED_BYTES = HEADER_SIZE + 1024;
if (armFile) {
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const realRead = fs.read;
	const stalledFds = new Set();
	fs.read = function patchedRead(fd, buffer, offset, length, position, callback) {
		if (stalledFds.has(fd)) {
			console.log('[blob-stall-source] stalling blob read on fd ' + fd);
			return;
		}
		if (position !== 0 || typeof callback !== 'function' || !fs.existsSync(armFile))
			return realRead.apply(this, arguments);
		return realRead.call(this, fd, buffer, offset, length, position, (error, bytesRead, readBuffer) => {
			if (!error && bytesRead > DELIVERED_BYTES && ((readBuffer[offset + HEADER_SIZE] * 43) & 0xff) === stallRecord) {
				try {
					fs.unlinkSync(armFile);
					stalledFds.add(fd);
					bytesRead = DELIVERED_BYTES;
					console.log('[blob-stall-source] stall engaged for record ' + stallRecord + ' on fd ' + fd);
				} catch {
					// another thread engaged it first
				}
			}
			callback(error, bytesRead, readBuffer);
		});
	};
	console.log('[blob-stall-source] installed; record ' + stallRecord + ' armed by ' + armFile);
}

export class LargeLocationImage extends Resource {
	async get(target) {
		target.checkPermission = false;
		const record = await databases.data.LargeLocation.get(Number(target.id));
		if (!record?.image) return new Response(null, { status: 404 });
		let bytes;
		try {
			bytes = await record.image.bytes();
		} catch (error) {
			return new Response(JSON.stringify({ error: String(error?.message ?? error) }), {
				status: error?.statusCode ?? 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
	}
}
