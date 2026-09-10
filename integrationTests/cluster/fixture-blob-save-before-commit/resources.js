import { Readable } from 'node:stream';

// Fixture for QA-488: the SPECIFIC saveBeforeCommit-over-the-wire corner of harper#1640 /
// PR #1641 (core 807d2e280) — none of the existing blob cluster tests create their blobs with
// `{ saveBeforeCommit: true }`. SbcLocation is an AUTHORITATIVE (non-caching) table: no
// sourcedFrom, so a read on the receiver can never re-source/mask a missing or truncated blob —
// the replicated bytes ARE the data. Each id maps to a fixed ~64 KB payload (content seeded by
// the id, above FILE_STORAGE_THRESHOLD=8192 so it is file-backed and spans multiple BLOB_CHUNK
// frames), so bytes are deterministic and can be verified byte-for-byte after replication.
const CHUNK = 4096;
const CHUNKS = 16; // 64 KB per blob, file-backed, multi-chunk over the wire

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
		// The mechanism under test: createBlob(..., { saveBeforeCommit: true }) gates the LOCAL
		// (origin) write's commit on the blob's own durable save before the record is visible.
		// Pre-fix, this flag rode the wire in the blob's packed properties (`pack()` spread the
		// blob's own properties), so the RECEIVER's apply of the replicated record also saw
		// `saveBeforeCommit: true` and routed through the "blobsNeedingSaving" branch of
		// startPreCommitBlobsForRecord instead of the source-apply "track only" branch — gating
		// the receiver's commit on a blob whose bytes are actually arriving out-of-band via
		// BLOB_CHUNK frames on the same (possibly backpressure-paused) replication socket. Circular
		// wait = permanent apply-loop wedge. The fix strips saveBeforeCommit/saveInRecord at pack()
		// time and checks trackPersistedBlobs FIRST, so the receiver never takes this branch.
		{ saveBeforeCommit: true }
	);
}

// GET /SeedSbcLocation/{id} -> writes record {id} (with its deterministic saveBeforeCommit
// file-backed blob) into the authoritative SbcLocation table.
export class SeedSbcLocation extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const id = Number(target.id);
		await tables.SbcLocation.put(id, { id, name: 'sbc location ' + id, image: blobForId(id) });
		return { seeded: id };
	}
}

// GET /SbcLocationImage/{id} -> the raw blob bytes, so a test can read them back and compare
// exactly. Safe to GET directly on this authoritative (non-caching) table: there is no source to
// re-fetch from, so a truncated/missing blob surfaces as a short/failed read, not a silent re-mint.
export class SbcLocationImage extends tables.SbcLocation {
	static async get(target) {
		const record = await super.get(target);
		if (!record || !record.image) return new Response(null, { status: 404 });
		return new Response(record.image, { headers: { 'Content-Type': 'application/octet-stream' } });
	}
}
