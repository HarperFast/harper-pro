/**
 * Regression guard for the receive-side memory crash that knocked a production node
 * off the cluster in early May. Reproducer: peer A goes offline, A's leader writes
 * thousands of records (in some cases inside a single large transaction → single
 * large WS message), peer A restarts, and decoding the backlog synchronously in
 * `onWSMessage` overruns the 2 GB old-gen limit.
 *
 * Fix landed in harper-pro main as `replication_receiveEventHighWaterMark`: the
 * per-record `do { ... } while (...)` loop now checks the consumer queue length
 * and awaits drain when it exceeds the HWM, pausing the WS in the meantime.
 *
 * This test forces the same backlog shape (big single-message batches via multi-
 * record upserts), restarts the catching-up node, and asserts that:
 *   1. The worker process never restarts during catch-up (no ERR_WORKER_OUT_OF_MEMORY).
 *   2. Peak resident-set stays well under what an unbounded decode would produce.
 *   3. Catch-up actually completes (no progress = no fix, just a no-op).
 *
 * The bound (1.5 GB peak RSS) is intentionally generous; the bug burst past 2 GB
 * inside ~25s and either OOM'd or got killed. Anything under that is "the
 * backpressure is doing something."
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, concurrent, readLog, getMemoryInfo, peakMemory } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const NODE_COUNT = 2;
const BACKLOG_TRANSACTIONS = 40; // each carries a 500-record batch → 20 000 records total
const BATCH_SIZE = 500; // tuned to comfortably exceed RECEIVE_EVENT_HIGH_WATER_MARK = 100

// Heavy multi-node suite — gated out of the regular integration matrix (shard
// contention / 15-min job cap). Runs in the stress workflow, which sets
// HARPER_RUN_STRESS_TESTS=1. `skip` also suppresses the before/after hooks.
const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';

suite('Replication receive-side backlog memory bound', { skip: !STRESS, timeout: 240000 }, (ctx) => {
	before(async () => {
		ctx.nodes = await Promise.all(
			Array(NODE_COUNT)
				.fill(null)
				.map(async () => {
					const nodeCtx = {
						name: ctx.name,
						harper: { hostname: await getNextAvailableLoopbackAddress() },
					};
					await startHarper(nodeCtx, {
						config: {
							analytics: { aggregatePeriod: -1 },
							logging: { colors: false, console: true, level: 'debug' },
							replication: { securePort: nodeCtx.harper.hostname + ':9933' },
						},
						env: { HARPER_NO_FLUSH_ON_EXIT: true },
					});
					return nodeCtx.harper;
				})
		);
		// table on both nodes
		await Promise.all(
			ctx.nodes.map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					table: 'load',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'String' },
						{ name: 'payload', type: 'String' },
					],
				})
			)
		);
		// connect: node 1 adds node 0
		const tokenResp = await sendOperation(ctx.nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: ctx.nodes[0].admin,
		});
		await sendOperation(ctx.nodes[1], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodes[0].hostname,
			authorization: 'Bearer ' + tokenResp.operation_token,
		});
		// Wait for connection — mirror the increasing-delay pattern from
		// replicationLoad.test.mjs so total wait can reach ~20s on a slow runner.
		let connected = false;
		for (let retries = 0; retries < 15; retries++) {
			const responses = await Promise.all(ctx.nodes.map((n) => sendOperation(n, { operation: 'cluster_status' })));
			const allConnected = responses.every(
				(r) =>
					(r.connections ?? []).length === NODE_COUNT - 1 &&
					(r.connections ?? []).every((c) => (c.database_sockets ?? []).every((s) => s.connected))
			);
			if (allConnected) {
				connected = true;
				break;
			}
			await delay(200 * (retries + 1));
		}
		if (!connected) throw new Error('Cluster failed to connect in time');
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n })));
	});

	test('B catches up a multi-thousand-record backlog without OOM or worker restart', async () => {
		const [A, B] = ctx.nodes;

		// Take B offline before generating the backlog. Reusing the original ctx
		// preserves dataRootDir + hostname so the restart resumes against the same DB.
		const nodeCtxB = { name: ctx.name, harper: { dataRootDir: B.dataRootDir, hostname: B.hostname } };
		await killHarper({ harper: B });

		// Build a backlog on A. Each upsert here is a single transaction with BATCH_SIZE
		// records → one WS message carrying 500 audit entries. The pre-fix code path
		// decoded all 500 synchronously inside `onWSMessage`; the fix yields after the
		// consumer queue exceeds RECEIVE_EVENT_HIGH_WATER_MARK (100).
		const payloadStr = 'x'.repeat(256);
		let written = 0;
		const { execute, finish } = concurrent(async () => {
			const id = written;
			written += BATCH_SIZE;
			const records = [];
			for (let i = 0; i < BATCH_SIZE; i++) records.push({ id: `r${id + i}`, payload: payloadStr });
			await sendOperation(A, { operation: 'upsert', table: 'load', records });
		}, 4);
		for (let i = 0; i < BACKLOG_TRANSACTIONS; i++) await execute();
		await finish();
		// allow A to flush
		await delay(500);

		// Restart B and start sampling its memory. The operationsAPIURL is hostname:port
		// based — both are preserved across restart, so the URL on the original B handle
		// keeps working once the new process is listening.
		const samples = [];
		let sampling = true;
		const sampler = (async () => {
			while (sampling) {
				samples.push(await getMemoryInfo(B));
				await delay(500);
			}
		})();

		await startHarper(nodeCtxB, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'debug' },
				replication: { securePort: nodeCtxB.harper.hostname + ':9933' },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		// Poll record counts directly — unambiguous catch-up signal, no dependency on
		// the shape of cluster_status's lastReceivedVersion fields.
		const sourceCount = (await sendOperation(A, { operation: 'describe_table', table: 'load' })).record_count;
		let caughtUp = false;
		let lastReceiverCount = 0;
		for (let r = 0; r < 360; r++) {
			const describeB = await sendOperation(nodeCtxB.harper, { operation: 'describe_table', table: 'load' });
			lastReceiverCount = describeB.record_count;
			if (lastReceiverCount >= sourceCount) {
				caughtUp = true;
				break;
			}
			await delay(500);
		}

		sampling = false;
		await sampler;

		// Assertion 1: catch-up actually happened.
		ok(
			caughtUp,
			`catch-up did not complete: receiver record_count ${lastReceiverCount} < source ${sourceCount} after 180s`
		);

		// Assertion 2: no receive-side OOM marker in the log.
		const log = await readLog(nodeCtxB.harper);
		ok(
			!log.includes('ERR_WORKER_OUT_OF_MEMORY'),
			'ERR_WORKER_OUT_OF_MEMORY appeared in B log; receive-side memory pressure is unbounded'
		);

		// Assertion 3: peak resident-set is comfortably under the unbounded-decode regime.
		// The wtk failure burst past 2 GB old-gen inside a single message. Anything
		// near or under 1.5 GB means the HWM-driven pause is taking effect.
		const { peakRss } = peakMemory(samples);
		const PEAK_RSS_LIMIT = 1.5 * 1024 * 1024 * 1024;
		ok(
			peakRss > 0 && peakRss < PEAK_RSS_LIMIT,
			`peak RSS during catch-up was ${(peakRss / 1024 / 1024).toFixed(0)} MB, ` +
				`expected < ${(PEAK_RSS_LIMIT / 1024 / 1024).toFixed(0)} MB ` +
				`(unbounded receive decode would balloon past this)`
		);
		console.log(
			`receive backlog test: ${written} records caught up, peak RSS ${(peakRss / 1024 / 1024).toFixed(0)} MB`
		);
	});
});
