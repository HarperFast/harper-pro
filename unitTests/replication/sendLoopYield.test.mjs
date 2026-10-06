import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import sinon from 'sinon';
import * as replication from '#src/replication/replicationConnection';

// Nested subscription closures need a socket/timer fixture here.
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

describe('replication sender yield budget', function () {
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

	it('shares one pending yield across subscriptions and starts a fresh 2ms budget on resume', async () => {
		const peer = createSender();
		now = anchor + 1;
		assert.equal(sender.sendRecord(), undefined);
		now = anchor + 2;
		const yielded = sender.sendRecord();
		assert.equal(typeof yielded?.then, 'function');
		assert.equal(peer.skipAuditRecord(), yielded);
		now = anchor + 10;
		assert.equal(peer.sendRecord(), yielded);
		await clock.tickAsync(0);
		await yielded;
		now = anchor + 11;
		assert.equal(sender.skipAuditRecord(), undefined);
		now = anchor + 12;
		const skippedYield = sender.skipAuditRecord();
		assert.equal(typeof skippedYield?.then, 'function');
		assert.equal(peer.sendRecord(), skippedYield);
		await clock.tickAsync(0);
		await skippedYield;
	});

	it('keeps yielding during a long skipped run so the sequence-update timer fires', async () => {
		let yields = 0;
		for (let record = 0; record < 400; record++) {
			sender.state.currentSequenceId++;
			now = anchor + record;
			const result = sender.skipAuditRecord();
			if (result) {
				yields++;
				await clock.tickAsync(record - clock.now);
				await result;
			}
		}
		assert.equal(yields, 199);
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
