// A key the clone can't fetch or its add_ssh_key refuses is skipped by name without stopping the rest;
// with the real add_ssh_key, see unitTests/security/sshKeyOperations.test.mjs.
import assert from 'node:assert/strict';
import { cloneSSHKeysFromLeader } from '#src/cloneNode/sshKeyClone';

function leaderWith(keys, { failGet = [] } = {}) {
	return async ({ operation, name }) => {
		if (operation === 'list_ssh_keys') return Object.keys(keys).map((key) => ({ name: key }));
		if (failGet.includes(name)) throw new Error(`leader request for '${name}' failed`);
		return { name, ...keys[name] };
	};
}

function recorder() {
	const added = [];
	const logged = [];
	return {
		added,
		logged,
		errors: () => logged.filter(({ level }) => level === 'error').map(({ message }) => message),
		addSSHKey: async (key) => {
			if (key.key === 'refused') throw new Error('The SSH key is damaged');
			added.push(key.name);
		},
		log: (message, level) => logged.push({ message, level }),
	};
}

describe('cloneSSHKeysFromLeader', () => {
	it('clones the keys after one the local add_ssh_key refuses', async () => {
		const clone = recorder();
		await cloneSSHKeysFromLeader(
			leaderWith({ first: { key: 'refused' }, second: { key: 'ok' } }),
			clone.addSSHKey,
			clone.log
		);

		assert.deepEqual(clone.added, ['second']);
		assert.deepEqual(clone.errors(), ["Skipped cloning SSH key 'first': The SSH key is damaged"]);
	});

	it('clones the keys after one the leader fails to return', async () => {
		const clone = recorder();
		const leader = leaderWith({ first: { key: 'ok' }, second: { key: 'ok' } }, { failGet: ['first'] });
		await cloneSSHKeysFromLeader(leader, clone.addSSHKey, clone.log);

		assert.deepEqual(clone.added, ['second']);
		assert.deepEqual(clone.errors(), ["Skipped cloning SSH key 'first': leader request for 'first' failed"]);
	});

	it('names each key it clones', async () => {
		const clone = recorder();
		await cloneSSHKeysFromLeader(leaderWith({ deploy: { key: 'ok' } }), clone.addSSHKey, clone.log);

		assert.ok(clone.logged.some(({ message }) => message === 'Cloning SSH key: deploy'));
	});

	it('logs a failed key listing and clones nothing, without throwing', async () => {
		const clone = recorder();
		const leader = async () => {
			throw new Error('leader unreachable');
		};
		await cloneSSHKeysFromLeader(leader, clone.addSSHKey, clone.log);

		assert.deepEqual(clone.added, []);
		assert.deepEqual(clone.errors(), ['Error cloning SSH keys: Error: leader unreachable']);
	});

	it('says so when the leader has no keys', async () => {
		const clone = recorder();
		await cloneSSHKeysFromLeader(leaderWith({}), clone.addSSHKey, clone.log);

		assert.deepEqual(clone.added, []);
		assert.deepEqual(clone.logged, [{ message: 'No SSH keys found on leader node to clone', level: undefined }]);
	});
});
