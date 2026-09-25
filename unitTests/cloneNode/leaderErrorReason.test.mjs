import assert from 'node:assert';
import { encode as cborEncode } from 'cbor-x';
import { leaderErrorReason, LEADER_ERROR_REASON_MAX_CHARS } from '#src/cloneNode/leaderErrorReason';

describe('leaderErrorReason', () => {
	it('reads the error field of a CBOR reply (the shape the operations server sends the clone)', () => {
		const body = Buffer.from('b90001656572726f726d4b6579206e6f7420666f756e64', 'hex');
		assert.strictEqual(leaderErrorReason('application/cbor', body), 'Key not found');
	});

	it('reads the error field of a JSON reply', () => {
		const body = Buffer.from(JSON.stringify({ error: 'This key is restricted to node-identity requests' }));
		assert.strictEqual(
			leaderErrorReason('application/json; charset=utf-8', body),
			'This key is restricted to node-identity requests'
		);
	});

	it('matches the media type case-insensitively', () => {
		const body = Buffer.from('b90001656572726f726d4b6579206e6f7420666f756e64', 'hex');
		assert.strictEqual(leaderErrorReason('Application/CBOR', body), 'Key not found');
	});

	it('uses a bare string reply as the reason', () => {
		assert.strictEqual(leaderErrorReason('application/cbor', cborEncode('Key not found')), 'Key not found');
	});

	it('falls back to text for a plain-text or HTML reply and keeps it on one line', () => {
		const body = Buffer.from('<html>\n  <body>502 Bad Gateway</body>\r\n</html>\n');
		assert.strictEqual(leaderErrorReason('text/html', body), '<html> <body>502 Bad Gateway</body> </html>');
	});

	it('falls back to text when the declared encoding does not decode', () => {
		assert.strictEqual(leaderErrorReason('application/json', Buffer.from('not json')), 'not json');
	});

	it('does not throw on an error field that is not a string', () => {
		const body = Buffer.from(JSON.stringify({ error: { toString: 1 } }));
		assert.doesNotThrow(() => leaderErrorReason('application/json', body));
	});

	it('returns an empty reason for an empty body', () => {
		assert.strictEqual(leaderErrorReason('application/cbor', Buffer.alloc(0)), '');
		assert.strictEqual(leaderErrorReason('', Buffer.alloc(0)), '');
	});

	it('caps the reason for an oversized body without decoding it as structured data', () => {
		const huge = Buffer.from(JSON.stringify({ error: 'x'.repeat(1024 * 1024) }));
		const reason = leaderErrorReason('application/json', huge);
		assert.strictEqual(reason.length, LEADER_ERROR_REASON_MAX_CHARS);
		assert.ok(reason.startsWith('{"error":"xxx'), reason.slice(0, 20));
	});
});
