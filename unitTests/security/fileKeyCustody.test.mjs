/**
 * File-tier custody: generate/persist/reload round-trip in a temp dir, decrypt of a
 * core-encryptEnvelope envelope, fingerprint match, per-kid filenames, and key-store
 * registration under both the per-kid name and the stable active alias.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { encryptEnvelope, fingerprintOf } from '#src/core/utility/secretEnvelope';
import { ENV_ENCRYPTED_PREFIX } from '#src/core/utility/envFile';
import { getPrivateKeys } from '#src/core/security/keys';
import {
	ensureFileKeys,
	loadFileKeys,
	hasFileKeys,
	isCustodyKeyName,
	privateKeyFileNameFor,
	registerCustodyKeysInKeyStore,
	ACTIVE_CUSTODY_KEY_NAME,
	kidOfPrivateKeyPem,
} from '#src/security/fileKeyCustody';
import { buildCustody } from '#src/security/keyCustody';

describe('fileKeyCustody', () => {
	let baseDir;
	before(() => {
		baseDir = mkdtempSync(join(tmpdir(), 'custody-file-test-'));
		setHdbBasePath(baseDir);
	});
	after(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('recognizes custody key names', () => {
		assert.equal(isCustodyKeyName(ACTIVE_CUSTODY_KEY_NAME), true);
		assert.equal(isCustodyKeyName('envSecrets.abcd1234.private.pem'), true);
		assert.equal(isCustodyKeyName('envSecrets.abcd1234.public.pem'), false);
		assert.equal(isCustodyKeyName('.jwtPrivate'), false);
		assert.equal(isCustodyKeyName('privateKey.pem'), false);
	});

	it('generates, persists (per-kid filename, restrictive modes), and reloads the keypair', function () {
		this.timeout(60000); // RSA-4096 generation
		assert.equal(hasFileKeys(), false);
		const generated = ensureFileKeys();
		assert.equal(generated.keys.size, 1);
		assert.equal(generated.keys.has(generated.activeKid), true);
		assert.equal(hasFileKeys(), true);

		const keysDir = join(baseDir, 'keys');
		const privateFile = privateKeyFileNameFor(generated.activeKid);
		assert.equal(privateFile, `envSecrets.${generated.activeKid.slice(0, 8)}.private.pem`);
		const files = readdirSync(keysDir).sort();
		assert.deepEqual(files, [privateFile, `envSecrets.${generated.activeKid.slice(0, 8)}.public.pem`].sort());
		assert.equal(statSync(join(keysDir, privateFile)).mode & 0o777, 0o600);
		assert.equal(
			statSync(join(keysDir, `envSecrets.${generated.activeKid.slice(0, 8)}.public.pem`)).mode & 0o777,
			0o644
		);

		// reload round-trip: same kid, same material; a second ensure does not regenerate
		const reloaded = loadFileKeys();
		assert.equal(reloaded.activeKid, generated.activeKid);
		assert.equal(reloaded.keys.get(reloaded.activeKid), generated.keys.get(generated.activeKid));
		assert.equal(ensureFileKeys().activeKid, generated.activeKid);

		// the kid is the key material's own fingerprint
		assert.equal(kidOfPrivateKeyPem(generated.keys.get(generated.activeKid)), generated.activeKid);
	});

	it('decrypts a core-encrypted envelope and reports the matching fingerprint', () => {
		const custodyKeys = loadFileKeys();
		const custody = buildCustody(custodyKeys);
		const { publicKey, fingerprint } = custody.getPublicKey();
		assert.equal(fingerprint, custodyKeys.activeKid);
		assert.equal(fingerprintOf(publicKey), fingerprint);

		const envelope = ENV_ENCRYPTED_PREFIX + encryptEnvelope('s3cret-value', publicKey, fingerprint);
		assert.equal(custody.decrypt(envelope), 's3cret-value');
	});

	it('registers the keys in the core key store under per-kid and active-alias names', () => {
		const custodyKeys = loadFileKeys();
		const privateKeys = getPrivateKeys();
		try {
			registerCustodyKeysInKeyStore(custodyKeys);
			const activePem = custodyKeys.keys.get(custodyKeys.activeKid);
			assert.equal(privateKeys.get(privateKeyFileNameFor(custodyKeys.activeKid)), activePem);
			assert.equal(privateKeys.get(ACTIVE_CUSTODY_KEY_NAME), activePem);
		} finally {
			// the key store is process-global — don't leak into other test files
			privateKeys.delete(privateKeyFileNameFor(custodyKeys.activeKid));
			privateKeys.delete(ACTIVE_CUSTODY_KEY_NAME);
		}
	});
});
