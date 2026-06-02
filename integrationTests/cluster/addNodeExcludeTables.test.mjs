/**
 * Integration test: add_node with sendsTo/receivesFrom excludeTables (PR #240).
 *
 * Unlike excludeTablesReplication.test.mjs (which uses static YAML routes),
 * this test establishes the bridge via the add_node OPERATION so we exercise
 * the actual migration path customers will use.
 *
 * Why three nodes: add_node itself persists the peer it connects to into the
 * local hdb_nodes table (that is how a node learns its peers). So "nodeA absent
 * from nodeB.hdb_nodes" cannot distinguish "exclusion worked" from "add_node
 * simply hasn't written it" — nodeA SHOULD be present on nodeB as a peer. To
 * test replication-exclusion of the hdb_nodes table we need a record that
 * exists in nodeA.hdb_nodes but is NOT written to nodeB by add_node: that is
 * nodeC. nodeA and nodeC are connected normally (hdb_nodes replicates between
 * them), so nodeA.hdb_nodes contains nodeC. nodeB then bridges to nodeA with
 * hdb_nodes excluded. nodeC can only appear on nodeB via hdb_nodes replication,
 * so its absence proves the exclusion holds across BOTH the from-scratch
 * full-table-copy path and ongoing audit-log forwarding.
 *
 * Setup:
 *   1. Start nodes A, B, C.
 *   2. Connect A <-> C with a plain add_node (no exclusion) so A.hdb_nodes = {A, C}.
 *   3. From B, add_node against A with excludeTables: ['hdb_nodes'] on the
 *      'system' database (both directions).
 *   4. Assert hdb_user replicates A -> B (positive control) and nodeC never
 *      appears in B.hdb_nodes (exclusion holds).
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
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

async function searchHdbNodeNames(node) {
	const rows = await sendOperation(node, {
		operation: 'search_by_value',
		search_attribute: 'name',
		search_value: '*',
		database: 'system',
		table: 'hdb_nodes',
		get_attributes: ['name'],
	}).catch(() => null);
	return (rows ?? []).map((r) => r.name);
}

suite('add_node excludeTables via operation (PR #240)', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		const hostnameC = await getNextAvailableLoopbackAddress();

		const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });

		const commonConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: {
					port: hostname + ':9933',
					securePort: null,
				},
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const ctxA = makeNodeCtx(hostnameA);
		const ctxB = makeNodeCtx(hostnameB);
		const ctxC = makeNodeCtx(hostnameC);

		await Promise.all([
			startHarper(ctxA, commonConfig(hostnameA)),
			startHarper(ctxB, commonConfig(hostnameB)),
			startHarper(ctxC, commonConfig(hostnameC)),
		]);

		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;
		ctx.nodeC = ctxC.harper;
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
			ctx.nodeC && teardownHarper({ harper: ctx.nodeC }),
		]);
	});

	test('hdb_user replicates A->B but excluded hdb_nodes (nodeC) does not leak to B', async () => {
		const { nodeA, nodeB, nodeC } = ctx;

		// 1. Connect A <-> C with a plain add_node (no exclusion) so hdb_nodes
		// replicates between them and nodeA.hdb_nodes comes to contain nodeC.
		await sendOperation(nodeC, {
			operation: 'add_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			authorization: nodeA.admin,
		});

		// Wait until nodeA actually knows about nodeC (otherwise the negative
		// assertion below would be vacuous — there'd be nothing to leak).
		let aKnowsC = false;
		for (let i = 0; i < 40 && !aKnowsC; i++) {
			await delay(500);
			aKnowsC = (await searchHdbNodeNames(nodeA)).includes(nodeC.hostname);
		}
		ok(aKnowsC, 'precondition: nodeA.hdb_nodes should contain nodeC after A<->C add_node');

		// 2. Bridge B -> A with hdb_nodes excluded in both directions. This is the
		// PR #240 migration config: replicate the system database but keep cluster
		// topology (hdb_nodes) local.
		const excludeTablesEntry = { database: 'system', excludeTables: ['hdb_nodes'] };
		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			authorization: nodeA.admin,
			sendsTo: [excludeTablesEntry],
			receivesFrom: [excludeTablesEntry],
		});

		// Wait for an active system-database socket from B's side.
		let connected = false;
		for (let i = 0; i < 40 && !connected; i++) {
			await delay(500);
			const statusB = await sendOperation(nodeB, { operation: 'cluster_status' }).catch(() => null);
			connected = statusB?.connections?.some?.((c) =>
				c.database_sockets?.some?.((s) => s.connected && s.database === 'system')
			);
		}
		ok(connected, 'nodeB should show a connected system-database socket to nodeA');

		// 3. Positive control: a user row written on A must replicate to B (proves
		// the system database is actively replicating across the bridge).
		const testUsername = 'bridge_op_user_' + Date.now();
		await sendOperation(nodeA, {
			operation: 'upsert',
			database: 'system',
			table: 'hdb_user',
			records: [{ username: testUsername, active: true, role: 'super_user', password: 'Placeholder1!' }],
		});

		let userOnB = false;
		for (let i = 0; i < 40 && !userOnB; i++) {
			await delay(300);
			const result = await sendOperation(nodeB, {
				operation: 'search_by_value',
				search_attribute: 'username',
				search_value: testUsername,
				database: 'system',
				table: 'hdb_user',
				get_attributes: ['username'],
			}).catch(() => null);
			userOnB = (result?.length ?? 0) > 0;
		}
		ok(userOnB, `hdb_user '${testUsername}' should replicate A->B via the add_node bridge`);

		// hdb_user and hdb_nodes share the 'system' database and the same subscription,
		// so the hdb_user arrival above is a happens-after barrier: if hdb_nodes were
		// replicating, nodeC would be on nodeB by now. A short settle guards reordering.
		await delay(1000);

		// 4. Negative: nodeC must never appear on nodeB. nodeB's add_node only wrote
		// nodeA (and itself) into nodeB.hdb_nodes; nodeC exists only in nodeA.hdb_nodes,
		// so it can reach nodeB exclusively via hdb_nodes replication — which is excluded.
		const namesOnB = await searchHdbNodeNames(nodeB);
		ok(
			!namesOnB.includes(nodeC.hostname),
			`nodeC (${nodeC.hostname}) must not leak into nodeB.hdb_nodes; excludeTables failed. Saw: ${namesOnB.join(', ')}`
		);
		// Sanity: nodeB does still know nodeA as its bridge peer (add_node's own write,
		// unaffected by replication exclusion).
		ok(namesOnB.includes(nodeA.hostname), `nodeB should still have its bridge peer nodeA (${nodeA.hostname})`);
	});
});
