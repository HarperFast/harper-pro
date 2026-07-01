import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import { encryptEnvelope } from '#src/security/envSecretCrypto';
import { decryptEnvelopeWithCustody, FileKeyCustody } from '#src/security/keyCustody';

const freshDir = () => mkdtempSync(join(tmpdir(), 'keycustody-'));
// A generated (leader-side) custody: ensureKey() is the explicit create step.
const genCustody = () => {
	const custody = new FileKeyCustody(freshDir());
	custody.ensureKey();
	return custody;
};

describe('FileKeyCustody', () => {
	it('generates a keypair, and unwraps envelopes encrypted for it (round-trip)', async () => {
		const custody = genCustody();
		const publicKey = await custody.publicKey();
		const kid = await custody.keyId();
		for (const value of ['sk-123', 'unicode café 🔐', 'multi\nline', '']) {
			const body = encryptEnvelope(value, publicKey, kid);
			assert.equal(await decryptEnvelopeWithCustody(body, custody), value);
		}
	});

	it('rejects an envelope encrypted for a different key (wrong kid)', async () => {
		const custody = genCustody();
		const body = encryptEnvelope('x', await custody.publicKey(), 'deadbeef');
		await assert.rejects(() => decryptEnvelopeWithCustody(body, custody), /no env-secrets key for kid/);
	});

	it('ensureKey is idempotent and persists — a second instance on the same dir loads the same key', async () => {
		const dir = freshDir();
		const a = new FileKeyCustody(dir);
		a.ensureKey();
		a.ensureKey(); // idempotent no-op
		const kid = await a.keyId();
		const b = new FileKeyCustody(dir); // load-only
		assert.equal(b.hasKey(), true);
		assert.equal(await b.keyId(), kid);
	});

	it('load-only custody (workers) does not generate and reports no key', async () => {
		const custody = new FileKeyCustody(freshDir());
		assert.equal(custody.hasKey(), false);
		await assert.rejects(() => custody.unwrapKey(Buffer.from('x')), /not available/);
	});

	it('never exposes the private key through the KeyCustody interface', () => {
		const custody = genCustody();
		// The interface surface is keyId / publicKey / unwrapKey only — no getPrivateKey.
		assert.equal('getPrivateKey' in custody, false);
	});
});
