import { suite, test, before, beforeEach, afterEach, after } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';

const TEST_DIRECTORY = import.meta.dirname ?? module.path;
const GITHUB_META_FETCH_PRELOAD = join(TEST_DIRECTORY, 'fixtures', 'redirectGitHubMetaFetch.mjs');
const GITHUB_SSH_KEYS = ['ssh-ed25519 fixture-key-one', 'ecdsa-sha2-nistp256 fixture-key-two'];
const GITHUB_KNOWN_HOSTS = GITHUB_SSH_KEYS.map((key) => `github.com ${key}\n`).join('');

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIRECTORY, '..', '..', 'dist', 'bin', 'harper.js');

async function sendOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	const responseData = await response.json();
	return { status: response.status, data: responseData };
}

suite('SSH Key Operations', (ctx) => {
	let disconnectGitHubMetaRequest = false;
	let githubMetaRequestCount = 0;
	const githubMetaServer = createServer((request, response) => {
		if (request.url !== '/meta') {
			response.writeHead(404).end();
			return;
		}

		githubMetaRequestCount++;
		if (disconnectGitHubMetaRequest) {
			request.socket.destroy();
			return;
		}

		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ ssh_keys: GITHUB_SSH_KEYS }));
	});

	before(async () => {
		await new Promise((resolve, reject) => {
			githubMetaServer.once('error', reject);
			githubMetaServer.listen(0, '127.0.0.1', () => {
				githubMetaServer.off('error', reject);
				resolve();
			});
		});
		const { port } = githubMetaServer.address();
		const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(GITHUB_META_FETCH_PRELOAD).href}`]
			.filter(Boolean)
			.join(' ');
		await startHarper(ctx, {
			env: {
				HARPER_SSH_KEY_GITHUB_META_FIXTURE_URL: `http://127.0.0.1:${port}/meta`,
				NODE_OPTIONS: nodeOptions,
			},
		});
	});

	beforeEach(async () => {
		disconnectGitHubMetaRequest = false;
		githubMetaRequestCount = 0;
		await rm(join(ctx.harper.dataRootDir, 'ssh'), { recursive: true, force: true });
	});

	afterEach(async () => {
		await rm(join(ctx.harper.dataRootDir, 'ssh'), { recursive: true, force: true });
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			await new Promise((resolve) => {
				if (!githubMetaServer.listening) {
					resolve();
					return;
				}
				githubMetaServer.close(resolve);
				githubMetaServer.closeAllConnections();
			});
		}
	});

	test('list_ssh_keys and get_ssh_known_hosts return empty state by default', async () => {
		let { status, data } = await sendOperation(ctx.harper, { operation: 'list_ssh_keys' });
		equal(status, 200);
		deepEqual(data, []);

		({ status, data } = await sendOperation(ctx.harper, { operation: 'get_ssh_known_hosts' }));
		equal(status, 200);
		deepEqual(data, { known_hosts: null });
	});

	test('add_ssh_key and list_ssh_keys and get_ssh_key reflect added key', async () => {
		let { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey1',
			key: 'random\nstring',
			host: 'testkey1.gitlab.com',
			hostname: 'gitlab.com',
			known_hosts: 'gitlab.com fake1\ngitlab.com fake2',
		});
		equal(status, 200);
		equal(data.message, 'Added ssh key: testkey1');

		({ status, data } = await sendOperation(ctx.harper, { operation: 'list_ssh_keys' }));
		equal(status, 200);
		deepEqual(data, [{ host: 'testkey1.gitlab.com', hostname: 'gitlab.com', name: 'testkey1' }]);

		({ status, data } = await sendOperation(ctx.harper, { operation: 'get_ssh_key', name: 'testkey1' }));
		equal(status, 200);
		equal(data.name, 'testkey1');
		equal(data.host, 'testkey1.gitlab.com');
		equal(data.hostname, 'gitlab.com');
		// Keys are sealed at rest (harper-pro#581) and get_ssh_key returns the envelope as-is —
		// the only consumer is cloneSSHKeys, which never needs the plaintext.
		ok(data.key.startsWith('enc:v1:'), 'expected key to be returned as an enc:v1: envelope');
		ok(!data.key.includes('random\nstring'), 'expected key to not be returned in plaintext');
	});

	test('add_ssh_key generate=true mints a keypair and returns the public key', async () => {
		let { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-generated',
			generate: true,
			host: 'testkey-generated.gitlab.com',
			hostname: 'gitlab.com',
		});
		equal(status, 200);
		equal(data.message, 'Added ssh key: testkey-generated');
		ok(
			typeof data.public_key === 'string' && data.public_key.startsWith('ssh-ed25519 '),
			'expected an ed25519 public key in the response'
		);

		// the minted private key is stored (sealed at rest) and retrievable as an envelope
		({ status, data } = await sendOperation(ctx.harper, { operation: 'get_ssh_key', name: 'testkey-generated' }));
		equal(status, 200);
		ok(data.key.startsWith('enc:v1:'), 'expected the minted key to be sealed at rest');
	});

	test('add_ssh_key rejects generate=true together with an explicit key', async () => {
		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-both',
			generate: true,
			key: 'random\nstring',
			host: 'testkey-both.gitlab.com',
			hostname: 'gitlab.com',
		});
		ok(status >= 400, `expected a client error, got ${status}`);
		equal(data.error, 'Provide either `key` or `generate: true`, not both.');
	});

	test('add_ssh_key with neither key nor generate returns a client error', async () => {
		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-neither',
			host: 'testkey-neither.gitlab.com',
			hostname: 'gitlab.com',
		});
		ok(status >= 400, `expected a client error, got ${status}`);
		equal(data.error, 'add_ssh_key requires `key`, or `generate: true` to mint one');
	});

	test('set_ssh_known_hosts and get_ssh_known_hosts reflect updated known hosts', async () => {
		let { status, data } = await sendOperation(ctx.harper, {
			operation: 'set_ssh_known_hosts',
			known_hosts: 'gitlab.com fake1\ngitlab.com fake2',
		});
		equal(status, 200);

		({ status, data } = await sendOperation(ctx.harper, { operation: 'get_ssh_known_hosts' }));
		equal(status, 200);
		deepEqual(data, { known_hosts: 'gitlab.com fake1\ngitlab.com fake2' });
	});

	test('add_ssh_key with github.com hostname fetches known_hosts from the controlled endpoint', async () => {
		let { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-github',
			key: 'random\nstring',
			host: 'testkey-github.github.com',
			hostname: 'github.com',
		});
		equal(status, 200);
		equal(data.message, 'Added ssh key: testkey-github');
		equal(githubMetaRequestCount, 1);

		({ status, data } = await sendOperation(ctx.harper, { operation: 'get_ssh_known_hosts' }));
		equal(status, 200);
		deepEqual(data, { known_hosts: GITHUB_KNOWN_HOSTS });
	});

	test('add_ssh_key reports the documented fallback when the github metadata fetch fails', async () => {
		disconnectGitHubMetaRequest = true;
		let { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-github-fallback',
			key: 'random\nstring',
			host: 'testkey-github-fallback.github.com',
			hostname: 'github.com',
		});
		equal(status, 200);
		equal(
			data.message,
			'Added ssh key: testkey-github-fallback. Unable to get known hosts from github.com. Set your known hosts manually using set_ssh_known_hosts.'
		);
		equal(githubMetaRequestCount, 1);

		({ status, data } = await sendOperation(ctx.harper, { operation: 'get_ssh_known_hosts' }));
		equal(status, 200);
		deepEqual(data, { known_hosts: '' });
	});

	test('update_ssh_key updates an existing key', async () => {
		await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-update',
			key: 'original\nstring',
			host: 'testkey-update.gitlab.com',
			hostname: 'gitlab.com',
		});

		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'update_ssh_key',
			name: 'testkey-update',
			key: 'updated\nstring',
		});
		equal(status, 200);
		equal(data.message, 'Updated ssh key: testkey-update');
	});

	test('delete_ssh_key removes a key', async () => {
		await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-delete',
			key: 'random\nstring',
			host: 'testkey-delete.gitlab.com',
			hostname: 'gitlab.com',
		});

		let { status, data } = await sendOperation(ctx.harper, { operation: 'delete_ssh_key', name: 'testkey-delete' });
		equal(status, 200);
		equal(data.message, 'Deleted ssh key: testkey-delete');

		({ status, data } = await sendOperation(ctx.harper, { operation: 'list_ssh_keys' }));
		equal(status, 200);
		deepEqual(data, []);
	});

	test('add_ssh_key with duplicate name returns error', async () => {
		await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-duplicate',
			key: 'key',
			host: 'test',
			hostname: 'gitlab.com',
		});

		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-duplicate',
			key: 'key',
			host: 'test',
			hostname: 'gitlab.com',
		});
		ok(status >= 400);
		equal(data.error, 'Key already exists. Use update_ssh_key or delete_ssh_key and then add_ssh_key');
	});

	test('update_ssh_key on nonexistent key returns error', async () => {
		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'update_ssh_key',
			name: 'nonexistent',
			key: 'anything',
		});
		ok(status >= 400);
		equal(data.error, "SSH key 'nonexistent' does not exist. Use add_ssh_key to create it.");
	});

	test('get_ssh_key on nonexistent key returns error', async () => {
		const { status, data } = await sendOperation(ctx.harper, { operation: 'get_ssh_key', name: 'nonexistent' });
		ok(status >= 400);
		equal(data.error, "SSH key 'nonexistent' does not exist.");
	});

	test('delete_ssh_key on nonexistent key returns error', async () => {
		const { status, data } = await sendOperation(ctx.harper, { operation: 'delete_ssh_key', name: 'nonexistent' });
		ok(status >= 400);
		equal(data.error, "SSH key 'nonexistent' does not exist.");
	});
});
