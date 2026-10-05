import assert from 'node:assert';
import { truncateCloseReason } from '#src/replication/replicationConnection';

describe('truncateCloseReason', () => {
	it('returns a short reason unchanged', () => {
		assert.strictEqual(truncateCloseReason('short reason'), 'short reason');
	});

	it('returns undefined for a non-string reason', () => {
		assert.strictEqual(truncateCloseReason(undefined), undefined);
		assert.strictEqual(truncateCloseReason(new Error('x')), undefined);
	});

	it('truncates a long ASCII reason to at most 123 bytes', () => {
		const reason = 'x'.repeat(200);
		const truncated = truncateCloseReason(reason);
		assert.ok(Buffer.byteLength(truncated, 'utf8') <= 123);
		assert.strictEqual(truncated, 'x'.repeat(123));
	});

	it('never returns more than 123 bytes when a multi-byte character sits on the cut boundary', () => {
		// 122 ASCII bytes plus a 3-byte character starting exactly at byte 122: a naive byte-offset
		// slice would cut the character in half, and decoding the incomplete tail as U+FFFD (3 bytes)
		// would push the result back over 123 bytes.
		const reason = 'a'.repeat(122) + '€' + 'trailing text that will not fit';
		const truncated = truncateCloseReason(reason);
		assert.ok(
			Buffer.byteLength(truncated, 'utf8') <= 123,
			`expected <=123 bytes, got ${Buffer.byteLength(truncated, 'utf8')}`
		);
		// The split character is dropped entirely rather than rendered as a replacement character.
		assert.strictEqual(truncated, 'a'.repeat(122));
	});
});
