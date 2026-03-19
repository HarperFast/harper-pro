import { suite, test, before, after } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert';
import { join } from 'node:path';
import { startHarper, teardownHarper } from '../../core/integrationTests/utils/harperLifecycle.ts';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

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
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
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
		deepEqual(data, { name: 'testkey1', host: 'testkey1.gitlab.com', hostname: 'gitlab.com', key: 'random\nstring' });

		// cleanup
		await sendOperation(ctx.harper, { operation: 'delete_ssh_key', name: 'testkey1' });
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

		// cleanup
		await sendOperation(ctx.harper, { operation: 'set_ssh_known_hosts', known_hosts: null });
	});

	test('add_ssh_key with github.com hostname fetches known_hosts automatically', async () => {
		let { status, data } = await sendOperation(ctx.harper, {
			operation: 'add_ssh_key',
			name: 'testkey-github',
			key: 'random\nstring',
			host: 'testkey-github.github.com',
			hostname: 'github.com',
		});
		equal(status, 200);
		equal(data.message, 'Added ssh key: testkey-github');

		({ status, data } = await sendOperation(ctx.harper, { operation: 'get_ssh_known_hosts' }));
		equal(status, 200);
		ok(data.known_hosts.split('\n').length > 2, 'expected known_hosts to contain auto-fetched github entries');

		// cleanup
		await sendOperation(ctx.harper, { operation: 'delete_ssh_key', name: 'testkey-github' });
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

		// cleanup
		await sendOperation(ctx.harper, { operation: 'delete_ssh_key', name: 'testkey-update' });
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

		// cleanup
		await sendOperation(ctx.harper, { operation: 'delete_ssh_key', name: 'testkey-duplicate' });
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
