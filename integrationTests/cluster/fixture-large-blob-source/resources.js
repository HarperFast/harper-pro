import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

// Streamed blob source whose payload is large enough (~50 KB) to exceed Harper's
// FILE_STORAGE_THRESHOLD (8192 bytes), guaranteeing the receiver's blob save goes
// through `createWriteStream` — which the companion fixture-blob-fail-injector
// monkey-patches. Smaller blobs are stored inline within the record and never
// touch the filesystem on the receive side, which would defeat the test.
tables.LargeLocation.sourcedFrom({
	get(id) {
		const image = createBlob(
			Readable.from(
				(async function* () {
					// 50 chunks × 1024 bytes = 51200 bytes per blob
					for (let i = 0; i < 50; i++) yield randomBytes(1024);
				})()
			)
		);
		return {
			id,
			name: 'large location ' + id,
			image,
		};
	},
});
