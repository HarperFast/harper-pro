/**
 * Regression anchor: a delete must not be resurrected when an offline node rejoins.
 *
 * Pins the delete/tombstone × node-restart × LWW-conflict interaction in a 2-node
 * bidirectional cluster. Existing coverage stops short of this corner:
 * replicationTopology covers online delete propagation; replicationReconnect and
 * replicationTopology cover kill → restart → catch-up but only for writes made
 * while a peer was offline, never deletes; replicationConflictDeterminism covers
 * concurrent-write LWW but only plain-field and addTo races, never delete-vs-update.
 *
 * Probe 1 — Delete-resurrection on rejoin:
 *   Key converged on both nodes. Kill B. Delete the key on A while B is offline.
 *   Restart B (re-passing its original config — without it the
 *   `replication.databases` filter is wiped and replication silently stops).
 *   After catch-up the record must be absent on BOTH nodes: B's stale surviving
 *   copy must not resurrect the key onto A.
 *
 * Probe 2 — LWW race, delete on A vs. offline update on B:
 *   Key converged on both, B killed, delete on A, B restarted and then updated
 *   while it still holds the stale copy and has not yet learned of A's delete.
 *   The update is issued strictly after the delete (sequential awaits + a restart
 *   in between, so its timestamp is unconditionally later), therefore LWW must
 *   deterministically resolve in favour of the UPDATE, on both nodes. This is
 *   asserted unconditionally — a test that accepts either winner would stay green
 *   even if LWW resolved the wrong way.
 *
 * Originating QA scenario: QA-383.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
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
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const UPDATED_AFTER_DELETE = 'probe3-v2-updated-after-delete';

/** Point lookup of `id` on `node`. Returns the record array (empty when absent). */
async function searchById(node, table, id) {
	return sendOperation(node, {
		operation: 'search_by_id',
		database: 'data',
		table,
		ids: [id],
		get_attributes: ['*'],
	});
}

/** Poll search_by_id on `node` for `id` until found or retries exhausted.
 *  Returns the record array (may be empty on timeout). */
async function pollForRecord(node, table, id, maxMs = 15000) {
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		const r = await searchById(node, table, id);
		if (r.length > 0) return r;
		await delay(300);
	}
	return [];
}

/** Poll until `id` on `node` carries `expectedValue`. Returns true on convergence. */
async function pollForValue(node, table, id, expectedValue, maxMs = 30000) {
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		const r = await searchById(node, table, id);
		if (r[0]?.value === expectedValue) return true;
		await delay(300);
	}
	return false;
}

/** Poll until `search_by_id` for `id` returns 0 results, or retries exhausted. */
async function pollForGone(node, table, id, maxMs = 15000) {
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		const r = await searchById(node, table, id);
		if (r.length === 0) return true;
		await delay(300);
	}
	return false;
}

/** Wait for cluster_status to show all database_sockets connected. */
async function waitForConnected(node, maxMs = 60000) {
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		const status = await sendOperation(node, { operation: 'cluster_status' }).catch(() => null);
		if (
			status?.connections?.length > 0 &&
			status.connections.every((c) => c.database_sockets?.length > 0 && c.database_sockets.every((s) => s.connected))
		)
			return true;
		await delay(500);
	}
	return false;
}

// Shared node-start options — replication config must be re-passed on restart.
function nodeConfig(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: {
				securePort: hostname + ':9933',
				databases: ['data'],
			},
		},
	};
}

suite('delete-resurrection on rejoin + delete-vs-update LWW', { timeout: 300000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };

		await Promise.all([startHarper(ctxA, nodeConfig(hostnameA)), startHarper(ctxB, nodeConfig(hostnameB))]);

		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;

		// Create the table on both nodes.
		for (const node of [ctx.nodeA, ctx.nodeB]) {
			await sendOperation(node, {
				operation: 'create_table',
				database: 'data',
				table: 'things',
				primary_key: 'id',
			});
		}

		// Bidirectional replication: A→B and B→A.
		// add_node from B pointing at A (B subscribes to A).
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			rejectUnauthorized: false,
			authorization: ctx.nodeA.admin,
		});
		// add_node from A pointing at B (A subscribes to B).
		await sendOperation(ctx.nodeA, {
			operation: 'add_node',
			hostname: ctx.nodeB.hostname,
			rejectUnauthorized: false,
			authorization: ctx.nodeB.admin,
		});

		// Wait for both connections to be established and carrying the 'data' DB socket.
		const aConnected = await waitForConnected(ctx.nodeA);
		const bConnected = await waitForConnected(ctx.nodeB);
		ok(aConnected, 'Node A did not form a connected cluster');
		ok(bConnected, 'Node B did not form a connected cluster');
		console.log('Cluster up — A:', ctx.nodeA.hostname, 'B:', ctx.nodeB.hostname);
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }).catch(() => {}),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }).catch(() => {}),
		]);
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Probe 1: delete-resurrection on rejoin
	// (online delete propagation is already covered by replicationTopology)
	// ──────────────────────────────────────────────────────────────────────────
	test('Probe 1: write + confirm convergence on both nodes before offline delete', async () => {
		// Fresh key for this probe.
		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'things',
			records: [{ id: 'probe2-key', value: 'probe2-v1' }],
		});

		// Wait for B to have it.
		const onB = await pollForRecord(ctx.nodeB, 'things', 'probe2-key');
		equal(onB.length, 1, 'probe2-key did not replicate to B before kill');
		console.log('Probe 1 setup: probe2-key converged on both nodes');
	});

	test('Probe 1: kill B, delete key on A, restart B — tombstone must win (no resurrection)', async () => {
		// Capture B's config before killing so we can pass it back on restart.
		const bHostname = ctx.nodeB.hostname;
		const bConfig = nodeConfig(bHostname);

		// Kill B.
		await killHarper({ harper: ctx.nodeB });
		console.log('Probe 1: B killed');

		// While B is offline, delete the key on A.
		await sendOperation(ctx.nodeA, {
			operation: 'delete',
			database: 'data',
			table: 'things',
			ids: ['probe2-key'],
		});
		// Confirm gone on A.
		const goneA = await sendOperation(ctx.nodeA, {
			operation: 'search_by_id',
			database: 'data',
			table: 'things',
			ids: ['probe2-key'],
			get_attributes: ['*'],
		});
		equal(goneA.length, 0, 'probe2-key still on A after delete while B offline');
		console.log('Probe 1: deleted on A while B offline — key gone on A');

		// Restart B with original config (critical: without config, replication.databases is wiped).
		const ctxForRestart = { name: ctx.name, harper: ctx.nodeB };
		const result = await startHarper(ctxForRestart, bConfig);
		ctx.nodeB = result.harper ?? ctxForRestart.harper;
		console.log('Probe 1: B restarted');

		// Wait for B to reconnect to A.
		const bReconnected = await waitForConnected(ctx.nodeB);
		ok(bReconnected, 'B did not reconnect to A after restart');
		console.log('Probe 1: B reconnected to A');

		// Allow catch-up time: poll B for the key to go away. The hard assertions
		// below judge the outcome; this only bounds the wait.
		await pollForGone(ctx.nodeB, 'things', 'probe2-key', 20000);

		// Check A — did B resurrect it?
		const onAAfter = await sendOperation(ctx.nodeA, {
			operation: 'search_by_id',
			database: 'data',
			table: 'things',
			ids: ['probe2-key'],
			get_attributes: ['*'],
		});

		const onBAfter = await sendOperation(ctx.nodeB, {
			operation: 'search_by_id',
			database: 'data',
			table: 'things',
			ids: ['probe2-key'],
			get_attributes: ['*'],
		});

		console.log('Probe 1 results — key on A:', onAAfter.length, 'key on B:', onBAfter.length);

		equal(
			onAAfter.length,
			0,
			`probe2-key resurrected on A after B rejoined — B's stale copy overrode the tombstone: ${JSON.stringify(onAAfter)}`
		);
		equal(
			onBAfter.length,
			0,
			`probe2-key still on B after catch-up — tombstone not applied: ${JSON.stringify(onBAfter)}`
		);
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Probe 2: LWW — delete on A vs. offline update on B
	// ──────────────────────────────────────────────────────────────────────────
	test('Probe 2: write + converge probe3-key', async () => {
		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'things',
			records: [{ id: 'probe3-key', value: 'probe3-v1' }],
		});
		const onB = await pollForRecord(ctx.nodeB, 'things', 'probe3-key');
		equal(onB.length, 1, 'probe3-key did not replicate to B before probe 2');
		console.log('Probe 2 setup: probe3-key converged on both nodes');
	});

	test('Probe 2: kill B, delete on A, restart B and update on B — later update must win by LWW', async () => {
		const bHostname = ctx.nodeB.hostname;
		const bConfig = nodeConfig(bHostname);

		// Kill B.
		await killHarper({ harper: ctx.nodeB });
		console.log('Probe 2: B killed');

		// Record timestamp of delete on A, then delete.
		const deleteTs = Date.now();
		await sendOperation(ctx.nodeA, {
			operation: 'delete',
			database: 'data',
			table: 'things',
			ids: ['probe3-key'],
		});
		console.log('Probe 2: deleted probe3-key on A at', deleteTs);

		// Restart B with original config.
		const ctxForRestart = { name: ctx.name, harper: ctx.nodeB };
		const result = await startHarper(ctxForRestart, bConfig);
		ctx.nodeB = result.harper ?? ctxForRestart.harper;
		console.log('Probe 2: B restarted');

		// Update probe3-key on B while it still holds the stale copy, before it has
		// learned of A's delete. The restart above already puts this well after
		// deleteTs; assert the ordering rather than assume it, since the whole point
		// of the probe is that the LATER write must win.
		const updateTs = Date.now();
		ok(
			updateTs > deleteTs,
			`precondition: update (${updateTs}) must be strictly later than delete (${deleteTs}) for LWW to favour it`
		);

		const updateResult = await sendOperation(ctx.nodeB, {
			operation: 'update',
			database: 'data',
			table: 'things',
			records: [{ id: 'probe3-key', value: UPDATED_AFTER_DELETE }],
		});
		// Precondition: B must genuinely have applied the update off its stale copy.
		// If B rejected it, the LWW race below never happened and a pass would be vacuous.
		ok(
			updateResult?.update_hashes?.includes('probe3-key'),
			`precondition: update of probe3-key on B must succeed while B holds the stale copy — got ${JSON.stringify(updateResult)}`
		);
		console.log('Probe 2: update on B at', updateTs, '— result:', JSON.stringify(updateResult));

		// Wait for reconnection and catch-up.
		const bReconnected = await waitForConnected(ctx.nodeB);
		ok(bReconnected, 'B did not reconnect to A after restart in probe 2');

		// The update is strictly later than the delete, so LWW must converge BOTH
		// nodes onto the updated record. Poll for that state rather than sleeping a
		// fixed interval; the assertions below then report whatever it settled on.
		const converged = await pollForValue(ctx.nodeA, 'things', 'probe3-key', UPDATED_AFTER_DELETE, 30000);

		const onAFinal = await searchById(ctx.nodeA, 'things', 'probe3-key');
		const onBFinal = await searchById(ctx.nodeB, 'things', 'probe3-key');

		console.log('Probe 2 LWW results:');
		console.log('  deleteTs:', deleteTs, 'updateTs:', updateTs, 'delta:', updateTs - deleteTs, 'ms');
		console.log('  A:', JSON.stringify(onAFinal));
		console.log('  B:', JSON.stringify(onBFinal));

		ok(
			converged,
			`LWW resolved against the later write: the update (${updateTs}) is later than the delete (${deleteTs}) but A did not converge on the updated record — A: ${JSON.stringify(onAFinal)}`
		);
		equal(onAFinal.length, 1, `A must hold the updated record — got ${JSON.stringify(onAFinal)}`);
		equal(onBFinal.length, 1, `B must hold the updated record — got ${JSON.stringify(onBFinal)}`);
		equal(onAFinal[0].value, UPDATED_AFTER_DELETE, 'A converged on the wrong value');
		equal(onBFinal[0].value, UPDATED_AFTER_DELETE, 'B converged on the wrong value — nodes disagree after LWW');
		console.log('Probe 2: UPDATE won on both nodes — EXPECTED (update has the later timestamp)');
	});
});
