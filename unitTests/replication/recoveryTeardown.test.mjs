import { expect } from 'chai';
import sinon from 'sinon';
import { WebSocket, WebSocketServer } from 'ws';
import {
	closeRecoveryTransport,
	escalateRecoverySession,
	normalizeWebSocketCloseReason,
} from '#src/replication/replicationConnection';

describe('replication recovery teardown', () => {
	it('contains diagnostic failures while falling through every transport teardown', () => {
		const terminate = sinon.stub().throws(new Error('terminate failed'));
		const destroy = sinon.stub().throws(new Error('destroy failed'));
		const scheduled = [];
		const escalate = sinon.stub().throws(new Error('escalation failed'));

		expect(() =>
			closeRecoveryTransport(1011, 'broken', {
				transport: {
					close: sinon.stub().throws(new Error('close failed')),
					terminate,
					destroy,
				},
				schedule: (callback) => scheduled.push(callback),
				escalate,
				report() {
					throw new Error('logger failed');
				},
			})
		).not.to.throw();

		expect(terminate.calledOnce).to.equal(true);
		expect(destroy.calledOnce).to.equal(true);
		expect(scheduled).to.have.length(1);
		expect(() => scheduled[0]()).not.to.throw();
		expect(escalate.calledOnce).to.equal(true);
	});

	it('does not schedule escalation when the close handshake starts', () => {
		const close = sinon.spy();
		const schedule = sinon.spy();

		expect(
			closeRecoveryTransport(1011, 'closing', {
				transport: { close, terminate: sinon.spy() },
				schedule,
				escalate: sinon.spy(),
			})
		).to.equal(true);
		expect(close.calledOnceWithExactly(1011, 'closing')).to.equal(true);
		expect(schedule.called).to.equal(false);
	});

	it('retires a stale failed socket without reconnecting the healthy replacement', () => {
		const failedSocket = {};
		const retire = sinon.spy();
		const forceReconnect = sinon.spy();

		escalateRecoverySession(failedSocket, {}, false, { retire, forceReconnect });

		expect(retire.calledOnce).to.equal(true);
		expect(forceReconnect.called).to.equal(false);
	});

	it('contains retirement and reconnect failures for the active socket', () => {
		const socket = {};
		const retire = sinon.stub().throws(new Error('retire failed'));
		const forceReconnect = sinon.stub().throws(new Error('reconnect failed'));
		const report = sinon.stub().throws(new Error('logger failed'));

		expect(() => escalateRecoverySession(socket, socket, false, { retire, forceReconnect, report })).not.to.throw();
		expect(retire.callCount).to.equal(2);
		expect(forceReconnect.calledOnce).to.equal(true);
	});
});

describe('normalizeWebSocketCloseReason', () => {
	it('keeps valid reasons and truncates on a UTF-8 code-point boundary', () => {
		expect(normalizeWebSocketCloseReason('a'.repeat(123))).to.equal('a'.repeat(123));
		const normalized = normalizeWebSocketCloseReason('a'.repeat(120) + '💥tail');
		expect(normalized).to.equal('a'.repeat(120) + '...');
		expect(Buffer.byteLength(normalized)).to.equal(123);
		expect(normalized).not.to.include('�');
	});

	it('uses a safe fixed reason when string conversion throws', () => {
		const reason = {
			toString() {
				throw new Error('no string');
			},
		};
		expect(normalizeWebSocketCloseReason(reason)).to.equal('Replication connection error');
	});

	it('produces a reason accepted and delivered by ws', async () => {
		const server = new WebSocketServer({ port: 0 });
		await new Promise((resolve) => server.once('listening', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('expected a TCP address');
		const peerClose = new Promise((resolve) =>
			server.once('connection', (peer) => peer.once('close', (_code, reason) => resolve(reason.toString())))
		);
		const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		await new Promise((resolve) => client.once('open', resolve));
		const normalized = normalizeWebSocketCloseReason('a'.repeat(120) + '💥tail');
		client.close(1011, normalized);
		expect(await peerClose).to.equal(normalized);
		await new Promise((resolve) => server.close(resolve));
	});

	it('pins ws leaving an overlong first close in CLOSING', async () => {
		const server = new WebSocketServer({ port: 0 });
		await new Promise((resolve) => server.once('listening', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('expected a TCP address');
		server.once('connection', () => {});
		const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		await new Promise((resolve) => client.once('open', resolve));
		expect(() => client.close(1011, 'a'.repeat(124))).to.throw(RangeError);
		expect(client.readyState).to.equal(WebSocket.CLOSING);
		client.terminate();
		await new Promise((resolve) => server.close(resolve));
	});
});
