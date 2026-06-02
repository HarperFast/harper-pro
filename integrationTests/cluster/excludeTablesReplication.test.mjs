/**
 * Integration test: per-route excludeTables for bridge replication (issue #239).
 * Two nodes are configured with static routes that exclude system.hdb_nodes.
 * Verifies that hdb_user records replicate across the bridge but hdb_nodes entries
 * stay local to each node.
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

suite('excludeTables replication', { timeout: 120000 }, (ctx) => {
	before(async () => {
		// Pre-allocate both hostnames so each node can configure a static route to the other.
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		// Exclude hdb_nodes in both send and receive directions on the system database.
		const excludeTablesEntry = { database: 'system', excludeTables: ['hdb_nodes'] };

		const makeNodeCtx = (hostname) => ({
			name: ctx.name,
			harper: { hostname },
		});

		const optionsFor = (hostname, peerHostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: {
					port: hostname + ':9933',
					securePort: null,
					routes: [
						{
							hostname: peerHostname,
							port: 9933,
							sendsTo: [excludeTablesEntry],
							receivesFrom: [excludeTablesEntry],
						},
					],
				},
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const ctxA = makeNodeCtx(hostnameA);
		const ctxB = makeNodeCtx(hostnameB);

		await Promise.all([
			startHarper(ctxA, optionsFor(hostnameA, hostnameB)),
			startHarper(ctxB, optionsFor(hostnameB, hostnameA)),
		]);

		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('hdb_user replicates but hdb_nodes stays per-cluster', async () => {
		const { nodeA, nodeB } = ctx;

		// Wait for both nodes to show an active system-database connection.
		let connected = false;
		for (let i = 0; i < 40 && !connected; i++) {
			await delay(500);
			const [statusA, statusB] = await Promise.all([
				sendOperation(nodeA, { operation: 'cluster_status' }).catch(() => null),
				sendOperation(nodeB, { operation: 'cluster_status' }).catch(() => null),
			]);
			const aOk = statusA?.connections?.some?.((c) =>
				c.database_sockets?.some?.((s) => s.connected && s.database === 'system')
			);
			const bOk = statusB?.connections?.some?.((c) =>
				c.database_sockets?.some?.((s) => s.connected && s.database === 'system')
			);
			connected = aOk && bOk;
		}
		ok(connected, 'both nodes should show a connected system-database socket');

		// Insert a user record on nodeA and wait for it to replicate to nodeB.
		const testUsername = 'bridge_test_user_' + Date.now();
		await sendOperation(nodeA, {
			operation: 'upsert',
			database: 'system',
			table: 'hdb_user',
			records: [{ username: testUsername, active: true, role: 'super_user', password: 'Placeholder1!' }],
		});

		let userOnB = null;
		for (let i = 0; i < 30 && !userOnB; i++) {
			await delay(300);
			const result = await sendOperation(nodeB, {
				operation: 'search_by_value',
				search_attribute: 'username',
				search_value: testUsername,
				database: 'system',
				table: 'hdb_user',
				get_attributes: ['username'],
			}).catch(() => null);
			if (result?.length > 0) userOnB = result;
		}
		ok(userOnB, `hdb_user record '${testUsername}' should replicate from nodeA to nodeB`);

		// Verify hdb_nodes on nodeB: nodeA's own entry must not appear there.
		const nodesOnB = await sendOperation(nodeB, {
			operation: 'search_by_value',
			search_attribute: 'name',
			search_value: '*',
			database: 'system',
			table: 'hdb_nodes',
			get_attributes: ['name'],
		});
		const nodeNamesOnB = nodesOnB.map((n) => n.name);
		ok(
			!nodeNamesOnB.includes(nodeA.hostname),
			`nodeA's hdb_nodes entry (${nodeA.hostname}) must not replicate to nodeB`
		);
		ok(nodeNamesOnB.includes(nodeB.hostname), `nodeB's own hdb_nodes entry (${nodeB.hostname}) must be present`);
		equal(nodeNamesOnB.length, 1, 'nodeB should have exactly one hdb_nodes entry (its own)');
	});
});
