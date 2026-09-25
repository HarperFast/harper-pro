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
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----\n';
const ROTATED_KEY =
	'-----BEGIN OPENSSH PRIVATE KEY-----\ncm90YXRlZC1rZXktbWF0ZXJpYWw\n-----END OPENSSH PRIVATE KEY-----\n';

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

	describe('ssh config blocks', () => {
		const configPath = () => join(sshDir, 'config');
		const addKey = (name) =>
			ops.addSSHKey(request({ name, key: PRIVATE_KEY, host: `${name}.alias`, hostname: 'example.com' }));
		const blockFor = (name) =>
			`#${name}\nHost ${name}.alias\n\tHostName example.com\n\tUser git\n\tIdentityFile ${join(sshDir, `${name}.key`)}\n\tIdentitiesOnly yes`;
		const byName = (a, b) => a.name.localeCompare(b.name);

		describe('of keys whose names share a prefix', () => {
			// `repo` is a prefix of `repo-2`, so a `#repo` pattern not anchored to its whole comment line
			// also matches the `#repo-2` block
			for (const order of [
				['repo-2', 'repo'],
				// `repo`'s block opens the file, with no line break before its comment line
				['repo', 'repo-2'],
			]) {
				describe(`added as ${order.join(', ')}`, () => {
					beforeEach(async () => {
						for (const name of order) await addKey(name);
					});

					it('get_ssh_key and list_ssh_keys return each key its own host', async () => {
						for (const name of order) assert.equal((await ops.getSSHKey({ name })).host, `${name}.alias`);
						assert.deepEqual((await ops.listSSHKeys()).sort(byName), [
							{ name: 'repo', host: 'repo.alias', hostname: 'example.com' },
							{ name: 'repo-2', host: 'repo-2.alias', hostname: 'example.com' },
						]);
					});

					it("delete_ssh_key removes only its own block, leaving the sibling's intact", async () => {
						await ops.deleteSSHKey({ name: 'repo' });

						assert.equal(readFileSync(configPath(), 'utf8'), blockFor('repo-2'));
						assert.deepEqual(await ops.listSSHKeys(), [
							{ name: 'repo-2', host: 'repo-2.alias', hostname: 'example.com' },
						]);
					});
				});
			}

			it('matches the comment line of a hand-edited config: blanks around the name, CRLF line endings', async () => {
				const handEdited = (text) => text.replace(/^#.*$/gm, ' \t$& \t').replace(/\n/g, '\r\n');
				for (const name of ['repo-2', 'repo']) await addKey(name);
				writeFileSync(configPath(), handEdited(readFileSync(configPath(), 'utf8')));

				assert.equal((await ops.getSSHKey({ name: 'repo' })).host, 'repo.alias');
				await ops.deleteSSHKey({ name: 'repo' });
				assert.equal(readFileSync(configPath(), 'utf8'), handEdited(blockFor('repo-2')).trimStart());
			});
		});

		for (const [edit, closingLine] of [
			['re-spaced', '\tIdentitiesOnly    yes'],
			['lower-cased', '\tidentitiesonly yes'],
			['written with `=`', '\tIdentitiesOnly = Yes'],
			['double-quoted', '\tIdentitiesOnly "yes"'],
			['single-quoted', "\tIdentitiesOnly 'yes'"],
			['given a trailing comment', '\tIdentitiesOnly yes # deploy key'],
		]) {
			it(`delete_ssh_key still ends a block at its closing line when that line was ${edit}`, async () => {
				const unmanaged = 'Host other\n\tHostName example.net';
				for (const name of ['first', 'second']) await addKey(name);
				writeFileSync(
					configPath(),
					readFileSync(configPath(), 'utf8').replace('\tIdentitiesOnly yes\n', `${closingLine}\n${unmanaged}\n`)
				);

				await ops.deleteSSHKey({ name: 'first' });
				assert.equal(readFileSync(configPath(), 'utf8'), `${unmanaged}\n${blockFor('second')}`);
			});
		}

		it("delete_ssh_key stops at the next key's block when a block's closing line was removed", async () => {
			for (const name of ['first', 'second']) await addKey(name);
			writeFileSync(configPath(), readFileSync(configPath(), 'utf8').replace('\tIdentitiesOnly yes\n', ''));

			await ops.deleteSSHKey({ name: 'first' });
			assert.equal(readFileSync(configPath(), 'utf8'), blockFor('second'));
		});

		it('delete_ssh_key stops at the next Host section when a block has no closing `IdentitiesOnly yes`', async () => {
			const unmanaged = 'Host other\n\tHostName example.net';
			await addKey('first');
			writeFileSync(
				configPath(),
				`${readFileSync(configPath(), 'utf8').replace('\tIdentitiesOnly yes', '\tIdentitiesOnly no')}\n${unmanaged}`
			);

			await ops.deleteSSHKey({ name: 'first' });
			assert.equal(readFileSync(configPath(), 'utf8'), unmanaged);
		});

		it('delete_ssh_key takes a middle block with its line break, leaving no blank line', async () => {
			for (const name of ['first', 'middle', 'last']) await addKey(name);

			await ops.deleteSSHKey({ name: 'middle' });
			assert.equal(readFileSync(configPath(), 'utf8'), `${blockFor('first')}\n${blockFor('last')}`);
		});

		it('delete_ssh_key keeps config lines after a block that belong to no key', async () => {
			const unmanaged = 'Host other\n\tHostName example.net';
			await addKey('repo');
			writeFileSync(configPath(), `${readFileSync(configPath(), 'utf8')}\n${unmanaged}`);

			await ops.deleteSSHKey({ name: 'repo' });
			assert.equal(readFileSync(configPath(), 'utf8'), unmanaged);
		});
	});

	describe('key names add_ssh_key could never create', () => {
		const NAME_ERROR = 'SSH key name can only contain alphanumeric, dash and underscore characters';
		// the key path is `<ssh dir>/<name>.key`, so `../outside` is `<root>/outside.key`
		const outsidePath = () => join(rootDir, 'outside.key');
		beforeEach(() => writeFileSync(outsidePath(), 'not an ssh key'));

		for (const [operation, call] of [
			['get_ssh_key', (name) => ops.getSSHKey({ name })],
			['update_ssh_key', (name) => ops.updateSSHKey(request({ name, key: ROTATED_KEY }))],
			['delete_ssh_key', (name) => ops.deleteSSHKey({ name })],
		]) {
			it(`${operation} refuses a name that resolves outside the ssh dir`, async () => {
				await assert.rejects(call('../outside'), { message: NAME_ERROR });
				assert.equal(readFileSync(outsidePath(), 'utf8'), 'not an ssh key');
			});
		}

		it('get_ssh_key, update_ssh_key and delete_ssh_key still accept every name add_ssh_key does', async () => {
			const name = 'deploy_key-2';
			await ops.addSSHKey(request({ name, key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' }));

			assert.equal((await ops.getSSHKey({ name })).host, 'gh');
			assert.equal((await ops.updateSSHKey(request({ name, key: ROTATED_KEY }))).message, `Updated ssh key: ${name}`);
			assert.equal((await ops.deleteSSHKey({ name })).message, `Deleted ssh key: ${name}`);
		});

		it('list_ssh_keys reports only the `<name>.key` files, or links to one, those operations accept', async () => {
			await ops.addSSHKey(request({ name: 'deploy_key-2', key: PRIVATE_KEY, host: 'gh', hostname: 'example.com' }));
			for (const stray of ['known_hosts.old', 'orphan', 'a.b.key']) writeFileSync(join(sshDir, stray), '');
			mkdirSync(join(sshDir, 'directory.key'));
			symlinkSync(join(sshDir, 'deploy_key-2.key'), join(sshDir, 'linked.key'));
			symlinkSync(join(sshDir, 'missing'), join(sshDir, 'dangling.key'));

			assert.deepEqual((await ops.listSSHKeys()).map((entry) => entry.name).sort(), ['deploy_key-2', 'linked']);
			assert.equal((await ops.getSSHKey({ name: 'linked' })).key, storedKeyFor('deploy_key-2'));
		});
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
	});
});
