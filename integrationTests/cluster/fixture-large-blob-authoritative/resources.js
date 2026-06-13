import { Readable } from 'node:stream';

// Authoritative (non-caching) large-blob fixture for the row-level blob repair on
// identity-tie replay. AuthLocation is a plain @table @export with NO sourcedFrom, so it
// is the authoritative copy: the blob bytes themselves are the replicated data, and a
// read on the receiver can NOT re-source/mask a missing blob (there is no source to read
// from). Each id maps to a fixed ~50 KB payload (content seeded by the id) so the bytes
// are deterministic and reproducible across the original stream and the resume re-stream.
const CHUNK = 1024;
const CHUNKS = 50; // 50 KB, above FILE_STORAGE_THRESHOLD (8192) so it is file-backed

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

// Serve the raw blob bytes for a record so a test can read them back and compare exactly.
// GET /AuthLocationImage/{id} -> the image blob as an octet-stream Response.
export class AuthLocationImage extends tables.AuthLocation {
	static async get(target) {
		const record = await super.get(target);
		if (!record || !record.image) return new Response(null, { status: 404 });
		return new Response(record.image, { headers: { 'Content-Type': 'application/octet-stream' } });
	}
}

// Seed endpoint: GET /SeedAuthLocation/{id} writes record {id} (with its deterministic
// file-backed blob) into the authoritative AuthLocation table. There is no sourcedFrom
// get on AuthLocation, so writes have to come from somewhere — this is that somewhere,
// driven over HTTP the same way the deterministic caching fixture is driven by GETs.
export class SeedAuthLocation extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const id = Number(target.id);
		await tables.AuthLocation.put(id, { id, name: 'auth location ' + id, image: blobForId(id) });
		return { seeded: id };
	}
}
