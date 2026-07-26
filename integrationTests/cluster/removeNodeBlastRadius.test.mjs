/**
 * QA-758: blast radius of the `remove_node_back` stray-semicolon bug (F-225).
 *
 * F-225 established that the reciprocal remove-node operation is registered as the
 * literal string 'remove_node_back;' (core-repo `replication/setNode.ts`), so it can
 * never match an incoming `operation: 'remove_node_back'` request. Consequence: when
 * A calls remove_node(B), A deletes its own hdb_nodes row for B and best-effort-sends
 * `remove_node_back` to B — which B can never handle — so B's local hdb_nodes record
 * for A, and B's live replication connection to A, are untouched.
 *
 * This test asks two questions left open by F-225:
 *
 * (a) Is the removal durable on the REMOVER across a restart of A? hdb_nodes is a
 *     persisted system-database table (system.hdb_nodes), not in-memory, so A must not
 *     resurrect B on a fresh process. That is asserted.
 *
 *     What B does after being removed is deliberately only LOGGED, never asserted. On a
 *     build where the reciprocal removal does not reach B, B keeps its row for A and keeps
 *     replicating; on a build where it does, B goes quiet. Asserting either direction would
 *     pin build-specific behavior — and asserting today's would pin a bug, turning this
 *     anchor red the moment it is fixed. The observations are printed so a reader of a CI
 *     run can still see which way the build behaved.
 *
 * (b) Re-join after removal: once B has no local record of A at all, does an explicit,
 *     authenticated `add_node` from B restore a live replicating connection? This is the
 *     operator-recovery path ("I removed the wrong node, put it back"), and it is expected
 *     to work — an authenticated add_node is a deliberate re-join, not a bypass. It is
 *     pinned here because the arms above delete membership state on both sides and nothing
 *     else in this suite asserts that re-joining from that state recovers.
 *     Deliberately NOT asserted: any claim about whether SUBSCRIPTION_REQUEST performs a
 *     synchronous membership check. This arm cannot distinguish "no such check exists"
 *     from "an authenticated add_node legitimately satisfies it", so concluding the former
 *     here would over-read the evidence.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
	startHarper,
	killHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT =
	process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ||
	join(import.meta.dirname ?? module.path, '..', '..', 'dist', 'bin', 'harper.js');

// Re-passed on every restart — see the "CRITICAL" note in the QA-758 brief: omitting
// options.config on restart wipes replication.databases and silently breaks the test.
// Plaintext port (not securePort/TLS) mirrors addNodeFullCopy.test.mjs's known-working
// 2-node add_node config — avoids TLS-handshake/CA-propagation stalls seen with securePort.
function nodeStartOptions(node) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			// stdStreams:false matches addNodeFullCopy.test.mjs (known-fast, passing 2-node
			// add_node scenario). true here, combined with the harness's baked-in debug log
			// level, was seen to produce huge PEM-dump log volume and stall connection setup
			// for 20-45s before timing out — logs still land in the per-node hdb.log file.
			logging: { colors: false, stdStreams: false, console: true },
			replication: {
				port: node.hostname + ':9933',
				securePort: null,
				databases: ['data'],
			},
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}

async function connected(node, peerHostname) {
	const status = await sendOperation(node, { operation: 'cluster_status' });
	const conn = (status.connections ?? []).find((c) => (c.name ?? c.url ?? '').includes(peerHostname));
	return !!conn && (conn.database_sockets ?? []).some((s) => s.connected);
}

async function waitUntil(fn, { timeoutMs = 45000, pollMs = 500, label = 'condition' } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await fn();
		if (last) return last;
		await delay(pollMs);
	}
	throw new Error(`Timed out waiting for: ${label}`);
}

suite('QA-758: remove_node blast radius', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		ctx.hostnameA = hostnameA;
		ctx.hostnameB = hostnameB;

		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
		await Promise.all([
			startHarper(ctxA, nodeStartOptions(ctxA.harper)),
			startHarper(ctxB, nodeStartOptions(ctxB.harper)),
		]);
		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;

		// Create the table on BOTH nodes before add_node. Diagnosed empirically: if only A
		// has the table pre-created (the addNodeFullCopy.test.mjs pattern, which tests
		// full-copy semantics and never checks cluster_status), B's `database_sockets`
		// entry for the connection it initiates never populates in cluster_status even
		// though data replication is actually flowing underneath — cluster_status just
		// isn't a reliable oracle in that configuration. Pre-creating on both sides
		// (the replicationTopology.test.mjs pattern) makes cluster_status.connected a
		// reliable signal, which this test relies on throughout.
		await sendOperation(ctx.nodeA, {
			operation: 'create_table',
			database: 'data',
			table: 'qa758',
			primary_key: 'id',
		});
		await sendOperation(ctx.nodeB, {
			operation: 'create_table',
			database: 'data',
			table: 'qa758',
			primary_key: 'id',
		});
	});

	after(async () => {
		// Never do fallible work before teardown; tear down whatever exists.
		const nodes = [ctx.nodeA, ctx.nodeB].filter(Boolean);
		await Promise.all(nodes.map((n) => teardownHarper({ harper: n }).catch(() => {})));
	});

	test('B joins A and replication works both ways it needs to (B follows A)', async () => {
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			authorization: ctx.nodeB.admin,
			rejectUnauthorized: false,
		});
		await waitUntil(() => connected(ctx.nodeB, ctx.hostnameA), { label: 'B connected to A' });
		await waitUntil(() => connected(ctx.nodeA, ctx.hostnameB), { label: 'A connected to B' });

		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'qa758',
			records: [{ id: 'seed-1', value: 'before-removal' }],
			replicatedConfirmation: 1,
		});
		const seeded = await waitUntil(
			async () => {
				const r = await sendOperation(ctx.nodeB, {
					operation: 'search_by_id',
					database: 'data',
					table: 'qa758',
					ids: ['seed-1'],
					get_attributes: ['id', 'value'],
				});
				return r.length ? r : null;
			},
			{ label: 'seed-1 replicated to B' }
		);
		equal(seeded[0].value, 'before-removal');
	});

	test('(a) A removes B: the remover drops B, and B is restarted for the arms below', async () => {
		await sendOperation(ctx.nodeA, { operation: 'remove_node', hostname: ctx.hostnameB });

		// ASSERTED: A's own side reflects the removal promptly. A's half of remove_node is
		// unconditional — it deletes its local hdb_nodes row regardless of whether the
		// best-effort remove_node_back reached B — so this holds on any build.
		await waitUntil(async () => !(await connected(ctx.nodeA, ctx.hostnameB)) || undefined, {
			label: 'A to report B disconnected',
		});
		const hdbNodesOnA = await sendOperation(ctx.nodeA, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: '*',
			get_attributes: ['name'],
		});
		ok(!hdbNodesOnA.some((r) => r.name === ctx.hostnameB), 'A must not have B in hdb_nodes after remove_node');

		// OBSERVATIONAL, NOT ASSERTED: whether B stops receiving writes. On builds where
		// the reciprocal removal does not reach B, B keeps its own hdb_nodes row for A and
		// keeps replicating; on a build where it does reach B, B should go quiet. Both are
		// logged rather than asserted, because asserting either direction would pin a
		// build-specific behavior and turn this anchor red the moment that changes.
		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'qa758',
			records: [{ id: 'post-removal-1', value: 'while-still-connected' }],
		});
		const stillFlowing = await waitUntil(
			async () => {
				const r = await sendOperation(ctx.nodeB, {
					operation: 'search_by_id',
					database: 'data',
					table: 'qa758',
					ids: ['post-removal-1'],
					get_attributes: ['id', 'value'],
				}).catch(() => []);
				return r.length ? r : null;
			},
			{ timeoutMs: 10000, label: 'B receiving a post-removal write from A (observational)' }
		).catch(() => null);
		console.log(
			`[observational] B ${stillFlowing ? 'STILL RECEIVED' : 'did not receive'} a post-removal write from A before restart`
		);

		// Restart B, re-passing its ORIGINAL config (per the hard rule — omitting
		// options.config wipes replication.databases and would falsely look like "fixed").
		// killHarper first — starting over a still-live process throws "Harper is already
		// running" (this is a genuine restart, not an in-place reconfigure).
		await killHarper({ harper: ctx.nodeB });
		ctx.nodeB = (await startHarper({ harper: ctx.nodeB }, nodeStartOptions(ctx.nodeB))).harper;

		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'qa758',
			records: [{ id: 'post-restart-1', value: 'after-B-restart' }],
		});
		const afterRestart = await waitUntil(
			async () => {
				const r = await sendOperation(ctx.nodeB, {
					operation: 'search_by_id',
					database: 'data',
					table: 'qa758',
					ids: ['post-restart-1'],
					get_attributes: ['id', 'value'],
				}).catch(() => []);
				return r.length ? r : null;
			},
			{ timeoutMs: 15000, label: 'B (post-restart) receiving writes from A (observational)' }
		).catch(() => null);
		console.log(
			`[observational] after restarting with its ORIGINAL config, B ${
				afterRestart ? 'RESUMED replication from A (stale peer state is durable on disk)' : 'stayed quiet'
			}`
		);
	});

	test('(a, mirror) the removal itself is durable across a restart of A (the remover)', async () => {
		// A already removed B in the previous test. Restart A with its original config
		// and confirm A does NOT spontaneously reconnect to B (i.e. A's hdb_nodes
		// deletion was a persisted write, not an in-memory-only side effect that a
		// fresh process would forget).
		await killHarper({ harper: ctx.nodeA });
		ctx.nodeA = (await startHarper({ harper: ctx.nodeA }, nodeStartOptions(ctx.nodeA))).harper;
		await delay(3000); // give any spurious reconnect attempt a window to appear
		const aConnectedToB = await connected(ctx.nodeA, ctx.hostnameB);
		equal(aConnectedToB, false, 'A must not show a reconnected socket to B after restarting — removal is durable on A');

		const hdbNodesOnA = await sendOperation(ctx.nodeA, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: '*',
			get_attributes: ['name'],
		});
		ok(
			!hdbNodesOnA.some((r) => r.name === ctx.hostnameB),
			'A must not have B in its persisted hdb_nodes table after restart'
		);
	});

	test('(b) an authenticated add_node re-join restores replication after B has no record of A', async () => {
		// Put B into the fully-removed end-state by deleting its hdb_nodes record for A —
		// the exact row remove_node_back would have deleted, had the operation name
		// matched. From there, an operator re-join is the documented recovery path.
		const bNodesForA = await sendOperation(ctx.nodeB, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: ctx.hostnameA,
			get_attributes: ['name'],
		});
		// Normalize to the fully-removed end state without asserting which state we started
		// from: on a build where the reciprocal removal reaches B the row is already gone,
		// on one where it does not we delete it here. Either way the arm below starts from
		// "B has no record of A", so it is agnostic to that behavior.
		console.log(`[observational] B ${bNodesForA.length > 0 ? 'still has' : 'no longer has'} an hdb_nodes row for A`);
		if (bNodesForA.length > 0) {
			await sendOperation(ctx.nodeB, {
				operation: 'delete',
				database: 'system',
				table: 'hdb_nodes',
				ids: [ctx.hostnameA],
			});
		}
		const afterDelete = await sendOperation(ctx.nodeB, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: ctx.hostnameA,
			get_attributes: ['name'],
		});
		equal(afterDelete.length, 0, 'B hdb_nodes row for A deleted (simulating the fixed removeNodeBack outcome)');

		// B re-joins A with an explicit, authenticated add_node. This is an operator
		// action carrying B's own admin credential, so acceptance is the expected and
		// desired outcome; the invariant being pinned is that recovery from a full
		// removal works, not anything about how A authorizes the subscription.
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.hostnameA,
			authorization: ctx.nodeB.admin,
			rejectUnauthorized: false,
		});

		const reconnected = await waitUntil(() => connected(ctx.nodeB, ctx.hostnameA), {
			timeoutMs: 20000,
			label: 'B reconnecting to A after re-subscribing with no local record of A',
		});
		ok(reconnected, 'B successfully re-established a connected replication socket to A');

		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'qa758',
			records: [{ id: 'post-resubscribe-1', value: 'A-still-accepts-B' }],
		});
		const resumed = await waitUntil(
			async () => {
				const r = await sendOperation(ctx.nodeB, {
					operation: 'search_by_id',
					database: 'data',
					table: 'qa758',
					ids: ['post-resubscribe-1'],
					get_attributes: ['id', 'value'],
				}).catch(() => []);
				return r.length ? r : null;
			},
			{ timeoutMs: 20000, label: 'B receiving a fresh write from A after re-subscribe' }
		);
		equal(
			resumed[0].value,
			'A-still-accepts-B',
			'after an authenticated add_node re-join, a fresh write on A must replicate to B'
		);
	});
});
