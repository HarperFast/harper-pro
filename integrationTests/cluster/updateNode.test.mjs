/**
 * Integration test: `update_node` is a registered, dispatchable operation.
 *
 * `setNode()` (replication/setNode.ts) has special-cased `req.operation === 'update_node'` for
 * its response message since it was written, and the documented API
 * (documentation/reference/replication/clustering.md, "Update Node") describes it — but the
 * `server.registerOperation?.()` block never registered the name, so every documented
 * update_node call hit Harper's flat operation-dispatch map lookup
 * (core/server/serverHelpers/serverUtilities.ts `getOperationFunction`, no aliasing) and 400'd
 * with "Operation 'update_node' not found". Fails on base (400, operation-not-found); passes
 * with the fix (200, the update_node-specific success message).
 *
 * Second case: the docs say update_node "will attempt to add the node if it does not exist", so
 * it must also succeed against a hostname with no existing hdb_nodes record (task brief's own
 * open question — resolved by the docs, not by a new existence check).
 */
import { suite, test, before, after } from 'node:test';
import { match } from 'node:assert/strict';
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
		await Promise.all([startHarper(ctxA, commonConfig(hostnameA)), startHarper(ctxB, commonConfig(hostnameB))]);
		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;

		// Establish A as an existing node on B before exercising update_node against it.
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

	test('update_node on an already-known node succeeds with the update-specific message', async () => {
		const { nodeA, nodeB } = ctx;

		const response = await sendOperation(nodeB, {
			operation: 'update_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			revoked_certificates: [],
			authorization: nodeA.admin,
		});

		// setNode()'s update_node branch (replication/setNode.ts:271-273) produces this exact
		// message -- distinct from add_node/set_node's "Successfully added ... to cluster" -- so a
		// 200 here with this text proves dispatch reached the real handler, not some coincidental
		// other route.
		match(response.message, /^Successfully updated /, `unexpected message: ${JSON.stringify(response.message)}`);
	});

	test('update_node against a hostname with no existing node record adds it (documented add-if-absent)', async (t) => {
		const { nodeB } = ctx;
		const hostnameC = await getNextAvailableLoopbackAddress();
		const ctxC = { name: t.name, harper: { hostname: hostnameC } };
		await startHarper(ctxC, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: { port: hostnameC + ':9933', securePort: null, databases: ['data'] },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		const nodeC = ctxC.harper;
		try {
			const response = await sendOperation(nodeB, {
				operation: 'update_node',
				hostname: nodeC.hostname,
				rejectUnauthorized: false,
				authorization: nodeC.admin,
			});
			match(response.message, /^Successfully updated /, `unexpected message: ${JSON.stringify(response.message)}`);
		} finally {
			await teardownHarper({ harper: nodeC });
		}
	});
});
