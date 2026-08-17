/**
 * `add_ssh_key generate=true` mints its keypair in process (harper-pro#594). The formats are
 * hand-encoded because Node's crypto cannot emit them — so the encoding itself is what needs
 * covering: an `openssh-key-v1` container OpenSSH will load and sign with, and an
 * `ssh-ed25519 <base64> <comment>` line a host will accept as a deploy key.
 *
 * The structural assertions run everywhere. The `ssh-keygen` assertions are the ones that actually
 * prove the bytes are right — nothing in our own code would notice a wrong field order — so they
 * run wherever ssh-keygen exists (CI's Linux images, macOS) and skip where it doesn't (Windows,
 * which is the whole reason the subprocess had to go).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasSSHKeygen = (() => {
	try {
		execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
		return true;
	} catch (error) {
		// `-?` is not a real flag: ssh-keygen prints usage and exits non-zero, which still proves it
		// ran. Only a spawn failure (ENOENT) means it is genuinely absent.
		return error.code !== 'ENOENT';
	}
})();

describe('ed25519 SSH keypair generation', () => {
	let generateEd25519SSHKeyPair;
	let dir;

	before(async function () {
		this.timeout(60000);
		({ generateEd25519SSHKeyPair } = await import('#src/security/sshKeyGeneration'));
	});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'ssh-keygen-test-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// writes the private key where ssh-keygen will accept it (it refuses group/world-readable keys)
	const writeKeyFile = (privateKey) => {
		const keyFile = join(dir, 'id_ed25519');
		writeFileSync(keyFile, privateKey, { mode: 0o600 });
		return keyFile;
	};

	it('returns an openssh-key-v1 private key and a single-line ssh-ed25519 public key', async () => {
		const { privateKey, publicKey } = await generateEd25519SSHKeyPair('harper:deploy');

		assert.match(privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
		assert.match(privateKey, /\n-----END OPENSSH PRIVATE KEY-----\n$/);

		const body = privateKey.split('\n').slice(1, -2);
		assert.ok(
			body.every((line) => line.length > 0 && line.length <= 70),
			`base64 body should be wrapped at 70 columns with no blank line: ${JSON.stringify(body)}`
		);
		assert.ok(
			Buffer.from(body.join(''), 'base64').subarray(0, 15).equals(Buffer.from('openssh-key-v1\0', 'utf8')),
			'private key should carry the openssh-key-v1 magic'
		);

		// `<type> <base64> <comment>`, on one line — the shape a host's deploy-key field expects
		const [type, encoded, comment] = publicKey.split(' ');
		assert.equal(type, 'ssh-ed25519');
		assert.equal(comment, 'harper:deploy');
		assert.ok(!publicKey.includes('\n'), 'the public key must be a single line');

		// the blob restates the type, then the raw 32-byte key, as RFC 4251 strings
		const blob = Buffer.from(encoded, 'base64');
		assert.equal(blob.readUInt32BE(0), 'ssh-ed25519'.length);
		assert.equal(blob.subarray(4, 15).toString('utf8'), 'ssh-ed25519');
		assert.equal(blob.readUInt32BE(15), 32);
		assert.equal(blob.length, 4 + 11 + 4 + 32);
	});

	it('rejects a comment containing a line break, and accepts one containing spaces', async () => {
		// a line break would split the one-line public key, leaving the tail parseable as its own entry
		for (const comment of ['harper:deploy\nssh-ed25519 AAAA injected', 'harper:deploy\r', '\n', 'a\r\nb']) {
			await assert.rejects(
				generateEd25519SSHKeyPair(comment),
				/must not contain a line break/,
				`expected rejection for ${JSON.stringify(comment)}`
			);
		}

		// spaces are legitimate — ssh treats the remainder of the line as the comment
		const { publicKey } = await generateEd25519SSHKeyPair('harper deploy key');
		assert.equal(publicKey.split(' ').slice(2).join(' '), 'harper deploy key');
		assert.ok(!publicKey.includes('\n'));
	});

	it('mints a distinct keypair per call', async () => {
		const first = await generateEd25519SSHKeyPair('harper:one');
		const second = await generateEd25519SSHKeyPair('harper:two');

		assert.notEqual(first.privateKey, second.privateKey);
		assert.notEqual(first.publicKey.split(' ')[1], second.publicKey.split(' ')[1]);
	});

	it('pads the private section correctly for any comment length', async () => {
		// the private section is padded to an 8-byte boundary, and the comment is what moves its
		// length — so walk enough comment lengths to cover every residue
		for (let length = 1; length <= 16; length++) {
			const comment = 'c'.repeat(length);
			const { privateKey, publicKey } = await generateEd25519SSHKeyPair(comment);
			assert.equal(publicKey.split(' ')[2], comment);
			if (hasSSHKeygen) {
				const derived = execFileSync('ssh-keygen', ['-y', '-f', writeKeyFile(privateKey)], { encoding: 'utf8' });
				assert.equal(
					derived.trim(),
					publicKey,
					`ssh-keygen should re-derive our public key (comment length ${length})`
				);
			}
		}
	});

	describe('against the real ssh-keygen', () => {
		beforeEach(function () {
			if (!hasSSHKeygen) this.skip();
		});

		it('loads the private key and re-derives the same public key and comment', async () => {
			const { privateKey, publicKey } = await generateEd25519SSHKeyPair('harper:deploy');

			const derived = execFileSync('ssh-keygen', ['-y', '-f', writeKeyFile(privateKey)], { encoding: 'utf8' });
			assert.equal(derived.trim(), publicKey);
		});

		it('fingerprints both halves identically', async () => {
			const { privateKey, publicKey } = await generateEd25519SSHKeyPair('harper:deploy');
			const publicKeyFile = join(dir, 'id_ed25519.pub');
			writeFileSync(publicKeyFile, publicKey + '\n');

			const fingerprintOf = (file) =>
				execFileSync('ssh-keygen', ['-l', '-f', file], { encoding: 'utf8' }).trim().split(' ')[1];

			assert.match(fingerprintOf(publicKeyFile), /^SHA256:/);
			assert.equal(fingerprintOf(writeKeyFile(privateKey)), fingerprintOf(publicKeyFile));
		});

		it('signs with the private key and verifies against the public key', async () => {
			// the strongest check available: -y only has to read the public half embedded in the
			// container, but signing exercises the private seed we encoded
			const { privateKey, publicKey } = await generateEd25519SSHKeyPair('harper:deploy');
			const message = 'harper deploy key\n';
			const messageFile = join(dir, 'message');
			writeFileSync(messageFile, message);
			const allowedSigners = join(dir, 'allowed_signers');
			writeFileSync(allowedSigners, `harper:deploy ${publicKey}\n`);

			execFileSync('ssh-keygen', ['-Y', 'sign', '-f', writeKeyFile(privateKey), '-n', 'test', messageFile], {
				stdio: 'ignore',
			});
			const verified = execFileSync(
				'ssh-keygen',
				['-Y', 'verify', '-f', allowedSigners, '-I', 'harper:deploy', '-n', 'test', '-s', `${messageFile}.sig`],
				{ input: message, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
			);
			assert.match(verified, /Good "test" signature/);
		});
	});
});
