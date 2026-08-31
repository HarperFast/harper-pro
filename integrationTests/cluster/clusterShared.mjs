import { equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Send an operation to a Harper node and validate the response
 * @param {Object} node - The Harper node instance
 * @param {Object} operation - The operation to send
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - aborts the request; pass `waitForCondition`'s signal so a
 * node that accepts the connection and never answers cannot outlive the wait's deadline
 * @returns {Promise<Object>} The response data
 */
export async function sendOperation(node, operation, options) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
		signal: options?.signal,
	});
	const responseData = await response.json();
	equal(response.status, 200, JSON.stringify(responseData));
	return responseData;
}

/**
 * Fetch a URL with automatic retry logic
 * @param {string} url - The URL to fetch
 * @param {Object} [options] - Fetch options
 * @param {number} [options.retries=20] - Number of retries
 * @returns {Promise<Response>} The fetch response
 */
export function fetchWithRetry(url, options) {
	let retries = options?.retries ?? 20;
	let response = fetch(url, options);
	if (retries > 0) {
		response = response.catch(() => {
			options ??= {};
			options.retries = retries - 1;
			return delay(500).then(() => fetchWithRetry(url, options));
		});
	}
	return response;
}

/**
 * Execute tasks concurrently with a concurrency limit
 * @param {Function} task - The task to execute
 * @param {number} [concurrency=100] - Maximum number of concurrent tasks
 * @returns {Object} Object with execute and finish methods
 */
export function concurrent(task, concurrency = 20) {
	let tasks = new Array(concurrency);
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
 * Read the hdb.log file for a given Harper node.
 *
 * When the integration-testing harness is configured with
 * `HARPER_INTEGRATION_TEST_LOG_DIR` (as it is in CI), Harper's `logging.root` is
 * redirected to a per-suite directory exposed on `ctx.harper.logDir` rather than
 * `{dataRootDir}/log`. We check both so the helper works locally and in CI.
 *
 * Reads the full file each time — fine for short replays, callers needing only
 * recent lines can filter by timestamp themselves.
 */
export async function readLog(node) {
	const { readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
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
 * Read the pid of a node's main Harper process from its pid file.
 *
 * Harper writes `{rootPath}/hdb.pid` from the main process only (bin/run.ts), and the
 * integration harness always starts nodes with `--ROOTPATH={dataRootDir}`, so this is the
 * node's process identity. Returns `undefined` while the file is absent — the restart path
 * unlinks it before relaunching.
 *
 * @param {Object} node
 * @returns {Promise<number|undefined>}
 */
export async function readNodePid(node) {
	const { readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	if (!node.dataRootDir) throw new Error('node has no dataRootDir; cannot locate its pid file');
	let contents;
	try {
		contents = await readFile(join(node.dataRootDir, 'hdb.pid'), 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') return undefined;
		throw err;
	}
	const pid = Number.parseInt(contents.trim(), 10);
	return Number.isInteger(pid) ? pid : undefined;
}

/**
 * Issue a `restart` operation and wait until the node is genuinely a NEW process.
 *
 * `restart` responds immediately and then tears the node down on a timer, so the main
 * thread keeps answering the operations socket for a moment afterwards. A test that only
 * polls for health after issuing a restart is therefore answered by the OUTGOING process
 * and sails straight through a restart that has not happened yet — which both makes the
 * test vacuous (no cold cache, no reconnect) and lets subsequent writes land in the
 * shutdown window, where they can be acknowledged and then lost.
 *
 * The pid file is the authoritative signal: the restart path unlinks it and the new main
 * process writes its own pid back. Callers should still poll for readiness afterwards —
 * the pid appears before the servers are listening.
 *
 * @param {Object} node
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=60000]
 * @param {number} [opts.pollMs=250]
 * @returns {Promise<number>} the new main-process pid
 */
export async function restartNode(node, { timeoutMs = 60000, pollMs = 250 } = {}) {
	const previousPid = await readNodePid(node);
	if (previousPid === undefined) {
		throw new Error(`node ${node.hostname} has no pid file before restart — it is not running`);
	}
	// The response can be lost if the socket closes first; the pid check below is what we trust.
	await sendOperation(node, { operation: 'restart' }).catch(() => {});
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await delay(pollMs);
		const pid = await readNodePid(node);
		if (pid !== undefined && pid !== previousPid) return pid;
	}
	throw new Error(`node ${node.hostname} did not restart within ${timeoutMs}ms (still pid ${previousPid})`);
}

/**
 * Terminate whichever Harper process a node is running RIGHT NOW, by pid file.
 *
 * `teardownHarper` kills the child handle it spawned, but a node that has been through a
 * `restart` is a different, detached process — the original handle has already exited, so
 * teardown finds nothing to kill and the restarted node survives the suite. Any test that
 * restarts a node must call this before `teardownHarper`, or it leaks a live Harper (and its
 * ports) into the rest of the CI job.
 *
 * @param {Object} node
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=15000]
 */
export async function stopNodeProcess(node, { timeoutMs = 15000 } = {}) {
	const pid = await readNodePid(node);
	if (pid === undefined) return; // no pid file: already stopped
	const isRunning = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		return; // already gone
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isRunning()) return;
		await delay(100);
	}
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		/* raced with its own exit */
	}
}

/**
 * Poll `probe` until it returns a truthy value, and return that value.
 *
 * `probe` is handed an AbortSignal that fires at the deadline, so `timeoutMs` bounds the whole
 * wait rather than only the gaps between polls — a node that accepts the connection but never
 * answers fails the wait instead of outliving it. Any other probe error propagates immediately.
 *
 * There is deliberately no shared "has `receiver` caught up to `source`" predicate: `cluster_status`
 * reports per-(database, peer) *inbound* watermarks, so no pair of them measures the same quantity
 * on two nodes, and the ceiling one link can reach depends on which origin logs that link carries,
 * which no operation reports. Convergence stays with the caller, which knows what it wrote.
 *
 * @param {(signal: AbortSignal) => unknown} probe - truthy return = satisfied
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=120000]
 * @param {number} [opts.pollMs=500]
 * @param {string|(() => string)} [opts.description] - what is being waited for, for the timeout
 * message; a function is called at timeout so it can report the probe's last observation
 * @returns {Promise<*>} the probe's first truthy value
 */
export async function waitForCondition(probe, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? 120000;
	const pollMs = opts.pollMs ?? 500;
	const controller = new AbortController();
	const { signal } = controller;
	const deadline = setTimeout(() => controller.abort(new Error(`deadline of ${timeoutMs}ms reached`)), timeoutMs);
	try {
		while (!signal.aborted) {
			try {
				const result = await probe(signal);
				if (result) return result;
			} catch (error) {
				if (!signal.aborted) throw error;
			}
			if (signal.aborted) break;
			await delay(pollMs, undefined, { signal }).catch(() => {});
		}
	} finally {
		clearTimeout(deadline);
	}
	const { description } = opts;
	const what = typeof description === 'function' ? description() : (description ?? 'condition');
	throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`, { cause: signal.reason });
}

/**
 * Snapshot of memory state on a single node. The shape is stable for tests so we don't
 * depend on `system_information`'s evolving structure: main-process RSS plus the most
 * informative per-thread heap metric. (Per-worker RSS isn't reported individually by
 * Harper; we use heap+external as a proxy for in-flight allocation pressure inside
 * the worker.)
 *
 * @typedef {Object} NodeMemorySnapshot
 * @property {number} t - Date.now() at sample time
 * @property {number} rss - main process resident-set in bytes (process.memoryUsage().rss)
 * @property {Array<{threadId:number,heapUsed:number,externalMemory:number,arrayBuffers:number}>} threads
 */

/**
 * Fetch a single memory snapshot via `system_information`.
 * Returns `null` if the call fails (transient during restart) — callers should treat
 * a few `null`s near a kill/restart as normal.
 *
 * @param {Object} node
 * @returns {Promise<NodeMemorySnapshot|null>}
 */
export async function getMemoryInfo(node) {
	try {
		const info = await sendOperation(node, {
			operation: 'system_information',
			attributes: ['memory', 'threads'],
		});
		const threads = (info.threads ?? []).map((t) => ({
			threadId: t.threadId ?? 0,
			heapUsed: t.heapUsed ?? 0,
			externalMemory: t.externalMemory ?? 0,
			arrayBuffers: t.arrayBuffers ?? 0,
		}));
		// system_information.memory contains the spread of process.memoryUsage() on the
		// main thread — `rss` is the field we care about for total footprint.
		const rss = info.memory?.rss ?? 0;
		return { t: Date.now(), rss, threads };
	} catch {
		return null;
	}
}

/**
 * Compute peak resident-set and peak per-worker heap+external across a series of
 * snapshots, ignoring `null` entries (returned when sampling races a restart).
 */
export function peakMemory(samples) {
	let peakRss = 0;
	let peakWorkerHeapExt = 0;
	for (const s of samples) {
		if (!s) continue;
		if (s.rss > peakRss) peakRss = s.rss;
		for (const t of s.threads) {
			const used = (t.heapUsed || 0) + (t.externalMemory || 0) + (t.arrayBuffers || 0);
			if (used > peakWorkerHeapExt) peakWorkerHeapExt = used;
		}
	}
	return { peakRss, peakWorkerHeapExt };
}
