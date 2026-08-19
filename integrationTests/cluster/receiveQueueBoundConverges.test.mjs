/**
 * The inbound-frame-queue budget must bound memory WITHOUT wedging the receive loop
 * (harper-pro#659, harper#2226).
 *
 * `ws.on('message')` chains every frame onto a serial promise chain that retains the whole frame
 * body, and nothing bounded that chain: a receive loop slower than the peer sends grows it at the
 * inbound line rate until the worker is OOM-killed (measured live: 43 GB on one worker, growth 1:1
 * with a 49 MB/s inbound rate). `createReceiveQueueGate` pauses the socket past a byte budget.
 *
 * The risk that needs proving is not the bound — that is unit-tested — it is DEADLOCK. Every prior
 * receive-side pause bug in this file (#457 consumer-less blob back-pressure, #403, #420) was a
 * pause that never lifted, and each one wedged replication silently. So this test runs a blob-dense
 * base copy — the scenario that historically wedged — with the budget set absurdly low (4 KB, i.e.
 * smaller than a single blob chunk, so the gate pauses on essentially every frame) and asserts the
 * copy still converges.
 *
 * Expected: converges, with the pause having engaged many times. If the gate could strand a pause
 * reason, this is the configuration that would show it.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { cp, mkdtemp } from 'node:fs/promises';
import { sendOperation, fetchWithRetry, readLog } from './clusterShared.mjs';

async function startWithFixture(nodeCtx, fixturePath, options) {
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
	);
	await cp(fixturePath, join(dataRootDir, 'components', basename(fixturePath)), { recursive: true, dereference: true });
	nodeCtx.harper = { hostname: nodeCtx.harper.hostname, dataRootDir };
	return startHarper(nodeCtx, options);
}

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const RECORDS = 80;
const BLOB_CHUNKS = process.env.HARPER_TEST_BLOB_CHUNKS || '128'; // 128 * 4096 = 512 KB/blob
// One socket read chunk — the configured floor, and far below one 512 KB blob's frames, so the gate
// pauses on essentially every inbound frame.
const TINY_QUEUE_BUDGET = 65536;
const PAUSE_LOG = 'inbound frame queue over its budget';
// A single frame is bounded only by the peer's maxPayload, not by the budget; the fixture's blobs cap
// each BLOB_CHUNK frame well under this.
const MAX_FRAME_BYTES = 1048576;
const CONVERGE_TIMEOUT_MS = 180000;
const SEED_CONVERGE_TIMEOUT_MS = 30000;
const POLL_MS = 500;
const FIXTURE = join(import.meta.dirname ?? module.path, 'fixture-blob-gap-deadlock-source');

function sharedConfig(host, extra = {}) {
	return {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, console: true, level: 'debug' },
		replication: { securePort: host + ':9933', ...extra },
	};
}

suite('Inbound receive-queue budget converges (base copy)', { timeout: 300000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startWithFixture(nodeA, FIXTURE, {
			config: sharedConfig(nodeA.harper.hostname),
			env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS },
		});
		// B: receiver with a pathologically small inbound budget, and a low recordConcurrency so its
		// apply falls behind — the combination that makes the gate pause constantly mid-copy.
		await startWithFixture(nodeB, FIXTURE, {
			config: sharedConfig(nodeB.harper.hostname, {
				recordConcurrency: 3,
				receiveQueueHighWaterMark: TINY_QUEUE_BUDGET,
			}),
			env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_BLOB_CHUNKS: BLOB_CHUNKS },
		});
		ctx.nodes = [nodeA.harper, nodeB.harper];

		const seeds = [];
		for (let id = 1; id <= RECORDS; id++) seeds.push(fetchWithRetry(ctx.nodes[0].httpURL + '/Prerender/' + id));
		await Promise.all(seeds);
		const deadline = Date.now() + SEED_CONVERGE_TIMEOUT_MS;
		let count = -1;
		while (Date.now() < deadline) {
			const d = await sendOperation(ctx.nodes[0], { operation: 'describe_table', table: 'Prerender' }).catch(
				() => null
			);
			count = d?.record_count ?? 0;
			if (count >= RECORDS) break;
			await delay(POLL_MS);
		}
		ok(count >= RECORDS, `source did not materialize blobs: holds ${count}/${RECORDS}`);
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n })));
	});

	test('a base copy converges with the inbound queue budget pausing on every frame', async () => {
		const tokenResp = await sendOperation(ctx.nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: ctx.nodes[0].admin,
		});
		for (let i = 0; i < 15; i++) {
			const r = await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: 'Bearer ' + tokenResp.operation_token,
			}).catch((e) => ({ error: String(e) }));
			if (!r?.error) break;
			await delay(500 * (i + 1));
		}

		const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
		let last = -1;
		let converged = false;
		while (Date.now() < deadline) {
			const d = await sendOperation(ctx.nodes[1], { operation: 'describe_table', table: 'Prerender' }).catch(
				() => null
			);
			last = d?.record_count ?? last;
			if (last >= RECORDS) {
				converged = true;
				break;
			}
			await delay(POLL_MS);
		}

		const log = await readLog(ctx.nodes[1]);
		if (process.env.HARPER_TEST_DUMP_LOGS) {
			const { writeFile } = await import('node:fs/promises');
			await writeFile(process.env.HARPER_TEST_DUMP_LOGS + '/rq-receiver.log', log);
		}
		// Match the CONFIGURED budget in the warn payload, not merely that a pause happened: 80 x 512 KB
		// of blob payload can trip the 32 MB DEFAULT on its own, so a bare "did it pause" assertion goes
		// green even when the configured 4 KB never reached the gate — which is precisely what an
		// unregistered config param would do (harper-pro#395). The logger pretty-prints the details
		// object across lines, so match within the block that follows the message, not within one line.
		const engaged = log
			.split(PAUSE_LOG)
			.slice(1)
			.filter((block) => block.slice(0, 300).includes(`highWaterMark: ${TINY_QUEUE_BUDGET}`)).length;
		console.log(
			`  records=${last}/${RECORDS} converged=${converged} budget=${TINY_QUEUE_BUDGET}B queue-pause log lines=${engaged}`
		);

		ok(
			converged,
			`base copy wedged with the inbound queue budget engaged: subscriber holds ${last}/${RECORDS}. ` +
				`A pause taken by the receive-queue gate was never lifted — the same failure class as ` +
				`harper-pro#457/#403/#420.`
		);
		ok(
			engaged > 0,
			`the receive-queue budget never engaged at the configured ${TINY_QUEUE_BUDGET}B, so this run does not ` +
				`exercise the pause path (a pause at the 32 MB default would not prove the config reached the gate)`
		);
		// The bound itself. NOTE this does NOT fail if the gate is removed: on a fast loopback receiver an
		// unbounded queue stays shallow anyway, and reproducing real growth needs a rate mismatch this
		// harness cannot create. What this suite proves is deadlock-freedom under constant pausing and
		// that the configured value reaches the gate; the policy math is unit-tested.
		const peak = Math.max(
			0,
			...log
				.split(PAUSE_LOG)
				.slice(1)
				.map((block) => Number(block.match(/peakQueuedBytes: (\d+)/)?.[1] ?? 0))
		);
		console.log(`  peak queued bytes observed = ${peak}`);
		ok(
			peak > 0 && peak <= TINY_QUEUE_BUDGET + MAX_FRAME_BYTES,
			`queued bytes peaked at ${peak}, past the ${TINY_QUEUE_BUDGET}B budget plus the one frame that ` +
				`crosses it (${MAX_FRAME_BYTES}B allowance)`
		);
	});
});
