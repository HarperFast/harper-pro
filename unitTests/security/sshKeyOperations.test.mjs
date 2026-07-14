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
 * The at-use half — decrypting to a transient 0600 file for the git invocation — lives in core
 * (`materializeGitSSH`) and is covered by core's Application tests.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
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
	});
});
