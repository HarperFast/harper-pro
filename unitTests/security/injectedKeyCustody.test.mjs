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
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encryptEnvelope } from '#src/core/utility/secretEnvelope';
import { ENV_ENCRYPTED_PREFIX } from '#src/core/utility/envFile';
import { ingestInjectedMaterial, SECRETS_KEY_FD_ENV, SECRETS_KEY_B64_ENV } from '#src/security/injectedKeyCustody';
import { resetInjectedIngestionForTests } from '#src/security/custodyState';
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
		// ingestion is one-shot/cached (idempotent by design) — clear the latch between cases
		resetInjectedIngestionForTests();
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

	it('is idempotent: reads the fd once, then serves the cached PEM without re-reading', () => {
		const pem = makePem();
		const pemPath = join(workDir, 'once-key.pem');
		writeFileSync(pemPath, pem);
		const fd = openSync(pemPath, 'r');
		process.env[SECRETS_KEY_FD_ENV] = String(fd);

		assert.equal(ingestInjectedMaterial(), pem); // first call reads + closes the fd
		assert.throws(() => fstatSync(fd), /EBADF/);
		// second call must NOT re-read (the fd is gone) — it returns the cached value
		assert.equal(ingestInjectedMaterial(), pem);
	});

	// harper-pro#530: the fd the entrypoint hands us (`exec 3<`) has no close-on-exec, so until we
	// close it every descendant that shares the process fd table can read the key off /proc.
	// A worker thread is the sharpest witness — it shares the fd table outright (no exec), so
	// closing the fd is the ONLY thing that denies it access. (Spawned subprocesses are additionally
	// covered by libuv stripping non-stdio fds on spawn; the next test spot-checks that end-to-end.)
	it('closes the key fd so a worker thread cannot read it off /proc after ingestion', async () => {
		const pem = makePem();
		const pemPath = join(workDir, 'wt-key.pem');
		writeFileSync(pemPath, pem);
		const fd = openSync(pemPath, 'r');
		process.env[SECRETS_KEY_FD_ENV] = String(fd);

		const readFdInWorker = (fdNum) =>
			new Promise((resolve, reject) => {
				const worker = new Worker(
					`const { parentPort, workerData } = require('node:worker_threads');
					const fs = require('node:fs');
					let result;
					try { result = 'READ:' + fs.readFileSync('/proc/self/fd/' + workerData.fd, 'utf8'); }
					catch (e) { result = 'ERR:' + e.code; }
					parentPort.postMessage(result);`,
					{ eval: true, workerData: { fd: fdNum } }
				);
				worker.once('message', (message) => worker.terminate().then(() => resolve(message)));
				worker.once('error', reject);
			});

		// while the fd is open, a worker shares it and can read the key through /proc
		assert.match(await readFdInWorker(fd), /^READ:/);

		assert.equal(ingestInjectedMaterial(), pem);
		assert.throws(() => fstatSync(fd), /EBADF/); // closed in-process

		// now the same worker read fails — the fd is off the shared table
		assert.doesNotMatch(await readFdInWorker(fd), /^READ:/);
	});

	// End-to-end acceptance: a subprocess spawned AFTER ingestion does not have the key on fd 3.
	// We reproduce the full entrypoint handoff in a child that runs the REAL ingestion: fd 3 is
	// inherited into the child via `stdio` (which, like the entrypoint's `exec 3<`, clears
	// close-on-exec), the child ingests (closing fd 3) and then spawns a grandchild that spot-checks
	// /proc/self/fd/3. NOTE: libuv also strips non-stdio fds from spawned subprocesses, so this
	// asserts the end-to-end contract rather than isolating the provider's close — the worker-thread
	// test above is what fails if the close regresses.
	it('a subprocess spawned after ingestion does not have the key on fd 3', () => {
		const pem = makePem();
		const pemPath = join(workDir, 'child-key.pem');
		writeFileSync(pemPath, pem);
		const fd = openSync(pemPath, 'r');
		// require the built provider by absolute path so the child needs no package/condition setup
		const custodyStatePath = fileURLToPath(new URL('../../dist/security/custodyState.js', import.meta.url));

		const childScript = `
			process.env['${SECRETS_KEY_FD_ENV}'] = '3';
			require(${JSON.stringify(custodyStatePath)}).consumeInjectedKeyMaterial();
			const r = require('node:child_process').spawnSync(
				'sh', ['-c', 'readlink /proc/self/fd/3 2>/dev/null || echo NO_FD3'],
				{ stdio: ['ignore', 'pipe', 'inherit'] });
			process.stdout.write(r.stdout.toString().trim());`;

		const result = spawnSync(process.execPath, ['-e', childScript], {
			// pass the key file as the child's fd 3, mirroring the entrypoint's `exec 3<`
			stdio: ['ignore', 'pipe', 'inherit', fd],
			env: process.env,
		});
		fstatSync(fd); // this test still holds its own copy; the child closed only its inherited fd
		assert.doesNotMatch(result.stdout.toString().trim(), /child-key\.pem/); // grandchild never sees the key
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
