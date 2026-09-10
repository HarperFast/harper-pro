/**
 * Regression (PR #572 review — Chris Barber): once a node is opted-in to directional routing, a
 * FULL-REPLICATION neighbor's per-database subscription must still be authorized when the sender falls
 * to the DYNAMIC hdb_nodes send-authority gate (no directional config route to that peer).
 *
 * `computeSelfReplicates` advertises a full-replication neighbor as `receivesFrom: [{ source: peer }]`
 * with NO `database` (a wildcard over all databases). The dynamic send gate in replicationConnection.ts
 * previously matched with a strict `sub.database === databaseName`, so that no-`database` entry never
 * matched and the subscription was rejected with `close(1008)` — silently stopping replication and
 * reconnect-churning. Before this PR the opted-in node advertised `replicates: true`, which
 * short-circuited that gate, so this only regressed once directional routing was introduced.
 *
 * Topology (all three replicate `data` + `system`):
 *   A  <== full replication (boolean routes both ways) ==>  B
 *   B  --directional route--> C            (this is what OPTS B IN, so B's self-record is a directional
 *                                           object with a wildcard `receivesFrom: [{ source: A }]`)
 * A has only a boolean route to B, so A's send gate to B has no directional config route and falls to
 * the dynamic hdb_nodes gate — the path under test. We then assert a `data` write on A reaches B.
 * Without the fix, A rejects B's `data` subscription and the write never arrives.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT =
	process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ||
	join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DB = 'data';
const TABLE = 'flow';

const optionsFor = (hostname, routes) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true, level: 'warn' },
		replication: {
			port: hostname + ':9933',
			securePort: null,
			databases: [DB, 'system'],
			routes,
		},
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

async function has(node, id) {
	const r = await sendOperation(node, {
		operation: 'search_by_id',
		database: DB,
		table: TABLE,
		ids: [id],
		get_attributes: ['id'],
	}).catch(() => null);
	return Array.isArray(r) && r.some((x) => x?.id === id);
}
async function waitFor(node, id, { timeoutMs = 60000, pollMs = 300 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await has(node, id)) return true;
		await delay(pollMs);
	}
	return false;
}

suite('opted-in node still authorizes a full-replication neighbor via the dynamic send gate', { timeout: 240000 }, (ctx) => {
	before(async () => {
		const A = await getNextAvailableLoopbackAddress();
		const B = await getNextAvailableLoopbackAddress();
		const C = await getNextAvailableLoopbackAddress();
		Object.assign(ctx, { A, B, C });

		const cA = { name: ctx.name, harper: { hostname: A } };
		const cB = { name: ctx.name, harper: { hostname: B } };
		const cC = { name: ctx.name, harper: { hostname: C } };
		await Promise.all([
			// A: full replication with B (BOOLEAN route → A's send gate to B falls to the dynamic hdb_nodes gate).
			startHarper(cA, optionsFor(A, [{ hostname: B, port: 9933 }])),
			// B: full replication with A (boolean) + a DIRECTIONAL route to C (this opts B in, making B's
			// self-record a directional object rather than `replicates: true`).
			startHarper(
				cB,
				optionsFor(B, [
					{ hostname: A, port: 9933 },
					{ hostname: C, port: 9933, replicates: { sends: true, receives: false } },
				])
			),
			// C: directional route back to B.
			startHarper(cC, optionsFor(C, [{ hostname: B, port: 9933, replicates: { sends: false, receives: true } }])),
		]);
		ctx.nodeA = cA.harper;
		ctx.nodeB = cB.harper;
		ctx.nodeC = cC.harper;

		await Promise.all(
			[ctx.nodeA, ctx.nodeB, ctx.nodeC].map((node) =>
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
		await delay(8000); // let self-records propagate + sockets establish
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
			ctx.nodeC && teardownHarper({ harper: ctx.nodeC }),
		]);
	});

	test('a data write on A reaches its full-replication neighbor B through the dynamic gate', async () => {
		const { nodeA, nodeB } = ctx;
		const rec = 'dyn-' + Date.now();
		await sendOperation(nodeA, { operation: 'insert', database: DB, table: TABLE, records: [{ id: rec, name: rec }] });
		const reachedB = await waitFor(nodeB, rec, { timeoutMs: 90000 });
		console.log(`[DYN-GATE] data write on A reached full-replication neighbor B = ${reachedB}`);
		ok(reachedB, 'A must authorize B (a full-replication neighbor) via the dynamic send gate even though B is opted-in');
	});
});
