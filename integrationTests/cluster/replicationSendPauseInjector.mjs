/**
 * A `threads.preload` that holds every WebSocket frame a worker sends to one peer while the file
 * `<HARPER_TEST_REPLICATION_PAUSE_DIR>/pause-<peer address>` exists, then sends them in order once it is removed:
 * a link whose frames are delayed without being dropped. Peers are told apart by the socket's remote address,
 * which on loopback is the peer's own address (replication binds `localAddress` to the node name). Frames still
 * held when the socket closes are discarded, as a real network would lose them.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const pauseDir = process.env.HARPER_TEST_REPLICATION_PAUSE_DIR;

if (pauseDir) {
	const send = WebSocket.prototype.send;
	const queues = new WeakMap();
	const peerOf = (socket) => socket._socket?.remoteAddress?.replace(/^::ffff:/, '');
	const paused = (socket) => {
		const peer = peerOf(socket);
		return Boolean(peer) && existsSync(join(pauseDir, `pause-${peer}`));
	};
	const drainWhenResumed = (socket, queue) => {
		const timer = setInterval(() => {
			if (socket.readyState !== WebSocket.OPEN) {
				clearInterval(timer);
				queues.delete(socket);
				return;
			}
			if (paused(socket)) return;
			clearInterval(timer);
			queues.delete(socket);
			for (const [payload, options, callback] of queue) send.call(socket, payload, options, callback);
		}, 20);
		timer.unref();
	};
	WebSocket.prototype.send = function pausableSend(data, options, callback) {
		if (typeof options === 'function') {
			callback = options;
			options = undefined;
		}
		let queue = queues.get(this);
		if (!queue && (this.readyState !== WebSocket.OPEN || !paused(this)))
			return send.call(this, data, options, callback);
		// the replication send loop reuses its encode buffer
		const payload = typeof data === 'string' ? data : Buffer.from(data);
		if (queue) queue.push([payload, options, callback]);
		else {
			queues.set(this, (queue = [[payload, options, callback]]));
			drainWhenResumed(this, queue);
		}
	};
}
