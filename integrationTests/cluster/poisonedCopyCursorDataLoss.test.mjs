/**
 * Characterization test: poisoned copyCursor data loss (harper-pro#537 symptom).
 *
 * This test documents the STILL-PRESENT cursor-trust behavior that the decode-drop route in #537
 * could produce. The #537 fix (classifyReplicationDecodeError) removes the way a decode failure
 * could CAUSE a poisoned copyCursor, but does NOT change how the leader responds when a receiver
 * presents a copyCursor with an afterKey deep in the keyspace:
 *
 *   Leader response: "I trust the cursor. I'll skip everything up to afterKey and send only the tail."
 *
 * This behavior is CORRECT for the intended use (resuming an interrupted copy: the receiver already
 * committed everything before afterKey). It becomes a DATA-LOSS VECTOR only when the cursor is wrong
 * — either injected maliciously or left stale by a bug (like the decode-drop that #537 fixes).
 *
 * What this test proves:
 *   A receiver that presents a copyCursor with afterKey='row-0500' receives ONLY rows row-0501..N,
 *   considers itself current (COPY_COMPLETE received, subscription connected), and permanently misses
 *   rows row-0001..row-0500 with no error surfaced.
 *
 * Why it is still worth having after #537:
 *   - Serves as a regression guard: if the leader ever STOPS trusting the copyCursor (i.e. always
 *     re-copies from scratch), this test would catch the regression.
 *   - Documents the severity: the missing rows are permanently gone — no reconnect or retry heals them.
 *   - Characterizes the attack surface: any future bug that writes a wrong afterKey to __dbis__ would
 *     exploit this trust (so the test is the "threat model" for the cursor-write path).
 *
 * How the cursor is injected:
 *   The env var HARPER_TEST_INJECT_COPY_CURSOR_JSON (set only on B) causes the subscription handshake
 *   to override the copyCursor read with a synthetic one — identical to the effect of a buggy interrupted
 *   copy leaving a wrong afterKey in the receiver's __dbis__ store.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal, match } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..', '..', 'dist', 'bin', 'harper.js'
);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';
const FIXTURE_PATH = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'fixture-poisoned-copy-cursor'
);

// Total rows seeded on A. Must be large enough that ~SKIP_COUNT rows are meaningful.
const TOTAL_ROWS = 1000;
// The afterKey inserted in the poisoned cursor. The leader skips this row AND everything before it.
// Rows are keyed 'row-0001'..'row-1000' (zero-padded for lexicographic ordering).
const POISON_AFTER_KEY = 'row-0500';
// Expected row count on B after the poisoned copy completes (rows 0501..1000).
const EXPECTED_AFTER_COPY = TOTAL_ROWS - 500;

// Convergence polling ceiling — poison copy is small (only the tail), so 60s is generous.
const CONVERGE_TIMEOUT_MS = 60_000;

function rowKey(i) {
	return 'row-' + String(i).padStart(4, '0');
}

async function waitForCount(node, target, timeoutMs = CONVERGE_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const desc = await sendOperation(node, {
				operation: 'describe_table',
				database: 'data',
				table: 'CopyCursorTest',
			});
			if ((desc.record_count ?? 0) >= target) return desc.record_count;
		} catch { /* transient */ }
		await delay(500);
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for CopyCursorTest count >= ${target}`);
}

async function getRowCount(node) {
	try {
		const desc = await sendOperation(node, {
			operation: 'describe_table',
			database: 'data',
			table: 'CopyCursorTest',
		});
		return desc.record_count ?? 0;
	} catch {
		return 0;
	}
}

suite(
	'Poisoned copyCursor data loss (characterization — harper-pro#537 cursor-trust behavior)',
	{ skip: !STRESS, timeout: 300_000 },
	(ctx) => {
		before(async () => {
			const hostnameA = await getNextAvailableLoopbackAddress();
			const hostnameB = await getNextAvailableLoopbackAddress();

			const replicationConfig = (hostname) => ({
				securePort: hostname + ':9933',
				databases: ['data'],
			});

			const commonConfig = (hostname) => ({
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, console: true, level: 'debug' },
					replication: replicationConfig(hostname),
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});

			// Start A (source, no test injection).
			const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
			await startHarper(ctxA, commonConfig(hostnameA));
			ctx.nodeA = ctxA.harper;

			// Build B's config: inject the synthetic copyCursor via env var.
			// The cursor points to our POISON_AFTER_KEY in the CopyCursorTest table so that A
			// skips rows 0001..0500 and delivers only 0501..1000 to B.
			//
			// copyStartTime must be set well in the future so the leader's post-copy audit replay
			// (which starts from copyStartTime) finds no entries — otherwise the leader would also
			// replay the skipped rows via audit entries, undoing the gap we want to observe.
			// A copyStartTime in the far future is safe here because this is a characterization test
			// (we want to freeze the partial state), not a real recovery scenario.
			const poisonedCursor = {
				db: 'data',
				cursor: {
					copyStartTime: Date.now() + 24 * 60 * 60 * 1000, // 24h ahead: suppress audit replay
					currentTable: 'CopyCursorTest',
					afterKey: POISON_AFTER_KEY,
					copyOrder: 1,            // COPY_ORDER_VERSION = 1 (replicationConnection.ts:117)
				},
			};
			const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
			await startHarper(ctxB, {
				...commonConfig(hostnameB),
				env: {
					HARPER_NO_FLUSH_ON_EXIT: true,
					HARPER_TEST_INJECT_COPY_CURSOR_JSON: JSON.stringify(poisonedCursor),
				},
			});
			ctx.nodeB = ctxB.harper;

			// Deploy fixture to both nodes (creates CopyCursorTest table).
			const payload = await targz(FIXTURE_PATH);
			await Promise.all([
				sendOperation(ctx.nodeA, {
					operation: 'deploy_component',
					project: 'poisoned-copy-cursor',
					payload,
					restart: true,
				}),
				sendOperation(ctx.nodeB, {
					operation: 'deploy_component',
					project: 'poisoned-copy-cursor',
					payload,
					restart: true,
				}),
			]);
			await delay(10_000);

			// Seed TOTAL_ROWS records on A with zero-padded string keys so lexicographic sort
			// matches numeric order. The poisoned cursor afterKey 'row-0500' sits at the midpoint.
			const records = Array.from({ length: TOTAL_ROWS }, (_, i) => ({
				id: rowKey(i + 1),
				val: `value-${i + 1}`,
			}));
			await sendOperation(ctx.nodeA, {
				operation: 'upsert',
				database: 'data',
				table: 'CopyCursorTest',
				records,
			});

			// Allow A to commit the writes before B connects.
			await delay(2_000);
		});

		after(async () => {
			await Promise.all([
				ctx.nodeA && teardownHarper({ harper: ctx.nodeA }).catch(() => null),
				ctx.nodeB && teardownHarper({ harper: ctx.nodeB }).catch(() => null),
			]);
		});

		test('B with poisoned copyCursor afterKey=row-0500 receives only the tail and considers itself current', async () => {
			const { nodeA, nodeB } = ctx;

			// Verify A has all TOTAL_ROWS before B joins.
			await waitForCount(nodeA, TOTAL_ROWS);

			// B subscribes to A as leader. The injected copyCursor activates the resume-skip: A skips
			// rows row-0001..row-0500 and starts sending from row-0501.
			await sendOperation(nodeB, {
				operation: 'add_node',
				hostname: nodeA.hostname,
				rejectUnauthorized: false,
				isLeader: true,
				authorization: nodeA.admin,
			});

			// Wait for B to receive the tail (EXPECTED_AFTER_COPY rows = 500).
			await waitForCount(nodeB, EXPECTED_AFTER_COPY);

			// Give extra time to detect any unexpected additional rows arriving (spurious re-copy).
			await delay(5_000);

			const countOnB = await getRowCount(nodeB);
			const countOnA = await getRowCount(nodeA);

			// CORE SYMPTOM ASSERTION: B has fewer rows than A and will never self-heal.
			// B is missing rows row-0001..row-0500 because the leader trusted the poisoned afterKey.
			ok(
				countOnB < countOnA,
				`SYMPTOM: B should have fewer rows than A (poisoned cursor skipped row-0001..row-0500). ` +
				`A=${countOnA}, B=${countOnB}`
			);
			equal(
				countOnB,
				EXPECTED_AFTER_COPY,
				`B should have exactly ${EXPECTED_AFTER_COPY} rows (row-0501..row-1000). Got ${countOnB}`
			);

			// Confirm B believes itself current: cluster_status shows connected with no active copy.
			const status = await sendOperation(nodeB, { operation: 'cluster_status' });
			const aConn = (status.connections ?? []).find((c) =>
				(c.url ?? c.name ?? '').includes(nodeA.hostname)
			);
			ok(aConn, 'B should have a connection entry for A in cluster_status');
			const allConnected = (aConn.database_sockets ?? []).every((s) => s.connected === true);
			ok(
				allConnected,
				`B believes it is connected and current (no active copy) while missing ${countOnA - countOnB} rows. ` +
				`Sockets: ${JSON.stringify(aConn.database_sockets)}`
			);

			// Confirm the injected cursor appeared in B's log (proves hook fired, not a stale full copy).
			const logB = await readLog(nodeB);
			ok(
				logB.includes('injecting synthetic copyCursor'),
				'B log must contain the test-hook marker line (confirms hook fired, not a stale full copy)'
			);

			// Spot-check: first row (should be ABSENT from B).
			const firstRow = await sendOperation(nodeB, {
				operation: 'search_by_id',
				database: 'data',
				table: 'CopyCursorTest',
				get_attributes: ['id', 'val'],
				ids: ['row-0001'],
			}).catch(() => []);
			equal(
				firstRow.length,
				0,
				'row-0001 (pre-cursor) must be ABSENT from B — the leader skipped it due to the poisoned afterKey'
			);

			// Spot-check: last row (should be PRESENT on B).
			const lastRow = await sendOperation(nodeB, {
				operation: 'search_by_id',
				database: 'data',
				table: 'CopyCursorTest',
				get_attributes: ['id', 'val'],
				ids: ['row-1000'],
			}).catch(() => []);
			equal(
				lastRow.length,
				1,
				'row-1000 (post-cursor) must be present on B'
			);
		});
	}
);
