import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import { encryptEnvelope } from '#src/security/envSecretCrypto';
import { decryptEnvelopeWithCustody, FileKeyCustody } from '#src/security/keyCustody';
import { createComponentSecrets } from '#src/security/secretsAccessor';

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

describe('createComponentSecrets (per-component accessor)', () => {
	it('resolves declared secrets and denies undeclared ones', async () => {
		const secrets = createComponentSecrets({
			componentName: 'my-app',
			declaredKeys: ['API_KEY', 'UNSET_KEY'],
			resolve: async (name) => (name === 'API_KEY' ? 'the-value' : undefined),
		});

		assert.equal(await secrets.get('API_KEY'), 'the-value');
		assert.deepEqual(secrets.list().sort(), ['API_KEY', 'UNSET_KEY']);
		assert.equal(secrets.has('API_KEY'), true);
		assert.equal(secrets.has('OTHER'), false);

		await assert.rejects(() => secrets.get('OTHER'), /not allowed to read secret "OTHER"/);
		await assert.rejects(() => secrets.get('UNSET_KEY'), /is not set/);
	});

	it('decrypts real ciphertext through custody without exposing the key (end-to-end)', async () => {
		const custody = new FileKeyCustody(freshDir(), { generate: true });
		const publicKey = await custody.publicKey();
		const kid = await custody.keyId();
		const ciphertext = { DATABASE_URL: encryptEnvelope('postgres://secret', publicKey, kid) };

		const secrets = createComponentSecrets({
			componentName: 'my-app',
			declaredKeys: ['DATABASE_URL'],
			resolve: async (name) => {
				const body = ciphertext[name];
				return body === undefined ? undefined : decryptEnvelopeWithCustody(body, custody);
			},
		});

		assert.equal(await secrets.get('DATABASE_URL'), 'postgres://secret');
	});
});
