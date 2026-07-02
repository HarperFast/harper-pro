/**
 * Component-level custody behavior against the real core submodule:
 *  - startOnMainThread (injected tier): ingest + scrub, registerSecretCustody wiring (core's
 *    decryptor slot + deferred-env replay flush), workerData provider registration probe.
 *  - ambiguity refusal: injected material + on-disk key → no custody, explicit config demanded.
 *  - dormancy: no material anywhere → nothing registered, loadEnv skip/defer behavior intact.
 *  - get_key custody-name gate: 403 without bypass_auth, served with it; other keys unaffected.
 *  - regression (core owns get_secrets_public_key): Pro startup never registers that operation.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';

function makePem() {
	return generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	}).privateKey;
}

describe('keyCustody component', () => {
	let baseDir;
	let server;
	let registeredOperations;
	let originalRegisterOperation;
	let core; // { registerSecretCustody, getSecretCustody, clearSecretCustody, getSecretDecryptor, clearSecretDecryptor, deferEncryptedEnvValue, getDeferredEncryptedEnvValues }
	let envelope; // { encryptEnvelope, fingerprintOf }
	let envFile; // { ENV_ENCRYPTED_PREFIX }
	let custodyModule;
	let fileModule;
	let injectedModule;
	let manageThreads;
	let getKeyExecute;

	let envMgr;
	let keysModule;
	let serverUtilities;

	before(async function () {
		this.timeout(60000);
		baseDir = mkdtempSync(join(tmpdir(), 'custody-component-test-'));
		envMgr = await import('#src/core/utility/environment/environmentManager');

		// serverUtilities installs server.registerOperation; wrap it BEFORE loading the Pro
		// modules so every Pro registration from here on is recorded.
		serverUtilities = await import('#src/core/server/serverHelpers/serverUtilities');
		({ server } = await import('#src/core/server/Server'));
		registeredOperations = [];
		originalRegisterOperation = server.registerOperation;
		server.registerOperation = (definition) => {
			registeredOperations.push(definition);
			return originalRegisterOperation(definition);
		};

		keysModule = await import('#src/core/security/keys');
		core = await import('#src/core/resources/secretDecryptor');
		envelope = await import('#src/core/utility/secretEnvelope');
		envFile = await import('#src/core/utility/envFile');
		manageThreads = await import('#src/core/server/threads/manageThreads');
		await import('#src/security/keyService'); // registers get_key (idempotent if already loaded)
		custodyModule = await import('#src/security/keyCustody');
		fileModule = await import('#src/security/fileKeyCustody');
		injectedModule = await import('#src/security/injectedKeyCustody');
		// resolve get_key through the real operation map (keyService may have been imported by an
		// earlier test file, before the recorder was installed)
		getKeyExecute = serverUtilities.getOperationFunction({ operation: 'get_key' }).operation_function;
	});

	// after all imports: loading Server/manageThreads re-initializes install props from the boot
	// props file, which would override an earlier setHdbBasePath and point keysDir at the real
	// local hdb root
	beforeEach(() => {
		envMgr.setHdbBasePath(baseDir);
	});

	after(() => {
		if (originalRegisterOperation) server.registerOperation = originalRegisterOperation;
		rmSync(baseDir, { recursive: true, force: true });
	});

	afterEach(() => {
		core.clearSecretCustody();
		core.clearSecretDecryptor();
		custodyModule.resetKeyCustodyForTests();
		delete process.env[injectedModule.SECRETS_KEY_FD_ENV];
		delete process.env[injectedModule.SECRETS_KEY_B64_ENV];
		rmSync(join(baseDir, 'keys'), { recursive: true, force: true });
		// the key store is process-global — clear any custody entries a test registered
		const privateKeys = keysModule.getPrivateKeys();
		for (const name of privateKeys.keys()) {
			if (fileModule.isCustodyKeyName(name)) privateKeys.delete(name);
		}
	});

	it('activates the injected tier: scrubs env, registers custody + decryptor, flushes deferred env values, registers the workerData provider', async () => {
		const pem = makePem();
		process.env[injectedModule.SECRETS_KEY_B64_ENV] = Buffer.from(pem).toString('base64');

		// an encrypted env value loaded before custody came up (queued by core loadEnv)
		const kid = fileModule.kidOfPrivateKeyPem(pem);
		const publicPem = fileModule.publicPemOf(pem);
		const deferred = envFile.ENV_ENCRYPTED_PREFIX + envelope.encryptEnvelope('deferred-plain', publicPem, kid);
		delete process.env.CUSTODY_TEST_DEFERRED;
		core.deferEncryptedEnvValue({
			key: 'CUSTODY_TEST_DEFERRED',
			rawValue: deferred,
			sourcePath: '/apps/x/.env',
			override: false,
		});

		custodyModule.startOnMainThread();

		assert.equal(process.env[injectedModule.SECRETS_KEY_B64_ENV], undefined); // scrubbed
		assert.equal(core.getDeferredEncryptedEnvValues().length, 0);
		const custody = core.getSecretCustody();
		assert.notEqual(custody, undefined);
		assert.equal(custody.getPublicKey().fingerprint, kid);
		// registerSecretCustody installed the decryptor slot (loadEnv path) too
		const inline = envFile.ENV_ENCRYPTED_PREFIX + envelope.encryptEnvelope('inline-plain', publicPem, kid);
		assert.equal(core.getSecretDecryptor()(inline), 'inline-plain');
		// ...and registration flushed the deferred queue into process.env
		assert.equal(process.env.CUSTODY_TEST_DEFERRED, 'deferred-plain');
		assert.equal(core.getDeferredEncryptedEnvValues().length, 0);
		delete process.env.CUSTODY_TEST_DEFERRED;

		// nothing persisted, nothing in the key store for the injected tier
		assert.equal(fileModule.hasFileKeys(), false);
		const { getPrivateKeys } = await import('#src/core/security/keys');
		assert.equal(getPrivateKeys().get(fileModule.ACTIVE_CUSTODY_KEY_NAME), undefined);
		// probe: the custody workerData provider is registered — a second registration collides
		assert.throws(
			() => manageThreads.registerWorkerDataProvider(custodyModule.CUSTODY_WORKER_DATA_KEY, () => undefined),
			/already in use/
		);
	});

	it('refuses to activate when both injected material and an on-disk key are present', () => {
		const filePem = makePem();
		const kid = fileModule.kidOfPrivateKeyPem(filePem);
		mkdirSync(join(baseDir, 'keys'), { recursive: true });
		writeFileSync(join(baseDir, 'keys', fileModule.privateKeyFileNameFor(kid)), filePem, { mode: 0o600 });
		process.env[injectedModule.SECRETS_KEY_B64_ENV] = Buffer.from(makePem()).toString('base64');

		custodyModule.startOnMainThread();

		assert.equal(core.getSecretCustody(), undefined);
		assert.equal(core.getSecretDecryptor(), undefined);
		assert.equal(process.env[injectedModule.SECRETS_KEY_B64_ENV], undefined); // still scrubbed
		// the disabled marker provider is registered for workers
		assert.throws(
			() => manageThreads.registerWorkerDataProvider(custodyModule.CUSTODY_WORKER_DATA_KEY, () => undefined),
			/already in use/
		);
	});

	it('explicit provider config resolves the ambiguity', () => {
		const filePem = makePem();
		const kid = fileModule.kidOfPrivateKeyPem(filePem);
		mkdirSync(join(baseDir, 'keys'), { recursive: true });
		writeFileSync(join(baseDir, 'keys', fileModule.privateKeyFileNameFor(kid)), filePem, { mode: 0o600 });
		process.env[injectedModule.SECRETS_KEY_B64_ENV] = Buffer.from(makePem()).toString('base64');

		custodyModule.startOnMainThread({ provider: 'file' });

		assert.equal(core.getSecretCustody().getPublicKey().fingerprint, kid); // the FILE key won
		assert.equal(process.env[injectedModule.SECRETS_KEY_B64_ENV], undefined);
	});

	it('stays dormant with no key material anywhere (worker start path)', () => {
		custodyModule.start();
		assert.equal(core.getSecretCustody(), undefined);
		assert.equal(core.getSecretDecryptor(), undefined);
		// loadEnv defer behavior is intact: entries queue instead of being applied
		core.deferEncryptedEnvValue({
			key: 'CUSTODY_TEST_X',
			rawValue: 'enc:v1:x',
			sourcePath: '/x/.env',
			override: false,
		});
		assert.equal(core.getDeferredEncryptedEnvValues().length, 1);
		assert.equal(process.env.CUSTODY_TEST_X, undefined);
	});

	it('worker start loads the file tier from disk and populates the key store', async () => {
		const filePem = makePem();
		const kid = fileModule.kidOfPrivateKeyPem(filePem);
		mkdirSync(join(baseDir, 'keys'), { recursive: true });
		writeFileSync(join(baseDir, 'keys', fileModule.privateKeyFileNameFor(kid)), filePem, { mode: 0o600 });

		custodyModule.start();

		assert.equal(core.getSecretCustody().getPublicKey().fingerprint, kid);
		const { getPrivateKeys } = await import('#src/core/security/keys');
		assert.equal(getPrivateKeys().get(fileModule.ACTIVE_CUSTODY_KEY_NAME), filePem);
		assert.equal(getPrivateKeys().get(fileModule.privateKeyFileNameFor(kid)), filePem);
	});

	it('get_key serves custody keys only to bypass_auth (internal / node-identity) requests', async () => {
		assert.notEqual(getKeyExecute, undefined);
		const { getPrivateKeys } = await import('#src/core/security/keys');
		getPrivateKeys().set(fileModule.ACTIVE_CUSTODY_KEY_NAME, 'CUSTODY-PEM');
		getPrivateKeys().set('unrelated.key', 'UNRELATED-PEM');
		try {
			// external-style request (bypass_auth stripped by the HTTP layer): refused with 403
			await assert.rejects(getKeyExecute({ name: fileModule.ACTIVE_CUSTODY_KEY_NAME }), (error) => {
				assert.match(error.message, /node-identity/);
				assert.equal(error.statusCode, 403);
				return true;
			});
			// node-identity / internal request: served
			assert.equal(await getKeyExecute({ name: fileModule.ACTIVE_CUSTODY_KEY_NAME, bypass_auth: true }), 'CUSTODY-PEM');
			// non-custody keys keep the existing behavior
			assert.equal(await getKeyExecute({ name: 'unrelated.key' }), 'UNRELATED-PEM');
		} finally {
			getPrivateKeys().delete(fileModule.ACTIVE_CUSTODY_KEY_NAME);
			getPrivateKeys().delete('unrelated.key');
		}
	});

	it('never registers get_secrets_public_key (core owns that operation)', async () => {
		const coreSecretOperations = await import('#src/core/components/secretOperations');
		const beforeHandler = serverUtilities.getOperationFunction({
			operation: 'get_secrets_public_key',
		}).operation_function;
		assert.equal(beforeHandler, coreSecretOperations.getSecretsPublicKey); // core's own handler

		// exercise both entry points, then verify nothing Pro registered overwrote it
		// (server.registerOperation is a silent Map.set)
		process.env[injectedModule.SECRETS_KEY_B64_ENV] = Buffer.from(makePem()).toString('base64');
		custodyModule.startOnMainThread();
		custodyModule.resetKeyCustodyForTests();
		custodyModule.start();
		const names = registeredOperations.map((definition) => definition.name);
		assert.equal(names.includes('get_secrets_public_key'), false);
		const afterHandler = serverUtilities.getOperationFunction({
			operation: 'get_secrets_public_key',
		}).operation_function;
		assert.equal(afterHandler, coreSecretOperations.getSecretsPublicKey);
	});
});
