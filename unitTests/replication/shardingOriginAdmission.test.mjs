import assert from 'node:assert';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { getDatabaseGeneration } from '#src/core/resources/auditStore';
import { receiveShardingOriginBound } from '#src/replication/shardingBootstrap';
import { answerMainThreadRequests } from '#src/core/server/threads/manageThreads';
import { listenersByType } from '#src/core/server/threads/threadMessageState';
import { table } from '#src/core/resources/databases';
import {
	originReadyWord,
	ORIGIN_READY,
	ORIGIN_BOUND_BUSY,
	recoveryBoundKey,
	recoveryBoundSourceKey,
	recordShardingOriginBound,
} from '#src/replication/shardingOriginAdmission';

describe('Sharding recovery issuance bounds', function () {
	this.timeout(20_000);
	let root, catalog, auditStore;
	const database = 'shardingBound';
	before(() => {
		const Rows = table({ database, table: 'Rows', attributes: [{ name: 'id', isPrimaryKey: true }] });
		root = Rows.primaryStore.rootStore;
		catalog = Rows.dbisDB;
		auditStore = Rows.auditStore;
	});
	it('holds admission before an asynchronous flush and prevents a stale coordinator from enabling', async () => {
		const word = originReadyWord(root, database);
		Atomics.store(word, 0, ORIGIN_READY);
		const before = Atomics.load(word, 0);
		const write = recordShardingOriginBound(root, catalog, database, 200, 'co-owner');
		assert.equal(Atomics.load(word, 0) & ORIGIN_READY, 0);
		assert.ok(Atomics.load(word, 0) & ORIGIN_BOUND_BUSY);
		await assert.rejects(recordShardingOriginBound(root, catalog, database, 300, 'second-peer'), /another sharding/);
		assert.notEqual(Atomics.compareExchange(word, 0, before, before | ORIGIN_READY), before);
		await write;
		assert.equal(Atomics.load(word, 0) & (ORIGIN_READY | ORIGIN_BOUND_BUSY), 0);
		assert.equal(catalog.getSync([recoveryBoundKey, database]), 200);
	});
	it('retries a concurrent update, retains the maximum and identifies its source', async () => {
		await recordShardingOriginBound(root, catalog, database, 300, 'second-peer');
		await recordShardingOriginBound(root, catalog, database, 100, 'older-copy');
		assert.equal(catalog.getSync([recoveryBoundKey, database]), 300);
		assert.equal(catalog.getSync([recoveryBoundSourceKey, database]), 'second-peer');
	});
	it('refuses invalid bounds without changing durable evidence', async () => {
		for (const bound of [0, -1, Infinity, NaN])
			await assert.rejects(recordShardingOriginBound(root, catalog, database, bound, 'peer'), /Invalid sharding/);
		assert.equal(catalog.getSync([recoveryBoundKey, database]), 300);
	});
	it('rejects a request for a replaced native root before persisting its bound', async () => {
		await assert.rejects(
			receiveShardingOriginBound({ action: 'copy', database, bound: 400, source: 'peer', generations: ['replaced'] }),
			/database changed/
		);
		assert.equal(catalog.getSync([recoveryBoundKey, database]), 300);
	});

	it('finishes main-owned native persistence when the requesting worker is terminated', async () => {
		const requestType = 'test-sharding-origin-bound';
		answerMainThreadRequests(requestType, receiveShardingOriginBound);
		const entered = Promise.withResolvers();
		const release = Promise.withResolvers();
		const finished = Promise.withResolvers();
		const nativeFlush = catalog.flush;
		catalog.flush = async function (options) {
			entered.resolve();
			await nativeFlush.call(this, options);
			await release.promise;
		};
		const worker = new Worker(
			`
			const { parentPort, workerData } = require('node:worker_threads');
			const { requestFromMainThread } = require(workerData.module);
			requestFromMainThread(workerData.type, workerData.payload, 15000).then(
				() => parentPort.postMessage({ done: true }),
				error => parentPort.postMessage({ error: error.message })
			);
		`,
			{
				eval: true,
				execArgv: [],
				workerData: {
					noServerStart: true,
					module: fileURLToPath(new URL('../../dist/core/server/threads/manageThreads.js', import.meta.url)),
					type: requestType,
					payload: {
						action: 'copy',
						database,
						bound: 500,
						source: 'dying-worker',
						generations: [getDatabaseGeneration(auditStore).id],
					},
				},
			}
		);
		let timer;
		try {
			worker.on('message', (message) => {
				if (message.type === requestType) {
					for (const listener of listenersByType.get(requestType))
						listener(message, {
							postMessage: (reply) => {
								finished.resolve(reply);
								worker.postMessage(reply);
							},
						});
				}
			});
			worker.on('error', entered.reject);
			await Promise.race([
				entered.promise,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error('main never received worker bound')), 15000);
				}),
			]);
			clearTimeout(timer);
			assert.ok(Atomics.load(originReadyWord(root, database), 0) & ORIGIN_BOUND_BUSY);
			await worker.terminate();
			release.resolve();
			const reply = await Promise.race([
				finished.promise,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error('main did not complete after requester exit')), 2000);
				}),
			]);
			assert.equal(reply.error, undefined);
			assert.equal(Atomics.load(originReadyWord(root, database), 0) & ORIGIN_BOUND_BUSY, 0);
			assert.equal(catalog.getSync([recoveryBoundKey, database]), 500);
		} finally {
			clearTimeout(timer);
			release.resolve();
			await worker.terminate();
			catalog.flush = nativeFlush;
			listenersByType.delete(requestType);
		}
	});
});
