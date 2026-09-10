/**
 * Integration test: multi-hop dedup exclusion must follow the EFFECTIVE local receive decision,
 * not the origin's advertised intent.
 *
 * The excluded-origins list a subscriber sends a relay peer ("omit this origin's log, I get it
 * directly") is computed on the main thread by subscriptionManager.computeExclusionOrigins, which
 * gives this node's config route precedence over the origin's advertised sends/sendsTo and keeps
 * relay delivery when table coverage is partial. This exercises the real wiring end to end
 * (subscribe-to-node payload -> SUBSCRIPTION_REQUEST excluded list), which unit tests on the
 * predicate cannot: an earlier regression passed every unit test while the wired parameter was
 * undefined on the outbound path.
 *
 * Topology (names by loopback hostname):
 *   A: to B { sends: true, receives: false }        A advertises sending to B, never pulls from B
 *      to C { sends: true, receives: true }
 *   B: to A { sends: true,
 *             receivesFrom: [{ database: 'system' }, { database: DB2, excludeTables: [T_EXCLUDED] }] }
 *      to C { sends: true, receives: true }
 *   C: to A/B { sends: true, receives: true }       unrestricted relay
 *
 * So B's effective receive from A is: nothing for DB1 (no receives, no matching receivesFrom
 * entry), system in full (which also guarantees A's advertised registry row is present on B,
 * making the old advertised-intent decision deterministic to pin), and DB2 minus T_EXCLUDED. A's registry row still advertises sendsTo B with no
 * exclusions. Deciding from that advertisement, B would tell relay C to omit A's log for both
 * databases, and A-origin writes to DB1 (entirely) and to DB2.T_EXCLUDED (the dropped table)
 * would reach B by neither path. Deciding from the effective config, B keeps relay delivery for
 * both, and still receives DB2's unexcluded table directly.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
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

const DB1 = 'flowdb';
const DB2 = 'flowdb2';
const TABLE1 = 'flow';
const T_INCLUDED = 'covered';
const T_EXCLUDED = 'filtered';

async function insertRecord(node, database, table, id) {
	return sendOperation(node, {
		operation: 'insert',
		database,
		table,
		records: [{ id, name: id }],
	});
}

async function hasRecord(node, database, table, id) {
	const result = await sendOperation(node, {
		operation: 'search_by_id',
		database,
		table,
		ids: [id],
		get_attributes: ['id'],
	}).catch(() => null);
	return Array.isArray(result) && result.some((r) => r?.id === id);
}

async function waitForRecord(node, database, table, id, { timeoutMs = 60000, pollMs = 300 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await hasRecord(node, database, table, id)) return true;
		await delay(pollMs);
	}
	return false;
}

suite('relay exclusion follows effective receive config', { timeout: 240000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		const hostnameC = await getNextAvailableLoopbackAddress();

		const optionsFor = (hostname, routes) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true, level: process.env.IT_LOG_LEVEL || 'error' },
				replication: {
					port: hostname + ':9933',
					securePort: null,
					// system stays replicated so hdb_nodes rows converge across the mesh; the regression
					// this pins requires B to hold A's advertised row.
					routes,
				},
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const route = (peerHostname, replicates) => ({ hostname: peerHostname, port: 9933, replicates });

		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
		const ctxC = { name: ctx.name, harper: { hostname: hostnameC } };

		await Promise.all([
			startHarper(
				ctxA,
				optionsFor(hostnameA, [
					route(hostnameB, { sends: true, receives: false }),
					route(hostnameC, { sends: true, receives: true }),
				])
			),
			startHarper(
				ctxB,
				optionsFor(hostnameB, [
					route(hostnameA, {
						sends: true,
						// The system entry gives B a DIRECT feed of A's hdb_nodes row, so the advertised
						// registry row this suite pivots on is always present on B (the relay path for
						// system is itself subject to the behavior under test). Full coverage, so the
						// fixed code correctly excludes A from the relay for system only.
						receivesFrom: [{ database: 'system' }, { database: DB2, excludeTables: [T_EXCLUDED] }],
					}),
					route(hostnameC, { sends: true, receives: true }),
				])
			),
			startHarper(
				ctxC,
				optionsFor(hostnameC, [
					route(hostnameA, { sends: true, receives: true }),
					route(hostnameB, { sends: true, receives: true }),
				])
			),
		]);

		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;
		ctx.nodeC = ctxC.harper;
		// Kept for the restart test: B must come back with the SAME routes and data root.
		ctx.bOptions = () =>
			optionsFor(hostnameB, [
				route(hostnameA, {
					sends: true,
					// The system entry gives B a DIRECT feed of A's hdb_nodes row, so the advertised
					// registry row this suite pivots on is always present on B (the relay path for
					// system is itself subject to the behavior under test). Full coverage, so the
					// fixed code correctly excludes A from the relay for system only.
					receivesFrom: [{ database: 'system' }, { database: DB2, excludeTables: [T_EXCLUDED] }],
				}),
				route(hostnameC, { sends: true, receives: true }),
			]);

		const tableDefs = [
			[DB1, TABLE1],
			[DB2, T_INCLUDED],
			[DB2, T_EXCLUDED],
		];
		await Promise.all(
			[ctx.nodeA, ctx.nodeB, ctx.nodeC].flatMap((node) =>
				tableDefs.map(([database, table]) =>
					sendOperation(node, {
						operation: 'create_table',
						database,
						table,
						primary_key: 'id',
						attributes: [
							{ name: 'id', type: 'ID' },
							{ name: 'name', type: 'String' },
						],
					})
				)
			)
		);
	});

	after(async () => {
		await Promise.all([ctx.nodeA, ctx.nodeB, ctx.nodeC].map((node) => node && teardownHarper({ harper: node })));
	});

	// Probe with a fresh id per attempt instead of one insert at suite start: a write that lands
	// while the initial bulk copies are still racing can be applied on the relay in copy mode (no
	// relay-side audit entry to forward) after the subscriber's own copy already snapshotted, and
	// is then legitimately unreachable. The behavior under test is steady-state streaming: with
	// the fix an early probe arrives; deciding exclusion from A's advertised sendsTo means NO
	// probe ever arrives, however long we keep writing.
	async function probeUntilArrival(database, table, prefix, { viaRelay = true } = {}) {
		for (let i = 0; i < 12; i++) {
			const id = `${prefix}-${i}`;
			await insertRecord(ctx.nodeA, database, table, id);
			if (viaRelay) {
				ok(
					await waitForRecord(ctx.nodeC, database, table, id, { timeoutMs: 15000 }),
					`A-origin write ${id} should reach relay C`
				);
			}
			if (await waitForRecord(ctx.nodeB, database, table, id, { timeoutMs: 5000 })) return true;
		}
		return false;
	}

	test("A's advertised registry row lands on B before any probing", async () => {
		// Ordering gate, not just a sanity check: the misbehavior under test is only reachable once
		// B holds A's advertised hdb_nodes row, so every following test must run with it present.
		// It arrives over B's direct system feed from A (the receivesFrom entry in B's route).
		ok(await waitForAdvertisedRowOnB(), "A's hdb_nodes row (the advertisement) should replicate to B");
	});

	async function waitForAdvertisedRowOnB() {
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline) {
			const rows = await sendOperation(ctx.nodeB, {
				operation: 'search_by_id',
				database: 'system',
				table: 'hdb_nodes',
				ids: [ctx.nodeA.hostname],
				get_attributes: ['name', 'replicates'],
			}).catch(() => null);
			if (Array.isArray(rows) && rows.some((r) => r?.name === ctx.nodeA.hostname && r?.replicates)) return true;
			await delay(500);
		}
		return false;
	}

	test('a locally disabled direct receive keeps relay delivery for the whole database', async () => {
		// B's only path for DB1 is A -> C -> B.
		ok(await probeUntilArrival(DB1, TABLE1, 'relay-db1'), 'A-origin write should reach B through relay C');
	});

	test('an unexcluded table still arrives', async () => {
		// Delivery-only assertion: with partial coverage B keeps BOTH the direct A subscription and
		// relay delivery from C, and a black-box arrival check cannot tell the two apart. This pins
		// that narrowing DB2's direct subscription did not lose the unexcluded table.
		ok(
			await probeUntilArrival(DB2, T_INCLUDED, 'direct-db2', { viaRelay: false }),
			'unexcluded table should reach B'
		);
	});

	test('a receive-side excluded table keeps relay delivery', async () => {
		// B drops this table on its direct A subscription, so the relay copy is the only real
		// delivery; excluding A from C would lose the rows entirely.
		ok(
			await probeUntilArrival(DB2, T_EXCLUDED, 'relay-db2-excluded'),
			'excluded-table write should reach B through relay C'
		);
	});

	test('relay delivery survives a restart of the subscriber', async () => {
		// The deterministic form of the regression. On a cold boot, B's subscription to C usually
		// forms BEFORE A's hdb_nodes row has replicated over, so an advertised-intent qualifier has
		// nothing to match and the relay flows by luck of the race. After a restart the row is
		// already local when the subscription is built, so deciding from the advertisement excludes
		// A from C at SUBSCRIPTION_REQUEST time and every later A-origin DB1 write is lost.
		// The advertisement must be local before the restart, or the rebuilt subscription races the
		// row's replication the same way a cold boot does and the old behavior escapes the pin.
		ok(await waitForAdvertisedRowOnB(), "A's hdb_nodes row should still be on B before the restart");
		const bHostname = ctx.nodeB.hostname;
		const bDataRootDir = ctx.nodeB.dataRootDir;
		await killHarper({ harper: ctx.nodeB });
		const ctxForRestart = { name: ctx.name, harper: { dataRootDir: bDataRootDir, hostname: bHostname } };
		const result = await startHarper(ctxForRestart, ctx.bOptions());
		ctx.nodeB = result.harper ?? ctxForRestart.harper;
		ok(
			await probeUntilArrival(DB1, TABLE1, 'relay-db1-restarted'),
			'A-origin write should reach restarted B through relay C'
		);
	});
});
