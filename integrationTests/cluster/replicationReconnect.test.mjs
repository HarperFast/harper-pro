/**
 * Replication reconnect / teardown tests
 *
 * Regression coverage for `NodeReplicationConnection`'s separation of
 * intentional teardowns (user-driven `unsubscribe()` / empty-subscription
 * delayed close) from transient protocol-level closes. The former should
 * cleanly disappear from `cluster_status`; the latter should retry instead of
 * staying silently dead.
 *
 * What is and isn't covered:
 *   - Covered: full add_node → cluster_status connected → remove_node → cleanly
 *     gone → re-add → cluster_status connected again. Exercises the
 *     `intentionallyUnsubscribed` path through `unsubscribe()` and the
 *     re-subscription path that previously could short-circuit on a stale
 *     `dbReplicationWorkers` entry.
 *   - Covered: kill + restart of a peer recovers replication. Exercises the
 *     generic retry path on TCP-level close (code 1006). Existing topology
 *     test asserts data flow; this one additionally asserts cluster_status
 *     returns to connected.
 *   - NOT covered: forcing one of the in-`replicateOverWS` `close(...)`
 *     paths (peer DISCONNECT, invalid sequence id, node-name-mismatch, auth
 *     after open). The harness has no fault-injection hook for those today.
 *     A follow-up issue tracks adding one.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import {
	killHarper,
	startHarper,
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

const NODE_COUNT = 2;
const RECONNECT_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 200;

async function waitForConnected(node, expectedConnectionCount, expectAllConnected = true) {
	const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
	let lastStatus;
	while (Date.now() < deadline) {
		lastStatus = await sendOperation(node, { operation: 'cluster_status' });
		if (lastStatus.connections.length === expectedConnectionCount) {
			if (!expectAllConnected) return lastStatus;
			const allConnected = lastStatus.connections.every(
				(conn) => conn.database_sockets.length > 0 && conn.database_sockets.every((socket) => socket.connected === true)
			);
			if (allConnected) return lastStatus;
		}
		await delay(POLL_INTERVAL_MS);
	}
	throw new Error(
		`Timed out waiting for cluster_status: wanted ${expectedConnectionCount} connection(s)` +
			(expectAllConnected ? ' all connected' : '') +
			`, got ${JSON.stringify(lastStatus)}`
	);
}

suite('Replication Reconnect', { timeout: 120000 }, (ctx) => {
	before(async () => {
		ctx.nodes = await Promise.all(
			Array(NODE_COUNT)
				.fill(null)
				.map(async () => {
					const nodeCtx = {
						name: ctx.name,
						harper: {
							hostname: await getNextAvailableLoopbackAddress(),
						},
					};
					await startHarper(nodeCtx, {
						config: {
							analytics: { aggregatePeriod: -1 },
							logging: { colors: false, stdStreams: true, console: true },
							replication: {
								securePort: nodeCtx.harper.hostname + ':9933',
								databases: ['data'],
							},
						},
					});
					return nodeCtx.harper;
				})
		);
		await Promise.all(
			ctx.nodes.map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					table: 'test',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				})
			)
		);
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('remove_node tears down cleanly and re-add reconnects', async () => {
		// Step 1: establish replication node1 -> node0
		await sendOperation(ctx.nodes[1], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodes[0].hostname,
			authorization: ctx.nodes[1].admin,
		});
		await waitForConnected(ctx.nodes[1], 1);

		// Step 2: remove the node. This exercises `unsubscribe()` -> sets
		// `intentionallyUnsubscribed = true` on the connection -> close handler's
		// terminal branch -> connection should disappear from cluster_status.
		// If the refactor broke the intentional path, the connection would either
		// stay in cluster_status with connected:false (looping retries) or fail
		// to disappear.
		await sendOperation(ctx.nodes[1], {
			operation: 'remove_node',
			hostname: ctx.nodes[0].hostname,
		});
		const after = await waitForConnected(ctx.nodes[1], 0, false);
		equal(after.connections.length, 0, 'expected node1 to have no replication connections after remove_node');

		// Step 3: re-add. Previously a stale `dbReplicationWorkers` entry from a
		// silent close could short-circuit the resubscribe in onDatabase; verify
		// reconnection still works.
		await sendOperation(ctx.nodes[1], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodes[0].hostname,
			authorization: ctx.nodes[1].admin,
		});
		const reconnected = await waitForConnected(ctx.nodes[1], 1);
		ok(
			reconnected.connections[0].database_sockets.every((socket) => socket.connected === true),
			'expected all database_sockets to be connected after re-add'
		);
	});

	test('remove_node while peer is down stops retries permanently', async () => {
		// Ensure replication is active.
		let status = await sendOperation(ctx.nodes[1], { operation: 'cluster_status' });
		if (status.connections.length === 0) {
			await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: ctx.nodes[1].admin,
			});
			await waitForConnected(ctx.nodes[1], 1);
		}

		// Kill node0 to put node1 into the retry-connect state.
		await killHarper({ harper: ctx.nodes[0] });
		// Brief pause to let node1 detect the disconnect and schedule a retry.
		await delay(800);

		// remove_node while the peer is unreachable. This must stop all retry
		// attempts — the intentionallyUnsubscribed guard in connect() ensures the
		// pending retry timer fires but returns immediately rather than opening a
		// new socket.
		await sendOperation(ctx.nodes[1], {
			operation: 'remove_node',
			hostname: ctx.nodes[0].hostname,
		});
		const afterRemove = await waitForConnected(ctx.nodes[1], 0, false);
		equal(afterRemove.connections.length, 0, 'expected 0 connections immediately after remove_node');

		// Restart node0. If the retry loop was not properly stopped, node1 would
		// reconnect once node0 is reachable again. Verify it does not.
		ctx.nodes[0] = (await startHarper({ harper: ctx.nodes[0] })).harper;
		await delay(2000);
		status = await sendOperation(ctx.nodes[1], { operation: 'cluster_status' });
		equal(status.connections.length, 0, 'node1 must not reconnect to a removed node even after that node restarts');
	});

	test('kill + restart of peer recovers replication connectivity', async () => {
		// Assume previous test left replication active. If not, re-establish.
		let status = await sendOperation(ctx.nodes[1], { operation: 'cluster_status' });
		if (status.connections.length === 0) {
			await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: ctx.nodes[1].admin,
			});
			await waitForConnected(ctx.nodes[1], 1);
		}

		// Kill node 0. node 1's outgoing WS will see ECONNRESET / code 1006 —
		// the generic transient close path. With the refactor, this should
		// still retry (the close handler treats anything not intentionally
		// unsubscribed as retryable).
		await killHarper({ harper: ctx.nodes[0] });
		// Brief pause so the disconnect is observable before restart.
		await delay(500);

		ctx.nodes[0] = (await startHarper({ harper: ctx.nodes[0] })).harper;

		// Connectivity should restore without manual re-add. This is the
		// regression guard for "any breakage of the retry path would strand
		// the connection".
		const recovered = await waitForConnected(ctx.nodes[1], 1);
		ok(
			recovered.connections[0].database_sockets.every((socket) => socket.connected === true),
			'expected cluster_status to recover to connected after peer restart'
		);

		// And data still flows through the recovered connection.
		await sendOperation(ctx.nodes[1], {
			operation: 'upsert',
			table: 'test',
			records: [{ id: 'recovered', name: 'recovered' }],
		});
		const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
		let response;
		while (Date.now() < deadline) {
			response = await sendOperation(ctx.nodes[0], {
				operation: 'search_by_id',
				table: 'test',
				get_attributes: ['id', 'name'],
				ids: ['recovered'],
			});
			if (response.length === 1) break;
			await delay(POLL_INTERVAL_MS);
		}
		equal(response.length, 1, 'expected upsert to replicate to node0 after recovery');
		equal(response[0].name, 'recovered');
	});
});
