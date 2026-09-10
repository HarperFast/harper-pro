import { Readable } from 'node:stream';

// QA-692 (source:gh-pro:537, blob-table full-copy interruption). Authoritative (no
// sourcedFrom) blob table modeled on fixture-large-blob-authoritative, but with a
// larger, size-parameterized blob so a full copy of a few hundred records has real
// wall-clock duration to interrupt. Content is a pure deterministic function of `id`
// so the test can independently recompute expected bytes without round-tripping
// through the source node.
const CHUNK = 1024;
const CHUNKS = 1024; // 1 MiB per blob, comfortably above FILE_STORAGE_THRESHOLD (8192) -> file-backed

function blobForId(id) {
	const seed = Number(id) | 0;
	return createBlob(
		Readable.from(
			(function* () {
				for (let c = 0; c < CHUNKS; c++) {
					const buf = Buffer.allocUnsafe(CHUNK);
					for (let i = 0; i < CHUNK; i++) buf[i] = (seed * 131 + c * 31 + i) & 0xff;
					yield buf;
				}
			})()
		),
		{ size: CHUNK * CHUNKS, saveBeforeCommit: true }
	);
}

// Serve the raw blob bytes so the test can read them back and compare exactly.
// GET /BlobCopyImage/{id} -> the payload blob as an octet-stream Response.
export class BlobCopyImage extends tables.BlobCopyRecord {
	static async get(target) {
		const record = await super.get(target);
		if (!record || !record.payload) return new Response(null, { status: 404 });
		return new Response(record.payload, { headers: { 'Content-Type': 'application/octet-stream' } });
	}
}

// Seed endpoint: GET /SeedBlobCopyRecord/{id} writes record {id} (with its deterministic
// file-backed blob) into the authoritative BlobCopyRecord table.
export class SeedBlobCopyRecord extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const id = Number(target.id);
		await tables.BlobCopyRecord.put(id, { id, name: 'blob-copy-' + id, payload: blobForId(id) });
		return { seeded: id };
	}
}
