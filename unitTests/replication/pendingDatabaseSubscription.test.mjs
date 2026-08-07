import assert from 'node:assert';
import {
	activeDatabaseSubscription,
	createPendingDatabaseSubscription,
	expirePendingDatabaseSubscription,
	resolveSendSubscriptionSetup,
	subscriptionForConnection,
	subscriptionForDatabase,
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

describe('activeDatabaseSubscription', () => {
	it('hides a retired placeholder and passes anything else through', () => {
		const subscriptions = new Map();
		const placeholder = createPendingDatabaseSubscription('db1', subscriptions);
		assert.strictEqual(activeDatabaseSubscription(placeholder), placeholder);

		expirePendingDatabaseSubscription('db1', placeholder, subscriptions);

		assert.strictEqual(activeDatabaseSubscription(placeholder), undefined);
		assert.strictEqual(activeDatabaseSubscription(undefined), undefined);
		const registered = { send() {} };
		assert.strictEqual(activeDatabaseSubscription(registered), registered);
	});

	it('lets a connection that cached the retired placeholder converge on a late registration', async () => {
		const subscriptions = new Map();
		const connection = { subscription: createPendingDatabaseSubscription('db1', subscriptions) };
		const sibling = { subscription: connection.subscription };

		expirePendingDatabaseSubscription('db1', connection.subscription, subscriptions);
		assert.strictEqual(await connection.subscription, undefined);

		const registered = { send() {} };
		subscriptions.set('db1', registered);

		for (const holder of [connection, sibling]) {
			assert.strictEqual(subscriptionForConnection(holder.subscription, 'db1', subscriptions), registered);
		}
		assert.strictEqual(subscriptions.get('db1'), registered);
	});
});

describe('subscriptionForDatabase', () => {
	it('returns the registered subscription without re-registering', () => {
		const registered = { send() {} };
		const subscriptions = new Map([['db1', registered]]);

		assert.strictEqual(subscriptionForDatabase('db1', subscriptions), registered);
		assert.strictEqual(subscriptions.get('db1'), registered);
	});

	it('never installs a placeholder over a registration that landed after an expiry', async () => {
		const subscriptions = new Map();
		const retired = createPendingDatabaseSubscription('db1', subscriptions);
		expirePendingDatabaseSubscription('db1', retired, subscriptions);
		const registered = { send() {} };
		subscriptions.set('db1', registered);

		assert.strictEqual(subscriptionForConnection(retired, 'db1', subscriptions), registered);
		assert.strictEqual(subscriptions.get('db1'), registered);
	});

	it('registers a fresh placeholder when nothing is registered', async () => {
		const subscriptions = new Map();
		const placeholder = subscriptionForDatabase('db1', subscriptions);

		assert.strictEqual(subscriptions.get('db1'), placeholder);
		const registered = { send() {} };
		placeholder.ready(registered);
		assert.strictEqual(await placeholder, registered);
	});
});

describe('persistent setup mismatch', () => {
	it('does not accumulate waiters on one retained promise across retries', async () => {
		const subscriptions = new Map();
		const placeholders = [];
		const failures = [];

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
		assert.strictEqual(new Set(placeholders).size, 5);
		assert.strictEqual(subscriptions.has('db1'), false);
		assert.strictEqual(await whenAllSettled(placeholders), 'settled');
	});
});
