// Test-only component. With HARPER_TEST_BLOB_STALL_ARM_FILE set and that file present, the first read
// of a /blobs/data/ file holding HARPER_TEST_BLOB_STALL_RECORD's payload reports only its first payload
// KiB and the next read on that descriptor never calls back: the peer receives part of the body and no
// terminal chunk. Engaging removes the arm file, so a restarted source sends normally.
//
// The record is recognized by the payload's first byte, (seed*131)&0xff in
// fixture-large-blob-deterministic (131*43≡1 mod 256). Harper's dist resolves `fs.*` off the CJS
// module object at call time, which `createRequire` lets us patch.
//
// /LargeLocationImage/<id> returns the record's blob bytes, or the read error's status and message.
import { createRequire } from 'node:module';

const armFile = process.env.HARPER_TEST_BLOB_STALL_ARM_FILE;
const stallRecord = Number.parseInt(process.env.HARPER_TEST_BLOB_STALL_RECORD || '0', 10);
const HEADER_SIZE = 8;
const DELIVERED_BYTES = HEADER_SIZE + 1024;
if (armFile) {
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const realOpen = fs.open;
	const realRead = fs.read;
	const realClose = fs.close;
	const blobFds = new Set();
	const stalledFds = new Set();
	fs.open = function patchedOpen(path, ...rest) {
		const callback = rest.at(-1);
		if (typeof path !== 'string' || !path.includes('/blobs/data/') || typeof callback !== 'function')
			return realOpen.apply(this, arguments);
		rest[rest.length - 1] = (error, fd) => {
			if (!error) blobFds.add(fd);
			callback(error, fd);
		};
		return realOpen.call(this, path, ...rest);
	};
	fs.close = function patchedClose(fd) {
		blobFds.delete(fd);
		stalledFds.delete(fd);
		return realClose.apply(this, arguments);
	};
	fs.read = function patchedRead(fd, buffer, offset, length, position, callback) {
		if (stalledFds.has(fd)) {
			console.log('[blob-stall-source] stalling blob read on fd ' + fd);
			return;
		}
		if (position !== 0 || typeof callback !== 'function' || !blobFds.has(fd) || !fs.existsSync(armFile))
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
