/**
 * Integration test: add_node with isLeader:true triggers a full-table copy.
 *
 * Full-copy is the mechanism that delivers PRE-EXISTING records — data written
 * before the subscription was established. Plain audit-log forwarding only
 * starts from "now", so receiving pre-existing records is the definitive
 * signature that startTime=0 (full copy) was requested.
 *
 * Setup:
 *   1. Start node A; create a table and write N records.
 *   2. Start node B (no replication config yet).
 *   3. From node B, call add_node { hostname: A, isLeader: true }.
 *   4. Assert all N pre-existing records arrive on B.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const PRE_EXISTING_RECORD_COUNT = 5;

suite('add_node isLeader full-table copy', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });

		// Common replication config: plaintext port only, replicate only the 'data' database
		// so system.hdb_nodes churn does not interfere.
		const replicationConfig = (hostname) => ({
			port: hostname + ':9933',
			securePort: null,
			databases: ['data'],
		});

		const commonConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: replicationConfig(hostname),
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const ctxA = makeNodeCtx(hostnameA);
		const ctxB = makeNodeCtx(hostnameB);

		// Start both nodes; B has no knowledge of A yet — we'll add_node after writing data.
		await Promise.all([startHarper(ctxA, commonConfig(hostnameA)), startHarper(ctxB, commonConfig(hostnameB))]);

		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;

		// Create the test table on node A and write pre-existing records.
		await sendOperation(ctx.nodeA, {
			operation: 'create_table',
			database: 'data',
			table: 'full_copy_test',
			primary_key: 'id',
		});

		const records = Array.from({ length: PRE_EXISTING_RECORD_COUNT }, (_, i) => ({
			id: `pre-existing-${i}`,
			value: `v${i}`,
		}));
		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'full_copy_test',
			records,
		});
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('pre-existing records arrive on B after add_node with isLeader:true', async () => {
		const { nodeA, nodeB } = ctx;

		// Node B joins node A as a subscriber, declaring A as its leader.
		// This should trigger startTime=0 (full copy) so B receives the records
		// written before the subscription was established.
		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: nodeA.admin,
		});

		// Poll until all pre-existing records appear on B (up to ~45 s).
		let received = [];
		for (let i = 0; i < 90 && received.length < PRE_EXISTING_RECORD_COUNT; i++) {
			await delay(500);
			const result = await sendOperation(nodeB, {
				operation: 'search_by_value',
				database: 'data',
				table: 'full_copy_test',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['id', 'value'],
			}).catch(() => []);
			received = result ?? [];
		}

		equal(
			received.length,
			PRE_EXISTING_RECORD_COUNT,
			`Expected ${PRE_EXISTING_RECORD_COUNT} pre-existing records on B, got ${received.length}`
		);

		// Spot-check one record to confirm content, not just count.
		const ids = received.map((r) => r.id).sort();
		ok(ids.includes('pre-existing-0'), 'pre-existing-0 must be present on B');
	});
});
