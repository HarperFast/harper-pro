/**
 * A metadata-only update_node against an existing node must not alter its replication topology.
 */
import { suite, test, before, after } from 'node:test';
import { match, ok, deepEqual } from 'node:assert/strict';
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

// Anchored to exclude the success-with-warning suffix.
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
			// The loopback pool can hand this address to a later test once C is torn down; remove_node
			// clears B's own hdb_nodes row for it so that test doesn't inherit this full-mesh add.
			await sendOperation(nodeB, { operation: 'remove_node', hostname: hostnameC }).catch(() => {});
			await teardownHarper({ harper: ctxC.harper });
		}
	});

	test('a metadata-only update_node leaves an existing selective subscription untouched', async (t) => {
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
						get_attributes: ['name', 'subscriptions', 'replicates', 'revoked_certificates'],
					})
				)[0];

			const before = await readNodeDRecordOnB();
			ok(
				Array.isArray(before?.subscriptions) && before.subscriptions.length > 0,
				'precondition: selective link established'
			);
			ok(
				before.replicates !== true,
				'precondition: not already full-mesh (a contaminated baseline would hide the bug)'
			);

			const response = await sendOperation(nodeB, {
				operation: 'update_node',
				hostname: nodeD.hostname,
				rejectUnauthorized: false,
				revoked_certificates: ['deadbeef'],
				authorization: nodeD.admin,
			});
			match(response.message, UPDATE_SUCCESS, `unexpected message: ${JSON.stringify(response.message)}`);

			const after = await readNodeDRecordOnB();
			deepEqual(after.replicates, before.replicates, 'a metadata-only update_node must not change replicates');
			deepEqual(after.subscriptions, before.subscriptions, 'a metadata-only update_node must not change subscriptions');
			ok(after.revoked_certificates?.includes('deadbeef'), 'revoked_certificates must still be applied locally');

			await sendOperation(nodeB, {
				operation: 'update_node',
				hostname: nodeD.hostname,
				rejectUnauthorized: false,
				start_time: new Date().toISOString(),
				authorization: nodeD.admin,
			});
			const afterFallthrough = await readNodeDRecordOnB();
			deepEqual(afterFallthrough.replicates, before.replicates, 'a fallthrough field must not widen replicates');
			deepEqual(
				afterFallthrough.subscriptions,
				before.subscriptions,
				'a fallthrough field must not change subscriptions'
			);
		} finally {
			await teardownHarper({ harper: ctxD.harper });
		}
	});
});
