import assert from 'node:assert';
import { setImmediate as waitForTurn } from 'node:timers/promises';
import { createWorkerSubscriptionAdmission } from '#src/replication/subscriptionManager';
import { getSubscriptionConnectionKey } from '#src/replication/replicator';

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe('worker subscription admission', () => {
	it('derives one connection key for setup and teardown when the nested URL is missing', () => {
		const connectingUrl = 'wss://peer:9933';
		assert.equal(
			getSubscriptionConnectionKey(connectingUrl, undefined),
			getSubscriptionConnectionKey(connectingUrl, connectingUrl)
		);
	});

	it('retains one latest pre-readiness action per target', async () => {
		const readiness = deferred();
		const actions = [];
		const admission = createWorkerSubscriptionAdmission({
			whenReady: () => readiness.promise,
			key: (message) => message.key,
			dispatch: (message) => actions.push(message),
			onError: assert.fail,
		});
		const first = { key: 'peer\0data', type: 'subscribe-to-node', generation: 1 };
		const latest = { key: 'peer\0data', type: 'subscribe-to-node', generation: 60_000 };
		admission.submit(first);
		for (let generation = 2; generation < latest.generation; generation++) admission.submit({ ...first, generation });
		admission.submit(latest);

		assert.equal(admission.pendingCount(), 1);
		assert.deepEqual(actions, []);
		readiness.resolve();
		await waitForTurn();
		assert.deepEqual(actions, [latest]);
		assert.equal(admission.pendingCount(), 0);
	});

	it('uses the final pre-readiness subscribe or unsubscribe state', async () => {
		const readiness = deferred();
		const actions = [];
		const admission = createWorkerSubscriptionAdmission({
			whenReady: () => readiness.promise,
			key: (message) => message.key,
			dispatch: (message) => actions.push(message.type),
			onError: assert.fail,
		});
		admission.submit({ key: 'peer\0data', type: 'subscribe-to-node' });
		admission.submit({ key: 'peer\0data', type: 'unsubscribe-from-node' });
		readiness.resolve();
		await waitForTurn();
		assert.deepEqual(actions, ['unsubscribe-from-node']);
	});

	it('runs post-readiness actions inline without deriving a key', async () => {
		const readiness = deferred();
		const actions = [];
		let keyCalls = 0;
		const admission = createWorkerSubscriptionAdmission({
			whenReady: () => readiness.promise,
			key: (message) => {
				keyCalls++;
				return message.key;
			},
			dispatch: (message) => actions.push(message.generation),
			onError: assert.fail,
		});
		admission.submit({ key: 'peer\0data', generation: 1 });
		readiness.resolve();
		await waitForTurn();
		admission.submit({ key: 'peer\0data', generation: 2 });

		assert.deepEqual(actions, [1, 2]);
		assert.equal(keyCalls, 1);
	});

	it('retains bounded state after readiness rejection and retries on the next message', async () => {
		const firstReadiness = deferred();
		let attempts = 0;
		const actions = [];
		const errors = [];
		const admission = createWorkerSubscriptionAdmission({
			whenReady: () => (++attempts === 1 ? firstReadiness.promise : Promise.resolve()),
			key: (message) => message.key,
			dispatch: (message) => actions.push(message.generation),
			onError: (_message, error) => errors.push(error.message),
		});
		admission.submit({ key: 'peer\0data', generation: 1 });
		firstReadiness.reject(new Error('component load failed'));
		await waitForTurn();
		assert.equal(admission.pendingCount(), 1);
		admission.submit({ key: 'peer\0data', generation: 2 });
		await waitForTurn();

		assert.deepEqual(errors, ['component load failed']);
		assert.deepEqual(actions, [2]);
		assert.equal(admission.pendingCount(), 0);
	});
});
