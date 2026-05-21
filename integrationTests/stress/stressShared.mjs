/**
 * Shared helpers for long-running stress tests in integrationTests/stress/.
 *
 * These tests are *opt-in* via `HARPER_RUN_STRESS_TESTS=1`. Each test file
 * checks this flag and refuses to register a suite when it's missing, so a
 * normal `npm run test:integration` doesn't accidentally fire a 30-minute
 * soak. Set the flag to actually run them.
 */

import { equal } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function stressEnabled() {
	return process.env.HARPER_RUN_STRESS_TESTS === '1';
}

/**
 * Send an operations-API request and assert HTTP 200.
 * Mirrors clusterShared.sendOperation; duplicated here to keep stress tests
 * independent of the cluster test surface.
 */
export async function sendOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	const data = await response.json();
	equal(response.status, 200, JSON.stringify(data));
	return data;
}

/**
 * Like sendOperation but returns `null` on any failure (used during restart
 * windows when the operations API is briefly unreachable).
 */
export async function trySendOperation(node, operation) {
	try {
		const response = await fetch(node.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(operation),
		});
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

/**
 * Like the cluster-test fetchWithRetry but with a default per-attempt timeout
 * so a stalled connection (e.g. to a node mid-kill) can't hang the test.
 */
export function fetchWithRetry(url, options) {
	let retries = options?.retries ?? 20;
	const perAttemptTimeoutMs = options?.timeoutMs ?? 5000;
	const fetchOpts = { ...options, signal: AbortSignal.timeout(perAttemptTimeoutMs) };
	delete fetchOpts.retries;
	delete fetchOpts.timeoutMs;
	let response = fetch(url, fetchOpts);
	if (retries > 0) {
		response = response.catch(() => {
			const nextOpts = { ...options, retries: retries - 1 };
			return delay(500).then(() => fetchWithRetry(url, nextOpts));
		});
	}
	return response;
}

export function concurrent(task, concurrency = 20) {
	const tasks = Array.from({ length: concurrency });
	let i = 0;
	return {
		async execute() {
			i = (i + 1) % concurrency;
			await tasks[i];
			tasks[i] = task();
		},
		finish() {
			return Promise.all(tasks);
		},
	};
}

/**
 * Read a node's `hdb.log`. Checks `ctx.harper.logDir` first (set when
 * `HARPER_INTEGRATION_TEST_LOG_DIR` is in the env), falls back to
 * `{dataRootDir}/log/hdb.log`. Returns '' if neither exists.
 */
export async function readLog(node) {
	const candidates = [];
	if (node.logDir) candidates.push(join(node.logDir, 'hdb.log'));
	if (node.dataRootDir) candidates.push(join(node.dataRootDir, 'log', 'hdb.log'));
	for (const path of candidates) {
		try {
			return await readFile(path, 'utf8');
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
	}
	return '';
}

/**
 * Capture a structured cluster_status snapshot — uniform shape so callers
 * can diff before/after windows without re-parsing nested objects.
 */
export async function clusterSnapshot(node) {
	const status = await sendOperation(node, { operation: 'cluster_status' });
	const peers = [];
	for (const conn of status.connections ?? []) {
		const peer = {
			url: conn.url,
			name: conn.name,
			subscriptions: conn.subscriptions,
			dbs: {},
		};
		for (const s of conn.database_sockets ?? []) {
			peer.dbs[s.database] = {
				connected: s.connected,
				lastReceivedVersion: s.lastReceivedVersion ?? null,
				lastCommitConfirmed: s.lastCommitConfirmed ?? null,
				backPressurePercent: s.backPressurePercent ?? 0,
			};
		}
		peers.push(peer);
	}
	return { node_name: status.node_name, peers };
}

/**
 * Wait until every database socket on `node`'s `cluster_status` reports
 * connected. Returns the final snapshot or throws on timeout.
 */
export async function waitForAllConnected(node, opts = {}) {
	const deadline = Date.now() + (opts.timeoutMs ?? 60000);
	let last;
	while (Date.now() < deadline) {
		last = await clusterSnapshot(node).catch(() => null);
		if (last && last.peers.length > 0 && last.peers.every((p) => Object.values(p.dbs).every((d) => d.connected))) {
			return last;
		}
		await delay(500);
	}
	throw new Error(`waitForAllConnected timed out; final snapshot: ${JSON.stringify(last)}`);
}

/**
 * Poll record counts on a single table until `node` matches `referenceCount`.
 * Returns the final count if it caught up, or throws on timeout.
 */
export async function waitForRecordCount(node, table, referenceCount, opts = {}) {
	const deadline = Date.now() + (opts.timeoutMs ?? 120000);
	let last = -1;
	while (Date.now() < deadline) {
		const resp = await trySendOperation(node, { operation: 'describe_table', table });
		if (resp?.record_count !== undefined) {
			last = resp.record_count;
			if (last >= referenceCount) return last;
		}
		await delay(opts.pollMs ?? 500);
	}
	throw new Error(`waitForRecordCount(${table}) timed out at ${last}, want ${referenceCount}`);
}

/**
 * Sample structured metrics from `system_information` at fixed intervals
 * and return all samples on stop. Captures memory + thread heap stats and
 * the *unique-PID set* per thread role, which is how we detect worker
 * restarts (a new pid in the same role means the previous worker died).
 */
export function sampleMetrics(node, opts = {}) {
	const interval = opts.intervalMs ?? 1000;
	const samples = [];
	let stopped = false;
	let timer;
	const tick = async () => {
		if (stopped) return;
		const info = await trySendOperation(node, {
			operation: 'system_information',
			attributes: ['memory', 'threads', 'metrics'],
		});
		if (info) {
			samples.push({
				t: Date.now(),
				rss: info.memory?.rss ?? 0,
				threads: (info.threads ?? []).map((th) => ({
					threadId: th.threadId ?? 0,
					name: th.name ?? '',
					heapUsed: th.heapUsed ?? 0,
					externalMemory: th.externalMemory ?? 0,
					arrayBuffers: th.arrayBuffers ?? 0,
				})),
			});
		}
		timer = setTimeout(tick, interval);
	};
	timer = setTimeout(tick, interval);
	return {
		samples,
		stop() {
			stopped = true;
			clearTimeout(timer);
			return samples;
		},
	};
}

/**
 * Summarise a samples array (from sampleMetrics) into peak/avg figures.
 */
export function summariseSamples(samples) {
	if (samples.length === 0) return { peakRss: 0, avgRss: 0, peakThreadFootprint: 0, sampleCount: 0 };
	let peakRss = 0;
	let sumRss = 0;
	let peakThreadFootprint = 0;
	for (const s of samples) {
		if (s.rss > peakRss) peakRss = s.rss;
		sumRss += s.rss;
		for (const t of s.threads) {
			const f = (t.heapUsed || 0) + (t.externalMemory || 0) + (t.arrayBuffers || 0);
			if (f > peakThreadFootprint) peakThreadFootprint = f;
		}
	}
	return {
		peakRss,
		avgRss: Math.floor(sumRss / samples.length),
		peakThreadFootprint,
		sampleCount: samples.length,
	};
}

const MB = 1024 * 1024;
export function mb(bytes) {
	return (bytes / MB).toFixed(0) + ' MB';
}

/**
 * Generate a deterministic-but-varied prerender-style record id like
 * "https://example.com/path/<n>|<device>". Mimics the Norton URL+device
 * tuple pattern from the wtk prerender table without depending on a real
 * URL list.
 */
const DEVICES = ['mobile', 'desktop', 'tablet'];
export function prerenderId(seq) {
	const dev = DEVICES[seq % DEVICES.length];
	return `https://example.com/path/${seq}|${dev}`;
}
