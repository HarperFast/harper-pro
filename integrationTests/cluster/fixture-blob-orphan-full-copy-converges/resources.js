import { Readable } from 'node:stream';

// Authoritative large-blob fixture for QA-177: TTL-evicted-orphan × full-copy scenario.
// BlobAsset is a plain @table @export (no sourcedFrom), so blobs are authoritative —
// they can only be recovered via replication re-stream (no re-source fallback).
// Each id maps to a fixed ~50 KB payload (above FILE_STORAGE_THRESHOLD so file-backed).
const CHUNK = 1024;
const CHUNKS = 50; // 50 KB

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
		)
	);
}

// Seed endpoint: GET /SeedBlobAsset/{id} writes record {id} (with its deterministic
// file-backed blob) into the authoritative BlobAsset table.
export class SeedBlobAsset extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const id = Number(target.id);
		await tables.BlobAsset.put(id, { id, name: 'blob asset ' + id, data: blobForId(id) });
		return { seeded: id };
	}
}
