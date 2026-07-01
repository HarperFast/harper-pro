import assert from 'node:assert';
import { describe, it } from 'mocha';
import {
	grantSecret,
	InMemorySecretsStore,
	isGranted,
	listSecrets,
	revokeSecret,
	setSecret,
} from '#src/security/secretsStore';

describe('secretsStore', () => {
	it('isGranted only allows components in the grant list', () => {
		const record = { name: 'X', grants: ['a', 'b'] };
		assert.equal(isGranted(record, 'a'), true);
		assert.equal(isGranted(record, 'c'), false);
		assert.equal(isGranted(undefined, 'a'), false);
	});

	it('setSecret upserts value / grants / description, and merges on re-set', async () => {
		const store = new InMemorySecretsStore();
		await setSecret(store, { name: 'DB', value: 'enc:v1:aaa', grants: ['app'], description: 'dsn' });
		let rec = await store.get('DB');
		assert.deepEqual(rec.grants, ['app']);
		assert.equal(rec.value, 'enc:v1:aaa');

		// Re-set only the value; grants + description persist.
		await setSecret(store, { name: 'DB', value: 'enc:v1:bbb' });
		rec = await store.get('DB');
		assert.equal(rec.value, 'enc:v1:bbb');
		assert.deepEqual(rec.grants, ['app']);
		assert.equal(rec.description, 'dsn');
	});

	it('setSecret can create grants before a value exists', async () => {
		const store = new InMemorySecretsStore();
		await setSecret(store, { name: 'PENDING', grants: ['app'] });
		const rec = await store.get('PENDING');
		assert.equal(rec.value, undefined);
		assert.deepEqual(rec.grants, ['app']);
	});

	it('grant/revoke add and remove a single component (deduped)', async () => {
		const store = new InMemorySecretsStore();
		await setSecret(store, { name: 'X', value: 'enc:v1:z', grants: ['a'] });
		await grantSecret(store, { name: 'X', component: 'b' });
		await grantSecret(store, { name: 'X', component: 'b' }); // idempotent
		assert.deepEqual((await store.get('X')).grants.sort(), ['a', 'b']);
		await revokeSecret(store, { name: 'X', component: 'a' });
		assert.deepEqual((await store.get('X')).grants, ['b']);
	});

	it('grant/revoke on a missing secret throws', async () => {
		const store = new InMemorySecretsStore();
		await assert.rejects(() => grantSecret(store, { name: 'NOPE', component: 'a' }), /does not exist/);
		await assert.rejects(() => revokeSecret(store, { name: 'NOPE', component: 'a' }), /does not exist/);
	});

	it('listSecrets returns grants + metadata but never the value', async () => {
		const store = new InMemorySecretsStore();
		await setSecret(store, { name: 'WITH', value: 'enc:v1:secret', grants: ['a'], description: 'd' });
		await setSecret(store, { name: 'WITHOUT', grants: ['b'] });
		const infos = (await listSecrets(store)).sort((x, y) => x.name.localeCompare(y.name));
		assert.deepEqual(infos, [
			{ name: 'WITH', grants: ['a'], description: 'd', hasValue: true, updatedBy: undefined, updatedAt: undefined },
			{
				name: 'WITHOUT',
				grants: ['b'],
				description: undefined,
				hasValue: false,
				updatedBy: undefined,
				updatedAt: undefined,
			},
		]);
		// Belt-and-suspenders: no `value` key on the public info.
		assert.equal(
			infos.every((i) => !('value' in i)),
			true
		);
	});
});
