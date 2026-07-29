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
 * What this spec pins (HARD ASSERTIONS, the durable regression value):
 *
 * (a) Is B's stale peer state durable across a *restart* of B (re-passing B's ORIGINAL
 *     config)? And is the removal itself durable across a restart of A (the remover)?
 *     hdb_nodes is a persisted system-database table (system.hdb_nodes), not in-memory,
 *     so the expectation is: yes on both counts — restart should not change either side's
 *     answer, because nothing about the bug is restart-dependent; it's a row-persistence
 *     problem, not a process-lifetime problem. Both legs stay hard assertions.
 *
 * What this spec deliberately does NOT pin (OBSERVATIONAL ONLY):
 *
 * (b) If the name were fixed so remove_node_back actually deleted B's row for A, would
 *     that alone stop B from reconnecting? SUBSCRIPTION_REQUEST handling in
 *     replicationConnection.ts gates only on the connection-level `authorization` object
 *     captured at connect time, then (if no directional route config decides the case)
 *     falls through to a *reactive* watch on future hdb_nodes change events
 *     (`getHDBNodeTable().subscribe(authorization.name)` -> shouldCloseSendAuthWatch).
 *     There is no synchronous point-read of hdb_nodes for the requesting peer at the
 *     moment SUBSCRIPTION_REQUEST is processed. The (b) leg simulates the fixed
 *     end-state (B's hdb_nodes row for A deleted) and has B re-subscribe to A. This is
 *     a SEPARATE, currently-live bug (F-228 / D-226, its own red candidate P-535): a
 *     re-subscribe with no local record of the peer still succeeds today. That leg is
 *     therefore observational only (computed + `console.log`ed, no assertion) — pinning
 *     the observed accept would freeze a known defect into CI, and asserting the refusal
 *     it should eventually produce would fail today. It stays observational until F-228
 *     is fixed and P-535 lands its own (asserted) regression test.
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

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

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

	test('(a) A removes B; B keeps replicating after B restarts with its ORIGINAL config', async () => {
		await sendOperation(ctx.nodeA, { operation: 'remove_node', hostname: ctx.hostnameB });

		// A's own side must reflect the removal promptly (its half of remove_node is
		// unconditional: it deletes its local hdb_nodes row regardless of whether the
		// best-effort remove_node_back reached B).
		await waitUntil(async () => !(await connected(ctx.nodeA, ctx.hostnameB)) || undefined, {
			label: 'A to report B disconnected',
		});

		// Give B a beat, then prove the connection was never actually told to close on
		// B's side: a write on A should still replicate to B *before* we restart B,
		// which is the core F-225 finding restated as ground truth for this test.
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
				});
				return r.length ? r : null;
			},
			{ label: 'B still receiving writes from A right after remove_node (pre-restart)' }
		);
		equal(stillFlowing[0].value, 'while-still-connected', 'B replicated a post-removal write before any restart');

		// Now restart B, re-passing its ORIGINAL config (per the hard rule — omitting
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
			{ timeoutMs: 30000, label: 'B (post-restart) receiving writes from A' }
		);
		equal(
			afterRestart[0].value,
			'after-B-restart',
			'B reconnected to A and resumed replication after restarting with its ORIGINAL config — stale peer state is durable on disk, not just a live in-memory socket'
		);

		const bConnectedToA = await connected(ctx.nodeB, ctx.hostnameA);
		ok(bConnectedToA, 'B (post-restart) shows an active connection back to A in cluster_status');
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

	test('(b) simulated fixed end-state: deleting B row-for-A does not stop B re-subscribing to A', async () => {
		// Simulate "the one-character fix were applied and had already run" by directly
		// deleting B's hdb_nodes record for A — the exact row remove_node_back would
		// have deleted, had the operation name matched.
		const bNodesForA = await sendOperation(ctx.nodeB, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: ctx.hostnameA,
			get_attributes: ['name'],
		});
		ok(bNodesForA.length > 0, 'precondition: B still has an hdb_nodes row for A (from earlier add_node)');

		await sendOperation(ctx.nodeB, {
			operation: 'delete',
			database: 'system',
			table: 'hdb_nodes',
			ids: [ctx.hostnameA],
		});
		const afterDelete = await sendOperation(ctx.nodeB, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: ctx.hostnameA,
			get_attributes: ['name'],
		});
		equal(afterDelete.length, 0, 'B hdb_nodes row for A deleted (simulating the fixed removeNodeBack outcome)');

		// OBSERVATIONAL ONLY — NOT asserted. Whether A's SUBSCRIPTION_REQUEST handling
		// synchronously re-validates membership is a SEPARATE, currently-live bug
		// (F-228 / D-226; its own red candidate is P-535), not the F-225 blast radius
		// this spec pins. Per the code read in replicationConnection.ts,
		// SUBSCRIPTION_REQUEST only gates on the cached connect-time `authorization`
		// object and otherwise falls through to a reactive hdb_nodes watch, so today's
		// observed behavior is that A accepts B's re-subscribe. Asserting that accept
		// would freeze the defect into CI; asserting the refusal it should eventually
		// produce would fail today. So this leg just computes and logs what happened —
		// P-535 owns the asserted regression test once F-228 is fixed.
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.hostnameA,
			authorization: ctx.nodeB.admin,
			rejectUnauthorized: false,
		});

		const reconnected = await waitUntil(() => connected(ctx.nodeB, ctx.hostnameA), {
			timeoutMs: 20000,
			label: 'B reconnecting to A after re-subscribing with no local record of A',
		}).catch(() => false);
		console.log(
			`[QA-758] (b) observation: B re-subscribed to A after A's row was deleted -> reconnected=${reconnected} ` +
				'(F-228/D-226/P-535, observational only)'
		);

		let resumedValue = null;
		if (reconnected) {
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
			).catch(() => null);
			resumedValue = resumed?.[0]?.value ?? null;
		}
		console.log(
			`[QA-758] (b) observation: post-resubscribe write from A reached B -> ${resumedValue ?? '(not observed)'} ` +
				'(F-228/D-226/P-535 — SUBSCRIPTION_REQUEST has no synchronous membership re-validation today; observational only)'
		);
	});
});
