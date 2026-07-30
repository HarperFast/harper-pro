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
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Read the current process's cgroup v2 memory breakdown. Because the stress
 * tests run inside the CI job container, this reflects the WHOLE container
 * (all Harper nodes + the test runner) — i.e. exactly what the container's
 * memory.max / OOM killer sees. Returns bytes split into anon (genuine,
 * unreclaimable) vs file (reclaimable page cache) vs fileDirty (pending
 * writeback — the vm.dirty_ratio concern), or null when cgroup v2 is absent
 * (non-Linux dev runs). Sampling from inside the container is reliable even
 * when the host is swap-thrashing, unlike host-side cgroup polling.
 */
export function readCgroupMem() {
	try {
		const current = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
		const stat = readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
		const field = (name) => {
			const m = stat.match(new RegExp(`^${name} (\\d+)`, 'm'));
			return m ? Number(m[1]) : 0;
		};
		return { current, anon: field('anon'), file: field('file'), fileDirty: field('file_dirty') };
	} catch {
		return null;
	}
}

/**
 * Read the counters that expose *host* pressure from inside the job container.
 * `/proc/stat`, `/proc/diskstats`, `/proc/loadavg`, `/proc/pressure/*` and
 * `/proc/meminfo` are not namespaced by Docker, so a container reads the whole
 * machine through them — which is exactly the signal cgroup memory stats cannot
 * see. Without this, a stress run that was slow because a neighbouring workload
 * saturated the box is indistinguishable from a genuine replication regression.
 * Returns null for any source the platform lacks (PSI is kernel-config gated,
 * and none of it exists off Linux).
 */
export function readHostCounters() {
	const readOrNull = (path) => {
		try {
			return readFileSync(path, 'utf8');
		} catch {
			return null;
		}
	};
	const stat = readOrNull('/proc/stat');
	const loadavg = readOrNull('/proc/loadavg');
	if (!stat || !loadavg) return null;

	// cpu aggregate line: user nice system idle iowait irq softirq steal ...
	const cpu =
		stat
			.match(/^cpu\s+(.*)$/m)?.[1]
			.trim()
			.split(/\s+/)
			.map(Number) ?? [];
	const [, , , idle = 0, iowait = 0, , , steal = 0] = cpu;
	const cpuTotal = cpu.reduce((sum, v) => sum + v, 0);

	// Sum every whole block device (skip partitions/loopbacks/dm) so one line
	// covers whatever the runner's storage happens to be called.
	let readSectors = 0;
	let writeSectors = 0;
	for (const line of (readOrNull('/proc/diskstats') ?? '').split('\n')) {
		const f = line.trim().split(/\s+/);
		if (f.length < 10) continue;
		const name = f[2];
		if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+)$/.test(name)) continue;
		readSectors += Number(f[5]);
		writeSectors += Number(f[9]);
	}

	// PSI "some" totals are microseconds of stall since boot — the single best
	// contention signal, because it counts time tasks *waited* rather than a rate.
	const psiTotal = (path) => {
		const m = readOrNull(path)?.match(/^some .*total=(\d+)/m);
		return m ? Number(m[1]) : null;
	};

	const memAvailableKb = Number(readOrNull('/proc/meminfo')?.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? 0);

	const [load1, load5] = loadavg.trim().split(/\s+/).map(Number);
	return {
		t: Date.now(),
		load1,
		load5,
		cpuTotal,
		cpuIdle: idle,
		cpuIowait: iowait,
		cpuSteal: steal,
		readSectors,
		writeSectors,
		psiCpu: psiTotal('/proc/pressure/cpu'),
		psiIo: psiTotal('/proc/pressure/io'),
		psiMem: psiTotal('/proc/pressure/memory'),
		memAvailableKb,
	};
}

/**
 * Turn two readHostCounters() readings into rates over the interval between
 * them: CPU time percentages, host block-device MB/s, and PSI stall percentage
 * (share of wall-clock in which at least one task was stalled). Returns null if
 * either reading is missing or the interval is degenerate.
 */
export function hostCounterDelta(before, after) {
	if (!before || !after) return null;
	const elapsedMs = after.t - before.t;
	if (elapsedMs <= 0) return null;
	const cpuTicks = after.cpuTotal - before.cpuTotal;
	const pct = (delta) => (cpuTicks > 0 ? (delta / cpuTicks) * 100 : 0);
	const stallPct = (key) =>
		before[key] == null || after[key] == null ? null : ((after[key] - before[key]) / 1000 / elapsedMs) * 100;
	// diskstats sectors are always 512 bytes regardless of the device's real sector size.
	const mbPerSec = (sectors) => (sectors * 512) / MB / (elapsedMs / 1000);
	return {
		elapsedSecs: elapsedMs / 1000,
		load1: after.load1,
		idlePct: pct(after.cpuIdle - before.cpuIdle),
		iowaitPct: pct(after.cpuIowait - before.cpuIowait),
		stealPct: pct(after.cpuSteal - before.cpuSteal),
		readMBps: mbPerSec(after.readSectors - before.readSectors),
		writeMBps: mbPerSec(after.writeSectors - before.writeSectors),
		psiCpuPct: stallPct('psiCpu'),
		psiIoPct: stallPct('psiIo'),
		psiMemPct: stallPct('psiMem'),
		memAvailableKb: after.memAvailableKb,
	};
}

/**
 * Sample host counters at a fixed interval. Unlike sampleMetrics this needs no
 * Harper node — it reads /proc directly — so it keeps running across node
 * restarts. `window()` returns the rates since the previous window() call (or
 * since start), which is what a poll loop wants to print alongside its progress.
 *
 * `window()` reads its own on-demand sample rather than pushing into `samples` —
 * `samples` is the timer's uniformly-spaced series that summariseHostSamples()
 * walks pairwise to find peaks; interleaving an on-demand reading (called from a
 * poll loop running close to, but not synchronized with, the same interval) can
 * land two entries milliseconds apart, and dividing a real counter delta by that
 * near-zero elapsed time manufactures a spurious peak rate.
 */
export function sampleHostCounters(opts = {}) {
	const interval = opts.intervalMs ?? 5000;
	const first = readHostCounters();
	const samples = first ? [first] : [];
	let windowStart = first;
	const timer = setInterval(() => {
		const sample = readHostCounters();
		if (sample) samples.push(sample);
	}, interval);
	timer.unref?.();
	return {
		samples,
		/** Rates since the previous window() call; null when /proc is unavailable. */
		window() {
			const now = readHostCounters();
			if (!now) return null;
			const delta = hostCounterDelta(windowStart, now);
			windowStart = now;
			return delta;
		},
		stop() {
			clearInterval(timer);
			// Take a final reading so the summary always spans right up to stop(), rather
			// than ending at whenever the last interval happened to land.
			const last = readHostCounters();
			if (last) samples.push(last);
			return samples;
		},
	};
}

/**
 * Summarise host-counter samples over the whole run: rates across the full
 * span, plus the worst individual interval, so a short contention burst that
 * averages away is still visible.
 */
export function summariseHostSamples(samples) {
	if (!samples || samples.length < 2) return null;
	const overall = hostCounterDelta(samples[0], samples[samples.length - 1]);
	if (!overall) return null;
	let peakLoad1 = 0;
	let peakIowaitPct = 0;
	let peakPsiIoPct = 0;
	let peakPsiCpuPct = 0;
	let minMemAvailableKb = Infinity;
	for (let i = 1; i < samples.length; i++) {
		const d = hostCounterDelta(samples[i - 1], samples[i]);
		if (!d) continue;
		if (d.load1 > peakLoad1) peakLoad1 = d.load1;
		if (d.iowaitPct > peakIowaitPct) peakIowaitPct = d.iowaitPct;
		if ((d.psiIoPct ?? 0) > peakPsiIoPct) peakPsiIoPct = d.psiIoPct;
		if ((d.psiCpuPct ?? 0) > peakPsiCpuPct) peakPsiCpuPct = d.psiCpuPct;
		if (d.memAvailableKb < minMemAvailableKb) minMemAvailableKb = d.memAvailableKb;
	}
	return {
		...overall,
		peakLoad1,
		peakIowaitPct,
		peakPsiIoPct,
		peakPsiCpuPct,
		minMemAvailableKb: minMemAvailableKb === Infinity ? 0 : minMemAvailableKb,
		sampleCount: samples.length,
	};
}

/** One-line rendering of a hostCounterDelta/summariseHostSamples result. */
export function formatHostCounters(d) {
	if (!d) return 'host: unavailable';
	const pct = (v) => (v == null ? 'n/a' : v.toFixed(0) + '%');
	return (
		`load=${d.load1.toFixed(2)} iowait=${pct(d.iowaitPct)} steal=${pct(d.stealPct)} ` +
		`psi(cpu/io/mem)=${pct(d.psiCpuPct)}/${pct(d.psiIoPct)}/${pct(d.psiMemPct)} ` +
		`hostIO=${d.readMBps.toFixed(0)}r/${d.writeMBps.toFixed(0)}w MB/s ` +
		`memAvail=${(d.memAvailableKb / 1024).toFixed(0)} MB`
	);
}

/**
 * Persist a stress run's metrics as JSON under HARPER_INTEGRATION_TEST_LOG_DIR —
 * the directory CI uploads as the run's log artifact — so throughput and host
 * pressure can be compared night to night without scraping console output.
 * No-ops when the env var is unset (local runs). Returns the path written.
 */
export function writeStressMetrics(name, metrics) {
	const dir = process.env.HARPER_INTEGRATION_TEST_LOG_DIR;
	if (!dir) return null;
	const path = join(dir, `${name}-metrics.json`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify(metrics, null, 2) + '\n');
		return path;
	} catch {
		return null;
	}
}

/**
 * Remove any previously-written metrics file for `name` before a run starts. Self-hosted
 * runners reuse the same workspace across runs (unlike ephemeral GH-hosted ones), so the
 * fixed path in writeStressMetrics() persists between them: a run that crashes before
 * reaching writeStressMetrics — e.g. during setup, or an early OOM/wedge — would otherwise
 * leave the *previous* run's metrics file in place, and CI uploads it as if it were this
 * run's data. Call this at the start of a suite so an early failure uploads no file rather
 * than a stale one that reads as a fresh success.
 */
export function clearStressMetrics(name) {
	const dir = process.env.HARPER_INTEGRATION_TEST_LOG_DIR;
	if (!dir) return;
	try {
		rmSync(join(dir, `${name}-metrics.json`), { force: true });
	} catch {
		// Best effort — a failure here must never fail the test.
	}
}

/** Append a markdown block to the GitHub Actions job summary, when running under one. */
export function writeJobSummary(markdown) {
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (!path) return;
	try {
		appendFileSync(path, markdown.endsWith('\n') ? markdown : markdown + '\n');
	} catch {
		// A missing/unwritable summary file must never fail the test.
	}
}

export function stressEnabled() {
	return process.env.HARPER_RUN_STRESS_TESTS === '1';
}

/**
 * Send an operations-API request and assert HTTP 200.
 * Mirrors clusterShared.sendOperation; duplicated here to keep stress tests
 * independent of the cluster test surface.
 */
export async function sendOperation(node, operation, { timeoutMs } = {}) {
	const fetchOpts = {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	};
	if (timeoutMs != null) fetchOpts.signal = AbortSignal.timeout(timeoutMs);
	const response = await fetch(node.operationsAPIURL, fetchOpts);
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
				cgroup: readCgroupMem(),
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
	if (samples.length === 0)
		return {
			peakRss: 0,
			avgRss: 0,
			peakThreadFootprint: 0,
			peakCgroupCurrent: 0,
			peakCgroupAnon: 0,
			peakCgroupFile: 0,
			peakCgroupDirty: 0,
			sampleCount: 0,
		};
	let peakRss = 0;
	let sumRss = 0;
	let peakThreadFootprint = 0;
	let peakCgroupCurrent = 0;
	let peakCgroupAnon = 0;
	let peakCgroupFile = 0;
	let peakCgroupDirty = 0;
	for (const s of samples) {
		if (s.rss > peakRss) peakRss = s.rss;
		sumRss += s.rss;
		for (const t of s.threads) {
			const f = (t.heapUsed || 0) + (t.externalMemory || 0) + (t.arrayBuffers || 0);
			if (f > peakThreadFootprint) peakThreadFootprint = f;
		}
		if (s.cgroup) {
			if (s.cgroup.current > peakCgroupCurrent) peakCgroupCurrent = s.cgroup.current;
			if (s.cgroup.anon > peakCgroupAnon) peakCgroupAnon = s.cgroup.anon;
			if (s.cgroup.file > peakCgroupFile) peakCgroupFile = s.cgroup.file;
			if (s.cgroup.fileDirty > peakCgroupDirty) peakCgroupDirty = s.cgroup.fileDirty;
		}
	}
	return {
		peakRss,
		avgRss: Math.floor(sumRss / samples.length),
		peakThreadFootprint,
		peakCgroupCurrent,
		peakCgroupAnon,
		peakCgroupFile,
		peakCgroupDirty,
		sampleCount: samples.length,
	};
}

const MB = 1024 * 1024;
export function mb(bytes) {
	return (bytes / MB).toFixed(0) + ' MB';
}

/**
 * Fabric-style RocksDB memory tuning for stress tests, mirroring host-manager's
 * instanceController: block cache = 15% and WriteBufferManager = 5% of a notional
 * per-instance hard limit (default 8 GB — the per-node size the bench container
 * targets). costToCache unifies memtable + cache accounting (the WBM charge shows
 * up in block-cache-usage). The WBM cap is the structural ceiling on total
 * memtable memory across all column families, which the default (no WBM) leaves
 * unbounded — a meaningful source of write-burst anon. Returns a `storage.rocks`
 * config object; all three knobs are env-overridable for ad-hoc tuning.
 */
export function fabricRocksConfig() {
	const hardMb = Number(process.env.HARPER_STRESS_ROCKS_INSTANCE_HARD_MB ?? 8192);
	const blockCacheMb = Number(process.env.HARPER_STRESS_ROCKS_BLOCK_CACHE_MB ?? Math.floor(hardMb * 0.15));
	const wbmMb = Number(process.env.HARPER_STRESS_ROCKS_WBM_MB ?? Math.floor(hardMb * 0.05));
	return {
		blockCacheSize: blockCacheMb * MB,
		writeBufferManagerSize: wbmMb * MB,
		writeBufferManagerCostToCache: true,
	};
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
