/**
 * HarperFast/harper#1212, cluster half: a replicated `drop_table` stays dropped across restarts, and a peer
 * that missed it neither brings the table back nor leaks its rows into a same-name recreate. Scenario 3 runs B
 * as a pre-stamp build (no capability bag, no stamps on the wire or in its catalog) through a drop it sees and
 * one it misses, then upgrades it. Scenario 5 checks a peer's drop never retires a `replicate: false` table;
 * scenario 6 that a node joining through a pre-stamp peer does not carry its stale definition back to the
 * dropper. Each test owns its tables. `dropTableOfflinePeer.test.mjs` runs every scenario on the default threads;
 * `dropTableOfflinePeerPool.test.mjs` runs a subset with replication on its dedicated worker pool.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import {
	startHarper,
	killHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import { sendOperation, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const ROWS_PER_NODE = 20;
// Replication has no "nothing more is coming" signal, so a check that something did NOT arrive
// waits this long after both directions report connected.
const SETTLE_MS = 5000;
// A single probe outside a wait still must not outlive a node that accepts the request and never answers.
const PROBE_MS = 30000;
const FIXTURES = import.meta.dirname ?? new URL('.', import.meta.url).pathname;

async function postOperation(node, operation, signal) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
		signal,
	});
	return { status: response.status, body: await response.json() };
}

async function tableExists(node, table, signal = AbortSignal.timeout(PROBE_MS)) {
	const described = await sendOperation(node, { operation: 'describe_database', database: 'data' }, { signal });
	return Object.hasOwn(described, table);
}

async function idsIn(node, table, signal = AbortSignal.timeout(PROBE_MS)) {
	const { status, body } = await postOperation(
		node,
		{
			operation: 'search_by_value',
			database: 'data',
			table,
			attribute: 'id',
			value: '*',
			get_attributes: ['id'],
		},
		signal
	);
	if (status !== 200) return null;
	return body.map((record) => record.id).sort();
}

/** True once `condition(signal)` is truthy, false at the deadline; the signal cancels a probe a hung node never answers. */
function waitFor(condition, maxMs = 30000, intervalMs = 300) {
	return waitForCondition((signal) => Promise.resolve(condition(signal)).catch(() => false), {
		timeoutMs: maxMs,
		pollMs: intervalMs,
	}).then(
		() => true,
		() => false
	);
}

async function waitForConnected(node, maxMs = 90000, peers = 1) {
	return waitFor(
		async (signal) => {
			const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
			return (
				status?.connections?.length >= peers &&
				status.connections.every(
					(connection) =>
						connection.database_sockets?.length > 0 && connection.database_sockets.every((socket) => socket.connected)
				)
			);
		},
		maxMs,
		500
	);
}

/** Fails unless the node runs `size` replication workers and every outbound database socket is on one of them. */
async function assertReplicationOnPool(node, size) {
	const { threads } = await sendOperation(node, { operation: 'system_information', attributes: ['threads'] });
	const pool = threads.filter((thread) => thread.name === 'replication').map((thread) => thread.threadId);
	equal(pool.length, size, `${node.hostname} runs ${pool.length} replication workers`);
	const { connections } = await sendOperation(node, { operation: 'cluster_status' });
	const sockets = connections.flatMap((connection) => connection.database_sockets);
	ok(sockets.length > 0, `${node.hostname} has no database socket`);
	for (const socket of sockets)
		ok(pool.includes(socket.threadId), `${socket.database} is on thread ${socket.threadId}, not the pool ${pool}`);
}

async function waitForBothConnected(ctx, what) {
	ok(await waitForConnected(ctx.nodeA), `A did not connect to B ${what}`);
	ok(await waitForConnected(ctx.nodeB), `B did not connect to A ${what}`);
}

function nodeConfig(hostname, { legacyPeer = false, replicationThreads } = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true },
			replication: {
				securePort: hostname + ':9933',
				databases: ['data'],
				...(replicationThreads && { threads: replicationThreads }),
			},
		},
		// A pre-#1212 peer: no NODE_NAME capability bag (the hook protocolCapabilityRegistry.test.mjs uses), so no
		// stamps on the wire, and none in its catalog.
		env: legacyPeer ? { HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1', HARPER_TEST_OMIT_TABLE_LIFECYCLE: '1' } : {},
	};
}

async function stop(node, { crash = false } = {}) {
	if (crash) {
		const harperProcess = node.process;
		ok(harperProcess.exitCode === null && harperProcess.signalCode === null, 'Harper exited before the kill');
		// Harper's SIGTERM handler exits at once, so a graceMs of 0 would still be a clean stop.
		try {
			process.kill(-harperProcess.pid, 'SIGKILL');
		} catch {
			harperProcess.kill('SIGKILL');
		}
	}
	await killHarper({ harper: node }, crash ? { graceMs: 0 } : undefined);
	if (crash) equal(node.process.signalCode, 'SIGKILL');
}

async function start(ctx, key, options) {
	const node = ctx[key];
	const restartCtx = { name: ctx.name, harper: node };
	const result = await startHarper(
		restartCtx,
		nodeConfig(node.hostname, { replicationThreads: ctx.replicationThreads, ...options })
	);
	ctx[key] = result?.harper ?? restartCtx.harper;
}

async function restartBoth(ctx, options) {
	await Promise.all([stop(ctx.nodeA, options), stop(ctx.nodeB, options)]);
	await Promise.all([start(ctx, 'nodeA'), start(ctx, 'nodeB')]);
	await waitForBothConnected(ctx, 'after restarting both');
}

async function seedConverged(ctx, table) {
	await sendOperation(ctx.nodeA, { operation: 'create_table', database: 'data', table, primary_key: 'id' });
	ok(await waitFor((signal) => tableExists(ctx.nodeB, table, signal)), `${table} did not replicate to B`);
	const expected = [];
	for (const [label, node] of [
		['a', ctx.nodeA],
		['b', ctx.nodeB],
	]) {
		const records = [];
		for (let i = 0; i < ROWS_PER_NODE; i++) {
			const id = `${label}-${String(i).padStart(3, '0')}`;
			records.push({ id, origin: label, n: i });
			expected.push(id);
		}
		await sendOperation(node, { operation: 'upsert', database: 'data', table, records });
	}
	expected.sort();
	for (const node of [ctx.nodeA, ctx.nodeB]) {
		ok(
			await waitFor(async (signal) => (await idsIn(node, table, signal))?.length === expected.length),
			`${table} did not converge on ${node.hostname}`
		);
	}
	return expected;
}

async function expectAbsentOnBoth(ctx, table, why) {
	deepEqual(
		{ a: await tableExists(ctx.nodeA, table), b: await tableExists(ctx.nodeB, table) },
		{ a: false, b: false },
		`${table} came back: ${why}`
	);
}

async function recreateEmptyOnBoth(ctx, table, why) {
	await sendOperation(ctx.nodeA, { operation: 'create_table', database: 'data', table, primary_key: 'id' });
	ok(await waitFor((signal) => tableExists(ctx.nodeB, table, signal)), `recreate of ${table} did not reach B`);
	await delay(SETTLE_MS);
	deepEqual(
		{ a: await idsIn(ctx.nodeA, table), b: await idsIn(ctx.nodeB, table) },
		{ a: [], b: [] },
		`recreated ${table} is not empty: ${why}`
	);
}

/**
 * `replicationThreads` sets `replication.threads`, so replication runs on dedicated pool workers while the
 * operations API, and every database open it causes, stays on the HTTP workers. `scenarios` names the ones to run
 * (`'1'`, `'2'`, `'2c'`, `'3'`, `'4'`, `'5'`, `'6'`; `'1'` is 1 and 1b, `'2'` is 2 and 2b); omitted, all run.
 */
export function dropTableOfflinePeerSuite({ replicationThreads, scenarios } = {}) {
	const runs = (scenario) => !scenarios || scenarios.includes(scenario);
	const name = replicationThreads
		? `drop_table with an offline peer, replication on ${replicationThreads} pool workers (harper#1212)`
		: 'drop_table with an offline peer (harper#1212)';
	suite(name, { timeout: 900000 }, (ctx) => {
		before(async () => {
			ctx.replicationThreads = replicationThreads;
			const hostnameA = await getNextAvailableLoopbackAddress();
			const hostnameB = await getNextAvailableLoopbackAddress();
			const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
			const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
			await Promise.all([
				startHarper(ctxA, nodeConfig(hostnameA, { replicationThreads })),
				startHarper(ctxB, nodeConfig(hostnameB, { replicationThreads })),
			]);
			ctx.nodeA = ctxA.harper;
			ctx.nodeB = ctxB.harper;
			// `data` only exists once it has a table; without it no database socket forms.
			for (const node of [ctx.nodeA, ctx.nodeB]) {
				await sendOperation(node, { operation: 'create_table', database: 'data', table: 'anchor', primary_key: 'id' });
			}
			await sendOperation(ctx.nodeB, {
				operation: 'add_node',
				hostname: ctx.nodeA.hostname,
				rejectUnauthorized: false,
				authorization: ctx.nodeA.admin,
			});
			await sendOperation(ctx.nodeA, {
				operation: 'add_node',
				hostname: ctx.nodeB.hostname,
				rejectUnauthorized: false,
				authorization: ctx.nodeB.admin,
			});
			await waitForBothConnected(ctx, 'at setup');
			if (replicationThreads)
				for (const node of [ctx.nodeA, ctx.nodeB]) await assertReplicationOnPool(node, replicationThreads);
		});

		after(async () => {
			await Promise.all([
				ctx.nodeA && teardownHarper({ harper: ctx.nodeA }).catch(() => {}),
				ctx.nodeB && teardownHarper({ harper: ctx.nodeB }).catch(() => {}),
				ctx.nodeJ && teardownHarper({ harper: ctx.nodeJ }).catch(() => {}),
			]);
		});

		if (runs('1'))
			for (const crash of [false, true]) {
				const label = crash ? '1b: SIGKILL' : '1: graceful';
				test(`scenario ${label}: connected drop, restart both, recreate empty`, { timeout: 300000 }, async () => {
					const table = crash ? 'dropped_then_killed' : 'dropped_everywhere';
					await seedConverged(ctx, table);

					const drop = await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table });
					equal(drop.replicated?.[0]?.status, undefined, `B did not acknowledge the drop: ${JSON.stringify(drop)}`);
					ok(
						await waitFor(async (signal) => !(await tableExists(ctx.nodeB, table, signal)), 30000, 50),
						'drop did not reach B'
					);

					await restartBoth(ctx, { crash });
					await delay(SETTLE_MS);
					await expectAbsentOnBoth(ctx, table, 'after the restart, without being recreated');

					await recreateEmptyOnBoth(ctx, table, 'pre-drop rows survived the restart');

					await restartBoth(ctx, { crash });
					await delay(SETTLE_MS);
					deepEqual(
						{ a: await idsIn(ctx.nodeA, table), b: await idsIn(ctx.nodeB, table) },
						{ a: [], b: [] },
						'recreated table repopulated after the second restart'
					);
				});
			}

		if (runs('2'))
			test(
				'scenario 2 and 2b: B offline during the drop, rejoins without the table or its rows; both restarted after',
				{ timeout: 300000 },
				async () => {
					const table = 'missed_drop';
					await seedConverged(ctx, table);

					await stop(ctx.nodeB);
					const drop = await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table });
					equal(drop.replicated?.[0]?.status, 'failed', `expected the drop RPC to B to fail: ${JSON.stringify(drop)}`);
					equal(await tableExists(ctx.nodeA, table), false);

					await start(ctx, 'nodeB');
					await waitForBothConnected(ctx, 'after B rejoined');
					ok(
						await waitFor(async (signal) => !(await tableExists(ctx.nodeB, table, signal))),
						'B kept the table it missed the drop of'
					);
					await delay(SETTLE_MS);
					await expectAbsentOnBoth(ctx, table, "B's stale definition recreated it on A, or B kept it");

					await restartBoth(ctx);
					await delay(SETTLE_MS);
					await expectAbsentOnBoth(ctx, table, 'after restarting both nodes');
					await recreateEmptyOnBoth(ctx, table, "B's pre-drop rows reached the recreated table");
				}
			);

		if (runs('2c'))
			test(
				'scenario 2c: A drops and recreates while B is offline, B rejoins without old rows',
				{ timeout: 300000 },
				async () => {
					const table = 'missed_drop_recreated';
					await seedConverged(ctx, table);

					await stop(ctx.nodeB);
					await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table });
					await sendOperation(ctx.nodeA, { operation: 'create_table', database: 'data', table, primary_key: 'id' });

					await start(ctx, 'nodeB');
					await waitForBothConnected(ctx, 'after B rejoined');
					ok(
						await waitFor(async (signal) => (await idsIn(ctx.nodeB, table, signal))?.length === 0),
						"B kept its pre-drop rows in the recreated table's name"
					);
					await sendOperation(ctx.nodeB, {
						operation: 'upsert',
						database: 'data',
						table,
						records: [{ id: 'b-new', origin: 'b', n: 1000 }],
					});
					ok(
						await waitFor(async (signal) => (await idsIn(ctx.nodeA, table, signal))?.includes('b-new')),
						'post-rejoin write did not reach A'
					);
					await delay(SETTLE_MS);
					deepEqual(
						{ a: await idsIn(ctx.nodeA, table), b: await idsIn(ctx.nodeB, table) },
						{ a: ['b-new'], b: ['b-new'] },
						'pre-drop rows leaked into the recreated table'
					);
				}
			);

		if (runs('3'))
			test(
				'scenario 3: B runs a pre-stamp build through a drop and a recreate, misses a drop, then upgrades',
				{ timeout: 400000 },
				async () => {
					const table = 'missed_drop_legacy_peer';
					const liveTable = 'recreated_while_legacy';
					const onLegacy = 'recreated_on_legacy';
					const emptyStale = 'dropped_not_recreated';

					// B as a pre-stamp build: no capability bag, no stamps on the wire, none kept in its catalog. Both
					// tables are created while it runs that build, so B's copies carry no stamp.
					await stop(ctx.nodeB);
					await start(ctx, 'nodeB', { legacyPeer: true });
					await waitForBothConnected(ctx, 'after B rejoined as a pre-stamp peer');
					const seeded = await seedConverged(ctx, table);
					await seedConverged(ctx, liveTable);
					await seedConverged(ctx, onLegacy);
					await sendOperation(ctx.nodeA, {
						operation: 'create_table',
						database: 'data',
						table: emptyStale,
						primary_key: 'id',
					});
					ok(
						await waitFor((signal) => tableExists(ctx.nodeB, emptyStale, signal)),
						`${emptyStale} did not replicate to B`
					);

					// A drops and recreates liveTable while B is connected: B applies the drop and recreates the table
					// from A's definition, so its copy is live and consistent but carries no stamp.
					await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table: liveTable });
					ok(
						await waitFor(async (signal) => !(await tableExists(ctx.nodeB, liveTable, signal))),
						'drop did not reach the pre-stamp B'
					);
					await recreateEmptyOnBoth(ctx, liveTable, 'rows survived the connected drop');
					await sendOperation(ctx.nodeA, {
						operation: 'upsert',
						database: 'data',
						table: liveTable,
						records: [{ id: 'a-after-recreate', origin: 'a', n: 1 }],
					});
					ok(
						await waitFor(async (signal) => (await idsIn(ctx.nodeB, liveTable, signal))?.includes('a-after-recreate')),
						"A's write to the recreated table did not reach the pre-stamp B"
					);

					// B itself drops and recreates a table while on the pre-stamp build: A applies the drop and keeps its
					// marker, then refuses B's unstamped recreate for as long as B runs that build.
					await sendOperation(ctx.nodeB, { operation: 'drop_table', database: 'data', table: onLegacy });
					ok(
						await waitFor(async (signal) => !(await tableExists(ctx.nodeA, onLegacy, signal))),
						"B's drop did not reach A"
					);
					await sendOperation(ctx.nodeB, {
						operation: 'create_table',
						database: 'data',
						table: onLegacy,
						primary_key: 'id',
					});
					await sendOperation(ctx.nodeB, {
						operation: 'upsert',
						database: 'data',
						table: onLegacy,
						records: [{ id: 'b-recreated-row', origin: 'b', n: 4000 }],
					});
					await delay(SETTLE_MS);
					equal(await tableExists(ctx.nodeA, onLegacy), false, "A took the pre-stamp node's unstamped recreate");

					// Now B misses two drops: a table with rows, and an empty one that is never recreated.
					await stop(ctx.nodeB);
					await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table });
					await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table: emptyStale });
					await start(ctx, 'nodeB', { legacyPeer: true });
					await waitForBothConnected(ctx, 'after the pre-stamp B rejoined');
					await delay(SETTLE_MS);
					// A pre-stamp peer never learns the drop, so it keeps its copy: the invariant is that the copy
					// cannot spread, not that it heals.
					deepEqual(
						{ a: await tableExists(ctx.nodeA, table), bRows: (await idsIn(ctx.nodeB, table))?.length },
						{ a: false, bRows: seeded.length },
						"B's stale definition recreated the table on A"
					);
					await sendOperation(ctx.nodeB, {
						operation: 'upsert',
						database: 'data',
						table,
						records: [{ id: 'b-stale-write', origin: 'b', n: 2000 }],
					});
					await delay(SETTLE_MS);
					equal(await tableExists(ctx.nodeA, table), false, "B's write to its stale copy reached A");
					// The same pre-stamp peer's writes to the live recreated table must keep replicating: a rolling
					// upgrade cannot lose a not-yet-upgraded node's writes.
					await sendOperation(ctx.nodeB, {
						operation: 'upsert',
						database: 'data',
						table: liveTable,
						records: [{ id: 'b-live-write', origin: 'b', n: 3000 }],
					});
					ok(
						await waitFor(async (signal) => (await idsIn(ctx.nodeA, liveTable, signal))?.includes('b-live-write')),
						"the pre-stamp peer's write to the live recreated table did not reach A"
					);

					// B upgrades. Its unstamped stale copy is retired; its unstamped live copy is kept and stamped.
					await stop(ctx.nodeB);
					await start(ctx, 'nodeB');
					await waitForBothConnected(ctx, 'after B rejoined on the current build');
					ok(
						await waitFor(async (signal) => !(await tableExists(ctx.nodeB, table, signal))),
						'upgraded B kept the stale table'
					);
					await delay(SETTLE_MS);
					await expectAbsentOnBoth(ctx, table, 'after the pre-stamp peer was upgraded');
					deepEqual(
						{ a: await idsIn(ctx.nodeA, liveTable), b: await idsIn(ctx.nodeB, liveTable) },
						{ a: ['a-after-recreate', 'b-live-write'], b: ['a-after-recreate', 'b-live-write'] },
						'the upgraded node lost or resurrected rows of the table it recreated on the old build'
					);
					// The table B recreated on the old build is stamped as newer than the drop and reaches A at last. The
					// rows B wrote to it while on the old build stay on B: A refused that generation's records then and
					// advanced past them (see replication/DESIGN.md item 28). New writes flow.
					ok(
						await waitFor((signal) => tableExists(ctx.nodeA, onLegacy, signal)),
						"the table recreated on the pre-stamp node did not reach A after B's upgrade"
					);
					await sendOperation(ctx.nodeB, {
						operation: 'upsert',
						database: 'data',
						table: onLegacy,
						records: [{ id: 'b-after-upgrade', origin: 'b', n: 5000 }],
					});
					ok(
						await waitFor(async (signal) => (await idsIn(ctx.nodeA, onLegacy, signal))?.includes('b-after-upgrade')),
						"a write to the table recreated on the pre-stamp node did not reach A after B's upgrade"
					);
					deepEqual(
						await idsIn(ctx.nodeB, onLegacy),
						['b-after-upgrade', 'b-recreated-row'],
						'B lost rows of the table it recreated'
					);
					// An unstamped stale copy with no row at all cannot prove it was recreated: it goes, and stays gone on A.
					ok(
						await waitFor(async (signal) => !(await tableExists(ctx.nodeB, emptyStale, signal))),
						'upgraded B kept an empty stale copy'
					);
					await delay(SETTLE_MS);
					await expectAbsentOnBoth(ctx, emptyStale, 'an empty stale copy on the upgraded node brought the table back');
				}
			);

		if (runs('4'))
			test('scenario 4: a drop the client asked not to replicate stays local', { timeout: 300000 }, async () => {
				const table = 'dropped_locally';
				const seeded = await seedConverged(ctx, table);
				await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table, replicated: false });
				equal(await tableExists(ctx.nodeA, table), false);
				await delay(SETTLE_MS);
				equal((await idsIn(ctx.nodeB, table))?.length, seeded.length, "a local-only drop reached B's copy");
				// Peers behave exactly as before the markers existed: B's definition brings the table back to A.
				await restartBoth(ctx);
				await delay(SETTLE_MS);
				equal((await idsIn(ctx.nodeB, table))?.length, seeded.length, 'B lost its copy after a restart');
			});

		if (runs('5'))
			test(
				'scenario 5: a peer drop never retires a replicate:false table; a replicated table beside it still goes',
				{ timeout: 300000 },
				async () => {
					const localTable = 'NodeLocalDrop';
					const control = 'node_local_control';
					const deployNodeLocal = async (node, fixture) => {
						await sendOperation(node, {
							operation: 'deploy_component',
							project: 'drop-node-local',
							payload: await targz(join(FIXTURES, fixture)),
							replicated: false,
							restart: true,
						});
						ok(
							await waitFor((signal) => tableExists(node, localTable, signal), 60000),
							`${node.hostname} did not load its node-local table`
						);
						await waitForBothConnected(ctx, `after ${node.hostname} deployed its node-local table`);
					};
					await deployNodeLocal(ctx.nodeB, 'fixture-drop-node-local');
					const localIds = ['b-local-0', 'b-local-1', 'b-local-2'];
					await sendOperation(ctx.nodeB, {
						operation: 'upsert',
						database: 'data',
						table: localTable,
						records: localIds.map((id) => ({ id })),
					});
					// A's replicated table of the same name: B keeps its own declaration and never takes A's.
					await sendOperation(ctx.nodeA, {
						operation: 'create_table',
						database: 'data',
						table: localTable,
						primary_key: 'id',
					});
					await seedConverged(ctx, control);

					// B learns these drops as markers when it reconnects.
					await stop(ctx.nodeB);
					await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table: localTable });
					await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table: control });
					await start(ctx, 'nodeB');
					await waitForBothConnected(ctx, 'after B rejoined');
					ok(
						await waitFor(async (signal) => !(await tableExists(ctx.nodeB, control, signal))),
						'B kept the replicated table it missed the drop of'
					);
					await delay(SETTLE_MS);
					deepEqual(await idsIn(ctx.nodeB, localTable), localIds, "A's drop marker retired B's node-local table");

					await stop(ctx.nodeB);
					await start(ctx, 'nodeB');
					await waitForBothConnected(ctx, 'after B reconnected again');
					await delay(SETTLE_MS);
					deepEqual(
						await idsIn(ctx.nodeB, localTable),
						localIds,
						"a reconnect's drop markers retired B's node-local table"
					);

					// A connected drop reaches B as the forwarded operation instead.
					await sendOperation(ctx.nodeA, {
						operation: 'create_table',
						database: 'data',
						table: localTable,
						primary_key: 'id',
					});
					await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table: localTable });
					await delay(SETTLE_MS);
					deepEqual(await idsIn(ctx.nodeB, localTable), localIds, "A's forwarded drop retired B's node-local table");

					// A's own node-local tables: one B keeps node-local too, one B replicates. Neither drop is A's to send.
					const sourceTable = 'NodeLocalSource';
					await sendOperation(ctx.nodeB, {
						operation: 'create_table',
						database: 'data',
						table: sourceTable,
						primary_key: 'id',
					});
					await sendOperation(ctx.nodeB, {
						operation: 'upsert',
						database: 'data',
						table: sourceTable,
						records: [{ id: 'b-replicated' }],
					});
					await deployNodeLocal(ctx.nodeA, 'fixture-drop-node-local-source');
					for (const table of [localTable, sourceTable])
						await sendOperation(ctx.nodeA, {
							operation: 'upsert',
							database: 'data',
							table,
							records: [{ id: 'a-local' }],
						});
					await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table: sourceTable });
					await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table: localTable });
					await delay(SETTLE_MS);
					deepEqual(
						{ local: await idsIn(ctx.nodeB, localTable), replicated: await idsIn(ctx.nodeB, sourceTable) },
						{ local: localIds, replicated: ['b-replicated'] },
						"A's drop of its node-local tables reached B"
					);
					await expectAbsentOnBoth(ctx, control, 'the replicated control table came back');
				}
			);

		if (runs('6'))
			test(
				"scenario 6: a node joining through a pre-stamp peer does not carry that peer's stale table back to the dropper",
				{ timeout: 400000 },
				async () => {
					const table = 'joined_through_legacy';
					await stop(ctx.nodeB);
					await start(ctx, 'nodeB', { legacyPeer: true });
					await waitForBothConnected(ctx, 'after B rejoined as a pre-stamp peer');
					const seeded = await seedConverged(ctx, table);
					await stop(ctx.nodeB);
					await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table });
					await start(ctx, 'nodeB', { legacyPeer: true });
					await waitForBothConnected(ctx, 'after the pre-stamp B rejoined');

					// With A down, B's unstamped definition is the first J learns of the name.
					await stop(ctx.nodeA);
					const hostnameJ = await getNextAvailableLoopbackAddress();
					const ctxJ = { name: ctx.name, harper: { hostname: hostnameJ } };
					await startHarper(ctxJ, nodeConfig(hostnameJ, { replicationThreads }));
					ctx.nodeJ = ctxJ.harper;
					await sendOperation(ctx.nodeJ, {
						operation: 'create_table',
						database: 'data',
						table: 'anchor',
						primary_key: 'id',
					});
					await sendOperation(ctx.nodeJ, {
						operation: 'add_node',
						hostname: ctx.nodeB.hostname,
						rejectUnauthorized: false,
						authorization: ctx.nodeB.admin,
					});
					ok(
						await waitFor(async (signal) => (await idsIn(ctx.nodeJ, table, signal))?.length === seeded.length, 90000),
						"J did not take the pre-stamp peer's copy"
					);

					await start(ctx, 'nodeA');
					await sendOperation(ctx.nodeJ, {
						operation: 'add_node',
						hostname: ctx.nodeA.hostname,
						rejectUnauthorized: false,
						authorization: ctx.nodeA.admin,
					});
					ok(await waitForConnected(ctx.nodeJ, 120000, 2), 'J did not connect to both A and B');
					ok(
						await waitFor(async (signal) => !(await tableExists(ctx.nodeJ, table, signal)), 60000),
						'J kept the stale copy after learning the drop'
					);
					await delay(SETTLE_MS);
					equal(
						await tableExists(ctx.nodeA, table),
						false,
						"J's copy of the stale definition recreated the table on A"
					);
				}
			);
	});
}
