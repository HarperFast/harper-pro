import assert from 'node:assert';
import { workers } from '#js/core/server/threads/manageThreads';
import { isReplicationWorker, replicationWorkers } from '#src/replication/replicationWorkers';
import { dispatchSubscriptionRequest, findStaleNodeUrls } from '#src/replication/subscriptionManager';

describe('replicationWorkers (harper-pro#974)', () => {
	const pool0 = { name: 'http', threadId: 1 };
	const isolated = { name: 'http', threadId: 2, application: 'isolated-app' };
	const pool1 = { name: 'http', threadId: 3 };
	const job = { name: 'job', threadId: 4 };

	beforeEach(() => {
		workers.push(pool0, isolated, pool1, job);
	});
	afterEach(() => {
		for (const worker of [pool0, isolated, pool1, job]) workers.splice(workers.indexOf(worker), 1);
	});

	it('admits plain http workers only', () => {
		assert.strictEqual(isReplicationWorker(pool0), true);
		assert.strictEqual(isReplicationWorker(isolated), false);
		assert.strictEqual(isReplicationWorker(job), false);
	});

	it('returns the plain http workers in start order, skipping an isolated application worker', () => {
		assert.deepStrictEqual(replicationWorkers(), [pool0, pool1]);
	});

	it('never dispatches a subscription to an isolated application worker', () => {
		const posted = [];
		isolated.postMessage = (message) => posted.push(message);
		assert.strictEqual(
			dispatchSubscriptionRequest({ worker: isolated }, { id: 1 }, replicationWorkers(), false, () => {}),
			'deferred'
		);
		assert.deepStrictEqual(posted, []);
	});

	it('marks a subscription held by an isolated application worker stale so the reconcile rebinds it', () => {
		const connections = new Map([
			['ws://pool:9933', new Map([['data', { worker: pool0 }]])],
			['ws://isolated:9933', new Map([['data', { worker: isolated }]])],
		]);
		assert.deepStrictEqual([...findStaleNodeUrls(connections, replicationWorkers())], ['ws://isolated:9933']);
	});
});
