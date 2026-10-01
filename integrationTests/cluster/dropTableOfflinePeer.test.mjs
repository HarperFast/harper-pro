/**
 * Regression anchor for HarperFast/harper#1212, cluster half: a replicated `drop_table` must stay
 * dropped across restarts, and a peer that was offline for the drop must not bring the table or
 * its rows back when it rejoins, nor leak them into a same-name table created after the drop.
 *
 * Two nodes, bidirectional replication of `data`, rows written on both and converged before each
 * scenario. Scenarios 1/1b drop with both nodes connected and restart them (gracefully / SIGKILL).
 * Scenarios 2/2b/2c stop B first, drop (and in 2c recreate) on A, then bring B back. Scenario 3 brings
 * B back as a pre-stamp peer (no capability bag, no lifecycle stamps): it cannot learn the drop, so A must
 * refuse its stale definition and the rows it streams, and B must catch up once it runs the current build.
 * Scenario 4 checks that a drop a client asked not to replicate stays local. Each test owns its tables.
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
} from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

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

async function postOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	return { status: response.status, body: await response.json() };
}

async function tableExists(node, table) {
	const described = await sendOperation(node, { operation: 'describe_database', database: 'data' });
	return Object.hasOwn(described, table);
}

async function idsIn(node, table) {
	const { status, body } = await postOperation(node, {
		operation: 'search_by_value',
		database: 'data',
		table,
		attribute: 'id',
		value: '*',
		get_attributes: ['id'],
	});
	if (status !== 200) return null;
	return body.map((record) => record.id).sort();
}

async function waitFor(condition, maxMs = 30000, intervalMs = 300) {
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		if (await condition().catch(() => false)) return true;
		await delay(intervalMs);
	}
	return false;
}

async function waitForConnected(node, maxMs = 90000) {
	return waitFor(
		async () => {
			const status = await sendOperation(node, { operation: 'cluster_status' });
			return (
				status?.connections?.length > 0 &&
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

async function waitForBothConnected(ctx, what) {
	ok(await waitForConnected(ctx.nodeA), `A did not connect to B ${what}`);
	ok(await waitForConnected(ctx.nodeB), `B did not connect to A ${what}`);
}

function nodeConfig(hostname, { legacyPeer = false } = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true },
			replication: {
				securePort: hostname + ':9933',
				databases: ['data'],
			},
		},
		// The same hook protocolCapabilityRegistry.test.mjs uses: no NODE_NAME capability bag, and with it no
		// lifecycle stamps on the definitions this node sends, which is what a pre-#1212 peer looks like.
		env: legacyPeer ? { HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1' } : {},
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
	const result = await startHarper(restartCtx, nodeConfig(node.hostname, options));
	ctx[key] = result?.harper ?? restartCtx.harper;
}

async function restartBoth(ctx, options) {
	await Promise.all([stop(ctx.nodeA, options), stop(ctx.nodeB, options)]);
	await Promise.all([start(ctx, 'nodeA'), start(ctx, 'nodeB')]);
	await waitForBothConnected(ctx, 'after restarting both');
}

async function seedConverged(ctx, table) {
	await sendOperation(ctx.nodeA, { operation: 'create_table', database: 'data', table, primary_key: 'id' });
	ok(await waitFor(() => tableExists(ctx.nodeB, table)), `${table} did not replicate to B`);
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
			await waitFor(async () => (await idsIn(node, table))?.length === expected.length),
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
	ok(await waitFor(() => tableExists(ctx.nodeB, table)), `recreate of ${table} did not reach B`);
	await delay(SETTLE_MS);
	deepEqual(
		{ a: await idsIn(ctx.nodeA, table), b: await idsIn(ctx.nodeB, table) },
		{ a: [], b: [] },
		`recreated ${table} is not empty: ${why}`
	);
}

suite('drop_table with an offline peer (harper#1212)', { timeout: 900000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
		await Promise.all([startHarper(ctxA, nodeConfig(hostnameA)), startHarper(ctxB, nodeConfig(hostnameB))]);
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
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }).catch(() => {}),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }).catch(() => {}),
		]);
	});

	for (const crash of [false, true]) {
		const label = crash ? '1b: SIGKILL' : '1: graceful';
		test(`scenario ${label}: connected drop, restart both, recreate empty`, { timeout: 300000 }, async () => {
			const table = crash ? 'dropped_then_killed' : 'dropped_everywhere';
			await seedConverged(ctx, table);

			const drop = await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table });
			equal(drop.replicated?.[0]?.status, undefined, `B did not acknowledge the drop: ${JSON.stringify(drop)}`);
			ok(await waitFor(async () => !(await tableExists(ctx.nodeB, table)), 30000, 50), 'drop did not reach B');

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
			ok(await waitFor(async () => !(await tableExists(ctx.nodeB, table))), 'B kept the table it missed the drop of');
			await delay(SETTLE_MS);
			await expectAbsentOnBoth(ctx, table, "B's stale definition recreated it on A, or B kept it");

			await restartBoth(ctx);
			await delay(SETTLE_MS);
			await expectAbsentOnBoth(ctx, table, 'after restarting both nodes');
			await recreateEmptyOnBoth(ctx, table, "B's pre-drop rows reached the recreated table");
		}
	);

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
				await waitFor(async () => (await idsIn(ctx.nodeB, table))?.length === 0),
				"B kept its pre-drop rows in the recreated table's name"
			);
			await sendOperation(ctx.nodeB, {
				operation: 'upsert',
				database: 'data',
				table,
				records: [{ id: 'b-new', origin: 'b', n: 1000 }],
			});
			ok(
				await waitFor(async () => (await idsIn(ctx.nodeA, table))?.includes('b-new')),
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

	test(
		'scenario 3: B rejoins as a pre-stamp peer; A refuses its stale table and rows until B is upgraded',
		{ timeout: 300000 },
		async () => {
			const table = 'missed_drop_legacy_peer';
			const seeded = await seedConverged(ctx, table);
			// A table dropped and recreated while both were connected: live on both, with a marker on both.
			const liveTable = 'recreated_before_legacy_rejoin';
			await seedConverged(ctx, liveTable);
			await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table: liveTable });
			ok(await waitFor(async () => !(await tableExists(ctx.nodeB, liveTable))), 'drop did not reach B');
			await recreateEmptyOnBoth(ctx, liveTable, 'rows survived the connected drop');

			await stop(ctx.nodeB);
			await sendOperation(ctx.nodeA, { operation: 'drop_table', database: 'data', table });

			await start(ctx, 'nodeB', { legacyPeer: true });
			await waitForBothConnected(ctx, 'after B rejoined as a pre-stamp peer');
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
			// The same pre-stamp peer's writes to a table that is live on A must keep replicating: a rolling
			// upgrade cannot lose a not-yet-upgraded node's writes.
			await sendOperation(ctx.nodeB, {
				operation: 'upsert',
				database: 'data',
				table: liveTable,
				records: [{ id: 'b-live-write', origin: 'b', n: 3000 }],
			});
			ok(
				await waitFor(async () => (await idsIn(ctx.nodeA, liveTable))?.includes('b-live-write')),
				"the pre-stamp peer's write to a live recreated table did not reach A"
			);

			await stop(ctx.nodeB);
			await start(ctx, 'nodeB');
			await waitForBothConnected(ctx, 'after B rejoined on the current build');
			ok(await waitFor(async () => !(await tableExists(ctx.nodeB, table))), 'upgraded B kept the stale table');
			await delay(SETTLE_MS);
			await expectAbsentOnBoth(ctx, table, 'after the pre-stamp peer was upgraded');
		}
	);

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
});
