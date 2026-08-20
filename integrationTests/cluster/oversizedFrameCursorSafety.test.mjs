/**
 * Integration test: an oversized replication transaction must not be silently skipped.
 *
 * The production failure (harper-pro#711) was permanent data loss: a queued transaction larger than
 * replication_maxPayload was dropped with a bare `return`, and later transactions kept advancing the
 * peer's resume cursor past it. The fix throws instead, which closes the leg so it resumes from the
 * un-advanced cursor. This pins the cursor-safety invariant: once a transaction is too large to send,
 * NO later transaction is delivered ahead of it.
 *
 * Setup: a small maxPayload on the source. Write a normal record (delivered), then an oversized record
 * (wedges the send leg), then another normal record. The follower must have the first record but NOT
 * the third. On base (silent drop) the third arrives while the oversized one is lost, so this fails.
 *
 * Keys are ordered k1 < k2 (oversized) < k3 so that neither delivery path can hand out the later record
 * early: a wedged leg reconnects into a key-ordered full copy, so k3 sorting AFTER the oversized k2
 * (rather than alphabetically before it) is what makes its absence a real cursor-safety signal.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname ?? module.path, '..', '..', 'dist', 'bin', 'harper.js');

const MAX_PAYLOAD = 512 * 1024; // 512 KiB send cap
const OVERSIZED_BYTES = 1024 * 1024; // 1 MiB value -> transaction frame exceeds the cap

suite('oversized replication transaction does not skip later transactions', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });
		const commonConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: { port: hostname + ':9933', securePort: null, databases: ['data'], maxPayload: MAX_PAYLOAD },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		const ctxA = makeNodeCtx(hostnameA);
		const ctxB = makeNodeCtx(hostnameB);
		await Promise.all([startHarper(ctxA, commonConfig(hostnameA)), startHarper(ctxB, commonConfig(hostnameB))]);
		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;

		await sendOperation(ctx.nodeA, { operation: 'create_table', database: 'data', table: 'oversized_test', primary_key: 'id' });
		// Establish replication before any oversized write, so the base copy (small) is unaffected.
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: ctx.nodeA.admin,
		});
	});

	after(async () => {
		await Promise.all([ctx.nodeA && teardownHarper({ harper: ctx.nodeA }), ctx.nodeB && teardownHarper({ harper: ctx.nodeB })]);
	});

	test('the follower receives the pre-oversized record but not the one queued behind it', async () => {
		const { nodeA, nodeB } = ctx;
		const hasId = async (id) =>
			((await sendOperation(nodeB, {
				operation: 'search_by_value',
				database: 'data',
				table: 'oversized_test',
				search_attribute: 'id',
				search_value: id,
				get_attributes: ['id'],
			}).catch(() => [])) ?? []).length > 0;

		// A normal record, delivered normally before the wedge.
		await sendOperation(nodeA, { operation: 'upsert', database: 'data', table: 'oversized_test', records: [{ id: 'k1_before', v: 'x' }] });
		for (let i = 0; i < 60 && !(await hasId('k1_before')); i++) await delay(500);
		ok(await hasId('k1_before'), 'the pre-oversized record must replicate normally');

		// An oversized transaction: too large to send, so the leg wedges on it.
		await sendOperation(nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'oversized_test',
			records: [{ id: 'k2_oversized', v: 'x'.repeat(OVERSIZED_BYTES) }],
		});
		// A later normal transaction: must NOT be delivered ahead of the wedged one.
		await sendOperation(nodeA, { operation: 'upsert', database: 'data', table: 'oversized_test', records: [{ id: 'k3_after', v: 'x' }] });

		// Give the leg ample time to (wrongly, on base) skip and deliver 'after'.
		await delay(10000);
		equal(await hasId('k3_after'), false, 'a transaction queued behind an oversized one must not be delivered');
		equal(await hasId('k2_oversized'), false, 'the oversized transaction itself cannot be sent under this cap');
	});
});
