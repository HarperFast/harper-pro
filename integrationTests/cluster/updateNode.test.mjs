/**
 * `update_node` must be dispatchable (regression: it was never registered), must add a node it
 * doesn't already know about (documented add-if-absent), and must not silently widen an existing
 * selective replication relationship when the request omits topology fields.
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
const SELECTIVE_DATABASE = 'data';
const SELECTIVE_TABLE = 'update_node_selective_test';

suite('update_node is a registered, dispatchable operation', { timeout: 120000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });
		const commonConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: { port: hostname + ':9933', securePort: null, databases: ['data'] },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const ctxA = makeNodeCtx(hostnameA);
		const ctxB = makeNodeCtx(hostnameB);
		const results = await Promise.allSettled([
			startHarper(ctxA, commonConfig(hostnameA)).then(() => {
				ctx.nodeA = ctxA.harper;
			}),
			startHarper(ctxB, commonConfig(hostnameB)).then(() => {
				ctx.nodeB = ctxB.harper;
			}),
		]);
		const rejected = results.find((r) => r.status === 'rejected');
		if (rejected) throw rejected.reason;

		// A SELECTIVE (not full-mesh) link from the start: `ensureNode` patches, so a later call that
		// omits `replicates` cannot clear an already-full-mesh record -- the relationship has to be
		// selective from its first registration for test 3 below to mean anything.
		await ensureTableExists(ctx.nodeA, { database: SELECTIVE_DATABASE, table: SELECTIVE_TABLE, primary_key: 'id' });
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			rejectUnauthorized: false,
			subscriptions: [{ database: SELECTIVE_DATABASE, table: SELECTIVE_TABLE, subscribe: true, publish: false }],
			authorization: ctx.nodeA.admin,
		});
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('update_node on an already-known node succeeds with the update-specific message', async () => {
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
			await startHarper(ctxC, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, console: true },
					replication: { port: hostnameC + ':9933', securePort: null, databases: ['data'] },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
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

	test('update_node with no topology fields preserves an existing selective subscription', async () => {
		const { nodeA, nodeB } = ctx;

		const readNodeARecordOnB = async () =>
			(
				await sendOperation(nodeB, {
					operation: 'search_by_value',
					database: 'system',
					table: 'hdb_nodes',
					search_attribute: 'name',
					search_value: nodeA.hostname,
					get_attributes: ['name', 'subscriptions', 'replicates'],
				})
			)[0];

		const before = await readNodeARecordOnB();
		ok(
			Array.isArray(before?.subscriptions) && before.subscriptions.length > 0,
			'precondition: selective link established in before()'
		);
		ok(before.replicates !== true, 'precondition: not full replication before the update');

		await sendOperation(nodeB, {
			operation: 'update_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			revoked_certificates: [],
			authorization: nodeA.admin,
		});

		const after = await readNodeARecordOnB();
		equal(
			after.replicates,
			before.replicates,
			'update_node must not widen replicates when topology fields are omitted'
		);
		deepEqual(
			after.subscriptions,
			before.subscriptions,
			'update_node must preserve the existing selective subscription'
		);
	});
});
