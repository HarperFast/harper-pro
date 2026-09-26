import { suite, test, before, beforeEach, afterEach, after } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
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

// add_ssh_key and update_ssh_key refuse anything ssh couldn't load, so every key sent here is real.
function makeKey() {
	return generateKeyPairSync('ec', {
		namedCurve: 'P-256',
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'sec1', format: 'pem' },
	}).privateKey;
}

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
			key: makeKey(),
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
		ok(!data.key.includes('PRIVATE KEY'), 'expected key to not be returned in plaintext');
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
			key: makeKey(),
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
			key: makeKey(),
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
			key: makeKey(),
			host: 'testkey-github-fallback.github.com',
			hostname: 'github.com',
		});
		equal(status, 200);
		equal(
			data.message,
			'Added ssh key: testkey-github-fallback. Unable to get known hosts from github.com. Set your known hosts manually using set_ssh_known_hosts.'
		);
		ok(githubMetaRequestCount >= 1);

		({ status, data } = await sendOperation(ctx.harper, { operation: 'get_ssh_known_hosts' }));
		equal(status, 200);
		deepEqual(data, { known_hosts: '' });
	});

	test('update_ssh_key updates an existing key', async () => {
		await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-update',
			key: makeKey(),
			host: 'testkey-update.gitlab.com',
			hostname: 'gitlab.com',
		});

		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'update_ssh_key',
			name: 'testkey-update',
			key: makeKey(),
		});
		equal(status, 200);
		equal(data.message, 'Updated ssh key: testkey-update');
	});

	test('delete_ssh_key removes a key', async () => {
		await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-delete',
			key: makeKey(),
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
		const key = makeKey();
		await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-duplicate',
			key,
			host: 'test',
			hostname: 'gitlab.com',
		});

		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-duplicate',
			key,
			host: 'test',
			hostname: 'gitlab.com',
		});
		ok(status >= 400);
		equal(data.error, 'Key already exists. Use update_ssh_key or delete_ssh_key and then add_ssh_key');
	});

	test('add_ssh_key refuses a public key sent in place of the private one, and stores nothing', async () => {
		let { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-public',
			key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGExampleExampleExampleExampleExampleExample me@laptop',
			host: 'testkey-public.gitlab.com',
			hostname: 'gitlab.com',
		});
		equal(status, 400);
		equal(
			data.error,
			'The SSH key looks like a public key ("ssh-ed25519 …"). Use the private key — the file without the .pub extension.'
		);

		({ status, data } = await sendOperation(ctx.harper, { operation: 'list_ssh_keys' }));
		equal(status, 200);
		deepEqual(data, []);
	});

	test('add_ssh_key refuses a hostname that would break the ssh config every key shares', async () => {
		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-hostname',
			key: makeKey(),
			host: 'testkey-hostname.gitlab.com',
			hostname: 'gitlab.com extra',
		});
		equal(status, 400);
		equal(
			data.error,
			`'hostname' must be a single hostname like "github.com", without spaces or line breaks; got "gitlab.com extra".`
		);
	});

	test('add_ssh_key accepts a key pasted with CRLF line endings and indentation', async () => {
		const pasted = makeKey()
			.trimEnd()
			.split('\n')
			.map((line) => `    ${line}`)
			.join('\r\n');
		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-pasted',
			key: pasted,
			host: 'testkey-pasted.gitlab.com',
			hostname: 'gitlab.com',
		});
		equal(status, 200, JSON.stringify(data));
		equal(data.message, 'Added ssh key: testkey-pasted');
	});

	test('update_ssh_key refuses a damaged key and keeps the working one', async () => {
		await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-damaged',
			key: makeKey(),
			host: 'testkey-damaged.gitlab.com',
			hostname: 'gitlab.com',
		});
		const before = await sendOperation(ctx.harper, { operation: 'get_ssh_key', name: 'testkey-damaged' });

		const lines = makeKey().split('\n');
		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'update_ssh_key',
			name: 'testkey-damaged',
			key: [...lines.slice(0, 1), ...lines.slice(2)].join('\n'),
		});
		equal(status, 400);
		equal(data.error, "The SSH key is damaged and can't be read. Copy it again from the original file.");

		const after = await sendOperation(ctx.harper, { operation: 'get_ssh_key', name: 'testkey-damaged' });
		equal(after.data.key, before.data.key);
	});

	test('update_ssh_key on nonexistent key returns error', async () => {
		const { status, data } = await sendOperation(ctx.harper, {
			operation: 'update_ssh_key',
			name: 'nonexistent',
			key: makeKey(),
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
