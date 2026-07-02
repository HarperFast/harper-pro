/**
 * Injected-tier ingestion (fd-first with env fallback and unconditional scrub), the kid-map
 * decrypt behavior of buildCustody, the worker-type filtering of the workerData provider, and
 * the pure provider-selection matrix.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, openSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { encryptEnvelope } from '#src/core/utility/secretEnvelope';
import { ENV_ENCRYPTED_PREFIX } from '#src/core/utility/envFile';
import { ingestInjectedMaterial, SECRETS_KEY_FD_ENV, SECRETS_KEY_B64_ENV } from '#src/security/injectedKeyCustody';
import { buildCustody, custodyKeysFromPem, makeWorkerDataProvider, chooseProvider } from '#src/security/keyCustody';
import { publicPemOf } from '#src/security/fileKeyCustody';

// RSA-2048 keeps the tests fast; the envelope scheme is modulus-size agnostic.
function makePem() {
	return generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	}).privateKey;
}

describe('injectedKeyCustody', () => {
	let workDir;
	before(() => {
		workDir = mkdtempSync(join(tmpdir(), 'custody-injected-test-'));
	});
	after(() => {
		rmSync(workDir, { recursive: true, force: true });
	});
	afterEach(() => {
		delete process.env[SECRETS_KEY_FD_ENV];
		delete process.env[SECRETS_KEY_B64_ENV];
	});

	it('ingests a PEM through a real fd, closes the fd, and scrubs both env vars', () => {
		const pem = makePem();
		const pemPath = join(workDir, 'fd-key.pem');
		writeFileSync(pemPath, pem);
		const fd = openSync(pemPath, 'r');
		process.env[SECRETS_KEY_FD_ENV] = String(fd);
		process.env[SECRETS_KEY_B64_ENV] = Buffer.from('decoy-should-not-be-used').toString('base64');

		const ingested = ingestInjectedMaterial();
		assert.equal(ingested, pem); // fd wins over the env fallback
		assert.equal(process.env[SECRETS_KEY_FD_ENV], undefined);
		assert.equal(process.env[SECRETS_KEY_B64_ENV], undefined);
		assert.throws(() => fstatSync(fd), /EBADF/); // fd was closed after the read
	});

	it('falls back to base64 env material and scrubs it', () => {
		const pem = makePem();
		process.env[SECRETS_KEY_B64_ENV] = Buffer.from(pem).toString('base64');
		assert.equal(ingestInjectedMaterial(), pem);
		assert.equal(process.env[SECRETS_KEY_B64_ENV], undefined);
	});

	it('rejects a non-integer fd value but still uses (and scrubs) the env fallback', () => {
		const pem = makePem();
		process.env[SECRETS_KEY_FD_ENV] = '../../etc/passwd';
		process.env[SECRETS_KEY_B64_ENV] = Buffer.from(pem).toString('base64');
		assert.equal(ingestInjectedMaterial(), pem);
		assert.equal(process.env[SECRETS_KEY_FD_ENV], undefined);
		assert.equal(process.env[SECRETS_KEY_B64_ENV], undefined);
	});

	it('returns undefined when no material is present', () => {
		assert.equal(ingestInjectedMaterial(), undefined);
	});

	it('decrypts by envelope kid from the map, falls back to the active key for kid-less envelopes, and rejects unknown kids', () => {
		const activePem = makePem();
		const olderPem = makePem();
		const custodyKeys = custodyKeysFromPem(activePem);
		const olderKeys = custodyKeysFromPem(olderPem);
		custodyKeys.keys.set(olderKeys.activeKid, olderPem); // two-entry kid map, active stays the same
		const custody = buildCustody(custodyKeys);

		// envelope for the OLDER (non-active) key resolves through the map by its kid
		const olderEnvelope =
			ENV_ENCRYPTED_PREFIX + encryptEnvelope('older-secret', publicPemOf(olderPem), olderKeys.activeKid);
		assert.equal(custody.decrypt(olderEnvelope), 'older-secret');

		// a kid-less envelope decrypts with the ACTIVE key
		const activeEnvelope = ENV_ENCRYPTED_PREFIX + encryptEnvelope('active-secret', publicPemOf(activePem), undefined);
		assert.equal(custody.decrypt(activeEnvelope), 'active-secret');

		// unknown kid surfaces the standard mismatch error
		const strangerKeys = custodyKeysFromPem(makePem());
		const strangerEnvelope =
			ENV_ENCRYPTED_PREFIX +
			encryptEnvelope(
				'other-secret',
				publicPemOf(strangerKeys.keys.get(strangerKeys.activeKid)),
				strangerKeys.activeKid
			);
		assert.throws(() => custody.decrypt(strangerEnvelope), /no secrets key for kid/);

		// getPublicKey exposes the single ACTIVE key
		assert.equal(custody.getPublicKey().fingerprint, custodyKeys.activeKid);
	});

	it('supplies key material to http workers only', () => {
		const custodyKeys = custodyKeysFromPem(makePem());
		const provider = makeWorkerDataProvider(custodyKeys);
		const forHttp = provider({ name: 'http' });
		assert.equal(forHttp.mode, 'injected');
		assert.equal(forHttp.activeKid, custodyKeys.activeKid);
		assert.deepEqual(forHttp.keys, Object.fromEntries(custodyKeys.keys));
		assert.equal(provider({ name: 'job' }), undefined);
		assert.equal(provider({}), undefined);
	});

	it('selects a provider automatically only when exactly one source exists', () => {
		assert.equal(chooseProvider(undefined, false, false), 'file'); // file tier generates on first boot
		assert.equal(chooseProvider(undefined, false, true), 'file');
		assert.equal(chooseProvider(undefined, true, false), 'injected');
		assert.equal(chooseProvider(undefined, true, true), 'ambiguous');
		assert.equal(chooseProvider('file', true, true), 'file');
		assert.equal(chooseProvider('injected', true, true), 'injected');
		assert.equal(chooseProvider('vault', false, false), 'invalid');
	});
});
