import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import { encryptEnvelope } from '#src/security/envSecretCrypto';
import { decryptEnvelopeWithCustody, FileKeyCustody } from '#src/security/keyCustody';

const freshDir = () => mkdtempSync(join(tmpdir(), 'keycustody-'));

describe('FileKeyCustody', () => {
	it('generates a keypair, and unwraps envelopes encrypted for it (round-trip)', async () => {
		const custody = new FileKeyCustody(freshDir(), { generate: true });
		const publicKey = await custody.publicKey();
		const kid = await custody.keyId();
		for (const value of ['sk-123', 'unicode café 🔐', 'multi\nline', '']) {
			const body = encryptEnvelope(value, publicKey, kid);
			assert.equal(await decryptEnvelopeWithCustody(body, custody), value);
		}
	});

	it('rejects an envelope encrypted for a different key (wrong kid)', async () => {
		const custody = new FileKeyCustody(freshDir(), { generate: true });
		const body = encryptEnvelope('x', await custody.publicKey(), 'deadbeef');
		await assert.rejects(() => decryptEnvelopeWithCustody(body, custody), /no env-secrets key for kid/);
	});

	it('persists the key — a second instance on the same dir loads the same key', async () => {
		const dir = freshDir();
		const a = new FileKeyCustody(dir, { generate: true });
		const kid = await a.keyId();
		const b = new FileKeyCustody(dir, { generate: false });
		assert.equal(b.hasKey(), true);
		assert.equal(await b.keyId(), kid);
	});

	it('load-only custody (workers) does not generate and reports no key', async () => {
		const custody = new FileKeyCustody(freshDir(), { generate: false });
		assert.equal(custody.hasKey(), false);
		await assert.rejects(() => custody.unwrapKey(Buffer.from('x')), /not available/);
	});

	it('never exposes the private key through the KeyCustody interface', () => {
		const custody = new FileKeyCustody(freshDir(), { generate: true });
		// The interface surface is keyId / publicKey / unwrapKey only — no getPrivateKey.
		assert.equal('getPrivateKey' in custody, false);
	});
});
