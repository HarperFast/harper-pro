import assert from 'node:assert';
import { workers } from '#js/core/server/threads/manageThreads';
import {
	isReplicationWorker,
	recordLockParticipantWorkers,
	replicationWorkers,
} from '#src/replication/replicationWorkers';
import { setActiveWorkerPools } from '#src/core/server/threads/workerPools';
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

describe('replicationWorkers with the replication pool (replication.threads)', () => {
	const http = { name: 'http', threadId: 1 };
	const isolated = { name: 'http', threadId: 2, application: 'iso-app' };
	const pooled = { name: 'replication', threadId: 3 };
	const job = { name: 'job', threadId: 4 };
	const all = [http, isolated, pooled, job];

	afterEach(() => setActiveWorkerPools([]));

	it('places replication only on the pool while the pool runs', () => {
		setActiveWorkerPools(['replication']);
		assert.strictEqual(isReplicationWorker(pooled), true);
		assert.strictEqual(isReplicationWorker(http), false);
		assert.deepStrictEqual(replicationWorkers(all), [pooled]);
	});

	it('never places replication on a pool worker while no pool runs', () => {
		assert.deepStrictEqual(replicationWorkers(all), [http]);
	});

	it('defers rather than falling back to HTTP workers while every pool member is down', () => {
		setActiveWorkerPools(['replication']);
		assert.deepStrictEqual(replicationWorkers([http, isolated, job]), []);
	});

	it('never opens a subscription on the main thread while the pool runs, even where main may fall back', () => {
		const onMain = [];
		setActiveWorkerPools(['replication']);
		assert.strictEqual(
			dispatchSubscriptionRequest({}, { id: 1 }, [], true, (r) => onMain.push(r)),
			'deferred'
		);
		assert.deepStrictEqual(onMain, []);
		setActiveWorkerPools([]);
		assert.strictEqual(
			dispatchSubscriptionRequest({}, { id: 2 }, [], true, (r) => onMain.push(r)),
			'main'
		);
		assert.deepStrictEqual(onMain, [{ id: 2 }]);
	});

	it('fences every worker that can hold a cluster lock, whatever the placement', () => {
		assert.deepStrictEqual(recordLockParticipantWorkers(all), [http, isolated, pooled]);
		setActiveWorkerPools(['replication']);
		assert.deepStrictEqual(recordLockParticipantWorkers(all), [http, isolated, pooled]);
	});
});
