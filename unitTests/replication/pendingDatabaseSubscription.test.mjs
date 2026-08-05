// harper-pro#642: a bounded setup wait must not leave the placeholder it timed out on pending.

import assert from 'node:assert';
import {
	createPendingDatabaseSubscription,
	expirePendingDatabaseSubscription,
	resolveSendSubscriptionSetup,
} from '#src/replication/replicationConnection';

const SETUP_TIMEOUT = 5;

function whenAllSettled(promises, timeout = 100) {
	return Promise.race([
		Promise.all(promises).then(() => 'settled'),
		new Promise((resolve) => setTimeout(() => resolve('pending'), timeout)),
	]);
}

describe('expirePendingDatabaseSubscription', () => {
	it('settles a pending placeholder and unregisters it', async () => {
		const subscriptions = new Map();
		const placeholder = createPendingDatabaseSubscription('db1', subscriptions);

		assert.strictEqual(expirePendingDatabaseSubscription('db1', placeholder, subscriptions), true);

		assert.strictEqual(subscriptions.has('db1'), false);
		assert.strictEqual(await placeholder, undefined);
	});

	it('leaves a placeholder that has been superseded in the map', async () => {
		const subscriptions = new Map();
		const placeholder = createPendingDatabaseSubscription('db1', subscriptions);
		const registered = { send() {} };
		subscriptions.set('db1', registered);

		assert.strictEqual(expirePendingDatabaseSubscription('db1', placeholder, subscriptions), false);

		assert.strictEqual(subscriptions.get('db1'), registered);
		assert.strictEqual(await whenAllSettled([placeholder], 20), 'pending');
	});

	it('ignores a subscription that is not a placeholder', () => {
		const registered = { send() {} };
		const subscriptions = new Map([['db1', registered]]);

		assert.strictEqual(expirePendingDatabaseSubscription('db1', registered, subscriptions), false);
		assert.strictEqual(expirePendingDatabaseSubscription('db1', undefined, subscriptions), false);
		assert.strictEqual(subscriptions.get('db1'), registered);
	});

	it('lets a late Replicator.subscribe() resolve a fresh placeholder after an expiry', async () => {
		const subscriptions = new Map();
		expirePendingDatabaseSubscription('db1', createPendingDatabaseSubscription('db1', subscriptions), subscriptions);

		const replacement = createPendingDatabaseSubscription('db1', subscriptions);
		const registered = { send() {} };
		replacement.ready(registered);

		assert.strictEqual(await replacement, registered);
	});
});

describe('persistent setup mismatch', () => {
	it('does not accumulate waiters on one retained promise across retries', async () => {
		const subscriptions = new Map();
		const placeholders = [];
		const failures = [];

		// Each iteration is one peer retry against a database this node never registers.
		for (let retry = 0; retry < 5; retry++) {
			const placeholder = subscriptions.get('db1') ?? createPendingDatabaseSubscription('db1', subscriptions);
			placeholders.push(placeholder);
			const resolved = await resolveSendSubscriptionSetup(undefined, placeholder, SETUP_TIMEOUT, (gate, reason) => {
				failures.push([gate, reason]);
				expirePendingDatabaseSubscription('db1', placeholder, subscriptions);
			});
			assert.strictEqual(resolved, undefined);
		}

		assert.strictEqual(failures.length, 5);
		assert.deepStrictEqual(failures[0], ['database', 'timeout']);
		// A retry must not re-race the promise the previous attempt already gave up on.
		assert.strictEqual(new Set(placeholders).size, 5);
		assert.strictEqual(subscriptions.has('db1'), false);
		assert.strictEqual(await whenAllSettled(placeholders), 'settled');
	});
});
