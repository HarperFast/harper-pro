/**
 * A `threads.preload` standing in for a multi-region network on loopback, applied to this node's outbound
 * (subscribing) replication sockets, which are the ones that receive a peer's data:
 * - HARPER_TEST_PEER_LATENCY_MS: JSON `{ host: ms }`; pings to and messages from that host are delayed by ms, so the
 *   link's measured latency and its delivery both carry it. Fixed per socket, so order is kept.
 * - HARPER_TEST_INGRESS_FILE: bytes and messages received per sending host, written as JSON to `<file>.<threadId>`.
 * - HARPER_TEST_PARTITION_FILE: a JSON array of hosts this node cannot reach, re-read every 200 ms; sockets to them
 *   are closed and new ones are closed as they open, leaving every other link up.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { WebSocket } from 'ws';

const latencyByHost = JSON.parse(process.env.HARPER_TEST_PEER_LATENCY_MS || '{}');
const ingressFile = process.env.HARPER_TEST_INGRESS_FILE;
const partitionFile = process.env.HARPER_TEST_PARTITION_FILE;

const ingress = {};
const openSockets = new Set();
let blocked = new Set();

function hostOf(socket) {
	try {
		return socket._isServer ? undefined : new URL(socket.url).hostname;
	} catch {
		return undefined;
	}
}

function byteLength(data) {
	if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
	return data?.byteLength ?? data?.length ?? 0;
}

const { emit, ping } = WebSocket.prototype;

WebSocket.prototype.emit = function regionEmit(event, ...args) {
	const host = hostOf(this);
	if (host === undefined) return emit.call(this, event, ...args);
	if (event === 'open') {
		if (blocked.has(host)) {
			this.terminate();
			return true;
		}
		openSockets.add(this);
	} else if (event === 'close') {
		openSockets.delete(this);
	} else if (event === 'message') {
		const counts = (ingress[host] ??= { bytes: 0, messages: 0 });
		counts.bytes += byteLength(args[0]);
		counts.messages++;
		const latency = latencyByHost[host];
		if (latency > 0) {
			setTimeout(() => emit.call(this, event, ...args), latency);
			return true;
		}
	}
	return emit.call(this, event, ...args);
};

WebSocket.prototype.ping = function regionPing(...args) {
	const latency = latencyByHost[hostOf(this)];
	if (!(latency > 0)) return ping.apply(this, args);
	setTimeout(() => {
		if (this.readyState === WebSocket.OPEN) ping.apply(this, args);
	}, latency);
};

if (ingressFile) {
	setInterval(() => writeFileSync(`${ingressFile}.${threadId}`, JSON.stringify(ingress)), 250).unref();
}

if (partitionFile) {
	setInterval(() => {
		try {
			blocked = new Set(JSON.parse(readFileSync(partitionFile, 'utf8')));
		} catch {
			blocked = new Set();
		}
		for (const socket of openSockets) {
			if (blocked.has(hostOf(socket))) socket.terminate();
		}
	}, 200).unref();
}
