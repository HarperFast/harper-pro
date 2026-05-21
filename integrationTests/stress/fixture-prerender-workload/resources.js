// Prerender-style cache fixture: a `sourcedFrom` table where each cache-miss GET
// produces a record + streamed blob whose size is intentionally bimodal to
// match the wtk production workload — about 60% of payloads land below
// Harper's FILE_STORAGE_THRESHOLD (8192 bytes, stored inline in the record)
// and 40% above (file-backed via createWriteStream).
//
// The mix exercises both blob storage paths in a single test run, which is
// what the production prerender table looked like (mix of small JSON-ish
// fragments and larger HTML pages).
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

// Deterministic-from-id sizing so the test gets a stable distribution rather
// than purely random outcomes — keeps assertions about "saw both paths" stable.
function payloadSizeFor(id) {
	// Hash the id to a number in [0, 1000)
	let h = 0;
	const s = String(id);
	for (let i = 0; i < s.length; i++) {
		h = (h * 31 + s.charCodeAt(i)) | 0;
	}
	const bucket = Math.abs(h) % 1000;
	// 60% small (1-4KB inline path), 40% large (16-64KB file path)
	if (bucket < 600) return 1024 + (bucket % 3072);
	return 16384 + ((bucket * 137) % 49152);
}

tables.Prerender.sourcedFrom({
	get(id) {
		const size = payloadSizeFor(id);
		const chunkSize = 1024;
		const chunks = Math.max(1, Math.ceil(size / chunkSize));
		const body = createBlob(
			Readable.from(
				(async function* () {
					let remaining = size;
					for (let i = 0; i < chunks; i++) {
						const take = Math.min(chunkSize, remaining);
						yield randomBytes(take);
						remaining -= take;
					}
				})()
			)
		);
		// Best-effort device extraction from id of the form "...|device"
		const sepIdx = String(id).lastIndexOf('|');
		const device = sepIdx >= 0 ? String(id).slice(sepIdx + 1) : 'desktop';
		return {
			id,
			device,
			random: Math.random(),
			cached_at: new Date(),
			body,
		};
	},
});
