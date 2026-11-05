/**
 * A `threads.preload` that delays every WebSocket frame a worker sends by a fixed time, standing in for
 * the network between nodes that loopback lacks. Fixed, so frames on one socket stay in order. The
 * payload is copied because the replication send loop reuses its encode buffer.
 */
import { WebSocket } from 'ws';

const latencyMs = Number(process.env.HARPER_TEST_REPLICATION_LATENCY_MS);

if (latencyMs > 0) {
	const send = WebSocket.prototype.send;
	WebSocket.prototype.send = function delayedSend(data, options, callback) {
		const payload = typeof data === 'string' ? data : Buffer.from(data);
		setTimeout(() => {
			if (this.readyState === WebSocket.OPEN) send.call(this, payload, options, callback);
			else (typeof options === 'function' ? options : callback)?.();
		}, latencyMs);
	};
}
