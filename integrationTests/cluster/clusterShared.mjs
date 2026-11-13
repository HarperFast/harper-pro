import { equal } from 'node:assert';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { teardownHarper } from '@harperfast/integration-testing';

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
	const { status, body } = await postOperation(node, operation, options);
	equal(status, 200, JSON.stringify(body));
	return body;
}

export async function postOperation(node, operation, options) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
		signal: options?.signal,
	});
	return { status: response.status, body: await response.json() };
}

/**
 * create_table whose post-condition is only that the table exists — a connected peer's definition
 * may have created it first. Guarantees existence, not that the supplied definition was applied.
 */
export async function ensureTableExists(node, definition, options) {
	const { status, body } = await postOperation(node, { ...definition, operation: 'create_table' }, options);
	if (status === 400 && body?.error === `Table '${definition.table}' already exists in '${definition.database}'`)
		return body;
	equal(status, 200, JSON.stringify(body));
	return body;
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

async function hdbLogPath(node) {
	const { join } = await import('node:path');
	return join(node.logDir || join(node.dataRootDir, 'log'), 'hdb.log');
}

/**
 * Mark the end of a node's hdb.log, for `readLogSince`. Take it before the event under test; an offset only means
 * something in the file it was measured on, and with `HARPER_INTEGRATION_TEST_LOG_DIR` set each start opens a new
 * log directory. Unlike `readLog`, there is no fallback to another directory: the node's own log must exist.
 */
export async function logMark(node) {
	const { readFile } = await import('node:fs/promises');
	const path = await hdbLogPath(node);
	return { path, length: (await readFile(path, 'utf8')).length };
}

/**
 * What the node's current log holds past `mark`. Assumes at most one start since the mark and an append-only log; a
 * missing or shorter log throws, so an assertion that nothing was logged cannot pass without having seen the log.
 */
export async function readLogSince(node, mark) {
	const { readFile } = await import('node:fs/promises');
	const path = await hdbLogPath(node);
	const text = await readFile(path, 'utf8');
	if (path !== mark.path) return text;
	if (text.length < mark.length)
		throw new Error(`${path} is ${text.length} characters, shorter than its mark at ${mark.length}`);
	return text.slice(mark.length);
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
 * @param {Object} node
 * @param {Object} [opts] - see `waitForNewPid`
 * @returns {Promise<number>} the new main-process pid
 */
export async function restartNode(node, opts) {
	const previousPid = await readNodePid(node);
	if (previousPid === undefined) {
		throw new Error(`node ${node.hostname} has no pid file before restart — it is not running`);
	}
	// The response can be lost if the socket closes first; the pid check is what we trust.
	await sendOperation(node, { operation: 'restart' }).catch(() => {});
	return waitForNewPid(node, previousPid, opts);
}

/**
 * Rolling-restart a node's HTTP workers and resolve once the restart job completes.
 *
 * `restart_service` answers as soon as the restart starts. Until its job completes, the old workers keep
 * serving the components they loaded at their own start, so a component copied in just before answers 404.
 * A completed job still leaves an old worker serving where its replacement failed to start.
 *
 * @param {Object} node
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs]
 */
export async function restartHttpWorkers(node, { timeoutMs = 120_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	const { job_id: id } = await sendOperation(
		node,
		{ operation: 'restart_service', service: 'http_workers' },
		{ signal: AbortSignal.timeout(timeoutMs) }
	);
	if (!id) throw new Error(`restart_service on ${node.hostname} returned no job id`);
	let job;
	await waitForCondition(
		async (signal) => {
			// a worker being retired can drop the request
			const [current] = await sendOperation(node, { operation: 'get_job', id }, { signal }).catch((error) => {
				if (signal.aborted) throw error;
				return [];
			});
			job = current ?? job;
			return job?.status === 'COMPLETE' || job?.status === 'ERROR';
		},
		{
			timeoutMs: Math.max(deadline - Date.now(), 1),
			description: () => `the HTTP-worker restart on ${node.hostname} (job ${JSON.stringify(job)})`,
		}
	);
	equal(job.status, 'COMPLETE', `HTTP-worker restart on ${node.hostname}: ${JSON.stringify(job)}`);
}

/**
 * Env that keeps one node's replication off the pool whether the pool comes from `HARPER_CONFIG` or the
 * `threads.count`-derived default (`Math.floor(threads.count / 2)` for `threads.count >= 2`). For a node whose
 * fault injection is application code: pool workers load none, so an injector armed over HTTP never runs on the
 * thread that owns the replication socket.
 *
 * @returns {Object} env entries to pass to startHarper/setupHarperWithFixture (empty only when HARPER_CONFIG already sets `replication.threads: 0`)
 */
export function replicationPoolOffEnv() {
	const shared = process.env.HARPER_CONFIG ? JSON.parse(process.env.HARPER_CONFIG) : undefined;
	if (shared?.replication?.threads === 0) return {};
	return { HARPER_CONFIG: JSON.stringify({ ...shared, replication: { ...shared?.replication, threads: 0 } }) };
}

/**
 * Whether this run's nodes replicate on the `replication` worker pool: `startHarper` passes `--THREADS_COUNT=1`
 * unless `threads.count` is set (keeping the `Math.floor(threads.count / 2)` default at 0), and the pool-on CI
 * legs set `replication.threads` for every node through `HARPER_CONFIG`.
 */
export function replicationPoolActive() {
	const shared = process.env.HARPER_CONFIG ? JSON.parse(process.env.HARPER_CONFIG) : undefined;
	return shared?.replication?.threads > 0;
}

/**
 * `threads` config that preloads workerFaultInjector.mjs on every worker thread, `replication` pool workers
 * included. Its features are armed by env; see that module.
 *
 * @param {Object} [threads] - other `threads` config to keep
 */
export function workerFaultInjectorThreads(threads) {
	return { ...threads, preload: [...(threads?.preload ?? []), join(import.meta.dirname, 'workerFaultInjector.mjs')] };
}

/**
 * Wait until a node's main process is no longer `previousPid` — for a caller that issues `restart`
 * itself because it must act inside the shutdown window (`restartNode` otherwise).
 *
 * The pid file is the authoritative signal: the restart path unlinks it and the new main
 * process writes its own pid back. Callers should still poll for readiness afterwards —
 * the pid appears before the servers are listening.
 *
 * @param {Object} node
 * @param {number} previousPid - `readNodePid(node)` from BEFORE the restart was issued
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=60000]
 * @param {number} [opts.pollMs=250]
 * @returns {Promise<number>} the new main-process pid
 */
export async function waitForNewPid(node, previousPid, { timeoutMs = 60000, pollMs = 250 } = {}) {
	// any pid differs from a missing one, so without this the wait would pass on the old process
	if (!Number.isInteger(previousPid)) {
		throw new TypeError(`waitForNewPid needs the pid ${node.hostname} had before restart, got ${previousPid}`);
	}
	const deadline = Date.now() + timeoutMs;
	let pid;
	while (Date.now() < deadline) {
		await delay(pollMs);
		pid = await readNodePid(node);
		if (pid !== undefined && pid !== previousPid) return pid;
	}
	const state = pid === undefined ? 'no pid file' : `still pid ${previousPid}`;
	throw new Error(`node ${node.hostname} did not restart within ${timeoutMs}ms (${state})`);
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
 * `after()` for a suite that restarts nodes: `stopNodeProcess` then `teardownHarper` on each node.
 * Every step is attempted on every node, and every error is rethrown together rather than logged.
 *
 * @param {Array<Object|undefined>} nodes - unstarted (undefined) entries are skipped
 */
export async function stopAndTeardownNodes(nodes) {
	const failures = [];
	await Promise.all(
		nodes.filter(Boolean).map(async (node) => {
			if (node.dataRootDir) await stopNodeProcess(node).catch((error) => failures.push(error));
			await teardownHarper({ harper: node }).catch((error) => failures.push(error));
		})
	);
	if (failures.length) throw new AggregateError(failures, 'Failed to stop or tear down a Harper node');
}

/**
 * Poll `probe` until it returns a truthy value, and return that value.
 *
 * `probe` is handed an AbortSignal that fires at the deadline, so `timeoutMs` bounds the whole
 * wait rather than only the gaps between polls — a node that accepts the connection but never
 * answers fails the wait instead of outliving it. Any other probe error propagates immediately.
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
	let lastError;
	try {
		while (!signal.aborted) {
			try {
				const result = await probe(signal);
				if (result) return result;
			} catch (error) {
				if (!signal.aborted) throw error;
				lastError = error;
			}
			if (signal.aborted) break;
			await delay(pollMs, undefined, { signal }).catch((error) => {
				if (!signal.aborted) throw error;
			});
		}
	} finally {
		// aborts requests the probe left in flight, not just the deadline timer
		controller.abort();
		clearTimeout(deadline);
	}
	const { description } = opts;
	let what = description ?? 'condition';
	if (typeof description === 'function') {
		// a description that throws must not replace the timeout it was meant to explain
		try {
			what = description();
		} catch (error) {
			what = `condition (description threw: ${error.message})`;
		}
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`, { cause: lastError ?? signal.reason });
}

/**
 * Resolves once `node` has had `peerName`'s answer to a replicated operation (the path `drop_table` and deploys take)
 * on every poll for `stableMs`. A connected replication socket does not prove that path: `add_node` returns before
 * the certificates it exchanged reach the TLS contexts, which every thread on both nodes rebuilds on its own 1.5s
 * debounce, so one answer proves only the threads that served it. `list_releases` is read-only.
 */
export function waitForOperationPath(node, peerName, { timeoutMs = 30000, pollMs = 250, stableMs = 2000 } = {}) {
	let lastAnswer;
	let answeringSince;
	return waitForCondition(
		async (signal) => {
			const { body } = await postOperation(node, { operation: 'list_releases', replicated: true }, { signal }).catch(
				(error) => {
					if (signal.aborted) throw error;
					return { body: { error: error.message } };
				}
			);
			lastAnswer = body;
			const peer = body?.nodes?.find((entry) => entry.node === peerName);
			if (!peer || peer.error || !Array.isArray(peer.components)) {
				answeringSince = undefined;
				return false;
			}
			answeringSince ??= Date.now();
			return Date.now() - answeringSince >= stableMs;
		},
		{
			timeoutMs,
			pollMs,
			description: () =>
				`${node.hostname} to get ${peerName}'s answer to a replicated operation for ${stableMs}ms; last: ${JSON.stringify(lastAnswer)}`,
		}
	);
}

/** A missing directory throws instead of reading as purged. */
export async function logSegments(node, logName, database = 'data') {
	const { readdir } = await import('node:fs/promises');
	const files = await readdir(join(node.dataRootDir, 'database', database, 'transaction_logs', logName));
	return files.filter((file) => file.endsWith('.txnlog'));
}

export function waitForLogPurged(node, logName, { database = 'data', timeoutMs = 180_000 } = {}) {
	let remaining = [];
	return waitForCondition(async () => (remaining = await logSegments(node, logName, database)).length === 0, {
		timeoutMs,
		description: () => `${logName}'s log purged on ${node.hostname} (still holds ${remaining.join(', ')})`,
	});
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
