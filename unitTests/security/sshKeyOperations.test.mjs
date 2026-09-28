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
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	readFileSync,
	writeFileSync,
	statSync,
	symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { hasSSH, hasSSHKeygen } from './sshKeyFixtures.mjs';
import { anchoredParser, regexParser } from './sshConfigEarlierParsers.mjs';

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

	describe('ssh config blocks', () => {
		const configPath = () => join(sshDir, 'config');
		const readConfig = () => readFileSync(configPath(), 'utf8');
		const keyPath = (name) => join(sshDir, `${name}.key`);
		const addKey = (name) =>
			ops.addSSHKey(request({ name, key: PRIVATE_KEY, host: `${name}.alias`, hostname: 'example.com' }));
		// the block add_ssh_key wrote before blocks had BEGIN and END lines
		const legacyBlockFor = (name) =>
			`#${name}\nHost ${name}.alias\n\tHostName example.com\n\tUser git\n\tIdentityFile ${keyPath(name)}\n\tIdentitiesOnly yes`;
		const withMarkers = (legacyBlock) => {
			const [header, ...lines] = legacyBlock.split('\n');
			const name = header.slice(1);
			return [header, `# BEGIN harper ssh key ${name}`, ...lines, `# END harper ssh key ${name}`].join('\n');
		};
		const blockFor = (name) => withMarkers(legacyBlockFor(name));
		const byName = (a, b) => a.name.localeCompare(b.name);
		const unmanaged = 'Host other\n\tHostName example.net';

		it("writes each key's block between BEGIN and END lines, under its `#name` line", async () => {
			await addKey('first');
			await addKey('second');

			assert.equal(readConfig(), `${blockFor('first')}\n${blockFor('second')}`);
		});

		describe('of keys whose names share a prefix', () => {
			for (const order of [
				['repo-2', 'repo'],
				// `repo`'s block opens the file
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

						assert.equal(readConfig(), blockFor('repo-2'));
						assert.deepEqual(await ops.listSSHKeys(), [
							{ name: 'repo-2', host: 'repo-2.alias', hostname: 'example.com' },
						]);
					});
				});
			}

			it('reads the markers of a hand-edited config: blanks around them, CRLF line endings', async () => {
				const handEdited = (text) => text.replace(/^#.*$/gm, ' \t$& \t').replace(/\n/g, '\r\n');
				for (const name of ['repo-2', 'repo']) await addKey(name);
				writeFileSync(configPath(), handEdited(readConfig()));

				assert.equal((await ops.getSSHKey({ name: 'repo' })).host, 'repo.alias');
				await ops.deleteSSHKey({ name: 'repo' });
				assert.equal(readConfig(), handEdited(blockFor('repo-2')));
			});
		});

		for (const [edit, identitiesOnlyLine] of [
			['re-spaced', '\tIdentitiesOnly    yes\n'],
			['removed', ''],
		]) {
			it(`delete_ssh_key removes a block whose IdentitiesOnly line was ${edit}, and nothing after it`, async () => {
				for (const name of ['first', 'second']) await addKey(name);
				writeFileSync(configPath(), readConfig().replace('\tIdentitiesOnly yes\n', identitiesOnlyLine));

				await ops.deleteSSHKey({ name: 'first' });
				assert.equal(readConfig(), blockFor('second'));
			});
		}

		it('delete_ssh_key removes every line between its markers, and keeps every line outside them', async () => {
			for (const name of ['first', 'second']) await addKey(name);
			writeFileSync(
				configPath(),
				readConfig()
					.replace('\tIdentitiesOnly yes\n', `\tIdentitiesOnly no\n#staging\n${unmanaged}\n`)
					// ssh reads this line as part of first's Host section, but it is outside first's markers
					.replace('# END harper ssh key first\n', '# END harper ssh key first\n\tUser deploy\n# about second\n')
			);

			await ops.deleteSSHKey({ name: 'first' });
			assert.equal(readConfig(), `\tUser deploy\n# about second\n${blockFor('second')}`);
		});

		it("never takes a `#word` line above the user's own Host section for key word's block", async () => {
			const usersSection = '#word\nHost word\n\tHostName word.example.net';
			mkdirSync(sshDir, { recursive: true });
			writeFileSync(configPath(), usersSection);
			await addKey('word');

			assert.equal((await ops.getSSHKey({ name: 'word' })).host, 'word.alias');
			await ops.deleteSSHKey({ name: 'word' });
			assert.equal(readConfig(), usersSection);
		});

		it("get_ssh_key and delete_ssh_key leave a lone `#name` line, and the next key's block, alone", async () => {
			for (const name of ['first', 'second']) await addKey(name);
			writeFileSync(configPath(), `#first\n${blockFor('second')}`);

			assert.equal((await ops.getSSHKey({ name: 'first' })).host, undefined);
			await ops.deleteSSHKey({ name: 'first' });
			assert.equal(readConfig(), `#first\n${blockFor('second')}`);
		});

		it('delete_ssh_key removes a block that lost its own Host line', async () => {
			await addKey('first');
			writeFileSync(configPath(), `${readConfig().replace('Host first.alias\n', '')}\n${unmanaged}`);

			assert.equal((await ops.getSSHKey({ name: 'first' })).host, undefined);
			await ops.deleteSSHKey({ name: 'first' });
			assert.equal(readConfig(), unmanaged);
		});

		it('delete_ssh_key takes a middle block with its line break, leaving no blank line', async () => {
			for (const name of ['first', 'middle', 'last']) await addKey(name);

			await ops.deleteSSHKey({ name: 'middle' });
			assert.equal(readConfig(), `${blockFor('first')}\n${blockFor('last')}`);
		});

		it('delete_ssh_key keeps config lines after a block that belong to no key', async () => {
			await addKey('repo');
			writeFileSync(configPath(), `${readConfig()}\n${unmanaged}`);

			await ops.deleteSSHKey({ name: 'repo' });
			assert.equal(readConfig(), unmanaged);
		});

		it('delete_ssh_key undoes add_ssh_key byte for byte', async () => {
			mkdirSync(sshDir, { recursive: true });
			for (const before of [unmanaged, `${unmanaged}\n`, `\r\n${unmanaged}\r\n\r\n`]) {
				writeFileSync(configPath(), before);
				await addKey('deploy');
				await ops.deleteSSHKey({ name: 'deploy' });
				assert.equal(readConfig(), before, JSON.stringify(before));
			}
		});

		it('get_ssh_key reads the first of two blocks for a key, and delete_ssh_key removes both', async () => {
			await addKey('deploy');
			writeFileSync(
				configPath(),
				`${readConfig()}\n${blockFor('deploy').replace('deploy.alias', 'newer.alias')}\n${unmanaged}`
			);

			assert.equal((await ops.getSSHKey({ name: 'deploy' })).host, 'deploy.alias');
			await ops.deleteSSHKey({ name: 'deploy' });
			assert.equal(readConfig(), unmanaged);
		});

		describe('with a damaged marker', () => {
			const damagedError = (name, line) =>
				isClientError(
					new RegExp(
						`^SSH key '${name}' was not deleted: line ${line} of the SSH config begins its block \\("# BEGIN harper ssh key ${name}"\\), but no "# END harper ssh key ${name}" line ends it\\.`
					)
				);

			it('delete_ssh_key refuses a key whose BEGIN line has no END, changing nothing, and deletes the others', async () => {
				for (const name of ['first', 'second', 'third']) await addKey(name);
				const damaged = readConfig().replace('# END harper ssh key first\n', '');
				writeFileSync(configPath(), damaged);

				await assert.rejects(ops.deleteSSHKey({ name: 'first' }), damagedError('first', 2));
				assert.equal(readConfig(), damaged);
				assert.ok(existsSync(keyPath('first')), 'the key file must be kept');
				assert.equal((await ops.getSSHKey({ name: 'first' })).host, undefined);

				await ops.deleteSSHKey({ name: 'third' });
				assert.equal(readConfig(), damaged.replace(`\n${blockFor('third')}`, ''));
			});

			for (const [shape, edit] of [
				[
					"first's END moved below second's block",
					(config) => `${config.replace('# END harper ssh key first\n', '')}\n# END harper ssh key first`,
				],
				[
					"second's END copied into first's block",
					(config) => config.replace('\tUser git\n', '\tUser git\n# END harper ssh key second\n'),
				],
			]) {
				it(`treats a block as unterminated when ${shape}, and still reads the other block`, async () => {
					for (const name of ['first', 'second']) await addKey(name);
					writeFileSync(configPath(), edit(readConfig()));

					await assert.rejects(ops.deleteSSHKey({ name: 'first' }), damagedError('first', 2));
					assert.equal((await ops.getSSHKey({ name: 'second' })).host, 'second.alias');
				});
			}

			it('treats the last block as unterminated when the file ends before its END line', async () => {
				for (const name of ['first', 'second']) await addKey(name);
				const damaged = readConfig().replace(/\n# END harper ssh key second$/, '');
				writeFileSync(configPath(), damaged);

				await assert.rejects(ops.deleteSSHKey({ name: 'second' }), damagedError('second', 10));
				assert.equal(readConfig(), damaged);
			});

			it('ignores an END line with no BEGIN', async () => {
				for (const name of ['first', 'second']) await addKey(name);
				writeFileSync(configPath(), `# END harper ssh key first\n${readConfig()}`);

				await ops.deleteSSHKey({ name: 'first' });
				assert.equal(readConfig(), `# END harper ssh key first\n${blockFor('second')}`);
			});
		});

		describe('rewriting the config', () => {
			it('keeps its mode and leaves no temporary file behind', async () => {
				for (const name of ['first', 'second']) await addKey(name);
				chmodSync(configPath(), 0o640);

				await ops.deleteSSHKey({ name: 'first' });
				assert.equal(statSync(configPath()).mode & 0o777, 0o640);
				assert.deepEqual(readdirSync(sshDir).sort(), ['config', 'known_hosts', 'second.key']);
			});

			it('writes a symlinked config at its target, keeping the link', async () => {
				for (const name of ['first', 'second']) await addKey(name);
				const target = join(rootDir, 'managed-ssh-config');
				renameSync(configPath(), target);
				symlinkSync(target, configPath());

				await ops.deleteSSHKey({ name: 'first' });
				assert.ok(lstatSync(configPath()).isSymbolicLink());
				assert.equal(readFileSync(target, 'utf8'), blockFor('second'));
			});

			it('fails delete_ssh_key, keeping the key and the config, when the config cannot be rewritten', async function () {
				// root is not held back by directory permissions
				if (process.getuid?.() === 0) this.skip();
				for (const name of ['first', 'second']) await addKey(name);
				const before = readConfig();

				chmodSync(sshDir, 0o500);
				try {
					await assert.rejects(ops.deleteSSHKey({ name: 'first' }), { code: 'EACCES' });
				} finally {
					chmodSync(sshDir, 0o700);
				}
				assert.equal(readConfig(), before);
				assert.deepEqual(readdirSync(sshDir).sort(), ['config', 'first.key', 'known_hosts', 'second.key']);
			});

			it('removes its temporary file when replacing the config fails', async function () {
				// an immutable config refuses the rename, after the temporary file is written; Linux needs root for that
				if (process.platform !== 'darwin') this.skip();
				for (const name of ['first', 'second']) await addKey(name);
				const before = readConfig();

				execFileSync('chflags', ['uchg', configPath()]);
				try {
					await assert.rejects(ops.deleteSSHKey({ name: 'first' }), { code: 'EPERM' });
				} finally {
					execFileSync('chflags', ['nouchg', configPath()]);
				}
				assert.equal(readConfig(), before);
				assert.deepEqual(readdirSync(sshDir).sort(), ['config', 'first.key', 'known_hosts', 'second.key']);
			});
		});

		describe('written before blocks had BEGIN and END lines', () => {
			let logged;
			let originalInfo;
			let originalError;
			beforeEach(() => {
				mkdirSync(sshDir, { recursive: true });
				logged = [];
				originalInfo = harperLogger.info;
				originalError = harperLogger.error;
				harperLogger.info = (...args) => logged.push(['info', args.join(' ')]);
				harperLogger.error = (...args) => logged.push(['error', args.join(' ')]);
			});
			afterEach(() => {
				harperLogger.info = originalInfo;
				harperLogger.error = originalError;
			});
			// as a node upgraded from an earlier version holds them: the key files, and a config of legacy blocks
			const seedKeys = (...names) => {
				for (const name of names) writeFileSync(keyPath(name), 'enc:v1:sealed');
			};

			it('get_ssh_key and list_ssh_keys read its blocks without writing the config', async () => {
				seedKeys('repo', 'repo-2');
				const legacy = `${legacyBlockFor('repo-2')}\n${legacyBlockFor('repo')}`;
				writeFileSync(configPath(), legacy);

				assert.equal((await ops.getSSHKey({ name: 'repo' })).host, 'repo.alias');
				assert.deepEqual((await ops.listSSHKeys()).sort(byName), [
					{ name: 'repo', host: 'repo.alias', hostname: 'example.com' },
					{ name: 'repo-2', host: 'repo-2.alias', hostname: 'example.com' },
				]);
				assert.equal(readConfig(), legacy);
			});

			it('migrateSSHConfig adds BEGIN and END lines around each key block, changing nothing else', async () => {
				seedKeys('first', 'second', 'third');
				writeFileSync(configPath(), handEditedLegacyConfig());

				await ops.migrateSSHConfig();
				assert.equal(readConfig(), handEditedLegacyConfig(true));
				assert.deepEqual(logged, [['info', `SSH config ${configPath()}: added BEGIN/END lines around 3 key block(s)`]]);
				assert.deepEqual(warnings, []);
			});

			it('adding BEGIN and END lines changes nothing ssh resolves for any host', async function () {
				if (!hasSSH) this.skip();
				seedKeys('first', 'second', 'third');
				const probe = join(rootDir, 'probe-config');
				const resolve = (config, host) => {
					writeFileSync(probe, config);
					return execFileSync('ssh', ['-G', '-F', probe, host], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
				};
				for (const host of ['first.alias', 'second.alias', 'third.alias', 'other', 'staging', 'unlisted.example.com']) {
					assert.equal(resolve(handEditedLegacyConfig(true), host), resolve(handEditedLegacyConfig(), host), host);
				}
			});

			it('migrateSSHConfig leaves a migrated config as it is', async () => {
				seedKeys('first', 'second', 'third');
				writeFileSync(configPath(), handEditedLegacyConfig());
				await ops.migrateSSHConfig();
				const { ino } = statSync(configPath());

				await ops.migrateSSHConfig();
				assert.equal(readConfig(), handEditedLegacyConfig(true));
				assert.equal(statSync(configPath()).ino, ino, 'the second pass must not rewrite the file');
			});

			it("leaves a section alone when its IdentityFile isn't the key file add_ssh_key wrote for that name", async () => {
				seedKeys('prod', 'moved');
				// the user's own section under a key's name, and a block whose IdentityFile was repointed
				const lookalike = '#prod\nHost prod\n\tHostName prod.example.net\n\tIdentityFile ~/.ssh/prod.key';
				const repointed = legacyBlockFor('moved').replace(keyPath('moved'), '/elsewhere/ssh/moved.key');
				writeFileSync(configPath(), `${lookalike}\n${repointed}`);

				await ops.migrateSSHConfig();
				assert.equal(readConfig(), `${lookalike}\n${repointed}`);
				assert.equal((await ops.getSSHKey({ name: 'prod' })).host, undefined);
				await ops.deleteSSHKey({ name: 'prod' });
				assert.equal(readConfig(), `${lookalike}\n${repointed}`);
				assert.equal(warnings.length, 1);
				assert.match(warnings[0], /: found no block it can manage for key\(s\) (moved, prod|prod, moved)$/);
			});

			it("delete_ssh_key writes BEGIN and END lines around the other keys' blocks", async () => {
				seedKeys('first', 'second');
				writeFileSync(configPath(), `${legacyBlockFor('first')}\n${legacyBlockFor('second')}\n${unmanaged}`);

				await ops.deleteSSHKey({ name: 'first' });
				assert.equal(readConfig(), `${blockFor('second')}\n${unmanaged}`);
			});

			it('keeps CRLF line endings on the lines it adds', async () => {
				seedKeys('first');
				const crlf = (text) => text.replace(/\n/g, '\r\n');
				writeFileSync(configPath(), crlf(`${legacyBlockFor('first')}\n${unmanaged}\n`));

				await ops.migrateSSHConfig();
				assert.equal(readConfig(), crlf(`${blockFor('first')}\n${unmanaged}\n`));
			});

			it('get_ssh_key reads the first block in the file, with markers or without', async () => {
				seedKeys('deploy');
				writeFileSync(
					configPath(),
					`${legacyBlockFor('deploy')}\n${blockFor('deploy').replace('deploy.alias', 'newer.alias')}`
				);

				assert.equal((await ops.getSSHKey({ name: 'deploy' })).host, 'deploy.alias');
				await ops.deleteSSHKey({ name: 'deploy' });
				assert.equal(readConfig(), '');
			});

			it('marks only the unmarked blocks of a config that has both', async () => {
				seedKeys('old');
				writeFileSync(configPath(), legacyBlockFor('old'));
				await addKey('new');

				await ops.migrateSSHConfig();
				assert.equal(readConfig(), `${blockFor('old')}\n${blockFor('new')}`);
			});

			it('migrateSSHConfig logs a config it cannot rewrite, and resolves', async function () {
				if (process.getuid?.() === 0) this.skip();
				seedKeys('first');
				writeFileSync(configPath(), legacyBlockFor('first'));

				chmodSync(sshDir, 0o500);
				try {
					await ops.migrateSSHConfig();
				} finally {
					chmodSync(sshDir, 0o700);
				}
				assert.equal(readConfig(), legacyBlockFor('first'));
				assert.equal(logged.length, 1);
				assert.equal(logged[0][0], 'error');
				assert.match(logged[0][1], /^Unable to add BEGIN\/END lines to the SSH config: EACCES/);
			});

			it("a node rolled back to an earlier version still reads and deletes each key's block", async () => {
				for (const name of ['first', 'middle', 'last']) await addKey(name);
				const config = readConfig();
				for (const [parser, earlier] of [
					['anchoredParser', anchoredParser],
					['regexParser', regexParser],
				]) {
					for (const name of ['first', 'middle', 'last']) {
						assert.deepEqual(earlier.get(config, name), { host: `${name}.alias`, hostname: 'example.com' }, parser);
					}
				}
				assert.equal(anchoredParser.delete(config, 'middle'), `${blockFor('first')}\n${blockFor('last')}`);
				assert.equal(anchoredParser.delete(config, 'last'), `${blockFor('first')}\n${blockFor('middle')}`);

				// the regex leaves middle's END line behind, which reads as nothing once this version is back
				writeFileSync(configPath(), regexParser.delete(config, 'middle'));
				rmSync(keyPath('middle'));
				assert.deepEqual((await ops.listSSHKeys()).sort(byName), [
					{ name: 'first', host: 'first.alias', hostname: 'example.com' },
					{ name: 'last', host: 'last.alias', hostname: 'example.com' },
				]);
				await ops.deleteSSHKey({ name: 'first' });
				await ops.deleteSSHKey({ name: 'last' });
				// the blank line is where the regex cut middle's lines out
				assert.equal(readConfig(), '\n# END harper ssh key middle');
			});
		});

		// The hand-edited shapes #910 had to infer, as an upgraded node's config holds them.
		function handEditedLegacyConfig(migrated = false) {
			const block = (name, extra = '') => {
				const legacy = legacyBlockFor(name) + extra;
				return migrated ? withMarkers(legacy) : legacy;
			};
			return [
				'# my own settings',
				'Host *',
				'\tServerAliveInterval 60',
				// a directive the user added to first's section goes with it
				block('first', '\n\tProxyJump bastion'),
				// a comment heading the next section stays outside first's markers
				'# notes on other',
				unmanaged,
				block('second'),
				'',
				// the user's own section under a comment that looks like a key's `#name` line
				'#staging',
				'Host staging',
				'\tHostName staging.example.net',
				block('third'),
			].join('\n');
		}
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

		const assertLoadsForGitDeploy = async () => {
			const { materializeGitSSH } = await import('#src/core/components/Application');
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
		};

		it("decrypts through core's materializeGitSSH to a key ssh loads, under the alias it was added with", async function () {
			this.timeout(60000);
			await ops.addSSHKey(
				request({ name: 'deploy', key: pasted(PRIVATE_KEY), host: 'deploy.example.com', hostname: 'git.example.com' })
			);

			await assertLoadsForGitDeploy();
		});

		it('still loads once BEGIN and END lines are added around a block an earlier version wrote', async function () {
			this.timeout(60000);
			await ops.addSSHKey(
				request({ name: 'deploy', key: PRIVATE_KEY, host: 'deploy.example.com', hostname: 'git.example.com' })
			);
			const configPath = join(sshDir, 'config');
			writeFileSync(
				configPath,
				readFileSync(configPath, 'utf8')
					.replace(/^# (BEGIN|END) .*\n?/gm, '')
					.trimEnd()
			);

			await ops.migrateSSHConfig();
			assert.match(readFileSync(configPath, 'utf8'), /^# BEGIN harper ssh key deploy$/m);
			await assertLoadsForGitDeploy();
		});
	});
});
