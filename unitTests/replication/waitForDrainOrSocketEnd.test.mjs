/**
 * Coverage for `waitForDrainOrSocketEnd` — the drain/close race added to `sendBlobs`'s two backpressure
 * waits (mid-loop and terminal-frame flush) in response to a PR #529 review from cb1kenobi.
 *
 * Before this fix, `sendBlobs` awaited a bare `ws._socket.once('drain', resolve)` whenever
 * `writableNeedDrain` was true. If the peer closed the connection while that wait was parked, the
 * socket never emits `drain`, so the promise never settled: `sendBlobs`'s `finally` block (which calls
 * `endBlobSend` and decrements `outstandingBlobsBeingSent`) never ran, leaking the drain token in
 * `blobSendDrain`'s module-global registry for the rest of the worker's life.
 *
 * `waitForDrainOrSocketEnd` races the `drain` wait against the raw socket's `close`/`error` events and
 * the WebSocket wrapper's `close` event, so a mid-flush disconnect always lets the waiter (and therefore
 * `sendBlobs`'s `finally`) settle. It's exercised here directly with plain `EventEmitter`s standing in
 * for the socket/ws — no real network needed, since the function only wires up listeners.
 */

import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { waitForDrainOrSocketEnd } from '#src/replication/replicationConnection';

describe('waitForDrainOrSocketEnd', () => {
	it('resolves when the socket emits drain', async () => {
		const socket = new EventEmitter();
		const ws = new EventEmitter();
		const promise = waitForDrainOrSocketEnd(socket, ws);
		socket.emit('drain');
		await promise;
		expect(socket.listenerCount('drain')).to.equal(0);
		expect(socket.listenerCount('close')).to.equal(0);
		expect(socket.listenerCount('error')).to.equal(0);
		expect(ws.listenerCount('close')).to.equal(0);
	});

	// This is the bug cb1kenobi flagged: a peer disconnect mid-flush must not hang the wait forever.
	it('resolves when the raw socket closes instead of draining (peer disconnect mid-flush)', async () => {
		const socket = new EventEmitter();
		const ws = new EventEmitter();
		const promise = waitForDrainOrSocketEnd(socket, ws);
		let settled = false;
		promise.then(() => (settled = true));

		socket.emit('close');
		// Let the microtask queue flush.
		await Promise.resolve();
		expect(settled).to.equal(true);
		// No dangling listeners left on either emitter after settling.
		expect(socket.listenerCount('drain')).to.equal(0);
		expect(socket.listenerCount('close')).to.equal(0);
		expect(socket.listenerCount('error')).to.equal(0);
		expect(ws.listenerCount('close')).to.equal(0);
	});

	it('resolves when the raw socket errors instead of draining', async () => {
		const socket = new EventEmitter();
		const ws = new EventEmitter();
		const promise = waitForDrainOrSocketEnd(socket, ws);
		socket.emit('error', new Error('ECONNRESET'));
		await promise;
		expect(socket.listenerCount('error')).to.equal(0);
	});

	it('resolves when the WebSocket wrapper closes even if the raw socket does not', async () => {
		const socket = new EventEmitter();
		const ws = new EventEmitter();
		const promise = waitForDrainOrSocketEnd(socket, ws);
		ws.emit('close');
		await promise;
		expect(socket.listenerCount('drain')).to.equal(0);
		expect(socket.listenerCount('close')).to.equal(0);
		expect(socket.listenerCount('error')).to.equal(0);
		expect(ws.listenerCount('close')).to.equal(0);
	});

	it('only settles once, and cleans up listeners on both emitters after the first event', async () => {
		const socket = new EventEmitter();
		const ws = new EventEmitter();
		let resolveCount = 0;
		const promise = waitForDrainOrSocketEnd(socket, ws).then(() => resolveCount++);
		socket.emit('close');
		// A drain that arrives after close should be a no-op (listener already removed) and must not
		// double-resolve or throw.
		expect(() => socket.emit('drain')).to.not.throw();
		await promise;
		expect(resolveCount).to.equal(1);
	});
});
