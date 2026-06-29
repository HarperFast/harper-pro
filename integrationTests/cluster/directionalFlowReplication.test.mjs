/**
 * Integration test: controlled-flow ("directional") replication via config routes (harper-pro#498).
 *
 * Regression guard for the bug where `replication.routes[].replicates.sends/receives` were stored and
 * round-tripped but NOT enforced on live connections — the runtime direction gates read `replicates`
 * only from the `hdb_nodes` record (which defaults to `replicates: true`), so traffic flowed fully
 * bidirectionally regardless of the route config.
 *
 * Topology (edge -> core, one-way upstream): node A is an edge that only SENDS to core B; node B only
 * RECEIVES from A. With the gates honoring the config route, B receives A's writes but A must never
 * receive B's writes (the "core should never send downstream" symptom from the issue).
 *
 *   A (edge): route to B = replicates { sends: true,  receives: false }
 *   B (core): route to A = replicates { sends: false, receives: true  }
 *
 * `system` is left unreplicated (databases: ['data']) per the controlled-flow operator guidance, so
 * hdb_nodes does not converge a full replicates:true mesh behind the directional routes.
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

const DB = 'data';
const TABLE = 'flow';

async function insertRecord(node, id) {
	return sendOperation(node, {
		operation: 'insert',
		database: DB,
		table: TABLE,
		records: [{ id, name: id }],
	});
}

async function hasRecord(node, id) {
	const result = await sendOperation(node, {
		operation: 'search_by_id',
		database: DB,
		table: TABLE,
		ids: [id],
		get_attributes: ['id'],
	}).catch(() => null);
	return Array.isArray(result) && result.some((r) => r?.id === id);
}

async function waitForRecord(node, id, { timeoutMs = 30000, pollMs = 300 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await hasRecord(node, id)) return true;
		await delay(pollMs);
	}
	return false;
}

suite('directional flow replication (harper-pro#498)', { timeout: 120000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress(); // edge
		const hostnameB = await getNextAvailableLoopbackAddress(); // core

		const optionsFor = (hostname, peerHostname, replicates) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: {
					port: hostname + ':9933',
					securePort: null,
					databases: ['data'], // keep system unreplicated under controlled flow
					routes: [{ hostname: peerHostname, port: 9933, replicates }],
				},
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };

		await Promise.all([
			// edge A sends upstream to core B, does not receive from it
			startHarper(ctxA, optionsFor(hostnameA, hostnameB, { sends: true, receives: false })),
			// core B receives from edge A, does not send back down
			startHarper(ctxB, optionsFor(hostnameB, hostnameA, { sends: false, receives: true })),
		]);

		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;

		// Create the replicated table on both nodes.
		await Promise.all(
			[ctx.nodeA, ctx.nodeB].map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: DB,
					table: TABLE,
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				})
			)
		);
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('upstream writes flow edge -> core, but core writes never flow back downstream', async () => {
		const { nodeA, nodeB } = ctx;

		// 1. Forward flow must work: an edge (A) write reaches core (B). The arrival of this probe is the
		//    readiness signal (the directional channel is live); harper uses a single receiver-initiated
		//    socket, so we assert on data flow rather than on cluster_status topology. A generous timeout
		//    absorbs connection/TLS/catch-up setup.
		const fwd1 = 'fwd-' + Date.now();
		await insertRecord(nodeA, fwd1);
		ok(
			await waitForRecord(nodeB, fwd1, { timeoutMs: 60000 }),
			`edge write '${fwd1}' should replicate to core (sends: true)`
		);

		// 2. Reverse flow must be blocked: a core (B) write must NEVER reach the edge (A), because A's
		//    config route sets receives:false (A never subscribes to B) and B's sets sends:false.
		const rev = 'rev-' + Date.now();
		await insertRecord(nodeB, rev);

		// Forward barrier: push another edge write and wait for it on core. By the time this second
		// forward record has propagated, any (buggy) reverse propagation of `rev` would also have had
		// time to arrive — making the absence check below a reliable signal, not just a short sleep.
		const fwd2 = 'fwd2-' + Date.now();
		await insertRecord(nodeA, fwd2);
		ok(await waitForRecord(nodeB, fwd2), `second edge write '${fwd2}' should replicate to core`);
		// Small additional settle margin.
		await delay(1500);

		ok(
			!(await hasRecord(nodeA, rev)),
			`core write '${rev}' must NOT replicate downstream to the edge (receives: false / sends: false)`
		);
	});
});
