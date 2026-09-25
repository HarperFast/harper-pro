/**
 * SSH deploy keys are sealed at rest (harper-pro#581). Before this, `add_ssh_key` wrote the private
 * key plaintext to `<rootDir>/ssh/<name>.key` AND replicated the raw key in the operation body, so
 * the key material landed on every peer's disk.
 *
 * Coverage here is the ingest half — the key is sealed into an `enc:v1:` envelope before it touches
 * disk or the replicated op body:
 *  - add/update seal, and the object handed to `replicateOperation` carries the envelope, not the key
 *  - an already-sealed key (replicated from a peer, or cloned from the leader via `get_ssh_key`)
 *    is stored verbatim rather than double-sealed or decrypted
 *  - an envelope sealed under a different cluster key is refused
 *  - `update_ssh_key` rotation and `list_ssh_keys` (names only) are externally unchanged
 *  - degraded mode: no custody → plaintext (today's behavior) plus a loud WARN
 *
 * Plus `generate: true` (harper-pro#594), where the node mints the keypair itself: the minted private
 * half must take that same seal-then-replicate path, and `generate` must not survive into the
 * replicated op. The encoding of the minted key is covered in `sshKeyGeneration.test.mjs`.
 *
 * The at-use half — decrypting to a transient 0600 file for the git invocation — lives in core
 * (`materializeGitSSH`) and is covered by core's Application tests.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { hasSSH, hasSSHKeygen } from './sshKeyFixtures.mjs';

// Real keys, minted in `before`: a supplied key must be one ssh can load.
let PRIVATE_KEY;
let PUBLIC_KEY;
let ROTATED_KEY;

function makePem() {
	return generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	}).privateKey;
}

describe('sshKeyOperations sealing', () => {
	let rootDir;
	let sshDir;
	let ops;
	let core; // secretDecryptor
	let custodyModule;
	let envMgr;
	let terms;
	let server;
	let harperLogger;
	let warnings;
	let originalWarn;

	// addSSHKey/updateSSHKey call replicateOperation, which dispatches to `server.nodes`. An empty
	// peer list exercises the real replication path (including the `req` it would have sent) without
	// a network.
	const request = (fields) => ({ ...fields });

	before(async function () {
		this.timeout(60000);
		envMgr = await import('#src/core/utility/environment/environmentManager');
		terms = await import('#src/core/utility/hdbTerms');
		({ server } = await import('#src/core/server/Server'));
		core = await import('#src/core/resources/secretDecryptor');
		custodyModule = await import('#src/security/keyCustody');
		harperLogger = (await import('#src/core/utility/logging/harper_logger')).default;
		ops = await import('#src/security/sshKeyOperations');
		const { generateEd25519SSHKeyPair } = await import('#src/security/sshKeyGeneration');
		({ privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = await generateEd25519SSHKeyPair('harper:deploy'));
		({ privateKey: ROTATED_KEY } = await generateEd25519SSHKeyPair('harper:rotated'));
	});

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), 'ssh-key-ops-test-'));
		sshDir = join(rootDir, 'ssh');
		envMgr.setProperty(terms.CONFIG_PARAMS.ROOTPATH, rootDir);
		server.nodes = [];

		warnings = [];
		originalWarn = harperLogger.warn;
		harperLogger.warn = (...args) => warnings.push(args.join(' '));

		// the file tier is what a real node runs: a cluster-shared keypair every peer holds
		custodyModule.resetKeyCustodyForTests();
		core.registerSecretCustody(custodyModule.buildCustody(custodyModule.custodyKeysFromPem(makePem())));
	});

	afterEach(() => {
		harperLogger.warn = originalWarn;
		core.clearSecretCustody();
		custodyModule.resetKeyCustodyForTests();
		rmSync(rootDir, { recursive: true, force: true });
	});

	const storedKeyFor = (name) => readFileSync(join(sshDir, `${name}.key`), 'utf8');
	const decrypt = (value) => core.getSecretCustody().decrypt(value);

	it('seals the private key before it reaches disk, and replicates the envelope rather than the key', async () => {
		const req = request({ name: 'deploy', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' });
		const response = await ops.addSSHKey(req);

		assert.equal(response.message, 'Added ssh key: deploy');

		// on disk: an envelope, never the key material
		const stored = storedKeyFor('deploy');
		assert.ok(stored.startsWith('enc:v1:'), 'key file should hold an enc:v1: envelope');
		assert.ok(!stored.includes('OPENSSH PRIVATE KEY'), 'plaintext key must not be on disk');
		assert.equal(decrypt(stored), PRIVATE_KEY, 'the envelope must round-trip to the original key');
		assert.equal(statSync(join(sshDir, 'deploy.key')).mode & 0o777, 0o600);

		// on the wire: replicateOperation is handed this same `req`, so the op body must already
		// carry the envelope — this is the peer's-disk exposure the issue is about
		assert.ok(req.key.startsWith('enc:v1:'), 'the replicated op body must carry the envelope');
		assert.equal(req.key, stored);
		assert.notEqual(req.key, PRIVATE_KEY);
	});

	it('writes the ssh config block pointing at the durable key path (core repoints it at the transient copy)', async () => {
		await ops.addSSHKey(request({ name: 'deploy', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' }));

		const config = readFileSync(join(sshDir, 'config'), 'utf8');
		assert.match(config, /IdentityFile .*deploy\.key/);
		assert.ok(!config.includes('OPENSSH PRIVATE KEY'));
	});

	it('stores an already-sealed key verbatim (peer replication / clone from leader) without double-sealing', async () => {
		// what a peer receives, or what cloneSSHKeys reads back from the leader via get_ssh_key
		await ops.addSSHKey(request({ name: 'origin', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' }));
		const envelope = storedKeyFor('origin');

		const req = request({ name: 'replica', key: envelope, host: 'gh', hostname: 'example.com' });
		await ops.addSSHKey(req);

		assert.equal(storedKeyFor('replica'), envelope, 'the envelope should be stored as-is');
		assert.equal(req.key, envelope, 'and forwarded as-is — never decrypted to forward');
		assert.equal(decrypt(storedKeyFor('replica')), PRIVATE_KEY);
	});

	it('refuses an envelope sealed under a different cluster key', async () => {
		const foreign = await import('#src/core/utility/secretEnvelope');
		const otherPem = makePem();
		const otherKeys = custodyModule.custodyKeysFromPem(otherPem);
		const fileModule = await import('#src/security/fileKeyCustody');
		const foreignEnvelope =
			'enc:v1:' + foreign.encryptEnvelope(PRIVATE_KEY, fileModule.publicPemOf(otherPem), otherKeys.activeKid);

		await assert.rejects(
			ops.addSSHKey(request({ name: 'foreign', key: foreignEnvelope, host: 'gh', hostname: 'example.com' })),
			/does not match this cluster's secrets key/
		);
	});

	it('refuses a malformed envelope', async () => {
		await assert.rejects(
			ops.addSSHKey(request({ name: 'bad', key: 'enc:v1:not-an-envelope', host: 'gh', hostname: 'example.com' })),
			/Invalid SSH key envelope/
		);
	});

	it('update_ssh_key rotates to a new sealed key, unchanged externally', async () => {
		await ops.addSSHKey(request({ name: 'deploy', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' }));
		const before = storedKeyFor('deploy');

		const req = request({ name: 'deploy', key: ROTATED_KEY });
		const response = await ops.updateSSHKey(req);

		assert.equal(response.message, 'Updated ssh key: deploy');
		const after = storedKeyFor('deploy');
		assert.notEqual(after, before, 'rotation must replace the stored envelope');
		assert.ok(after.startsWith('enc:v1:'));
		assert.equal(decrypt(after), ROTATED_KEY);
		assert.ok(req.key.startsWith('enc:v1:'), 'rotation must not replicate the raw key either');
	});

	it('list_ssh_keys still returns names (and host config) only — never key material', async () => {
		await ops.addSSHKey(request({ name: 'alpha', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' }));
		await ops.addSSHKey(request({ name: 'beta', key: ROTATED_KEY, host: 'gl', hostname: 'example.org' }));

		const listed = await ops.listSSHKeys();

		assert.deepEqual(listed.map((entry) => entry.name).sort(), ['alpha', 'beta']);
		for (const entry of listed) {
			assert.equal(entry.key, undefined);
			assert.ok('host' in entry && 'hostname' in entry);
		}
	});

	describe('generate: true (harper-pro#594)', () => {
		// deliberately not `hostname: 'github.com'` — that branch fetches api.github.com for real, and a
		// unit test should not depend on the network (or on GitHub's unauthenticated rate limit)
		it('mints the keypair, returns the public half, and seals the private half like a supplied key', async () => {
			const req = request({ name: 'minted', generate: true, host: 'gh', hostname: 'example.com' });
			const response = await ops.addSSHKey(req);

			assert.equal(response.message, 'Added ssh key: minted');
			assert.match(response.public_key, /^ssh-ed25519 [A-Za-z0-9+/=]+ harper:minted$/);

			// the private half took the same seal-at-rest path a client-supplied key takes
			const stored = storedKeyFor('minted');
			assert.ok(stored.startsWith('enc:v1:'), 'the minted key must be sealed at rest');
			assert.match(decrypt(stored), /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
			assert.equal(statSync(join(sshDir, 'minted.key')).mode & 0o777, 0o600);

			// the minted plaintext must not reach the wire either
			assert.equal(req.key, stored);
			assert.ok(!req.key.includes('OPENSSH PRIVATE KEY'));
		});

		it('strips `generate` before replicating, so a peer stores the minted key instead of minting its own', async () => {
			// left in place, the replicated op would carry both `generate` and the minted `key` — which
			// addSSHKey's mutual-exclusion guard would then reject on every peer
			const req = request({ name: 'minted', generate: true, host: 'gh', hostname: 'example.com' });
			await ops.addSSHKey(req);

			assert.ok(!('generate' in req), 'the replicated op body must not carry `generate`');
			assert.ok(req.key.startsWith('enc:v1:'), 'it carries the sealed minted key instead');
		});

		it('refuses `generate` together with `key`', async () => {
			await assert.rejects(
				ops.addSSHKey(request({ name: 'both', generate: true, key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' })),
				/Provide either `key` or `generate: true`, not both/
			);
		});

		it("refuses a stringified `generate`, rather than minting for a truthy 'false'", async () => {
			// validateBySchema discards Joi's coerced value, so without .strict() the raw string stays on
			// the request — and 'false' is truthy, which would mint a keypair the caller declined
			for (const value of ['false', 'true', 'FALSE']) {
				await assert.rejects(
					ops.addSSHKey(request({ name: 'stringy', generate: value, host: 'gh', hostname: 'example.com' })),
					/must be a boolean/,
					`expected ${JSON.stringify(value)} to be rejected outright`
				);
			}
			assert.throws(() => readFileSync(join(sshDir, 'stringy.key')), /ENOENT/, 'nothing may have been minted');
		});

		it('refuses neither `generate` nor `key`', async () => {
			await assert.rejects(
				ops.addSSHKey(request({ name: 'neither', host: 'gh', hostname: 'example.com' })),
				/requires `key`, or `generate: true`/
			);
		});

		it('rejects a duplicate name before minting anything', async () => {
			await ops.addSSHKey(request({ name: 'taken', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' }));
			const before = storedKeyFor('taken');

			await assert.rejects(
				ops.addSSHKey(request({ name: 'taken', generate: true, host: 'gh', hostname: 'example.com' })),
				/Key already exists/
			);
			assert.equal(storedKeyFor('taken'), before, 'the existing key must be untouched');
		});
	});

	it('get_ssh_key returns the stored envelope, so the clone path carries ciphertext too', async () => {
		await ops.addSSHKey(request({ name: 'deploy', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' }));

		const fetched = await ops.getSSHKey({ name: 'deploy' });

		assert.ok(fetched.key.startsWith('enc:v1:'));
		assert.ok(!fetched.key.includes('OPENSSH PRIVATE KEY'));
		assert.equal(fetched.host, 'gh');
		assert.equal(fetched.hostname, 'example.com');
	});

	describe('degraded mode (no secret custody on this node)', () => {
		beforeEach(() => {
			core.clearSecretCustody();
		});

		it('falls back to the plaintext key file and says so at WARN', async () => {
			const req = request({ name: 'deploy', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' });
			await ops.addSSHKey(req);

			assert.equal(storedKeyFor('deploy'), PRIVATE_KEY, 'degraded mode keeps the pre-#581 behavior');
			assert.equal(statSync(join(sshDir, 'deploy.key')).mode & 0o777, 0o600);

			const warned = warnings.find((line) => line.includes('PLAINTEXT'));
			assert.ok(warned, `expected a plaintext WARN, got: ${JSON.stringify(warnings)}`);
			assert.ok(warned.includes('deploy'), 'the WARN should name the key');
			assert.ok(!warned.includes('OPENSSH PRIVATE KEY'), 'the WARN must not contain key material');
		});

		it('still accepts a sealed key from a peer, storing it opaquely for a node that can decrypt it', async () => {
			// a cluster where the custody key has not reached this node yet (e.g. mid-clone) must not
			// reject replicated keys — it stores the envelope it cannot read
			const custodyKeys = custodyModule.custodyKeysFromPem(makePem());
			const envelopeModule = await import('#src/core/utility/secretEnvelope');
			const fileModule = await import('#src/security/fileKeyCustody');
			const envelope =
				'enc:v1:' +
				envelopeModule.encryptEnvelope(
					PRIVATE_KEY,
					fileModule.publicPemOf(custodyKeys.keys.get(custodyKeys.activeKid)),
					custodyKeys.activeKid
				);

			await ops.addSSHKey(request({ name: 'replica', key: envelope, host: 'gh', hostname: 'example.com' }));

			assert.equal(storedKeyFor('replica'), envelope);
		});

		it('stores a pasted key as the normalized plaintext ssh reads', async () => {
			await ops.addSSHKey(request({ name: 'deploy', key: pasted(PRIVATE_KEY), host: 'gh', hostname: 'example.com' }));

			assert.equal(storedKeyFor('deploy'), PRIVATE_KEY);
		});
	});

	// an indented, CRLF, double-spaced copy of `key` — every line of it still the key's
	const pasted = (key) =>
		key
			.trimEnd()
			.split('\n')
			.map((line) => `\t${line}  `)
			.join('\r\n\r\n');
	const isClientError = (pattern) => (error) => error.statusCode === 400 && pattern.test(error.message);
	const configFile = () => join(sshDir, 'config');

	describe('validating what is supplied', () => {
		it('refuses a public key in place of the private one, and writes nothing', async () => {
			const req = request({ name: 'deploy', key: PUBLIC_KEY, host: 'gh', hostname: 'example.com' });

			await assert.rejects(
				ops.addSSHKey(req),
				isClientError(/^The SSH key looks like a public key \("ssh-ed25519 …"\)/)
			);
			assert.throws(() => storedKeyFor('deploy'), /ENOENT/);
			assert.throws(() => readFileSync(configFile()), /ENOENT/);
			assert.equal(req.key, PUBLIC_KEY, 'nothing was sealed for replication either');
		});

		it('stores, and replicates, a pasted key in the form ssh reads', async () => {
			const req = request({ name: 'deploy', key: pasted(PRIVATE_KEY), host: 'gh', hostname: 'example.com' });
			await ops.addSSHKey(req);

			assert.equal(decrypt(storedKeyFor('deploy')), PRIVATE_KEY);
			assert.equal(req.key, storedKeyFor('deploy'));
		});

		it('refuses a rotation to a key ssh could not load, leaving the working key untouched', async () => {
			await ops.addSSHKey(request({ name: 'deploy', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' }));
			const keyBefore = storedKeyFor('deploy');
			const configBefore = readFileSync(configFile(), 'utf8');

			const broken = PRIVATE_KEY.replace(/\n[A-Za-z0-9+/=]+\n/, '\n');
			await assert.rejects(ops.updateSSHKey(request({ name: 'deploy', key: broken })), isClientError(/damaged/));
			await assert.rejects(ops.updateSSHKey(request({ name: 'deploy', key: PUBLIC_KEY })), isClientError(/public key/));

			assert.equal(storedKeyFor('deploy'), keyBefore);
			assert.equal(readFileSync(configFile(), 'utf8'), configBefore);
		});

		it('rotates to a pasted key stored in the form ssh reads', async () => {
			await ops.addSSHKey(request({ name: 'deploy', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' }));
			const req = request({ name: 'deploy', key: pasted(ROTATED_KEY) });
			await ops.updateSSHKey(req);

			assert.equal(decrypt(storedKeyFor('deploy')), ROTATED_KEY);
			assert.equal(req.key, storedKeyFor('deploy'));
		});

		it('writes and replicates host and hostname trimmed', async () => {
			// deliberately not github.com, which fetches api.github.com's known hosts for real
			const req = request({
				name: 'deploy',
				key: PRIVATE_KEY,
				host: ' deploy.example.com\n',
				hostname: '\tgit.example.com ',
			});
			await ops.addSSHKey(req);

			assert.match(readFileSync(configFile(), 'utf8'), /^Host deploy\.example\.com\n\tHostName git\.example\.com\n/m);
			assert.equal(req.host, 'deploy.example.com');
			assert.equal(req.hostname, 'git.example.com');
		});

		it('refuses a host or hostname that would break the ssh config every key shares, before writing anything', async () => {
			for (const [field, value, reason] of [
				['host', 'deploy example.com', /must be a single alias/],
				['hostname', 'git.example.com extra', /must be a single hostname/],
				['hostname', 'git"example.com', /must not contain quotes/],
				['hostname', '=#x', /must not contain quotes or "="/],
				['host', '*.example.com', /must be one alias, not a pattern/],
				['host', '-oProxyCommand', /must not start with "-"/],
			]) {
				const req = request({ name: 'bad', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com', [field]: value });
				await assert.rejects(ops.addSSHKey(req), isClientError(new RegExp(`^'${field}' ${reason.source}`)));
			}
			assert.throws(() => storedKeyFor('bad'), /ENOENT/);
			assert.throws(() => readFileSync(configFile()), /ENOENT/);
		});

		it('cloning from a leader skips a legacy key this node refuses, and still clones the next one', async () => {
			// a key the leader stored before validation existed, as its get_ssh_key returns it
			const leader = {
				legacy: { name: 'legacy', key: 'random\nstring', host: 'legacy.example.com', hostname: 'example.com' },
				deploy: { name: 'deploy', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' },
			};
			const logged = [];
			const { cloneSSHKeysFromLeader } = await import('#src/cloneNode/sshKeyClone');
			await cloneSSHKeysFromLeader(
				async ({ operation, name }) =>
					operation === 'list_ssh_keys' ? [{ name: 'legacy' }, { name: 'deploy' }] : { ...leader[name] },
				ops.addSSHKey,
				(message, level) => logged.push({ message, level })
			);

			assert.equal(decrypt(storedKeyFor('deploy')), PRIVATE_KEY);
			assert.throws(() => storedKeyFor('legacy'), /ENOENT/);
			const errors = logged.filter(({ level }) => level === 'error').map(({ message }) => message);
			assert.equal(errors.length, 1);
			assert.match(errors[0], /^Skipped cloning SSH key 'legacy': The SSH key doesn't look like a private key\./);
			assert.ok(!logged.some(({ message }) => message.includes('random')), 'no key material may be logged');
		});
	});

	describe('a stored key, loaded by ssh for a git deploy', () => {
		before(function () {
			if (!hasSSH || !hasSSHKeygen) this.skip();
		});

		it("decrypts through core's materializeGitSSH to a key ssh loads, under the alias it was added with", async function () {
			this.timeout(60000);
			const { materializeGitSSH } = await import('#src/core/components/Application');
			await ops.addSSHKey(
				request({ name: 'deploy', key: pasted(PRIVATE_KEY), host: 'deploy.example.com', hostname: 'git.example.com' })
			);

			const gitSSH = await materializeGitSSH();
			try {
				const sshConfig = gitSSH.command.match(/-F (\S+)/)[1];
				const resolved = execFileSync('ssh', ['-G', '-F', sshConfig, 'deploy.example.com'], {
					stdio: ['ignore', 'pipe', 'pipe'],
				}).toString();
				assert.match(resolved, /^hostname git\.example\.com$/m);
				const identityFile = resolved.match(/^identityfile (.+)$/m)[1];
				const derived = execFileSync('ssh-keygen', ['-y', '-P', '', '-f', identityFile], {
					stdio: ['ignore', 'pipe', 'pipe'],
				}).toString();
				assert.equal(derived.split(' ').slice(0, 2).join(' '), PUBLIC_KEY.split(' ').slice(0, 2).join(' '));
			} finally {
				await gitSSH.cleanup();
			}
		});
	});
});
