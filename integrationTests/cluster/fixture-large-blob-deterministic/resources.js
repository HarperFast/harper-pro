import { Readable } from 'node:stream';

// Deterministic large-blob source: each id maps to a fixed ~50 KB payload (content
// seeded by the id), so the same id always yields the same blob bytes -> the same
// content-addressed fileId -> the same on-disk path. This is what lets the
// transient blob-fail injector (fail the first save per path, succeed on retry)
// model a recoverable fault: the receiver's repair re-fetch streams the same blob
// to the same path, where the second save attempt succeeds. (The randomBytes-based
// fixture-large-blob-source is unsuitable here — re-sourcing a record would mint new
// content and a new path, so the injector would fail every attempt.)
const CHUNK = 1024;
const CHUNKS = 50; // 50 KB, above FILE_STORAGE_THRESHOLD (8192) so it is file-backed

tables.LargeLocation.sourcedFrom({
	get(id) {
		const seed = Number(id) | 0;
		const body = createBlob(
			Readable.from(
				(function* () {
					for (let c = 0; c < CHUNKS; c++) {
						const buf = Buffer.allocUnsafe(CHUNK);
						for (let i = 0; i < CHUNK; i++) buf[i] = (seed * 131 + c * 31 + i) & 0xff;
						yield buf;
					}
				})()
			)
		);
		return { id, name: 'large location ' + id, image: body };
	},
});
