import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import { encryptEnvelope } from '#src/security/envSecretCrypto';
import { decryptEnvelopeWithCustody, FileKeyCustody } from '#src/security/keyCustody';
import { createComponentSecrets } from '#src/security/secretsAccessor';
import { InMemorySecretsStore, setSecret } from '#src/security/secretsStore';

const freshDir = () => mkdtempSync(join(tmpdir(), 'secrets-'));

// A store whose values are plain strings, with a trivial "decrypt" — lets the accessor's authority
// logic be tested without crypto. (End-to-end crypto is covered in the last test.)
async function plainStore(entries) {
	const store = new InMemorySecretsStore();
	for (const [name, { value, grants }] of Object.entries(entries)) {
		await setSecret(store, { name, value, grants });
	}
	return store;
}
const identity = async (s) => s;

describe('createComponentSecrets (store-backed authority)', () => {
	it('resolves granted secrets and denies ungranted ones', async () => {
		const store = await plainStore({
			API_KEY: { value: 'the-value', grants: ['my-app'] },
			OTHERS_SECRET: { value: 'nope', grants: ['other-app'] },
		});
		const secrets = createComponentSecrets({ componentName: 'my-app', store, decrypt: identity });

		assert.equal(await secrets.get('API_KEY'), 'the-value');
		assert.equal(await secrets.has('API_KEY'), true);
		assert.deepEqual(await secrets.list(), ['API_KEY']);

		// Not granted to my-app — refused before any decryption, and error points at the operator.
		assert.equal(await secrets.has('OTHERS_SECRET'), false);
		await assert.rejects(() => secrets.get('OTHERS_SECRET'), /is not granted secret "OTHERS_SECRET"/);
		await assert.rejects(() => secrets.get('OTHERS_SECRET'), /a component cannot grant itself/);
		// Unknown secret is likewise refused.
		await assert.rejects(() => secrets.get('NOPE'), /is not granted/);
	});

	it('a component cannot widen access via its own manifest', async () => {
		// Manifest asks for a secret that exists but grants it to someone else.
		const store = await plainStore({ SECRET: { value: 'v', grants: ['other-app'] } });
		const secrets = createComponentSecrets({
			componentName: 'my-app',
			store,
			decrypt: identity,
			manifest: [{ name: 'SECRET', required: true }],
		});
		await assert.rejects(() => secrets.get('SECRET'), /is not granted/);
		assert.deepEqual(await secrets.list(), []); // authoritative list ignores the manifest
	});

	it('granted-but-unset secret reports distinctly from ungranted', async () => {
		const store = await plainStore({ NEEDS_VALUE: { grants: ['my-app'] } }); // granted, no value
		const secrets = createComponentSecrets({ componentName: 'my-app', store, decrypt: identity });
		await assert.rejects(() => secrets.get('NEEDS_VALUE'), /granted but has no value set/);
	});

	it('describe() returns the manifest (non-authoritative) without values', async () => {
		const store = await plainStore({});
		const secrets = createComponentSecrets({
			componentName: 'my-app',
			store,
			decrypt: identity,
			manifest: [{ name: 'DATABASE_URL', required: true, description: 'Postgres DSN' }],
		});
		assert.deepEqual(secrets.describe(), [{ name: 'DATABASE_URL', required: true, description: 'Postgres DSN' }]);
	});

	it('ensureRequired() distinguishes not-granted from granted-but-unset, ignores optional', async () => {
		const store = await plainStore({
			GRANTED_SET: { value: 'v', grants: ['my-app'] },
			GRANTED_UNSET: { grants: ['my-app'] },
			GRANTED_OPTIONAL_MISSING: { grants: ['other-app'] },
		});
		const secrets = createComponentSecrets({
			componentName: 'my-app',
			store,
			decrypt: identity,
			manifest: [
				{ name: 'GRANTED_SET', required: true },
				{ name: 'GRANTED_UNSET', required: true },
				{ name: 'NOT_GRANTED', required: true },
				{ name: 'GRANTED_OPTIONAL_MISSING', required: false },
			],
		});
		await assert.rejects(
			() => secrets.ensureRequired(),
			(e) => /not granted: NOT_GRANTED/.test(e.message) && /granted but unset: GRANTED_UNSET/.test(e.message)
		);
		// Optional and satisfied ones are not reported.
		await assert.rejects(
			() => secrets.ensureRequired(),
			(e) => !/GRANTED_SET/.test(e.message) && !/GRANTED_OPTIONAL_MISSING/.test(e.message)
		);
	});

	it('ensureRequired() passes when required secrets are granted and set', async () => {
		const store = await plainStore({ A: { value: 'v', grants: ['my-app'] } });
		const secrets = createComponentSecrets({
			componentName: 'my-app',
			store,
			decrypt: identity,
			manifest: [{ name: 'A', required: true }],
		});
		await assert.doesNotReject(() => secrets.ensureRequired());
	});

	it('decrypts real ciphertext through custody without exposing the key (end-to-end)', async () => {
		const custody = new FileKeyCustody(freshDir());
		custody.ensureKey();
		const publicKey = await custody.publicKey();
		const kid = await custody.keyId();

		const store = new InMemorySecretsStore();
		await setSecret(store, {
			name: 'DATABASE_URL',
			value: encryptEnvelope('postgres://secret', publicKey, kid),
			grants: ['my-app'],
		});

		const secrets = createComponentSecrets({
			componentName: 'my-app',
			store,
			decrypt: (ciphertext) => decryptEnvelopeWithCustody(ciphertext, custody),
		});

		assert.equal(await secrets.get('DATABASE_URL'), 'postgres://secret');
	});
});
