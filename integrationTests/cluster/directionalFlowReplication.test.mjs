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
import { sendOperation, ensureTableExists, waitForCondition } from './clusterShared.mjs';

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
const TABLE_DEFINITION = {
	database: DB,
	table: TABLE,
	primary_key: 'id',
	attributes: [
		{ name: 'id', type: 'ID' },
		{ name: 'name', type: 'String' },
	],
};

async function insertRecord(node, id) {
	return sendOperation(node, {
		operation: 'insert',
		database: DB,
		table: TABLE,
		records: [{ id, name: id }],
	});
}

async function hasRecord(node, id, signal) {
	const result = await sendOperation(
		node,
		{
			operation: 'search_by_id',
			database: DB,
			table: TABLE,
			ids: [id],
			get_attributes: ['id'],
		},
		{ signal }
	);
	return Array.isArray(result) && result.some((r) => r?.id === id);
}

function waitForRecord(node, id, { timeoutMs = 30000, description } = {}) {
	return waitForCondition((signal) => hasRecord(node, id, signal), { timeoutMs, pollMs: 300, description });
}

suite('directional flow replication (harper-pro#498)', { timeout: 180000 }, (ctx) => {
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
		await startHarper(ctxA, optionsFor(hostnameA, hostnameB, { sends: true, receives: false }));
		ctx.nodeA = ctxA.harper;
		await ensureTableExists(ctx.nodeA, TABLE_DEFINITION);

		// Seeded before the core exists. The core's base copy anchors its resume cursor at the wall-clock
		// instant the copy starts, and a transaction's log key is fixed when it stages its first write, so a
		// write still in flight at that instant reaches neither the copy nor the audit tail behind it.
		ctx.seedId = 'seed-' + Date.now();
		await insertRecord(ctx.nodeA, ctx.seedId);

		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
		await startHarper(ctxB, optionsFor(hostnameB, hostnameA, { sends: false, receives: true }));
		ctx.nodeB = ctxB.harper;
		await ensureTableExists(ctx.nodeB, TABLE_DEFINITION);
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('upstream writes flow edge -> core, but core writes never flow back downstream', async () => {
		const { nodeA, nodeB } = ctx;

		// 1. Forward flow must work. harper uses a single receiver-initiated socket, so readiness is proven
		//    by data arriving rather than by cluster_status: first the pre-start seed the base copy carries,
		//    then a write issued after it, which can only reach the core over the live audit tail.
		await waitForRecord(nodeB, ctx.seedId, {
			timeoutMs: 60000,
			description: `pre-start edge write '${ctx.seedId}' to reach core (sends: true)`,
		});

		const fwd1 = 'fwd-' + Date.now();
		await insertRecord(nodeA, fwd1);
		await waitForRecord(nodeB, fwd1, {
			timeoutMs: 60000,
			description: `edge write '${fwd1}' to replicate to core (sends: true)`,
		});

		// 2. Reverse flow must be blocked: a core (B) write must NEVER reach the edge (A), because A's
		//    config route sets receives:false (A never subscribes to B) and B's sets sends:false.
		const rev = 'rev-' + Date.now();
		await insertRecord(nodeB, rev);

		// Forward barrier: push another edge write and wait for it on core. By the time this second
		// forward record has propagated, any (buggy) reverse propagation of `rev` would also have had
		// time to arrive — making the absence check below a reliable signal, not just a short sleep.
		const fwd2 = 'fwd2-' + Date.now();
		await insertRecord(nodeA, fwd2);
		await waitForRecord(nodeB, fwd2, { description: `second edge write '${fwd2}' to replicate to core` });
		// Small additional settle margin.
		await delay(1500);

		ok(
			!(await hasRecord(nodeA, rev)),
			`core write '${rev}' must NOT replicate downstream to the edge (receives: false / sends: false)`
		);
	});
});
