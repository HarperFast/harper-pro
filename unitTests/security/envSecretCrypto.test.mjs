import assert from 'node:assert';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { fingerprintOf, encryptEnvelope, decryptEnvelope } from '#src/security/envSecretCrypto';

// 2048-bit keys keep keygen fast; the envelope code paths are identical at any RSA size.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const fp = fingerprintOf(publicKey);

// Re-serialize an envelope body after mutating its fields (to forge tampered/malformed envelopes).
const reencode = (body, mutate) => {
	const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	mutate(obj);
	return Buffer.from(JSON.stringify(obj)).toString('base64url');
};

describe('envSecretCrypto', () => {
	describe('round-trip (client encrypt -> server decrypt)', () => {
		const samples = [
			'sk-1234567890',
			'p@ss w#rd"with\'quotes',
			'multi\nline\nvalue',
			'-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(2000) + '\n-----END PRIVATE KEY-----\n', // > RSA max: needs hybrid
			'unicode: café 🔐 日本語',
			'',
		];
		for (const s of samples) {
			it(`recovers ${JSON.stringify(s.length > 24 ? s.slice(0, 24) + '…' : s)}`, () => {
				assert.equal(decryptEnvelope(encryptEnvelope(s, publicKey, fp), privateKey, fp), s);
			});
		}
	});

	it('fingerprint is stable and derivable from the private key', () => {
		assert.equal(fingerprintOf(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })), fp);
	});

	describe('deny paths', () => {
		it('rejects an envelope encrypted for a different key (wrong kid)', () => {
			const body = encryptEnvelope('x', publicKey, 'deadbeef');
			assert.throws(() => decryptEnvelope(body, privateKey, fp), /no env-secrets key for kid/);
		});

		it('rejects a tampered ciphertext (GCM auth)', () => {
			const tampered = reencode(encryptEnvelope('secret', publicKey, fp), (o) => {
				const ct = Buffer.from(o.ct, 'base64');
				ct[0] ^= 0xff;
				o.ct = ct.toString('base64');
			});
			assert.throws(() => decryptEnvelope(tampered, privateKey, fp));
		});

		it('rejects a tampered authentication tag', () => {
			const tampered = reencode(encryptEnvelope('secret', publicKey, fp), (o) => {
				const tag = Buffer.from(o.tag, 'base64');
				tag[0] ^= 0xff;
				o.tag = tag.toString('base64');
			});
			assert.throws(() => decryptEnvelope(tampered, privateKey, fp));
		});

		it('rejects malformed envelopes (not JSON, wrong type, missing field)', () => {
			assert.throws(() => decryptEnvelope('!!!not-base64-json', privateKey, fp), /malformed env-secret envelope/);
			const arrayBody = Buffer.from(JSON.stringify([]), 'utf8').toString('base64url');
			assert.throws(() => decryptEnvelope(arrayBody, privateKey, fp), /malformed env-secret envelope/);
			const missingTag = reencode(encryptEnvelope('x', publicKey, fp), (o) => delete o.tag);
			assert.throws(() => decryptEnvelope(missingTag, privateKey, fp), /malformed env-secret envelope/);
		});
	});
});
