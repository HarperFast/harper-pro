/**
 * Decode-drop recovery (harper-pro#537 / #545 regression guard, harper-pro#690).
 *
 * The failure this guards against: a replicated record whose value cannot be decoded on the receiver
 * (the field signature is `Unexpected end of MessagePack data` from a torn stored value). Before #545,
 * the receive path CLOSED the connection on such a failure (#521) and resumed from the same durable
 * cursor, which re-delivered the same undecodable record forever — an endless decode -> close -> resume
 * loop that wedged the leg and starved every record behind the poison one (observed in production:
 * 226/141 cycles on two legs, ~100k log lines in 8 minutes).
 *
 * #545's disposition: a decode failure is permanent, so skip the record (count it via `decode-drop`),
 * let the resume cursor advance, and keep the leg alive. This test proves that end to end on a real
 * two-node cluster:
 *   1. every non-poison record is delivered (the leg is not starved);
 *   2. the poison records are absent (skipped, not applied with garbage);
 *   3. the connection does NOT enter the close/resume loop (zero inbound-close log lines);
 *   4. a live write AFTER the poison converges also arrives (the leg keeps working).
 *
 * The decode failure is induced deterministically by `maybeInjectDecodeFailureForTest`
 * (HARPER_TEST_DECODE_FAIL_RECORD_PREFIX on the receiver), the same env-gated one-shot-per-record
 * pattern as the sibling copy-cursor / stall injections — no genuinely corrupt blob needed.
 *
 * Stress-gated (spawns two Harper child processes) like the other cluster tests.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog, stopNodeProcess } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';
const FIXTURE_PATH = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'fixture-decode-drop');

const TOTAL_ROWS = 200;
// Records whose id starts with this prefix throw on value-decode at the receiver.
const POISON_PREFIX = 'poison-';
const POISON_COUNT = 3;
const EXPECTED_GOOD = TOTAL_ROWS; // all clean rows must arrive; poison rows are extra and skipped
const CONVERGE_TIMEOUT_MS = 90_000;

function goodKey(i) {
	return 'row-' + String(i).padStart(4, '0');
}

async function tableCount(node) {
	try {
		const desc = await sendOperation(node, { operation: 'describe_table', database: 'data', table: 'DecodeDropTest' });
		return desc.record_count ?? 0;
	} catch {
		return 0;
	}
}

async function waitForCount(node, target, timeoutMs = CONVERGE_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	let last = 0;
	while (Date.now() < deadline) {
		last = await tableCount(node);
		if (last >= target) return last;
		await delay(500);
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for DecodeDropTest count >= ${target} (last ${last})`);
}

async function hasRow(node, id) {
	const res = await sendOperation(node, {
		operation: 'search_by_hash',
		database: 'data',
		table: 'DecodeDropTest',
		hash_values: [id],
		get_attributes: ['id'],
	});
	return Array.isArray(res) && res.length === 1;
}

suite('Decode-drop recovery (harper-pro#537/#545)', { skip: !STRESS, timeout: 300_000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		const commonConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'debug' },
				replication: { securePort: hostname + ':9933', databases: ['data'] },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		// A = source (no injection).
		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		await startHarper(ctxA, commonConfig(hostnameA));
		ctx.nodeA = ctxA.harper;

		// B = receiver, armed to throw on decode of any `poison-*` record.
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
		await startHarper(ctxB, {
			...commonConfig(hostnameB),
			env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_DECODE_FAIL_RECORD_PREFIX: POISON_PREFIX },
		});
		ctx.nodeB = ctxB.harper;

		const payload = await targz(FIXTURE_PATH);
		await Promise.all([
			sendOperation(ctx.nodeA, { operation: 'deploy_component', project: 'decode-drop', payload, restart: true }),
			sendOperation(ctx.nodeB, { operation: 'deploy_component', project: 'decode-drop', payload, restart: true }),
		]);
		await delay(10_000);

		// Seed clean rows + poison rows on A, interleaved so a starved leg (poison stops progress)
		// is distinguishable from a healthy skip (clean rows keep flowing past the poison).
		const records = [];
		for (let i = 1; i <= TOTAL_ROWS; i++) {
			records.push({ id: goodKey(i), val: `value-${i}` });
			if (i <= POISON_COUNT) records.push({ id: POISON_PREFIX + i, val: `poison-${i}` });
		}
		await sendOperation(ctx.nodeA, { operation: 'upsert', database: 'data', table: 'DecodeDropTest', records });
		await delay(2_000);
	});

	after(async () => {
		// teardownHarper's argument must be a context: it early-returns on a falsy `ctx.harper`.
		await Promise.all(
			[ctx.nodeA, ctx.nodeB].filter(Boolean).map(async (node) => {
				await stopNodeProcess(node).catch(() => {});
				await teardownHarper({ harper: node }).catch(() => {});
			})
		);
	});

	test('B joins A, skips the undecodable records, and stays alive', async () => {
		// B declares A its leader: isLeader:true forces a full copy (startTime=0).
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			port: 9933,
			isLeader: true,
			rejectUnauthorized: false,
			authorization: ctx.nodeA.admin,
		});

		// (1) every clean row arrives — the leg is NOT starved behind the poison record.
		// waitForCount throws if B never reaches EXPECTED_GOOD within the timeout; that throw
		// is the assertion (a trailing ok(count >= target) would be dead — waitForCount only
		// returns on success).
		await waitForCount(ctx.nodeB, EXPECTED_GOOD);

		// (2) the poison records were skipped, not applied.
		for (let i = 1; i <= POISON_COUNT; i++) {
			equal(await hasRow(ctx.nodeB, POISON_PREFIX + i), false, `poison-${i} must be absent on B (skipped)`);
		}

		// (3) the connection did NOT enter the #521 close/resume loop.
		const logB = await readLog(ctx.nodeB);
		const closeLines = (logB.match(/Error handling incoming replication message/g) ?? []).length;
		equal(closeLines, 0, `B must not close/resume on decode failure (found ${closeLines} close lines)`);
		// and it did surface the drop rather than swallow it silently.
		ok(/Error decoding replication message/.test(logB), 'B should log the decode drop');

		// (4) a live write after convergence still replicates — the leg keeps working.
		await sendOperation(ctx.nodeA, {
			operation: 'insert',
			database: 'data',
			table: 'DecodeDropTest',
			records: [{ id: 'row-live-1', val: 'after' }],
		});
		const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
		let live = false;
		while (Date.now() < deadline) {
			try {
				if (await hasRow(ctx.nodeB, 'row-live-1')) {
					live = true;
					break;
				}
			} catch {}
			await delay(500);
		}
		ok(live, 'a live write after the poison must replicate to B (leg alive)');
	});
});
