/**
 * Runs one VM pair's share of the matrix on the client VM:
 *   fio on the data disk → load records → wait for compaction → snapshot the data directory
 *   → per (workload, skew): closed-loop maximum, unconstrained → per cell: open-loop at
 *   rateFraction × that maximum, under the cell's memory policy.
 * Every calibration and cell starts from the post-load snapshot with the page cache dropped, so
 * workload B's updates and earlier cells never change what a later cell reads. Results are one JSON
 * file per cell; a rerun skips files that exist, so a restarted orchestrator resumes.
 *
 *   node orchestrate.mts --plan plan.json --out results/
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile, appendFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
	blockCacheCounters,
	blockCacheWindow,
	parseServerSnapshot,
	windowMetrics,
	type BlockCacheCounters,
	type ServerSnapshot,
} from './counters.mts';
import { summarize } from './histogram.mts';
import {
	runLoadWorkers,
	runPhaseWorkers,
	type HttpTarget,
	type OpSpec,
	type PhaseStats,
	type WorkerTask,
} from './loadgen.mts';
import type { CellPlan, MemoryPolicy, PairPlan } from './matrix.mts';

export interface OrchestratorPlan {
	runId: string;
	harperCommit: string;
	pair: PairPlan;
	server: { host: string; user: string; sshKey: string };
	adminPassword: string;
	client: {
		workers: number;
		inFlightCapPerWorker: number;
		requestTimeoutMs: number;
		calibrationConcurrency: number;
		loadConcurrency: number;
	};
}

export const CELL_SCHEMA = 'memory-curve-cell/1';
export const CALIBRATION_SCHEMA = 'memory-curve-calibration/1';

/** Fraction of scheduled requests that may be shed or time out before a cell counts as saturated. */
const SATURATION_LOSS = 0.001;
/** How far the server counter window may sit from the client's measured window. */
const SCHEDULE_TOLERANCE_SEC = 15;

export function phaseSummary(stats: PhaseStats, seconds: number) {
	const failedOrShed = stats.shed + stats.timeouts;
	return {
		...stats.toJSON(),
		seconds,
		okPerSec: stats.ok / seconds,
		lossFraction: stats.scheduled === 0 ? 0 : failedOrShed / stats.scheduled,
		latencySummary: summarize(stats.latency),
		lagSummary: summarize(stats.lag),
	};
}

class Orchestrator {
	readonly plan: OrchestratorPlan;
	readonly out: string;
	readonly target: HttpTarget;
	readonly opBase: Omit<OpSpec, 'workload' | 'skew'>;
	readonly workers: number;

	constructor(plan: OrchestratorPlan, out: string) {
		this.plan = plan;
		this.out = out;
		const { pair, client, adminPassword, server } = plan;
		// 0 means one worker per vCPU but one, resolved here on the client.
		this.workers = client.workers || availableParallelism() - 1;
		if (!Number.isInteger(this.workers) || this.workers < 1)
			throw new Error(`invalid client worker count ${this.workers}`);
		this.target = {
			baseUrl: `http://${server.host}:9926`,
			authorization: 'Basic ' + Buffer.from(`admin:${adminPassword}`).toString('base64'),
			maxSockets: client.inFlightCapPerWorker,
			timeoutMs: client.requestTimeoutMs,
		};
		this.opBase = {
			keyCount: pair.records,
			keyWidth: pair.keyWidth,
			shape: { fieldCount: pair.fieldCount, fieldLength: pair.fieldLength },
			table: 'usertable',
		};
	}

	async log(message: string): Promise<void> {
		const line = `${new Date().toISOString()} ${message}`;
		console.log(line);
		await appendFile(join(this.out, 'orchestrate.log'), line + '\n');
	}

	async status(state: Record<string, unknown>): Promise<void> {
		await writeJSON(join(this.out, 'status.json'), { ...state, updatedAt: new Date().toISOString() });
	}

	ctl(args: Array<string | number>, timeoutMs = 15 * 60_000): Promise<string> {
		const { host, user, sshKey } = this.plan.server;
		const sshArgs = [
			'-i',
			sshKey,
			'-o',
			'BatchMode=yes',
			'-o',
			'StrictHostKeyChecking=accept-new',
			'-o',
			`UserKnownHostsFile=${join(this.out, 'known_hosts')}`,
			'-o',
			'ConnectTimeout=20',
			'-o',
			'ServerAliveInterval=15',
			`${user}@${host}`,
			'sudo',
			'/opt/memory-curve/server-ctl.sh',
			...args.map(String),
		];
		return new Promise((resolve, reject) => {
			execFile('ssh', sshArgs, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) reject(new Error(`server-ctl ${args[0]} failed: ${error.message}\n${stderr.slice(-2000)}`));
				else resolve(stdout);
			});
		});
	}

	async snapshot(): Promise<ServerSnapshot> {
		return parseServerSnapshot(await this.ctl(['counters'], 60_000));
	}

	async harperMetrics(): Promise<any> {
		return JSON.parse(await this.ctl(['metrics'], 120_000));
	}

	async startHarper(policy: MemoryPolicy): Promise<void> {
		await this.ctl([
			'start',
			policy.memoryMaxBytes ?? 'unlimited',
			policy.memoryHighBytes ?? 'max',
			policy.blockCacheBytes,
			policy.writeBufferManagerBytes,
		]);
	}

	/** Same on-disk state, cold page cache, fresh process under `policy`. */
	async prepare(policy: MemoryPolicy): Promise<void> {
		await this.ctl(['stop']);
		await this.ctl(['restore']);
		await this.ctl(['drop-caches']);
		await this.startHarper(policy);
	}

	async fio(): Promise<void> {
		const file = join(this.out, 'fio.json');
		if (existsSync(file)) return;
		await this.log('fio: measuring the data disk');
		await writeJSON(file, JSON.parse(await this.ctl(['fio'], 30 * 60_000)));
	}

	async load(): Promise<void> {
		const datasetFile = join(this.out, 'dataset.json');
		if ((await this.ctl(['has-snapshot'])).trim() === 'yes' && existsSync(datasetFile)) return;
		const { pair, client } = this.plan;
		await this.log(`load: ${pair.records} records of ${pair.fieldCount} x ${pair.fieldLength} B`);
		await this.ctl(['stop']);
		await this.ctl(['init-root']);
		await this.startHarper(unconstrainedOf(pair));
		const started = Date.now();
		const per = Math.ceil(pair.records / this.workers);
		const tasks: WorkerTask[] = [];
		for (let low = 0; low < pair.records; low += per) {
			tasks.push({
				mode: 'load',
				concurrency: client.loadConcurrency,
				low,
				high: Math.min(pair.records, low + per),
				op: { ...this.opBase, workload: 'C', skew: 'uniform' },
			});
		}
		const result = await runLoadWorkers({ ...this.target, maxSockets: client.loadConcurrency }, tasks);
		const loadSeconds = (Date.now() - started) / 1000;
		if (result.failed > 0)
			throw new Error(`load failed for ${result.failed} records: ${result.errorSamples.join('; ')}`);
		await this.log(`load: ${result.ok} records in ${loadSeconds.toFixed(0)} s; waiting for compaction`);
		const compaction = await this.waitForCompaction();
		await this.ctl(['stop']);
		const sizes = JSON.parse(await this.ctl(['sizes']));
		await this.ctl(['snapshot']);
		await writeJSON(datasetFile, {
			records: pair.records,
			recordShape: { fieldCount: pair.fieldCount, fieldLength: pair.fieldLength },
			loadSeconds,
			loadRecordsPerSec: result.ok / loadSeconds,
			compaction,
			sizes,
			dataBytes: sizes.sstBytes + sizes.blobBytes,
		});
		await this.log(`load: dataset ${JSON.stringify(sizes)}`);
	}

	async waitForCompaction(): Promise<{ seconds: number; settled: boolean }> {
		const started = Date.now();
		let quietPolls = 0;
		while (Date.now() - started < 3 * 3600_000) {
			const metrics = await this.harperMetrics();
			const tables = Object.values(metrics?.metrics?.data?.tables ?? {}) as any[];
			const busy = tables.some(
				(table) =>
					(table.numRunningCompactions ?? 0) > 0 ||
					(table.compactionPending ?? 0) > 0 ||
					(table.estimatePendingCompactionBytes ?? 0) > 0
			);
			quietPolls = busy ? 0 : quietPolls + 1;
			if (quietPolls >= 2) return { seconds: (Date.now() - started) / 1000, settled: true };
			await delay(15_000);
		}
		await this.log('load: compaction still pending after 3 h; snapshotting anyway');
		return { seconds: (Date.now() - started) / 1000, settled: false };
	}

	async calibrate(workload: string, skew: string, policy: MemoryPolicy): Promise<number> {
		const file = join(this.out, 'calibration', `${workload}-${skew}.json`);
		if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8')).maxPerSec;
		const { client, pair } = this.plan;
		const { calibrateWarmupSec, calibrateMeasureSec } = pair.timing;
		await this.log(`calibrate: ${workload} ${skew}`);
		await this.prepare(policy);
		// The maximum is meant with the dataset in memory; a 2-minute warm-up cannot read 24 GB at disk IOPS.
		await this.ctl(['warm-page-cache'], 60 * 60_000);
		try {
			const startMs = Date.now() + 2000;
			const phases = [
				{ name: 'warmup', seconds: calibrateWarmupSec },
				{ name: 'measure', seconds: calibrateMeasureSec },
			];
			const concurrency = Math.ceil(client.calibrationConcurrency / this.workers);
			const tasks: WorkerTask[] = Array.from({ length: this.workers }, (_, i) => ({
				mode: 'closed',
				concurrency,
				phases,
				startMs,
				op: { ...this.opBase, workload, skew },
				seed: 1000 + i,
			}));
			const [server, { phases: result, usage }] = await settleBoth(
				this.windowSnapshots(startMs + calibrateWarmupSec * 1000, calibrateMeasureSec * 1000),
				runPhaseWorkers({ ...this.target, maxSockets: concurrency }, tasks)
			);
			const measure = phaseSummary(result.measure, calibrateMeasureSec);
			if (result.measure.errors > 0) throw new Error(`calibration errors: ${result.measure.errorSamples.join('; ')}`);
			await writeJSON(file, {
				schema: CALIBRATION_SCHEMA,
				runId: this.plan.runId,
				pair: pair.name,
				workload,
				skew,
				policy,
				maxPerSec: measure.okPerSec,
				client: { warmup: phaseSummary(result.warmup, calibrateWarmupSec), measure, usage },
				server,
			});
			await this.log(`calibrate: ${workload} ${skew} max ${measure.okPerSec.toFixed(0)} req/s`);
			return measure.okPerSec;
		} finally {
			await this.ctl(['stop']);
		}
	}

	/**
	 * Block-cache counters come from Harper itself, so a server stalled under memory pressure may not
	 * answer; the kernel counters that show the stall are still recorded, with the cache stats unavailable.
	 */
	async cacheCounters(notes: string[]): Promise<BlockCacheCounters | null> {
		try {
			return blockCacheCounters(await this.harperMetrics(), 'data');
		} catch (error) {
			notes.push(`block-cache counters unavailable: ${(error as Error).message.split('\n')[0]}`);
			return null;
		}
	}

	/** Server counters at the start, middle and end of a window, and block-cache counters at its ends. */
	async windowSnapshots(windowStartMs: number, windowMs: number) {
		const notes: string[] = [];
		await delay(Math.max(0, windowStartMs - Date.now()));
		const [start, cacheStart] = await Promise.all([this.snapshot(), this.cacheCounters(notes)]);
		await delay(Math.max(0, windowStartMs + windowMs / 2 - Date.now()));
		const middle = await this.snapshot();
		await delay(Math.max(0, windowStartMs + windowMs - Date.now()));
		const [end, cacheEnd] = await Promise.all([this.snapshot(), this.cacheCounters(notes)]);
		const window = windowMetrics(start, end);
		const driftSec =
			Math.max(
				Math.abs(start.timeSeconds * 1000 - windowStartMs),
				Math.abs(end.timeSeconds * 1000 - (windowStartMs + windowMs))
			) / 1000;
		if (driftSec > SCHEDULE_TOLERANCE_SEC) {
			window.invalidReasons.push(`server counters taken ${driftSec.toFixed(0)} s off the measured window`);
		}
		return {
			window,
			firstHalf: windowMetrics(start, middle),
			secondHalf: windowMetrics(middle, end),
			blockCache: cacheStart && cacheEnd ? blockCacheWindow(cacheStart, cacheEnd, window.seconds) : null,
			notes,
		};
	}

	async cell(cell: CellPlan, offeredRatePerSec: number, calibrationMaxPerSec: number): Promise<void> {
		const file = join(this.out, 'cells', `${cell.id}.json`);
		if (existsSync(file)) return;
		const { client, pair } = this.plan;
		const { warmupSec, measureSec } = pair.timing;
		const startedAt = new Date().toISOString();
		const base = {
			schema: CELL_SCHEMA,
			runId: this.plan.runId,
			harperCommit: this.plan.harperCommit,
			pair: pair.name,
			cell,
			offeredRatePerSec,
			calibrationMaxPerSec,
			startedAt,
		};
		await this.log(`cell ${cell.id}: ${offeredRatePerSec.toFixed(0)} req/s`);
		try {
			await this.prepare(cell.policy);
			const startMs = Date.now() + 2000;
			const phases = [
				{ name: 'warmup', seconds: warmupSec },
				{ name: 'measure', seconds: measureSec },
			];
			const tasks: WorkerTask[] = Array.from({ length: this.workers }, (_, i) => ({
				mode: 'open',
				ratePerSec: offeredRatePerSec / this.workers,
				inFlightCap: client.inFlightCapPerWorker,
				phases,
				startMs,
				op: { ...this.opBase, workload: cell.workload, skew: cell.skew },
				seed: 1 + i,
			}));
			const [server, { phases: result, usage }] = await settleBoth(
				this.windowSnapshots(startMs + warmupSec * 1000, measureSec * 1000),
				runPhaseWorkers(this.target, tasks)
			);
			const sizes = JSON.parse(await this.ctl(['sizes']));
			const measure = phaseSummary(result.measure, measureSec);
			const invalidReasons = [...server.window.invalidReasons];
			if (result.measure.errors > SATURATION_LOSS * result.measure.scheduled) {
				invalidReasons.push(`${result.measure.errors} request errors: ${result.measure.errorSamples.join('; ')}`);
			}
			const saturated = measure.lossFraction > SATURATION_LOSS || measure.okPerSec < 0.99 * offeredRatePerSec;
			const clientLimited = usage.cpuCores > 0.85 * usage.cpuCount || (measure.lagSummary.p99Ms ?? 0) > 10;
			await writeJSON(file, {
				...base,
				finishedAt: new Date().toISOString(),
				valid: invalidReasons.length === 0,
				invalidReasons,
				saturated,
				clientLimited,
				client: { warmup: phaseSummary(result.warmup, warmupSec), measure, usage },
				server,
				sizes,
			});
			await this.log(
				`cell ${cell.id}: p99 ${measure.latencySummary.p99Ms?.toFixed(2)} ms, ` +
					`${server.window.disk.readsPerSec.toFixed(0)} disk reads/s, loss ${(measure.lossFraction * 100).toFixed(2)}%` +
					(invalidReasons.length ? `, INVALID: ${invalidReasons.join('; ')}` : '')
			);
		} catch (error) {
			// stop saves this container's log tail for `logs`
			await this.ctl(['stop']).catch(() => {});
			const logs = await this.ctl(['logs']).catch(() => '');
			await writeJSON(file, {
				...base,
				finishedAt: new Date().toISOString(),
				valid: false,
				invalidReasons: [`cell failed: ${(error as Error).message}`],
				containerLogTail: logs.slice(-4000),
			});
			await this.log(`cell ${cell.id}: FAILED ${(error as Error).message}`);
		} finally {
			await this.ctl(['stop']).catch(() => {});
		}
	}

	async run(): Promise<void> {
		const { pair } = this.plan;
		const total = pair.calibrations.length + pair.cells.length;
		let done = 0;
		await this.status({ phase: 'fio', done, total });
		await this.fio();
		await this.status({ phase: 'load', done, total });
		await this.load();
		const maxima = new Map<string, number>();
		for (const { workload, skew, policy } of pair.calibrations) {
			await this.status({ phase: 'calibrate', current: `${workload}-${skew}`, done, total });
			maxima.set(`${workload}/${skew}`, await this.calibrate(workload, skew, policy));
			done++;
		}
		for (const cell of pair.cells) {
			await this.status({ phase: 'cells', current: cell.id, done, total });
			const max = maxima.get(`${cell.workload}/${cell.skew}`)!;
			await this.cell(cell, pair.rateFraction * max, max);
			done++;
		}
		await this.status({ phase: 'done', done, total });
	}
}

/** Waits for both, so load workers never outlive a failed counter read into the next cell. */
async function settleBoth<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
	const [first, second] = await Promise.allSettled([a, b]);
	if (first.status === 'rejected') throw first.reason;
	if (second.status === 'rejected') throw second.reason;
	return [first.value, second.value];
}

function unconstrainedOf(pair: PairPlan): MemoryPolicy {
	return pair.calibrations[0].policy;
}

export async function writeJSON(file: string, value: unknown): Promise<void> {
	const temporary = `${file}.tmp`;
	await writeFile(temporary, JSON.stringify(value, null, '\t') + '\n');
	await rename(temporary, file);
}

async function listFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true, recursive: true });
	return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

/** Writes SHA256SUMS over every result file, in `sha256sum -c` format. */
export async function writeChecksums(dir: string): Promise<void> {
	const lines: string[] = [];
	for (const file of (await listFiles(dir)).sort()) {
		const name = relative(dir, file);
		if (name === 'SHA256SUMS' || name === 'DONE' || name === 'FAILED' || name.endsWith('.tmp')) continue;
		lines.push(
			`${createHash('sha256')
				.update(await readFile(file))
				.digest('hex')}  ${name}`
		);
	}
	await writeFile(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n');
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { plan: { type: 'string' }, out: { type: 'string' } } });
	if (!values.plan || !values.out) throw new Error('usage: orchestrate.mts --plan <plan.json> --out <dir>');
	const plan: OrchestratorPlan = JSON.parse(await readFile(values.plan, 'utf8'));
	const out = values.out;
	for (const dir of [out, join(out, 'cells'), join(out, 'calibration')]) await mkdir(dir, { recursive: true });
	const { adminPassword: _secret, ...publicPlan } = plan;
	await writeJSON(join(out, 'plan.json'), publicPlan);
	const orchestrator = new Orchestrator(plan, out);
	try {
		await orchestrator.run();
		await orchestrator.log('done');
		await writeChecksums(out);
		await writeFile(join(out, 'DONE'), new Date().toISOString() + '\n');
	} catch (error) {
		await orchestrator.log(`FAILED: ${(error as Error).stack ?? error}`);
		await orchestrator.status({ phase: 'failed', error: String((error as Error).message ?? error) });
		await writeChecksums(out);
		await writeFile(join(out, 'FAILED'), String((error as Error).stack ?? error) + '\n');
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
