import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

// Caching (`sourcedFrom`) blob source for the blob-gap deadlock repro. Mirrors the soak's
// `Prerender` caching table. Each record carries a LARGE streamed blob (~256 KB across many
// chunks) so that:
//   - the receiver's blob save always goes through the file-backed write path (well over
//     FILE_STORAGE_THRESHOLD = 8192), and
//   - each blob spans many BLOB_CHUNK frames, maximizing the chance that some of those frames
//     land behind a data frame that is parked in the receive-side `waitForDrain` backpressure
//     pause — the precondition for the receive/apply circular wait.
const CHUNK = 4096;
const CHUNKS = Number.parseInt(process.env.HARPER_TEST_BLOB_CHUNKS || '64', 10); // 64 * 4096 = 256 KB

tables.Prerender.sourcedFrom({
	get(id) {
		const image = createBlob(
			Readable.from(
				(async function* () {
					for (let i = 0; i < CHUNKS; i++) yield randomBytes(CHUNK);
				})()
			)
		);
		return {
			id,
			name: 'prerender ' + id,
			image,
		};
	},
});
