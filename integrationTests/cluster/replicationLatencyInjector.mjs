/**
 * A `threads.preload` that delays every WebSocket frame a worker sends by a fixed time, standing in for
 * the network between nodes that loopback lacks. Fixed, so frames on one socket stay in order. The
 * payload is copied because the replication send loop reuses its encode buffer. The marker file proves
 * to a test that frames went through this patch, so it cannot silently stop exercising latency.
 */
import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const latencyMs = Number(process.env.HARPER_TEST_REPLICATION_LATENCY_MS);
const markerPath = process.env.HARPER_TEST_REPLICATION_LATENCY_MARKER;

if (latencyMs > 0) {
	const send = WebSocket.prototype.send;
	let marked = false;
	WebSocket.prototype.send = function delayedSend(data, options, callback) {
		if (this.readyState === WebSocket.CONNECTING) return send.call(this, data, options, callback);
		if (!marked && markerPath) {
			marked = true;
			writeFileSync(markerPath, '');
		}
		const payload = typeof data === 'string' ? data : Buffer.from(data);
		setTimeout(() => send.call(this, payload, options, callback), latencyMs);
	};
}
