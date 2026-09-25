/**
 * `update_node` must be dispatchable (regression: it was never registered), must add a node it
 * doesn't already know about (documented add-if-absent), must succeed against an existing
 * full-mesh node, and must refuse -- not silently widen -- a metadata-only call against a node
 * with a restricted replication topology.
 */
import { suite, test, before, after } from 'node:test';
import { match, equal, ok, deepEqual } from 'node:assert/strict';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, ensureTableExists } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

// Anchored at both ends: excludes setNode()'s success-with-warning suffix (a rejected/unreachable peer).
const UPDATE_SUCCESS = /^Successfully updated '[^']+'$/;

function nodeConfig(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true },
			replication: { port: hostname + ':9933', securePort: null, databases: ['data'] },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}

suite('update_node is a registered, dispatchable operation', { timeout: 120000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
		const results = await Promise.allSettled([
			startHarper(ctxA, nodeConfig(hostnameA)).then(() => {
				ctx.nodeA = ctxA.harper;
			}),
			startHarper(ctxB, nodeConfig(hostnameB)).then(() => {
				ctx.nodeB = ctxB.harper;
			}),
		]);
		const rejected = results.find((r) => r.status === 'rejected');
		if (rejected) throw rejected.reason;

		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			rejectUnauthorized: false,
			authorization: ctx.nodeA.admin,
		});
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('update_node on an already-known (full-mesh) node succeeds with the update-specific message', async () => {
		const { nodeA, nodeB } = ctx;

		const response = await sendOperation(nodeB, {
			operation: 'update_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			revoked_certificates: [],
			authorization: nodeA.admin,
		});

		match(response.message, UPDATE_SUCCESS, `unexpected message: ${JSON.stringify(response.message)}`);
	});

	test('update_node against a hostname with no existing node record adds it (documented add-if-absent)', async (t) => {
		const { nodeB } = ctx;
		const hostnameC = await getNextAvailableLoopbackAddress();
		const ctxC = { name: t.name, harper: { hostname: hostnameC } };
		try {
			await startHarper(ctxC, nodeConfig(hostnameC));
			const nodeC = ctxC.harper;

			const response = await sendOperation(nodeB, {
				operation: 'update_node',
				hostname: nodeC.hostname,
				rejectUnauthorized: false,
				authorization: nodeC.admin,
			});
			match(response.message, UPDATE_SUCCESS, `unexpected message: ${JSON.stringify(response.message)}`);
		} finally {
			await teardownHarper({ harper: ctxC.harper });
		}
	});

	test('update_node with no topology fields against a selectively-replicating node is refused, not widened', async (t) => {
		const { nodeB } = ctx;
		const database = 'data';
		const table = 'update_node_selective_test';
		const hostnameD = await getNextAvailableLoopbackAddress();
		const ctxD = { name: t.name, harper: { hostname: hostnameD } };
		try {
			await startHarper(ctxD, nodeConfig(hostnameD));
			const nodeD = ctxD.harper;

			await ensureTableExists(nodeD, { database, table, primary_key: 'id' });
			await sendOperation(nodeB, {
				operation: 'add_node',
				hostname: nodeD.hostname,
				rejectUnauthorized: false,
				subscriptions: [{ database, table, subscribe: true, publish: false }],
				authorization: nodeD.admin,
			});

			const readNodeDRecordOnB = async () =>
				(
					await sendOperation(nodeB, {
						operation: 'search_by_value',
						database: 'system',
						table: 'hdb_nodes',
						search_attribute: 'name',
						search_value: nodeD.hostname,
						get_attributes: ['name', 'subscriptions', 'replicates'],
					})
				)[0];

			const before = await readNodeDRecordOnB();
			ok(
				Array.isArray(before?.subscriptions) && before.subscriptions.length > 0,
				'precondition: selective link established'
			);

			const res = await fetch(nodeB.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: 'update_node',
					hostname: nodeD.hostname,
					rejectUnauthorized: false,
					revoked_certificates: [],
					authorization: nodeD.admin,
				}),
			});
			equal(res.status, 400, `expected a topology-ambiguous update_node to be refused, got ${res.status}`);

			const after = await readNodeDRecordOnB();
			equal(after.replicates, before.replicates, 'the refused call must not have changed replicates at all');
			deepEqual(after.subscriptions, before.subscriptions, 'the selective subscription must be unchanged');
		} finally {
			await teardownHarper({ harper: ctxD.harper });
		}
	});
});
