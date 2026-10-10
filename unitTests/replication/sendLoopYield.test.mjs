import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Worker } from 'node:worker_threads';
import sinon from 'sinon';
import * as replication from '#src/replication/replicationConnection';

const source = readFileSync(new URL('../../dist/replication/replicationConnection.js', import.meta.url), 'utf8');
const skipStart = source.indexOf('function skipAuditRecord() {');
const skipEnd = source.indexOf('if (!sentNodeIds.has(', skipStart);
const waitStart = source.indexOf('// wait if there is back-pressure', skipEnd);
const waitEnd = source.indexOf('const sendQueuedData =', waitStart);
assert(skipStart >= 0 && skipEnd > skipStart && waitStart > skipEnd && waitEnd > waitStart);
const skip = source.slice(skipStart, skipEnd);
const wait = source.slice(waitStart, waitEnd).replace(/};\s*$/, '');
const realPerformanceNow = performance.now.bind(performance);

function createSender() {
	const socket = new EventEmitter();
	socket.writableNeedDrain = false;
	const ws = new EventEmitter();
	ws._socket = socket;
	const sent = [];
	ws.send = (message) => sent.push(message);
	const state = {
		ws,
		logger: {},
		yieldSendLoop: replication.yieldSendLoop,
		msgpackr_1: { encode: (message) => message },
		setImmediate,
		setTimeout,
		DEBUG_MODE: false,
		SEQUENCE_ID_UPDATE: 143,
		SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY: 300,
		MAX_OUTSTANDING_BLOBS_BEING_SENT: 5,
		outstandingBlobsBeingSent: 0,
		blobSentCallbacks: [],
		wsClosed: false,
		isPausedForBackPressure: false,
		currentSequenceId: 1000,
		sentSequenceId: 0,
		skippedMessageSequenceUpdateTimer: null,
		updateBackPressureRatio() {},
	};
	const senders = runInNewContext(
		`${skip}\nfunction sendRecord() { ${wait} }\n({ sendRecord, skipAuditRecord })`,
		state
	);
	return { ...senders, state, sent, ws, socket };
}

describe('replication sender yield budget on the main-thread fallback', function () {
	this.timeout(5000);
	let clock;
	let sender;
	let now = 1_000_000;
	let anchor;
	let performanceNow;

	beforeEach(async () => {
		clock = sinon.useFakeTimers({ toFake: ['setImmediate', 'setTimeout', 'clearTimeout'] });
		now = Math.max(now + 1000, realPerformanceNow() + 1000);
		anchor = now;
		performanceNow = sinon.stub(performance, 'now').callsFake(() => now);
		if (replication.yieldSendLoop) {
			const yielded = replication.yieldSendLoop();
			await clock.tickAsync(0);
			await yielded;
		}
		sender = createSender();
	});

	afterEach(async () => {
		try {
			await clock?.runAllAsync();
			now += 2;
			const turn = replication.yieldSendLoop?.();
			performanceNow?.callsFake(realPerformanceNow);
			await clock?.runAllAsync();
			await turn;
		} finally {
			performanceNow?.restore();
			clock?.restore();
		}
	});

	it('sends records below the time budget without a macrotask per record', () => {
		for (let record = 0; record < 1000; record++) {
			assert.equal(sender.sendRecord(), undefined, 'an uncongested record must not schedule a turn below budget');
		}
		assert.equal(clock.countTimers(), 0);
	});

	it('skips records below the time budget without a macrotask per record', () => {
		for (let record = 0; record < 1000; record++) {
			assert.equal(sender.skipAuditRecord(), undefined, 'a skipped record must not schedule a turn below budget');
		}
		assert.equal(clock.countTimers(), 1, 'only the sequence-update timer should be armed');
	});

	it('shares one pending yield across subscriptions and starts a fresh 0.5ms budget on resume', async () => {
		const peer = createSender();
		now = anchor + 0.499;
		assert.equal(sender.sendRecord(), undefined);
		now = anchor + 0.5;
		const yielded = sender.sendRecord();
		assert.equal(typeof yielded?.then, 'function');
		assert.equal(peer.skipAuditRecord(), yielded);
		now = anchor + 10;
		assert.equal(peer.sendRecord(), yielded);
		await clock.tickAsync(0);
		await yielded;
		now = anchor + 10.499;
		assert.equal(sender.skipAuditRecord(), undefined);
		now = anchor + 10.5;
		const skippedYield = sender.skipAuditRecord();
		assert.equal(typeof skippedYield?.then, 'function');
		assert.equal(peer.sendRecord(), skippedYield);
		await clock.tickAsync(0);
		await skippedYield;
	});

	it('keeps yielding during a long skipped run so the sequence-update timer fires', async () => {
		let yields = 0;
		for (let record = 0; record < 1600; record++) {
			sender.state.currentSequenceId++;
			now = anchor + record * 0.25;
			const result = sender.skipAuditRecord();
			if (result) {
				yields++;
				await clock.tickAsync(record * 0.25 - clock.now);
				await result;
			}
		}
		assert.equal(yields, 799);
		assert.equal(sender.sent.length, 1);
		assert.equal(sender.sent[0][0], sender.state.SEQUENCE_ID_UPDATE);
		assert(sender.sent[0][1] > 1000 && sender.sent[0][1] < sender.state.currentSequenceId);
	});

	it('waits for socket drain even below the fairness budget', async () => {
		sender.socket.writableNeedDrain = true;
		let settled = false;
		const waiting = sender.sendRecord().then(() => (settled = true));
		await clock.tickAsync(10);
		assert.equal(settled, false);
		sender.socket.emit('drain');
		await waiting;
		assert.equal(sender.ws.listenerCount('close'), 0);
	});

	it('waits for blob capacity even below the fairness budget', async () => {
		sender.state.outstandingBlobsBeingSent = 5;
		let settled = false;
		const waiting = sender.sendRecord().then(() => (settled = true));
		await clock.tickAsync(10);
		assert.equal(settled, false);
		assert.equal(sender.state.blobSentCallbacks.length, 1);
		sender.state.blobSentCallbacks.shift()();
		await waiting;
	});

	it('still waits for saturated blobs after the socket drains', async () => {
		sender.socket.writableNeedDrain = true;
		sender.state.outstandingBlobsBeingSent = 5;
		let settled = false;
		const waiting = sender.sendRecord().then(() => (settled = true));
		sender.socket.emit('drain');
		await clock.tickAsync(0);
		assert.equal(settled, false);
		sender.state.blobSentCallbacks.shift()();
		await waiting;
	});

	it('lets a closed socket release its drain wait', async () => {
		sender.socket.writableNeedDrain = true;
		const waiting = sender.sendRecord();
		sender.ws.emit('close');
		await waiting;
		assert.equal(sender.socket.listenerCount('drain'), 0);
	});
});

describe('replication sender budgets in worker threads', function () {
	this.timeout(15000);
	for (const { name, workerPools, budget } of [
		{ name: 'replication', workerPools: ['replication'], budget: 2 },
		{ name: 'http', workerPools: [], budget: 0.5 },
		{ name: 'http', workerPools: ['replication'], budget: 0.5 },
	]) {
		it(`uses ${budget}ms on ${name} workers with pools ${JSON.stringify(workerPools)}`, async () => {
			const worker = new Worker(
				`
				const { parentPort, workerData } = require('node:worker_threads');
				const { yieldSendLoop } = require(workerData.modulePath);
				const assert = require('node:assert');
				const { isDedicatedPoolWorker, isWorkerPoolActive } = require(workerData.poolModulePath);
				assert.strictEqual(isDedicatedPoolWorker(), workerData.name === 'replication');
				assert.strictEqual(isWorkerPoolActive('replication'), workerData.workerPools.includes('replication'));
				(async () => {
					let now = 1000;
					const turns = [];
					Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
					global.setImmediate = (callback) => turns.push(callback);
					const initial = yieldSendLoop();
					turns.shift()();
					await initial;
					now += workerData.budget - 0.001;
					const belowBudget = yieldSendLoop() === undefined;
					now = 1000 + workerData.budget;
					const pending = yieldSendLoop();
					const atBudget = pending instanceof Promise;
					const shared = yieldSendLoop() === pending;
					const pendingTurns = turns.length;
					now = 2000;
					turns.shift()?.();
					await pending;
					now += workerData.budget - 0.001;
					const freshBudget = yieldSendLoop() === undefined;
					now = 2000 + workerData.budget;
					const renewed = yieldSendLoop();
					const nextBudget = renewed instanceof Promise;
					turns.shift()?.();
					await renewed;
					parentPort.postMessage({ type: 'sender-budget', observed: { belowBudget, atBudget, shared, pendingTurns, freshBudget, nextBudget } });
				})().catch((error) => { throw error; });
				`,
				{
					eval: true,
					execArgv: [],
					stdout: true,
					stderr: true,
					workerData: {
						name,
						workerPools,
						budget,
						noServerStart: true,
						modulePath: fileURLToPath(new URL('../../dist/replication/replicationConnection.js', import.meta.url)),
						poolModulePath: fileURLToPath(new URL('../../dist/core/server/threads/workerPools.js', import.meta.url)),
					},
				}
			);
			let responseTimeout;
			try {
				const observed = await new Promise((resolve, reject) => {
					responseTimeout = setTimeout(() => reject(new Error('worker did not report its sender budget')), 10000);
					worker.on('message', (message) => {
						if (message?.type === 'sender-budget') resolve(message.observed);
					});
					worker.once('error', reject);
					worker.once('exit', (code) => reject(new Error(`worker exited before reporting its budget: ${code}`)));
				});
				assert.deepStrictEqual(observed, {
					belowBudget: true,
					atBudget: true,
					shared: true,
					pendingTurns: 1,
					freshBudget: true,
					nextBudget: true,
				});
			} finally {
				clearTimeout(responseTimeout);
				await worker.terminate();
			}
		});
	}
});
