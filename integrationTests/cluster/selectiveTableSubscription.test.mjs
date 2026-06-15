/**
 * Integration test: selective table subscription within a replicated user database (issue #301).
 *
 * Production clusters often need a subset of tables inside an otherwise-replicated
 * database to stay node-local — for example, a per-node working-set table inside the
 * same database as a globally replicated catalog. Per-route `excludeTables` entries
 * on `sendsTo`/`receivesFrom` implement this. `excludeTablesReplication.test.mjs`
 * already exercises the mechanism for the system database (excluding `hdb_nodes`
 * while `hdb_user` replicates), but not for user tables in a user-defined database.
 *
 * Two nodes share a bridge over `data` with `excludeTables: ['Table2']` configured in
 * both directions. Verifies that Table1 writes cross the bridge while Table2 writes
 * stay on the originating node regardless of which side wrote them.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { resolve } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = resolve(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

// Window we wait while asserting that a non-replicated table's writes do NOT arrive at
// the peer. Generous enough that a slow-but-successful replication can't slip past as
// a false negative.
const LOCALITY_WINDOW_MS = 4000;
const LOCALITY_POLL_MS = 250;

suite('Selective table subscription', { timeout: 120000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		// Exclude Table2 from the bridge in both directions. Table1 (and any other table
		// in `data`) remains free to replicate.
		const excludeTablesEntry = { database: 'data', excludeTables: ['Table2'] };

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

		// Create both tables on both nodes. Schema for Table2 won't propagate over the
		// bridge (excludeTables affects schema as well as data), so each node must
		// create it independently.
		for (const node of [ctx.nodeA, ctx.nodeB]) {
			await sendOperation(node, {
				operation: 'create_table',
				database: 'data',
				table: 'Table1',
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'value', type: 'String' },
				],
			});
			await sendOperation(node, {
				operation: 'create_table',
				database: 'data',
				table: 'Table2',
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'value', type: 'String' },
				],
			});
		}
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('Table1 replicates across the bridge, Table2 stays local', async () => {
		const { nodeA, nodeB } = ctx;

		// Wait for the data-database socket to come up on both sides. The static-route
		// handshake takes a moment after both processes start.
		// [sel-window EXPERIMENT] window bumped 20s->60s + connect-time logging to
		// distinguish "slow handshake under CI load" from "never connects (deadlock)".
		let connected = false;
		const startWait = Date.now();
		let waitIters = 0;
		for (let i = 0; i < 120 && !connected; i++) {
			waitIters = i + 1;
			await delay(500);
			const [statusA, statusB] = await Promise.all([
				sendOperation(nodeA, { operation: 'cluster_status' }).catch(() => null),
				sendOperation(nodeB, { operation: 'cluster_status' }).catch(() => null),
			]);
			const aOk = statusA?.connections?.some?.((c) =>
				c.database_sockets?.some?.((s) => s.connected && s.database === 'data')
			);
			const bOk = statusB?.connections?.some?.((c) =>
				c.database_sockets?.some?.((s) => s.connected && s.database === 'data')
			);
			connected = aOk && bOk;
		}
		// eslint-disable-next-line no-console
		console.log(
			`[sel-window] data-db socket connected=${connected} after ${Date.now() - startWait}ms (${waitIters} polls, window=60s)`
		);
		ok(connected, 'both nodes should show a connected data-database socket');

		// Insert a Table1 record on nodeA and wait for it to replicate to nodeB.
		// Static-route peers don't register in hdb_nodes (system DB is not shared),
		// so `replicatedConfirmation` can't count them — we poll for arrival
		// instead, matching excludeTablesReplication.test.mjs.
		await sendOperation(nodeA, {
			operation: 'insert',
			database: 'data',
			table: 'Table1',
			records: [{ id: 't1-from-A', value: 'replicated' }],
		});
		let t1OnB = [];
		for (let i = 0; i < 30 && t1OnB.length === 0; i++) {
			await delay(200);
			t1OnB = await sendOperation(nodeB, {
				operation: 'search_by_id',
				database: 'data',
				table: 'Table1',
				ids: ['t1-from-A'],
				get_attributes: ['id', 'value'],
			});
		}
		equal(t1OnB.length, 1, 'Table1 record should replicate from A to B');
		equal(t1OnB[0].value, 'replicated');

		// Reverse direction: a Table1 record written on nodeB must also reach nodeA.
		await sendOperation(nodeB, {
			operation: 'insert',
			database: 'data',
			table: 'Table1',
			records: [{ id: 't1-from-B', value: 'replicated-reverse' }],
		});
		let t1OnA = [];
		for (let i = 0; i < 30 && t1OnA.length === 0; i++) {
			await delay(200);
			t1OnA = await sendOperation(nodeA, {
				operation: 'search_by_id',
				database: 'data',
				table: 'Table1',
				ids: ['t1-from-B'],
				get_attributes: ['id', 'value'],
			});
		}
		equal(t1OnA.length, 1, 'Table1 record should replicate from B to A');

		// Write to the excluded Table2 on each side. Each record must stay on its
		// origin and never appear on the peer, even after a generous wait window.
		await sendOperation(nodeA, {
			operation: 'insert',
			database: 'data',
			table: 'Table2',
			records: [{ id: 't2-on-A', value: 'local-to-A' }],
		});
		await sendOperation(nodeB, {
			operation: 'insert',
			database: 'data',
			table: 'Table2',
			records: [{ id: 't2-on-B', value: 'local-to-B' }],
		});

		// Confirm both writes are present locally.
		const localA = await sendOperation(nodeA, {
			operation: 'search_by_id',
			database: 'data',
			table: 'Table2',
			ids: ['t2-on-A'],
			get_attributes: ['id', 'value'],
		});
		const localB = await sendOperation(nodeB, {
			operation: 'search_by_id',
			database: 'data',
			table: 'Table2',
			ids: ['t2-on-B'],
			get_attributes: ['id', 'value'],
		});
		equal(localA.length, 1, 'Table2 write must be present on origin A');
		equal(localB.length, 1, 'Table2 write must be present on origin B');

		// Poll the opposite node for the full locality window. The record must never
		// show up on the other side.
		const deadline = Date.now() + LOCALITY_WINDOW_MS;
		while (Date.now() < deadline) {
			const [crossOnB, crossOnA] = await Promise.all([
				sendOperation(nodeB, {
					operation: 'search_by_id',
					database: 'data',
					table: 'Table2',
					ids: ['t2-on-A'],
					get_attributes: ['id'],
				}),
				sendOperation(nodeA, {
					operation: 'search_by_id',
					database: 'data',
					table: 'Table2',
					ids: ['t2-on-B'],
					get_attributes: ['id'],
				}),
			]);
			equal(crossOnB.length, 0, "Table2 record from A leaked to B (excludeTables should block it)");
			equal(crossOnA.length, 0, "Table2 record from B leaked to A (excludeTables should block it)");
			await delay(LOCALITY_POLL_MS);
		}
	});
});
