/**
 * QA-689 (source: gh-pro:537 "Interrupted bulk copies can persist a resume cursor over an
 * undelivered range", HIGH / data-loss shaped). Proposed fix PR #554 ("verify resume-claimed
 * copy ranges with key checksums") is UNMERGED at this SHA.
 *
 * Claim under test: a bulk copy (full-copy on add_node) interrupted mid-range can leave the
 * receiver with a persisted `[copyCursor, nodeId]` resume cursor whose `afterKey` is ahead of
 * what was actually made durable. On reconnect the leader trusts the cursor's skip-loop
 * (replicationConnection.ts: `isCopyResumeOrderCompatible` validates only that the cursor was
 * built under the same COPY_ORDER_VERSION — it never re-verifies that the claimed-delivered
 * range actually landed) and resumes streaming strictly AFTER `afterKey`, so any range that was
 * "claimed" by the cursor but never durably committed is skipped forever. `cluster_status` and
 * the cursor state both read as caught-up/complete while rows are silently missing.
 *
 * copyProgressWedgeRecovery.test.mjs (#453) covers a DIFFERENT corner: an artificially frozen
 * copy that makes NO progress at all (0 records ever committed), recovered by the copy-progress
 * watchdog reconnecting and re-streaming from scratch. This test targets the corner that one
 * does not: a copy that DOES make real partial progress (many committed batches, a genuinely
 * advancing resume cursor) and is then abruptly killed (SIGKILL, no graceful shutdown flush) at
 * several different points along that progress — probing whether the persisted cursor can ever
 * end up ahead of durable rows.
 *
 * Oracle: a full bidirectional primary-key-set comparison between source and receiver after
 * final convergence — NOT a row count, and NOT cluster_status (that mechanism is the thing under
 * test: the issue is precisely that cluster_status/the cursor can read "caught up" over a gap).
 *
 * Precondition (hard-asserted, so a clean negative is non-vacuous): at each kill, the receiver's
 * row count must be strictly between 0 and the total seeded row count — i.e. the copy was
 * genuinely interrupted mid-range, not before it started or after it finished.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const TOTAL_RECORDS = 30000;
const VALUE_BYTES = 900; // real per-record payload size, so the copy takes real wall-clock time
const SEED_BATCH_SIZE = 1500;
// Fractions of TOTAL_RECORDS at which we attempt an interruption. If the copy outruns a
// checkpoint before we can catch it there, we just move on (or stop, if it's already done).
const INTERRUPT_FRACTIONS = [0.05, 0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.88, 0.95];
const POLL_MS = 20;
const PER_CHECKPOINT_WAIT_MS = 90000;
const FINAL_CONVERGENCE_TIMEOUT_MS = 180000;
const FINAL_STAGNATION_MS = 20000;
const OP_TIMEOUT_MS = 15000;

/** fetch with a hard timeout — this test's own bespoke network calls (not the shared helper). */
async function op(node, operation, timeoutMs = OP_TIMEOUT_MS) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const data = await response.json();
	equal(response.status, 200, JSON.stringify(data));
	return data;
}

async function recordCount(node) {
	try {
		const desc = await op(node, { operation: 'describe_table', database: 'data', table: 'test' });
		return desc?.record_count ?? 0;
	} catch {
		return -1; // node unreachable (mid-restart); caller treats as "not yet observed"
	}
}

/** Abrupt SIGKILL of the whole process group — no graceful shutdown, no flush-on-exit. */
async function hardKill(node) {
	const proc = node.process;
	if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
	await new Promise((resolve) => {
		proc.once('exit', resolve);
		try {
			process.kill(-proc.pid, 'SIGKILL');
		} catch {
			try {
				proc.kill('SIGKILL');
			} catch {
				resolve();
			}
		}
	});
}

function nodeOptions(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true },
			replication: {
				securePort: hostname + ':9933',
				databases: ['data'],
			},
		},
	};
}

async function fetchAllIds(node) {
	const result = await op(
		node,
		{
			operation: 'search_by_value',
			database: 'data',
			table: 'test',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id'],
		},
		60000
	);
	return new Set((result ?? []).map((r) => r.id));
}

suite('QA-689: interrupted bulk copy resume cursor vs. an undelivered range', { timeout: 900000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		const source = { name: ctx.name, harper: { hostname: hostnameA } };
		const receiver = { name: ctx.name, harper: { hostname: hostnameB } };

		await Promise.all([
			startHarper(source, nodeOptions(hostnameA)),
			startHarper(receiver, nodeOptions(hostnameB)),
		]);
		ctx.source = source.harper;
		ctx.receiver = receiver.harper;

		await op(ctx.source, {
			operation: 'create_table',
			database: 'data',
			table: 'test',
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'value', type: 'String' },
			],
		});

		// Seed ALL records BEFORE add_node so the entire thing rides the full copy (startTime=0),
		// not live audit-replay — a copy long enough in wall-clock terms to interrupt repeatedly.
		for (let batchStart = 0; batchStart < TOTAL_RECORDS; batchStart += SEED_BATCH_SIZE) {
			const records = [];
			const end = Math.min(batchStart + SEED_BATCH_SIZE, TOTAL_RECORDS);
			for (let i = batchStart; i < end; i++) {
				records.push({ id: `row-${i}`, value: randomBytes(VALUE_BYTES).toString('base64') });
			}
			await op(ctx.source, { operation: 'upsert', database: 'data', table: 'test', records }, 30000);
		}
		const seeded = await recordCount(ctx.source);
		equal(seeded, TOTAL_RECORDS, `expected ${TOTAL_RECORDS} seeded rows on source, got ${seeded}`);
	});

	after(async () => {
		await Promise.all(
			[ctx.source && teardownHarper({ harper: ctx.source }), ctx.receiver && teardownHarper({ harper: ctx.receiver })].filter(
				Boolean
			)
		);
	});

	test('repeated mid-copy SIGKILL + restart converges to an exact key match (no permanently sealed gap)', async () => {
		// Kick off the full copy: receiver joins source as its leader.
		await op(ctx.receiver, {
			operation: 'add_node',
			hostname: ctx.source.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: ctx.receiver.admin,
		});

		const interruptions = [];
		for (const frac of INTERRUPT_FRACTIONS) {
			const target = Math.floor(TOTAL_RECORDS * frac);
			const deadline = Date.now() + PER_CHECKPOINT_WAIT_MS;
			let count = 0;
			while (Date.now() < deadline) {
				count = await recordCount(ctx.receiver);
				if (count >= target || count >= TOTAL_RECORDS) break;
				await delay(POLL_MS);
			}
			if (count >= TOTAL_RECORDS) {
				console.log(`[qa689] checkpoint frac=${frac}: copy already reached ${count}/${TOTAL_RECORDS}; stopping interruption loop`);
				break;
			}
			// Hard precondition: the copy must be GENUINELY interrupted mid-range, not before start
			// or after finish — otherwise a clean negative here would be vacuous.
			ok(
				count > 0 && count < TOTAL_RECORDS,
				`precondition failed at frac=${frac}: receiver count must be strictly between 0 and ${TOTAL_RECORDS}, got ${count}`
			);
			interruptions.push({ frac, countAtKill: count });
			console.log(`[qa689] interrupting at frac=${frac}, receiver count=${count}/${TOTAL_RECORDS}`);
			await hardKill(ctx.receiver);
			ctx.receiver = (await startHarper({ harper: ctx.receiver }, nodeOptions(ctx.receiver.hostname))).harper;
		}

		ok(interruptions.length > 0, 'precondition never armed: never observed a genuine mid-copy interruption (harness/timing issue)');

		// Let the (possibly resumed, possibly restarted-from-persisted-cursor) copy run to
		// completion without further interruption, or until it visibly stagnates.
		const finalDeadline = Date.now() + FINAL_CONVERGENCE_TIMEOUT_MS;
		let lastCount = -1;
		let stableSince = Date.now();
		let finalCount = 0;
		while (Date.now() < finalDeadline) {
			finalCount = await recordCount(ctx.receiver);
			if (finalCount !== lastCount) {
				lastCount = finalCount;
				stableSince = Date.now();
			}
			if (finalCount >= TOTAL_RECORDS) break;
			if (Date.now() - stableSince > FINAL_STAGNATION_MS) {
				console.log(`[qa689] receiver count stagnated at ${finalCount}/${TOTAL_RECORDS} for >${FINAL_STAGNATION_MS}ms`);
				break;
			}
			await delay(250);
		}
		console.log(`[qa689] final receiver record_count=${finalCount}/${TOTAL_RECORDS} after ${interruptions.length} interruption(s): ${JSON.stringify(interruptions)}`);

		// A little extra settle time before the oracle scan, in case the last commit is still
		// draining (blob/durability watermark) even though the count already reads TOTAL_RECORDS.
		await delay(3000);

		// THE ORACLE: full bidirectional key-set comparison. Not a count, not cluster_status.
		const sourceIds = await fetchAllIds(ctx.source);
		const receiverIds = await fetchAllIds(ctx.receiver);
		equal(sourceIds.size, TOTAL_RECORDS, `sanity: source itself should still have all ${TOTAL_RECORDS} rows`);

		const missingOnReceiver = [...sourceIds].filter((id) => !receiverIds.has(id));
		const missingOnSource = [...receiverIds].filter((id) => !sourceIds.has(id));
		console.log(
			`[qa689] key comparison: source=${sourceIds.size} receiver=${receiverIds.size} missingOnReceiver=${missingOnReceiver.length} missingOnSource=${missingOnSource.length}`
		);
		if (missingOnReceiver.length > 0) {
			console.log(`[qa689] first missing-on-receiver ids: ${missingOnReceiver.slice(0, 20).join(', ')}`);
		}

		equal(
			missingOnReceiver.length,
			0,
			`DEFECT SIGNATURE: receiver is permanently missing ${missingOnReceiver.length}/${TOTAL_RECORDS} rows the source has, ` +
				`after ${interruptions.length} genuine mid-copy interruption(s) (${JSON.stringify(interruptions)}) — ` +
				`a resume cursor claiming completion over an undelivered range (harper-pro#537)`
		);
		equal(missingOnSource.length, 0, `unexpected: receiver has ${missingOnSource.length} rows not present on source`);
	});
});
