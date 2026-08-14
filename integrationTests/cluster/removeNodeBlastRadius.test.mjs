/**
 * QA-758: reciprocal remove_node and authenticated rejoin lifecycle.
 *
 * In a three-node full-replication topology, A's remove_node(B) deletes A's peer row for B and sends
 * remove_node_back naming B. B must handle that reciprocal operation by deleting its own
 * self row, which is the local "replication enabled" authority and therefore disconnects B
 * from every peer, not only A.
 *
 * The regression has three production pieces:
 *
 * - remove_node_back must be registered under the exact operation name (no trailing semicolon);
 * - reciprocal removal must persist on B, including across restart;
 * - add_node must recreate B's self row and turn its subscriptions back on without restarting.
 *   Explicitly-disabled subscription entries retain their cleanup iterator but must not take the
 *   active-entry fast path when restored membership schedules a fresh subscribe-to-node.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok, rejects } from 'node:assert';
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
	join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

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

const ip = (value = '') => (value.match(/127\.0\.0\.\d+/) || [value])[0];

async function connected(node, peerHostname) {
	const status = await sendOperation(node, { operation: 'cluster_status' });
	const conn = (status.connections ?? []).find(
		(connection) => connection.name === peerHostname || ip(connection.url) === peerHostname
	);
	return !!conn && (conn.database_sockets ?? []).some((s) => s.connected);
}

async function waitUntil(fn, { timeoutMs = 45000, pollMs = 500, label = 'condition' } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	let lastError;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			lastError = undefined;
		} catch (error) {
			lastError = error;
		}
		if (last) return last;
		await delay(pollMs);
	}
	const lastErrorMessage = lastError === undefined ? '' : `; last error: ${String(lastError)}`;
	throw new Error(`Timed out waiting for: ${label}${lastErrorMessage}`, { cause: lastError });
}

test('waitUntil retries predicate errors and reports the last one on timeout', async () => {
	let attempts = 0;
	const value = await waitUntil(
		async () => {
			attempts++;
			if (attempts === 1) throw new Error('attribute schema is not ready');
			return 'ready';
		},
		{ timeoutMs: 5000, pollMs: 1 }
	);
	equal(value, 'ready');

	await rejects(
		waitUntil(
			async () => {
				throw 'last transient response';
			},
			{ timeoutMs: 20, pollMs: 1, label: 'retryable operation' }
		),
		/Timed out waiting for: retryable operation; last error: last transient response/
	);

	attempts = 0;
	await rejects(
		waitUntil(
			async () => {
				attempts++;
				if (attempts === 1) throw new Error('stale connection error');
				return null;
			},
			{ timeoutMs: 20, pollMs: 1, label: 'eventual value' }
		),
		/^Timed out waiting for: eventual value$/
	);
});

suite('QA-758: remove_node blast radius', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		const hostnameC = await getNextAvailableLoopbackAddress();
		ctx.hostnameA = hostnameA;
		ctx.hostnameB = hostnameB;
		ctx.hostnameC = hostnameC;

		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
		const ctxC = { name: ctx.name, harper: { hostname: hostnameC } };
		await Promise.all([
			startHarper(ctxA, nodeStartOptions(ctxA.harper)).then(() => {
				ctx.nodeA = ctxA.harper;
			}),
			startHarper(ctxB, nodeStartOptions(ctxB.harper)).then(() => {
				ctx.nodeB = ctxB.harper;
			}),
			startHarper(ctxC, nodeStartOptions(ctxC.harper)).then(() => {
				ctx.nodeC = ctxC.harper;
			}),
		]);

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
		await sendOperation(ctx.nodeC, {
			operation: 'create_table',
			database: 'data',
			table: 'qa758',
			primary_key: 'id',
		});
	});

	after(async () => {
		// Never do fallible work before teardown; tear down whatever exists.
		const nodes = [ctx.nodeA, ctx.nodeB, ctx.nodeC].filter(Boolean);
		await Promise.all(nodes.map((n) => teardownHarper({ harper: n }).catch(() => {})));
	});

	test('B joins A and C in a three-node topology', async () => {
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			authorization: ctx.nodeA.admin,
			rejectUnauthorized: false,
		});
		await sendOperation(ctx.nodeC, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			authorization: ctx.nodeA.admin,
			rejectUnauthorized: false,
		});
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeC.hostname,
			authorization: ctx.nodeC.admin,
			rejectUnauthorized: false,
		});
		await waitUntil(() => connected(ctx.nodeB, ctx.hostnameA), { label: 'B connected to A' });
		await waitUntil(() => connected(ctx.nodeA, ctx.hostnameB), { label: 'A connected to B' });
		await waitUntil(() => connected(ctx.nodeB, ctx.hostnameC), { label: 'B connected to C' });
		await waitUntil(() => connected(ctx.nodeC, ctx.hostnameB), { label: 'C connected to B' });

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

	test('(a) A removes B from the three-node cluster without restarting any process', async () => {
		await sendOperation(ctx.nodeA, { operation: 'remove_node', hostname: ctx.hostnameB });

		await waitUntil(async () => !(await connected(ctx.nodeA, ctx.hostnameB)) || undefined, {
			label: 'A to report B disconnected',
		});
		await waitUntil(async () => !(await connected(ctx.nodeB, ctx.hostnameC)) || undefined, {
			label: 'B to disconnect from C when its full-replication self row is removed',
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

		const hdbNodesOnB = await sendOperation(ctx.nodeB, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: ctx.hostnameB,
			get_attributes: ['name'],
		});
		equal(hdbNodesOnB.length, 0, 'remove_node_back must delete B self row in a full-replication topology');
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

	test('(b) an authenticated add_node re-join restores replication after B has no self row', async () => {
		const bSelfRows = await sendOperation(ctx.nodeB, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: ctx.hostnameB,
			get_attributes: ['name'],
		});
		equal(bSelfRows.length, 0, 'B must begin rejoin in the real reciprocal-removal state');

		// B re-joins A with an explicit, authenticated add_node. This is an operator
		// action carrying A's admin credential, so acceptance is the expected and
		// desired outcome; the invariant being pinned is that recovery from a full
		// removal works, not anything about how A authorizes the subscription.
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.hostnameA,
			authorization: ctx.nodeA.admin,
			rejectUnauthorized: false,
		});

		const restoredSelfRows = await sendOperation(ctx.nodeB, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: ctx.hostnameB,
			get_attributes: ['name', 'replicates'],
		});
		equal(restoredSelfRows.length, 1, "add_node must recreate B's hdb_nodes self row");
		equal(restoredSelfRows[0].replicates, true, 'restored B self row must advertise full replication');
		await waitUntil(() => connected(ctx.nodeB, ctx.hostnameA), { label: 'B reconnected to A without a restart' });
		await waitUntil(() => connected(ctx.nodeB, ctx.hostnameC), { label: 'B reconnected to C without a restart' });

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
				});
				return r.length ? r : null;
			},
			{ timeoutMs: 20000, label: 'B receiving a fresh write from A after re-subscribe' }
		);
		equal(
			resumed[0].value,
			'A-still-accepts-B',
			'after an authenticated add_node re-join, a fresh write on A must replicate to B'
		);

		await sendOperation(ctx.nodeC, {
			operation: 'upsert',
			database: 'data',
			table: 'qa758',
			records: [{ id: 'post-resubscribe-c', value: 'C-restored-too' }],
		});
		const resumedFromC = await waitUntil(
			async () => {
				const r = await sendOperation(ctx.nodeB, {
					operation: 'search_by_id',
					database: 'data',
					table: 'qa758',
					ids: ['post-resubscribe-c'],
					get_attributes: ['id', 'value'],
				});
				return r.length ? r : null;
			},
			{ timeoutMs: 20000, label: 'B receiving a fresh write from C after re-subscribe' }
		);
		equal(resumedFromC[0].value, 'C-restored-too', 'restoring B membership must re-enable every peer subscription');
	});

	test('(c) reciprocal removal of B remains durable across B restart', async () => {
		await sendOperation(ctx.nodeA, { operation: 'remove_node', hostname: ctx.hostnameB });
		await waitUntil(
			async () => {
				const rows = await sendOperation(ctx.nodeB, {
					operation: 'search_by_value',
					database: 'system',
					table: 'hdb_nodes',
					search_attribute: 'name',
					search_value: ctx.hostnameB,
					get_attributes: ['name'],
				});
				return rows.length === 0;
			},
			{ label: 'B self row removed before restart' }
		);

		await killHarper({ harper: ctx.nodeB });
		ctx.nodeB = (await startHarper({ harper: ctx.nodeB }, nodeStartOptions(ctx.nodeB))).harper;

		const hdbNodesOnRestartedB = await sendOperation(ctx.nodeB, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: ctx.hostnameB,
			get_attributes: ['name'],
		});
		equal(hdbNodesOnRestartedB.length, 0, 'B self-row removal must remain durable across restart');
	});
});
