import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import { encryptEnvelope } from '#src/security/envSecretCrypto';
import { decryptEnvelopeWithCustody, FileKeyCustody } from '#src/security/keyCustody';
import { createComponentSecrets } from '#src/security/secretsAccessor';

const freshDir = () => mkdtempSync(join(tmpdir(), 'secrets-'));

describe('createComponentSecrets (per-component accessor)', () => {
	it('resolves declared secrets and denies undeclared ones', async () => {
		const secrets = createComponentSecrets({
			componentName: 'my-app',
			declarations: [
				{ name: 'API_KEY', required: true },
				{ name: 'UNSET_KEY', required: false },
			],
			resolve: async (name) => (name === 'API_KEY' ? 'the-value' : undefined),
		});

		assert.equal(await secrets.get('API_KEY'), 'the-value');
		assert.deepEqual(secrets.list().sort(), ['API_KEY', 'UNSET_KEY']);
		assert.equal(secrets.has('API_KEY'), true);
		assert.equal(secrets.has('OTHER'), false);

		// Undeclared read is refused before resolve is ever consulted (least authority).
		await assert.rejects(() => secrets.get('OTHER'), /not allowed to read secret "OTHER"/);
		await assert.rejects(() => secrets.get('UNSET_KEY'), /is not set/);
	});

	it('describe() surfaces declarations (for operator tooling) without values', () => {
		const secrets = createComponentSecrets({
			componentName: 'my-app',
			declarations: [{ name: 'DATABASE_URL', required: true, description: 'Postgres DSN' }],
			resolve: async () => 'postgres://secret',
		});
		assert.deepEqual(secrets.describe(), [{ name: 'DATABASE_URL', required: true, description: 'Postgres DSN' }]);
	});

	it('ensureRequired() fails loud listing only the missing required secrets', async () => {
		const present = new Set(['SET_REQUIRED']);
		const secrets = createComponentSecrets({
			componentName: 'my-app',
			declarations: [
				{ name: 'SET_REQUIRED', required: true },
				{ name: 'MISSING_REQUIRED', required: true },
				{ name: 'MISSING_OPTIONAL', required: false },
			],
			resolve: async (name) => (present.has(name) ? 'v' : undefined),
		});
		await assert.rejects(() => secrets.ensureRequired(), /missing required secret\(s\): MISSING_REQUIRED/);
		// The optional missing one is not reported.
		await assert.rejects(
			() => secrets.ensureRequired(),
			(e) => !/MISSING_OPTIONAL/.test(e.message)
		);
	});

	it('ensureRequired() passes when every required secret resolves', async () => {
		const secrets = createComponentSecrets({
			componentName: 'my-app',
			declarations: [
				{ name: 'A', required: true },
				{ name: 'B', required: false },
			],
			resolve: async (name) => (name === 'A' ? 'v' : undefined),
		});
		await assert.doesNotReject(() => secrets.ensureRequired());
	});

	it('decrypts real ciphertext through custody without exposing the key (end-to-end)', async () => {
		const custody = new FileKeyCustody(freshDir(), { generate: true });
		const publicKey = await custody.publicKey();
		const kid = await custody.keyId();
		const ciphertext = { DATABASE_URL: encryptEnvelope('postgres://secret', publicKey, kid) };

		const secrets = createComponentSecrets({
			componentName: 'my-app',
			declarations: [{ name: 'DATABASE_URL', required: true }],
			resolve: async (name) => {
				const body = ciphertext[name];
				return body === undefined ? undefined : decryptEnvelopeWithCustody(body, custody);
			},
		});

		assert.equal(await secrets.get('DATABASE_URL'), 'postgres://secret');
	});
});
