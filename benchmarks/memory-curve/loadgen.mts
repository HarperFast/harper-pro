/**
 * Load generation for the memory-curve benchmark, run on the client VM.
 *
 * - Open loop (`OpenLoopRun`): request i is due at start + i / rate whatever the server is doing,
 *   and its latency is measured from that intended time, so server stalls show up as latency
 *   instead of as a slower client (no coordinated omission). A request due while `inFlightCap`
 *   requests are outstanding is shed and counted. Every scheduled request ends as exactly one of
 *   ok / error / timeout / shed, attributed to the phase its intended time falls in.
 * - Closed loop (`ClosedLoopRun`): fixed concurrency, used only to measure the maximum rate.
 * - Bulk load (`loadRange`): PUTs every record of a key range, retrying failures.
 *
 * The runs are driven by worker threads (`runWorkers`); each worker owns one keep-alive HTTP agent,
 * and the main thread sums their phase histograms.
 */
import http from 'node:http';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { WORKLOADS, buildRecord, formatKey, type RecordShape } from '../../core/benchmarks/ycsb/workload.mts';
import { LatencyHistogram, type HistogramJSON } from './histogram.mts';
import { makeKeyIndexChooser, seededUniform } from './keys.mts';

export type OpType = 'read' | 'update';
export type Outcome = 'ok' | 'error' | 'timeout';

export interface Op {
	type: OpType;
	method: 'GET' | 'PUT';
	path: string;
	body?: Buffer;
}

export interface ExecResult {
	outcome: Outcome;
	detail?: string;
}

export type Executor = (op: Op) => Promise<ExecResult>;

/** Runs an executor so that a throw or rejection becomes an `error` outcome. */
function settle(execute: Executor, op: Op): Promise<ExecResult> {
	const failed = (error: unknown): ExecResult => ({
		outcome: 'error',
		detail: `${op.method} ${op.path}: ${String(error)}`,
	});
	try {
		return execute(op).catch(failed);
	} catch (error) {
		return Promise.resolve(failed(error));
	}
}

export interface PhaseSpec {
	name: string;
	seconds: number;
}

const ERROR_SAMPLES = 5;

export class PhaseStats {
	scheduled = 0;
	ok = 0;
	errors = 0;
	timeouts = 0;
	shed = 0;
	readonly latency = new LatencyHistogram();
	readonly lag = new LatencyHistogram();
	readonly byType: Record<OpType, LatencyHistogram> = { read: new LatencyHistogram(), update: new LatencyHistogram() };
	readonly errorSamples: string[] = [];

	recordFailure(result: ExecResult): void {
		if (result.outcome === 'timeout') this.timeouts++;
		else this.errors++;
		if (this.errorSamples.length < ERROR_SAMPLES && result.detail) this.errorSamples.push(result.detail);
	}

	merge(other: PhaseStats): void {
		this.scheduled += other.scheduled;
		this.ok += other.ok;
		this.errors += other.errors;
		this.timeouts += other.timeouts;
		this.shed += other.shed;
		this.latency.merge(other.latency);
		this.lag.merge(other.lag);
		for (const type of ['read', 'update'] as const) this.byType[type].merge(other.byType[type]);
		for (const sample of other.errorSamples)
			if (this.errorSamples.length < ERROR_SAMPLES) this.errorSamples.push(sample);
	}

	toJSON(): PhaseStatsJSON {
		return {
			scheduled: this.scheduled,
			ok: this.ok,
			errors: this.errors,
			timeouts: this.timeouts,
			shed: this.shed,
			latency: this.latency.toJSON(),
			lag: this.lag.toJSON(),
			byType: { read: this.byType.read.toJSON(), update: this.byType.update.toJSON() },
			errorSamples: this.errorSamples,
		};
	}

	static fromJSON(json: PhaseStatsJSON): PhaseStats {
		const stats = new PhaseStats();
		stats.scheduled = json.scheduled;
		stats.ok = json.ok;
		stats.errors = json.errors;
		stats.timeouts = json.timeouts;
		stats.shed = json.shed;
		stats.latency.merge(LatencyHistogram.fromJSON(json.latency));
		stats.lag.merge(LatencyHistogram.fromJSON(json.lag));
		for (const type of ['read', 'update'] as const)
			stats.byType[type].merge(LatencyHistogram.fromJSON(json.byType[type]));
		stats.errorSamples.push(...json.errorSamples);
		return stats;
	}
}

export interface PhaseStatsJSON {
	scheduled: number;
	ok: number;
	errors: number;
	timeouts: number;
	shed: number;
	latency: HistogramJSON;
	lag: HistogramJSON;
	byType: Record<OpType, HistogramJSON>;
	errorSamples: string[];
}

class PhaseClock {
	readonly phases: PhaseSpec[];
	readonly stats: PhaseStats[];
	private readonly ends: number[];

	constructor(phases: PhaseSpec[]) {
		this.phases = phases;
		this.stats = phases.map(() => new PhaseStats());
		let total = 0;
		this.ends = phases.map((phase) => (total += phase.seconds * 1000));
	}

	get totalMs(): number {
		return this.ends.at(-1) ?? 0;
	}

	/** The phase an offset (ms from start) falls in, or undefined past the last phase. */
	at(offsetMs: number): PhaseStats | undefined {
		if (offsetMs < 0) return undefined;
		for (let i = 0; i < this.ends.length; i++) if (offsetMs < this.ends[i]) return this.stats[i];
		return undefined;
	}

	result(): Record<string, PhaseStats> {
		return Object.fromEntries(this.phases.map((phase, i) => [phase.name, this.stats[i]]));
	}
}

export interface OpenLoopOptions {
	ratePerSec: number;
	phases: PhaseSpec[];
	inFlightCap: number;
	startMs: number;
	now: () => number;
	nextOp: () => Op;
	execute: Executor;
}

export class OpenLoopRun {
	private readonly options: OpenLoopOptions;
	private readonly clock: PhaseClock;
	private readonly intervalMs: number;
	private readonly total: number;
	private sent = 0;
	private inFlight = 0;
	private idle: (() => void) | undefined;

	constructor(options: OpenLoopOptions) {
		this.options = options;
		if (!(options.ratePerSec > 0)) throw new RangeError(`open-loop rate must be > 0, got ${options.ratePerSec}`);
		this.clock = new PhaseClock(options.phases);
		this.intervalMs = 1000 / options.ratePerSec;
		this.total = Math.floor((this.clock.totalMs / 1000) * options.ratePerSec);
	}

	get outstanding(): number {
		return this.inFlight;
	}

	/** Issues every request due by now; returns ms until the next one is due, or -1 when all are issued. */
	tick(): number {
		const { startMs, now, inFlightCap, nextOp, execute } = this.options;
		const nowMs = now();
		while (this.sent < this.total) {
			const intended = startMs + this.sent * this.intervalMs;
			if (intended > nowMs) return intended - nowMs;
			this.sent++;
			const phase = this.clock.at(intended - startMs)!;
			phase.scheduled++;
			if (this.inFlight >= inFlightCap) {
				phase.shed++;
				continue;
			}
			const op = nextOp();
			phase.lag.record((nowMs - intended) * 1000);
			this.inFlight++;
			settle(execute, op).then((result) => {
				this.inFlight--;
				if (result.outcome === 'ok') {
					const micros = (now() - intended) * 1000;
					phase.ok++;
					phase.latency.record(micros);
					phase.byType[op.type].record(micros);
				} else {
					phase.recordFailure(result);
				}
				if (this.inFlight === 0 && this.idle) this.idle();
			});
		}
		return -1;
	}

	/** Resolves once nothing is outstanding (each request is bounded by the executor's deadline). */
	drain(): Promise<void> {
		if (this.inFlight === 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.idle = resolve;
		});
	}

	result(): Record<string, PhaseStats> {
		return this.clock.result();
	}

	/** Drives the run on real timers until every request is issued and answered. */
	async run(): Promise<Record<string, PhaseStats>> {
		for (;;) {
			const wait = this.tick();
			if (wait < 0) break;
			await delay(Math.min(Math.max(wait, 0), 50));
		}
		await this.drain();
		return this.result();
	}
}

export interface ClosedLoopOptions {
	concurrency: number;
	phases: PhaseSpec[];
	startMs: number;
	now: () => number;
	nextOp: () => Op;
	execute: Executor;
}

/** Fixed-concurrency run; each completion is attributed to the phase it completes in. */
export class ClosedLoopRun {
	private readonly options: ClosedLoopOptions;
	private readonly clock: PhaseClock;

	constructor(options: ClosedLoopOptions) {
		this.options = options;
		this.clock = new PhaseClock(options.phases);
	}

	async run(): Promise<Record<string, PhaseStats>> {
		const { startMs, now, nextOp, execute, concurrency } = this.options;
		const endMs = startMs + this.clock.totalMs;
		const startDelay = startMs - now();
		if (startDelay > 0) await delay(startDelay);
		const loop = async (): Promise<void> => {
			while (now() < endMs) {
				const op = nextOp();
				const issued = now();
				const result = await settle(execute, op);
				const done = now();
				const phase = this.clock.at(done - startMs);
				if (!phase) break;
				phase.scheduled++;
				if (result.outcome === 'ok') {
					phase.ok++;
					phase.latency.record((done - issued) * 1000);
					phase.byType[op.type].record((done - issued) * 1000);
				} else {
					phase.recordFailure(result);
				}
			}
		};
		await Promise.all(Array.from({ length: concurrency }, loop));
		return this.clock.result();
	}
}

export interface LoadRangeResult {
	ok: number;
	failed: number;
	errorSamples: string[];
}

/** PUTs indices [low, high) with `concurrency` requests in flight, retrying each failure up to `retries` times. */
export async function loadRange(options: {
	low: number;
	high: number;
	concurrency: number;
	retries: number;
	makeOp: (index: number) => Op;
	execute: Executor;
}): Promise<LoadRangeResult> {
	const { low, high, concurrency, retries, makeOp, execute } = options;
	const result: LoadRangeResult = { ok: 0, failed: 0, errorSamples: [] };
	let next = low;
	const loop = async (): Promise<void> => {
		while (next < high) {
			const index = next++;
			for (let attempt = 0; ; attempt++) {
				const outcome = await settle(execute, makeOp(index));
				if (outcome.outcome === 'ok') {
					result.ok++;
					break;
				}
				if (attempt >= retries) {
					result.failed++;
					if (result.errorSamples.length < ERROR_SAMPLES) result.errorSamples.push(outcome.detail ?? outcome.outcome);
					break;
				}
				await delay(100 * 2 ** attempt);
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, loop));
	return result;
}

export interface HttpTarget {
	baseUrl: string;
	authorization: string;
	maxSockets: number;
	timeoutMs: number;
}

/** node:http executor with an absolute per-request deadline; never rejects. */
export function createHttpExecutor(target: HttpTarget): { execute: Executor; close: () => void } {
	const url = new URL(target.baseUrl);
	const agent = new http.Agent({ keepAlive: true, maxSockets: target.maxSockets, maxFreeSockets: target.maxSockets });
	const port = Number(url.port) || 80;
	const execute: Executor = (op) =>
		new Promise((resolve) => {
			let settled = false;
			const finish = (result: ExecResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};
			const headers: Record<string, string> = { authorization: target.authorization };
			if (op.body) {
				headers['content-type'] = 'application/json';
				headers['content-length'] = String(op.body.length);
			}
			const req = http.request(
				{ hostname: url.hostname, port, path: op.path, method: op.method, headers, agent },
				(res) => {
					const status = res.statusCode ?? 0;
					let errorBody = '';
					res.on('data', (chunk: Buffer) => {
						if (status >= 300 && errorBody.length < 200) errorBody += chunk.toString();
					});
					res.on('end', () =>
						finish(
							status >= 200 && status < 300
								? { outcome: 'ok' }
								: { outcome: 'error', detail: `${op.method} ${op.path} -> ${status} ${errorBody.slice(0, 200)}` }
						)
					);
					res.on('error', (error) => finish({ outcome: 'error', detail: `${op.method} ${op.path}: ${error.message}` }));
				}
			);
			const timer = setTimeout(() => {
				finish({ outcome: 'timeout', detail: `${op.method} ${op.path} exceeded ${target.timeoutMs} ms` });
				req.destroy();
			}, target.timeoutMs);
			req.on('error', (error) => finish({ outcome: 'error', detail: `${op.method} ${op.path}: ${error.message}` }));
			req.end(op.body);
		});
	return { execute, close: () => agent.destroy() };
}

export interface OpSpec {
	workload: string;
	skew: string;
	keyCount: number;
	keyWidth: number;
	shape: RecordShape;
	table: string;
}

/** Ops for a YCSB workload mix (reads and updates only) over the loaded key range. */
export function makeOpFactory(spec: OpSpec, seed: number): () => Op {
	const mix = WORKLOADS[spec.workload]?.mix;
	if (!mix) throw new Error(`unknown workload ${spec.workload}`);
	const unsupported = Object.keys(mix).filter((type) => type !== 'read' && type !== 'update');
	if (unsupported.length > 0)
		throw new Error(`workload ${spec.workload} uses ${unsupported.join(', ')}; only read/update are supported`);
	const readShare = (mix.read ?? 0) / ((mix.read ?? 0) + (mix.update ?? 0));
	const random = seededUniform(seed);
	const chooser = makeKeyIndexChooser(spec.skew, spec.keyCount, random);
	return () => {
		const index = chooser.next();
		const path = `/${spec.table}/${formatKey(index, spec.keyWidth)}`;
		if (random() < readShare) return { type: 'read', method: 'GET', path };
		return { type: 'update', method: 'PUT', path, body: recordBody(spec, index) };
	};
}

export function recordBody(spec: Pick<OpSpec, 'shape' | 'keyCount' | 'keyWidth'>, index: number): Buffer {
	return Buffer.from(
		JSON.stringify(buildRecord(spec.shape, { index, keyCount: spec.keyCount, keyWidth: spec.keyWidth }))
	);
}

export type WorkerTask =
	| {
			mode: 'open';
			ratePerSec: number;
			inFlightCap: number;
			phases: PhaseSpec[];
			startMs: number;
			op: OpSpec;
			seed: number;
	  }
	| { mode: 'closed'; concurrency: number; phases: PhaseSpec[]; startMs: number; op: OpSpec; seed: number }
	| { mode: 'load'; concurrency: number; low: number; high: number; op: OpSpec };

interface WorkerData {
	memoryCurveWorker: true;
	target: HttpTarget;
	task: WorkerTask;
}

type WorkerReply =
	| { kind: 'phases'; phases: Record<string, PhaseStatsJSON> }
	| { kind: 'load'; result: LoadRangeResult }
	| { kind: 'error'; message: string };

const epochNow = (): number => performance.timeOrigin + performance.now();

async function workerMain(data: WorkerData): Promise<WorkerReply> {
	const { execute, close } = createHttpExecutor(data.target);
	try {
		const { task } = data;
		if (task.mode === 'load') {
			const result = await loadRange({
				low: task.low,
				high: task.high,
				concurrency: task.concurrency,
				retries: 5,
				makeOp: (index) => ({
					type: 'update',
					method: 'PUT',
					path: `/${task.op.table}/${formatKey(index, task.op.keyWidth)}`,
					body: recordBody(task.op, index),
				}),
				execute,
			});
			return { kind: 'load', result };
		}
		const nextOp = makeOpFactory(task.op, task.seed);
		const run =
			task.mode === 'open'
				? new OpenLoopRun({ ...task, now: epochNow, nextOp, execute })
				: new ClosedLoopRun({ ...task, now: epochNow, nextOp, execute });
		const phases = await run.run();
		return {
			kind: 'phases',
			phases: Object.fromEntries(Object.entries(phases).map(([name, stats]) => [name, stats.toJSON()])),
		};
	} finally {
		close();
	}
}

if (!isMainThread && (workerData as WorkerData | undefined)?.memoryCurveWorker) {
	workerMain(workerData as WorkerData).then(
		(reply) => parentPort!.postMessage(reply),
		(error: unknown) =>
			parentPort!.postMessage({
				kind: 'error',
				message: String((error as Error)?.stack ?? error),
			} satisfies WorkerReply)
	);
}

/**
 * One worker per task. When any worker fails, the others are terminated and awaited before the
 * failure propagates, so no request generator outlives the group into the next cell.
 */
async function runWorkers(target: HttpTarget, tasks: WorkerTask[]): Promise<WorkerReply[]> {
	const workers: Worker[] = [];
	const runs = tasks.map(
		(task) =>
			new Promise<WorkerReply>((resolve, reject) => {
				const worker = new Worker(new URL(import.meta.url), {
					workerData: { memoryCurveWorker: true, target, task } satisfies WorkerData,
				});
				workers.push(worker);
				let reply: WorkerReply | undefined;
				let failure: unknown;
				worker.once('message', (message: WorkerReply) => {
					reply = message;
				});
				worker.once('error', (error: unknown) => {
					failure = error;
				});
				worker.once('exit', (code) => {
					if (failure !== undefined) reject(failure);
					else if (reply?.kind === 'error') reject(new Error(`load worker failed: ${reply.message}`));
					else if (reply) resolve(reply);
					else reject(new Error(`load worker exited with code ${code} before reporting`));
				});
			})
	);
	let firstFailure: unknown;
	for (const run of runs) {
		run.catch((error: unknown) => {
			firstFailure ??= error;
			for (const worker of workers) void worker.terminate();
		});
	}
	const settled = await Promise.allSettled(runs);
	if (firstFailure !== undefined) throw firstFailure;
	return settled.map((result) => (result as PromiseFulfilledResult<WorkerReply>).value);
}

export interface ClientUsage {
	cpuCores: number;
	cpuCount: number;
}

/** Runs one task per worker and sums their phase statistics; any worker failure fails the run. */
export async function runPhaseWorkers(
	target: HttpTarget,
	tasks: WorkerTask[]
): Promise<{ phases: Record<string, PhaseStats>; usage: ClientUsage }> {
	const cpuBefore = process.cpuUsage();
	const wallBefore = performance.now();
	const replies = await runWorkers(target, tasks);
	const cpu = process.cpuUsage(cpuBefore);
	const phases: Record<string, PhaseStats> = {};
	for (const reply of replies) {
		if (reply.kind !== 'phases') throw new Error(`expected phase statistics, got ${reply.kind}`);
		for (const [name, json] of Object.entries(reply.phases)) {
			(phases[name] ??= new PhaseStats()).merge(PhaseStats.fromJSON(json));
		}
	}
	return {
		phases,
		usage: {
			cpuCores: (cpu.user + cpu.system) / 1000 / (performance.now() - wallBefore),
			cpuCount: availableParallelism(),
		},
	};
}

export async function runLoadWorkers(target: HttpTarget, tasks: WorkerTask[]): Promise<LoadRangeResult> {
	const replies = await runWorkers(target, tasks);
	const total: LoadRangeResult = { ok: 0, failed: 0, errorSamples: [] };
	for (const reply of replies) {
		if (reply.kind !== 'load') throw new Error(`expected a load result, got ${reply.kind}`);
		total.ok += reply.result.ok;
		total.failed += reply.result.failed;
		total.errorSamples.push(...reply.result.errorSamples.slice(0, ERROR_SAMPLES - total.errorSamples.length));
	}
	return total;
}
