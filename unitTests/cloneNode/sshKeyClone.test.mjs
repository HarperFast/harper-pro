import assert from 'node:assert/strict';
import { cloneSSHKeysFromLeader } from '#src/cloneNode/sshKeyClone';

function leaderWith(keys, { failures = {} } = {}) {
	const requested = [];
	const remaining = { ...failures };
	const requestLeader = async ({ operation, name }) => {
		requested.push(name ?? operation);
		const target = name ?? operation;
		if (remaining[target] > 0) {
			remaining[target]--;
			throw new Error(`leader request for '${target}' failed`);
		}
		if (operation === 'list_ssh_keys') return Object.keys(keys).map((key) => ({ name: key }));
		return { name, ...keys[name] };
	};
	return { requestLeader, requested };
}

function recorder({ local = {}, refuseRemoval = [] } = {}) {
	const added = [];
	const removed = [];
	const logged = [];
	return {
		added,
		removed,
		logged,
		errors: () => logged.filter(({ level }) => level === 'error').map(({ message }) => message),
		addSSHKey: async (key) => {
			if (key.key === 'refused') throw Object.assign(new Error('The SSH key is damaged'), { statusCode: 400 });
			if (key.key === 'disk full') throw new Error('ENOSPC: no space left on device');
			added.push(key.name);
		},
		localSSHKeyState: async (name) => local[name] ?? 'absent',
		removeLocalSSHKey: async (name) => {
			if (refuseRemoval.includes(name))
				throw Object.assign(new Error(`SSH key '${name}' was not deleted`), { statusCode: 400 });
			removed.push(name);
		},
		log: (message, level) => logged.push({ message, level }),
	};
}

const clone = (leader, node, options) =>
	cloneSSHKeysFromLeader({
		requestLeader: leader.requestLeader,
		addSSHKey: node.addSSHKey,
		localSSHKeyState: node.localSSHKeyState,
		removeLocalSSHKey: node.removeLocalSSHKey,
		log: node.log,
		retryDelayMs: 0,
		...options,
	});

describe('cloneSSHKeysFromLeader', () => {
	it('clones the keys after one the local add_ssh_key refuses', async () => {
		const node = recorder();
		await clone(leaderWith({ first: { key: 'refused' }, second: { key: 'ok' } }), node);

		assert.deepEqual(node.added, ['second']);
		assert.deepEqual(node.errors(), ["Skipped cloning SSH key 'first': The SSH key is damaged"]);
	});

	it('retries a leader request that fails, then clones the key', async () => {
		const node = recorder();
		const leader = leaderWith({ first: { key: 'ok' } }, { failures: { list_ssh_keys: 2, first: 2 } });
		await clone(leader, node);

		assert.deepEqual(node.added, ['first']);
		assert.deepEqual(node.errors(), []);
	});

	it('throws when a leader request still fails after every attempt, cloning no key after it', async () => {
		const node = recorder();
		const leader = leaderWith({ first: { key: 'ok' }, second: { key: 'ok' } }, { failures: { first: 3 } });
		await assert.rejects(clone(leader, node), {
			message: "get_ssh_key 'first' failed on the leader 3 times: leader request for 'first' failed",
		});

		assert.deepEqual(node.added, []);
		assert.deepEqual(leader.requested, ['list_ssh_keys', 'first', 'first', 'first']);
	});

	it('throws when the key listing still fails after every attempt', async () => {
		const node = recorder();
		const leader = leaderWith({ first: { key: 'ok' } }, { failures: { list_ssh_keys: 3 } });
		await assert.rejects(clone(leader, node), {
			message: "list_ssh_keys failed on the leader 3 times: leader request for 'list_ssh_keys' failed",
		});

		assert.deepEqual(node.added, []);
	});

	it('throws a key this node cannot store, rather than skipping it', async () => {
		const node = recorder();
		await assert.rejects(clone(leaderWith({ first: { key: 'disk full' }, second: { key: 'ok' } }), node), {
			message: "Unable to store SSH key 'first' cloned from the leader: ENOSPC: no space left on device",
		});

		assert.deepEqual(node.added, []);
	});

	it('leaves a key an earlier attempt cloned, without fetching it again', async () => {
		const node = recorder({ local: { first: 'complete' } });
		const leader = leaderWith({ first: { key: 'ok' }, second: { key: 'ok' } });
		await clone(leader, node);

		assert.deepEqual(node.added, ['second']);
		assert.deepEqual(leader.requested, ['list_ssh_keys', 'second']);
		assert.deepEqual(node.errors(), []);
		assert.ok(node.logged.some(({ message }) => message === "SSH key 'first' is already on this node"));
	});

	it('replaces a key an earlier attempt left partly written', async () => {
		const node = recorder({ local: { first: 'partial' } });
		const leader = leaderWith({ first: { key: 'ok' } });
		await clone(leader, node);

		assert.deepEqual(node.removed, ['first']);
		assert.deepEqual(node.added, ['first']);
		assert.deepEqual(leader.requested, ['list_ssh_keys', 'first']);
	});

	it('skips a partly written key this node refuses to remove, and clones the next one', async () => {
		const node = recorder({ local: { first: 'partial' }, refuseRemoval: ['first'] });
		const leader = leaderWith({ first: { key: 'ok' }, second: { key: 'ok' } });
		await clone(leader, node);

		assert.deepEqual(node.added, ['second']);
		assert.deepEqual(node.errors(), ["Skipped cloning SSH key 'first': SSH key 'first' was not deleted"]);
		assert.deepEqual(leader.requested, ['list_ssh_keys', 'second']);
	});

	it('names each key it clones', async () => {
		const node = recorder();
		await clone(leaderWith({ deploy: { key: 'ok' } }), node);

		assert.ok(node.logged.some(({ message }) => message === 'Cloning SSH key: deploy'));
	});

	it('says so when the leader has no keys', async () => {
		const node = recorder();
		await clone(leaderWith({}), node);

		assert.deepEqual(node.added, []);
		assert.deepEqual(node.logged, [{ message: 'No SSH keys found on leader node to clone', level: undefined }]);
	});
});
