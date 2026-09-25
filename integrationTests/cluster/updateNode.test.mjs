/**
 * Integration test: `update_node` is a registered, dispatchable operation, and (per docs) adds
 * the node when it doesn't already exist.
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

// Anchored at both ends so it does NOT match the success-with-warning variant setNode() returns
// when the peer rejects/errors ("Successfully updated '<url>' but there was an error ..."):
// a peer-rejected update_node must fail this test, not pass it.
const UPDATE_SUCCESS = /^Successfully updated '[^']+'$/;

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
		// Assign as each node starts (not after Promise.all resolves) so `after` can tear down
		// whichever one succeeded if the other's startHarper rejects.
		await Promise.all([
			startHarper(ctxA, commonConfig(hostnameA)).then(() => {
				ctx.nodeA = ctxA.harper;
			}),
			startHarper(ctxB, commonConfig(hostnameB)).then(() => {
				ctx.nodeB = ctxB.harper;
			}),
		]);

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
});
