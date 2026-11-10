import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	ClosedLoopRun,
	OpenLoopRun,
	createHttpExecutor,
	loadRange,
	makeOpFactory,
	runLoadWorkers,
	runPhaseWorkers,
	type ExecResult,
	type Op,
	type PhaseStats,
} from './loadgen.mts';

const readOp = (): Op => ({ type: 'read', method: 'GET', path: '/t/k' });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function controlledExecutor() {
	const pending: Array<(result: ExecResult) => void> = [];
	return {
		pending,
		execute: () => new Promise<ExecResult>((resolve) => pending.push(resolve)),
	};
}

function totals(phases: Record<string, PhaseStats>) {
	let scheduled = 0;
	let accounted = 0;
	for (const stats of Object.values(phases)) {
		scheduled += stats.scheduled;
		accounted += stats.ok + stats.errors + stats.timeouts + stats.shed;
	}
	return { scheduled, accounted };
}

describe('OpenLoopRun', () => {
	it('issues requests on schedule and measures latency from the intended send time', async () => {
		let t = 1000;
		const executor = controlledExecutor();
		const run = new OpenLoopRun({
			ratePerSec: 1000,
			phases: [
				{ name: 'warmup', seconds: 0.005 },
				{ name: 'measure', seconds: 0.005 },
			],
			inFlightCap: 100,
			startMs: 1000,
			now: () => t,
			nextOp: readOp,
			execute: executor.execute,
		});
		assert.equal(run.tick(), 1);
		assert.equal(executor.pending.length, 1);
		t = 1009.5;
		assert.equal(run.tick(), -1);
		assert.equal(executor.pending.length, 10);
		t = 1012;
		executor.pending[0]({ outcome: 'ok' });
		executor.pending[7]({ outcome: 'ok' });
		executor.pending[8]({ outcome: 'error', detail: 'GET /t/k -> 500' });
		executor.pending[9]({ outcome: 'timeout' });
		for (const i of [1, 2, 3, 4, 5, 6]) executor.pending[i]({ outcome: 'ok' });
		await flush();
		await run.drain();
		const { warmup, measure } = run.result();
		assert.equal(warmup.scheduled, 5);
		assert.equal(measure.scheduled, 5);
		assert.equal(warmup.ok, 5);
		assert.equal(measure.ok, 3);
		assert.equal(measure.errors, 1);
		assert.equal(measure.timeouts, 1);
		assert.deepEqual(measure.errorSamples, ['GET /t/k -> 500']);
		// request 0 was due at 1000 and completed at 1012
		assert.equal(warmup.latency.maxMicros, 12_000);
		// request 5, due at 1005, was sent at 1009.5
		assert.equal(measure.lag.maxMicros, 4500);
		assert.deepEqual(totals(run.result()), { scheduled: 10, accounted: 10 });
	});

	it('sheds requests due while the in-flight cap is reached, and still accounts for all of them', async () => {
		let t = 0;
		const executor = controlledExecutor();
		const run = new OpenLoopRun({
			ratePerSec: 1000,
			phases: [{ name: 'measure', seconds: 0.02 }],
			inFlightCap: 3,
			startMs: 0,
			now: () => t,
			nextOp: readOp,
			execute: executor.execute,
		});
		t = 25;
		run.tick();
		assert.equal(executor.pending.length, 3);
		assert.equal(run.outstanding, 3);
		for (const resolve of executor.pending) resolve({ outcome: 'ok' });
		await run.drain();
		const { measure } = run.result();
		assert.equal(measure.scheduled, 20);
		assert.equal(measure.shed, 17);
		assert.equal(measure.ok, 3);
	});

	it('turns an executor rejection into an error instead of losing the request', async () => {
		const run = new OpenLoopRun({
			ratePerSec: 1000,
			phases: [{ name: 'measure', seconds: 0.002 }],
			inFlightCap: 10,
			startMs: 0,
			now: () => 5,
			nextOp: readOp,
			execute: () => {
				throw new Error('boom');
			},
		});
		run.tick();
		await run.drain();
		assert.equal(run.result().measure.errors, 2);
	});

	it('rejects a non-positive rate', () => {
		assert.throws(
			() =>
				new OpenLoopRun({
					ratePerSec: 0,
					phases: [],
					inFlightCap: 1,
					startMs: 0,
					now: () => 0,
					nextOp: readOp,
					execute: async () => ({ outcome: 'ok' }),
				}),
			RangeError
		);
	});
});

describe('ClosedLoopRun', () => {
	it('keeps `concurrency` requests in flight and attributes completions to phases', async () => {
		let t = 0;
		const run = new ClosedLoopRun({
			concurrency: 2,
			phases: [
				{ name: 'warmup', seconds: 0.01 },
				{ name: 'measure', seconds: 0.01 },
			],
			startMs: 0,
			now: () => t,
			nextOp: readOp,
			execute: async () => {
				t += 0.5;
				return { outcome: 'ok' };
			},
		});
		const { warmup, measure } = await run.run();
		assert.ok(warmup.ok > 0 && measure.ok > 0);
		// 40 requests fit in 20 ms; the ones completing exactly at the end fall outside every phase
		assert.ok(warmup.ok + measure.ok >= 38 && warmup.ok + measure.ok <= 40, `${warmup.ok + measure.ok}`);
		assert.equal(warmup.errors + measure.errors, 0);
	});
});

describe('loadRange', () => {
	it('retries failures and counts what never succeeds', async () => {
		const attempts = new Map<number, number>();
		const result = await loadRange({
			low: 0,
			high: 20,
			concurrency: 4,
			retries: 1,
			makeOp: (index) => ({ type: 'update', method: 'PUT', path: `/t/${index}` }),
			execute: async (op) => {
				const index = Number(op.path.split('/')[2]);
				const count = (attempts.get(index) ?? 0) + 1;
				attempts.set(index, count);
				if (index === 13) return { outcome: 'error', detail: 'always' };
				return count === 1 && index % 5 === 0 ? { outcome: 'timeout' } : { outcome: 'ok' };
			},
		});
		assert.equal(result.ok, 19);
		assert.equal(result.failed, 1);
		assert.deepEqual(result.errorSamples, ['always']);
		assert.equal(attempts.get(5), 2);
	});
});

describe('makeOpFactory', () => {
	const spec = {
		skew: 'zipf-1',
		keyCount: 1000,
		keyWidth: 4,
		shape: { fieldCount: 10, fieldLength: 100 },
		table: 'usertable',
	};

	it('issues only reads for workload C', () => {
		const next = makeOpFactory({ ...spec, workload: 'C' }, 1);
		for (let i = 0; i < 1000; i++) {
			const op = next();
			assert.equal(op.method, 'GET');
			assert.match(op.path, /^\/usertable\/user\d{4}$/);
		}
	});

	it('issues about 5% full-record updates for workload B', () => {
		const next = makeOpFactory({ ...spec, workload: 'B' }, 2);
		let updates = 0;
		for (let i = 0; i < 20_000; i++) {
			const op = next();
			if (op.type === 'update') {
				updates++;
				const record = JSON.parse(op.body!.toString());
				assert.equal(Object.keys(record).length, 10);
				assert.equal(record.field9.length, 100);
			}
		}
		assert.ok(updates > 800 && updates < 1200, `${updates} updates`);
	});

	it('refuses workloads with operations it cannot issue', () => {
		assert.throws(() => makeOpFactory({ ...spec, workload: 'E' }, 1), /only read\/update/);
	});
});

describe('workers over HTTP', () => {
	let server: http.Server;
	let baseUrl: string;
	const puts = new Set<string>();

	before(async () => {
		server = http.createServer((req, res) => {
			if (req.url === '/usertable/hang') return;
			if (req.method === 'PUT') puts.add(req.url!);
			req.resume();
			req.on('end', () => {
				res.writeHead(req.headers.authorization === 'Basic test' ? 200 : 401);
				res.end('{}');
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(() => {
		server.closeAllConnections();
		server.close();
	});

	const op = {
		workload: 'B',
		skew: 'uniform',
		keyCount: 500,
		keyWidth: 3,
		shape: { fieldCount: 2, fieldLength: 30 },
		table: 'usertable',
	};

	it('runs an open-loop schedule in worker threads and sums their phases', async () => {
		const target = { baseUrl, authorization: 'Basic test', maxSockets: 50, timeoutMs: 2000 };
		// Generous lead time: a worker thread that starts after startMs sends its overdue requests at once.
		const startMs = Date.now() + 2000;
		const phases = [
			{ name: 'warmup', seconds: 0.2 },
			{ name: 'measure', seconds: 0.4 },
		];
		const { phases: result, usage } = await runPhaseWorkers(target, [
			{ mode: 'open', ratePerSec: 250, inFlightCap: 200, phases, startMs, op, seed: 1 },
			{ mode: 'open', ratePerSec: 250, inFlightCap: 200, phases, startMs, op, seed: 2 },
		]);
		assert.equal(result.warmup.scheduled, 100);
		assert.equal(result.measure.scheduled, 200);
		assert.equal(result.measure.ok, 200);
		assert.equal(result.measure.latency.count, 200);
		assert.ok(usage.cpuCount > 0);
	});

	it('loads every key of a range', async () => {
		puts.clear();
		const target = { baseUrl, authorization: 'Basic test', maxSockets: 8, timeoutMs: 2000 };
		const result = await runLoadWorkers(target, [
			{ mode: 'load', concurrency: 4, low: 0, high: 60, op },
			{ mode: 'load', concurrency: 4, low: 60, high: 120, op },
		]);
		assert.deepEqual(result, { ok: 120, failed: 0, errorSamples: [] });
		assert.equal(puts.size, 120);
		assert.ok(puts.has('/usertable/user119'));
	});

	it('terminates the other workers when one fails, so none keeps sending', async () => {
		let requests = 0;
		const counting = http.createServer((req, res) => {
			requests++;
			req.resume();
			req.on('end', () => res.end('{}'));
		});
		await new Promise<void>((resolve) => counting.listen(0, '127.0.0.1', resolve));
		const target = {
			baseUrl: `http://127.0.0.1:${(counting.address() as AddressInfo).port}`,
			authorization: 'Basic test',
			maxSockets: 8,
			timeoutMs: 2000,
		};
		const phases = [{ name: 'measure', seconds: 30 }];
		const started = Date.now();
		await assert.rejects(
			runPhaseWorkers(target, [
				{ mode: 'open', ratePerSec: 200, inFlightCap: 8, phases, startMs: Date.now(), op, seed: 1 },
				{
					mode: 'open',
					ratePerSec: 200,
					inFlightCap: 8,
					phases,
					startMs: Date.now(),
					op: { ...op, workload: 'nope' },
					seed: 2,
				},
			]),
			/unknown workload nope/
		);
		assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
		const afterRejection = requests;
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(requests, afterRejection);
		counting.closeAllConnections();
		counting.close();
	});

	it('times a hung request out at its deadline and reports a non-2xx status as an error', async () => {
		const { execute, close } = createHttpExecutor({
			baseUrl,
			authorization: 'Basic test',
			maxSockets: 2,
			timeoutMs: 200,
		});
		const started = Date.now();
		const hung = await execute({ type: 'read', method: 'GET', path: '/usertable/hang' });
		assert.equal(hung.outcome, 'timeout');
		assert.ok(Date.now() - started < 1000);
		close();
		const unauthorized = createHttpExecutor({ baseUrl, authorization: 'Basic nope', maxSockets: 2, timeoutMs: 1000 });
		const denied = await unauthorized.execute({ type: 'read', method: 'GET', path: '/usertable/user001' });
		assert.equal(denied.outcome, 'error');
		assert.match(denied.detail!, /401/);
		unauthorized.close();
	});
});
