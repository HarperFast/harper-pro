import { expect } from 'chai';
import { WebSocket, WebSocketServer } from 'ws';
import { normalizeWebSocketCloseReason } from '#src/replication/replicationConnection';

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
		const peerClose = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timed out waiting for the peer close event')), 5000);
			server.once('connection', (peer) =>
				peer.once('close', (_code, reason) => {
					clearTimeout(timer);
					resolve(reason.toString());
				})
			);
		});
		const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		await new Promise((resolve) => client.once('open', resolve));
		const normalized = normalizeWebSocketCloseReason('a'.repeat(120) + '💥tail');
		client.close(1011, normalized);
		expect(await peerClose).to.equal(normalized);
		await new Promise((resolve) => server.close(resolve));
	});

	it('ws rejects an overlong close reason, which is why callers must normalize it first', async () => {
		const server = new WebSocketServer({ port: 0 });
		await new Promise((resolve) => server.once('listening', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('expected a TCP address');
		server.once('connection', () => {});
		const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		await new Promise((resolve) => client.once('open', resolve));
		expect(() => client.close(1011, 'a'.repeat(124))).to.throw(RangeError);
		client.terminate();
		await new Promise((resolve) => server.close(resolve));
	});
});
