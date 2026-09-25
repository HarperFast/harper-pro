import { decode as cborDecode } from 'cbor-x';

export const LEADER_ERROR_REASON_MAX_CHARS = 500;
const MAX_STRUCTURED_BODY_BYTES = 64 * 1024;

/** Never throws: a malformed reply must not replace the HTTP failure it describes. */
export function leaderErrorReason(contentType: string, body: Buffer): string {
	let decoded: unknown;
	const mediaType = contentType.toLowerCase();
	if (body.length <= MAX_STRUCTURED_BODY_BYTES) {
		try {
			if (mediaType.includes('application/cbor')) decoded = cborDecode(body);
			else if (mediaType.includes('application/json')) decoded = JSON.parse(body.toString('utf8'));
		} catch {}
	}
	const field = (decoded as { error?: unknown } | null | undefined)?.error;
	const text =
		typeof decoded === 'string'
			? decoded
			: typeof field === 'string'
				? field
				: body.subarray(0, LEADER_ERROR_REASON_MAX_CHARS * 4).toString('utf8');
	return text
		.slice(0, LEADER_ERROR_REASON_MAX_CHARS * 2)
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, LEADER_ERROR_REASON_MAX_CHARS);
}
