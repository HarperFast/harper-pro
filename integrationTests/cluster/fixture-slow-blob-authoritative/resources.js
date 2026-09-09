import { Readable } from 'node:stream';

// Authoritative (non-caching) blob fixture whose payload is deliberately LARGE — large enough that the
// receiver's save cannot finish inside COMMITTED_UPDATE_DELAY (2 ms), which is the precondition for the
// clamped-confirmation shape unconfirmedSendBlobQuietFalseFire.test.mjs pins. The 50 KB blob in
// fixture-large-blob-authoritative is marginal over loopback: it sometimes lands durable before the
// confirmation timer fires, and the test then passes on unfixed code.
const CHUNK = 64 * 1024;
const CHUNKS = 64; // 4 MiB

function payloadForId(id) {
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

// GET /SlowBlobPayload/{id} -> the payload bytes, so a test can prove the receiver holds them complete.
export class SlowBlobPayload extends tables.SlowBlob {
	static async get(target) {
		const record = await super.get(target);
		if (!record || !record.payload) return new Response(null, { status: 404 });
		return new Response(record.payload, { headers: { 'Content-Type': 'application/octet-stream' } });
	}
}

// GET /SeedSlowBlob/{id} writes record {id} with its blob. There is no sourcedFrom get on SlowBlob, so
// writes have to come from somewhere; this is that somewhere, driven over HTTP.
export class SeedSlowBlob extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const id = Number(target.id);
		await tables.SlowBlob.put(id, { id, name: 'slow blob ' + id, payload: payloadForId(id) });
		return { seeded: id, bytes: CHUNK * CHUNKS };
	}
}
