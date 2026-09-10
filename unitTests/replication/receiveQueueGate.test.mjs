/**
 * The inbound frame queue was unbounded (harper-pro#659, harper#2226): `ws.on('message')` chains
 * every frame onto `messageProcessing`, whose links retain the frame bodies, so a receive loop
 * slower than the peer grew that chain at the inbound line rate — measured live at 43 GB on one
 * worker, 1:1 with a 49 MB/s inbound rate, with `blobsInFlight` empty (so no blob-side bound could
 * have covered it).
 *
 * `createReceiveQueueGate` is the budget and `receiveQueueBudget` coerces its config value. Both are
 * pure, so the policy is exercised here with explicit byte counts; the integration test covers
 * deadlock-freedom and that a configured value reaches the gate.
 */

import { expect } from 'chai';
import { CONFIG_PARAMS } from '#src/core/utility/hdbTerms';
import { createReceiveQueueGate, receiveQueueBudget } from '#src/replication/replicationConnection';

const READ_CHUNK = 65536; // SOCKET_READ_CHUNK_BYTES: what a queued frame can pin
const HWM = 64 * READ_CHUNK; // 4 MB -> maxFrames 64, lowWaterMark 2 MB, lowWaterFrames 32
const FRAME = 400_000; // 11 frames cross the byte ceiling while staying under the frame ceiling
const DEFAULT_BUDGET = 33554432;

describe('replication inbound frame queue budget — #2226 unbounded receive queue', () => {
	it('admits frames without pausing while under both ceilings', () => {
		const gate = createReceiveQueueGate(HWM);
		expect(gate.admit(FRAME)).to.equal(false);
		expect(gate.admit(FRAME)).to.equal(false);
		expect(gate.queuedBytes).to.equal(2 * FRAME);
		expect(gate.queuedFrames).to.equal(2);
		expect(gate.paused).to.equal(false);
		expect(gate.pauses).to.equal(0);
	});

	it('pauses when the byte ceiling is exceeded, and only once', () => {
		const gate = createReceiveQueueGate(HWM);
		let paused = false;
		for (let i = 0; i < 11 && !paused; i++) paused = gate.admit(FRAME);
		expect(paused).to.equal(true);
		expect(gate.queuedBytes).to.be.above(HWM);
		// Frames already in flight when the pause was taken must not each re-pause: the caller would
		// stack pause reasons that the matching settles never balance, stranding the socket.
		expect(gate.admit(FRAME)).to.equal(false);
		expect(gate.admit(FRAME)).to.equal(false);
		expect(gate.pauses).to.equal(1);
	});

	it('stays paused while the queue drains only to just above the low-water mark', () => {
		const gate = createReceiveQueueGate(HWM);
		while (!gate.admit(FRAME));
		expect(gate.paused).to.equal(true);
		let resumes = 0;
		while (gate.queuedBytes > HWM / 2 + FRAME) if (gate.settle(FRAME)) resumes++;
		expect(gate.paused).to.equal(true);
		expect(resumes).to.equal(0);
		expect(gate.settle(FRAME)).to.equal(true);
		expect(gate.paused).to.equal(false);
		expect(gate.pauses).to.equal(1);
	});

	it('does not resume on a settle while unpaused (no unbalanced removePauseReason)', () => {
		const gate = createReceiveQueueGate(HWM);
		gate.admit(FRAME);
		expect(gate.settle(FRAME)).to.equal(false);
		expect(gate.paused).to.equal(false);
	});

	it('bounds the FRAME count too, so many tiny frames cannot queue without limit', () => {
		const gate = createReceiveQueueGate(HWM);
		let paused = false;
		for (let i = 0; i <= gate.maxFrames && !paused; i++) paused = gate.admit(1);
		expect(paused).to.equal(true);
		expect(gate.queuedFrames).to.equal(gate.maxFrames + 1);
		expect(gate.queuedBytes).to.be.below(HWM); // the byte ceiling was never close
	});

	it('holds the pause while the FRAME count drains only partway', () => {
		const gate = createReceiveQueueGate(HWM);
		for (let i = 0; i <= gate.maxFrames; i++) gate.admit(1);
		expect(gate.paused).to.equal(true);
		let resumes = 0;
		while (gate.queuedFrames > gate.maxFrames / 2 + 1) if (gate.settle(1)) resumes++;
		expect(gate.paused).to.equal(true);
		expect(resumes).to.equal(0);
		expect(gate.settle(1)).to.equal(true);
		expect(gate.paused).to.equal(false);
	});

	it('keeps the frame ceiling inside the byte budget at every budget', () => {
		// A queued frame can pin a whole read chunk, so maxFrames x READ_CHUNK is the real worst case.
		// A floor on maxFrames would break this for small budgets (64 x 64 KB = 4 MB against 64 KB).
		for (const budget of [READ_CHUNK, 1048576, HWM, DEFAULT_BUDGET])
			expect(createReceiveQueueGate(budget).maxFrames * READ_CHUNK).to.be.at.most(budget);
		expect(createReceiveQueueGate(DEFAULT_BUDGET).maxFrames).to.equal(512);
		expect(createReceiveQueueGate(READ_CHUNK).maxFrames).to.equal(1);
	});

	it('an oversized single frame costs one pause cycle, never a wedge', () => {
		const gate = createReceiveQueueGate(HWM);
		// maxPayload on the accepting side is orders of magnitude over any sane budget, and the frame has
		// already arrived — so it is accepted, it pauses, it drains, it resumes.
		expect(gate.admit(100 * 1024 * 1024)).to.equal(true);
		expect(gate.settle(100 * 1024 * 1024)).to.equal(true);
		expect(gate.paused).to.equal(false);
		expect(gate.peakQueuedBytes).to.equal(100 * 1024 * 1024);
	});

	it('tracks peaks for the pause warning', () => {
		const gate = createReceiveQueueGate(HWM);
		gate.admit(FRAME);
		gate.admit(FRAME);
		gate.settle(FRAME);
		expect(gate.peakQueuedBytes).to.equal(2 * FRAME);
		expect(gate.peakQueuedFrames).to.equal(2);
	});

	it('a zero budget disables the bound — the pre-fix behavior this guards against', () => {
		const gate = createReceiveQueueGate(0);
		for (let i = 0; i < 1000; i++) expect(gate.admit(1 << 20)).to.equal(false);
		expect(gate.paused).to.equal(false);
		expect(gate.queuedBytes).to.equal(1000 << 20); // 1 GB queued, never a pause
	});

	it('lands a junk budget on the default with the bound still ACTIVE, never unbounded', () => {
		// receiveQueueBudget keeps this unreachable in production; the gate is exported, so it holds on
		// its own. A NaN budget would otherwise fail every comparison in both directions — every frame
		// pausing and every settle resuming. Falling back to DISABLED would be the other wrong answer:
		// it restores the unbounded queue this whole change exists to remove.
		for (const budget of [NaN, Infinity, -1, 'abc', null, undefined]) {
			const gate = createReceiveQueueGate(budget);
			let paused = false;
			for (let i = 0; i < 64 && !paused; i++) paused = gate.admit(1 << 20);
			expect(paused, `budget ${String(budget)} left the queue unbounded`).to.equal(true);
			expect(gate.maxFrames).to.equal(512); // the 32 MB default's ceiling
		}
	});

	it('coerces a numeric string rather than disabling the bound', () => {
		const gate = createReceiveQueueGate('1048576');
		expect(gate.maxFrames).to.equal(16);
	});

	describe('receiveQueueBudget', () => {
		// `env.get` resolves only names registered in CONFIG_PARAMS, so an unregistered key silently
		// falls back to the default — how replication_leadingDuplicateSkip shipped inert (harper-pro#395).
		it('has its config param registered, so a configured budget reaches the gate', () => {
			expect(CONFIG_PARAMS.REPLICATION_RECEIVEQUEUEHIGHWATERMARK).to.equal('replication_receiveQueueHighWaterMark');
		});

		// A NaN reaching the gate would disable neither ceiling while failing every comparison: every
		// frame pauses and every settle resumes, so each frame costs ws.pause()/resume(), four watchdog
		// handoffs and a blob-stream walk.
		it('falls back to the default rather than producing NaN', () => {
			for (const value of ['32mb', undefined, null, '', {}, -1, Infinity, NaN])
				expect(receiveQueueBudget(value)).to.equal(DEFAULT_BUDGET);
		});

		it('honors an explicit 0 as the documented disable', () => {
			expect(receiveQueueBudget(0)).to.equal(0);
			expect(receiveQueueBudget('0')).to.equal(0);
		});

		it('floors a configured budget at one read chunk, below which it cannot hold a frame', () => {
			expect(receiveQueueBudget(1)).to.equal(READ_CHUNK);
			expect(receiveQueueBudget(4096)).to.equal(READ_CHUNK);
			expect(receiveQueueBudget(1048576)).to.equal(1048576);
		});
	});
});
