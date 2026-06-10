/**
 * Integration test: non-replicated user database alongside a replicated one (issue #301).
 *
 * Production multi-region clusters commonly run a node-local database (e.g. a render
 * job queue or per-node work queue) next to a globally replicated database for shared
 * state. `replication.databases` enumerates the databases that participate in
 * replication; anything else stays per-node. Existing cluster tests verify the
 * database-level config (replicate `data` but not `system`) and per-route
 * excludeTables, but none assert node-locality of writes to a user-defined
 * non-replicated database.
 *
 * Three nodes share `shared_db` and each owns its own `local_db`. The suite asserts:
 * writes to `local_db` on one node never surface on the others while `shared_db`
 * writes in the same instance converge normally, and that each node's `local_db.Jobs`
 * queue stays isolated when every node enqueues concurrently (the job-queue pattern;
 * cross-reference HarperFast/harper#1193).
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

const NODE_COUNT = 3;
const SHARED_DB = 'shared_db';
const LOCAL_DB = 'local_db';
// Window we wait while asserting that non-replicated data does NOT arrive. Longer than
// the convergence delays used elsewhere in this suite so a slow but successful
// replication wouldn't slip past the assertion as a false negative.
const LOCALITY_WINDOW_MS = 4000;
const LOCALITY_POLL_MS = 250;

suite('Non-replicated database', { timeout: 180000 }, (ctx) => {
	before(async () => {
		ctx.nodes = await Promise.all(
			Array(NODE_COUNT)
				.fill(null)
				.map(async () => {
					const nodeCtx = {
						name: ctx.name,
						harper: { hostname: await getNextAvailableLoopbackAddress() },
					};
					await startHarper(nodeCtx, {
						config: {
							analytics: { aggregatePeriod: -1 },
							logging: { colors: false, stdStreams: false, console: true },
							replication: {
								securePort: nodeCtx.harper.hostname + ':9933',
								// Only SHARED_DB participates in replication. LOCAL_DB stays per-node.
								databases: [SHARED_DB],
							},
						},
						env: { HARPER_NO_FLUSH_ON_EXIT: true },
					});
					return nodeCtx.harper;
				})
		);

		// Create the shared (replicated) and local (per-node) databases on every node.
		// LOCAL_DB schema won't propagate via replication, so each node must create
		// it independently.
		for (const node of ctx.nodes) {
			await sendOperation(node, { operation: 'create_database', database: SHARED_DB });
			await sendOperation(node, { operation: 'create_database', database: LOCAL_DB });
			await sendOperation(node, {
				operation: 'create_table',
				database: SHARED_DB,
				table: 'SharedTable',
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'value', type: 'String' },
				],
			});
			await sendOperation(node, {
				operation: 'create_table',
				database: LOCAL_DB,
				table: 'Jobs',
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'payload', type: 'String' },
				],
			});
		}
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('connect nodes in a star topology over the shared database', async () => {
		// Star + back-fill: each subsequent node adds node 0; node 0 then advertises
		// the others. Same pattern as fullyConnectedReplication.test.mjs.
		for (let j = 1; j < NODE_COUNT; j++) {
			await sendOperation(ctx.nodes[j], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: ctx.nodes[j].admin,
			});
		}
		// Wait until every node reports an active SHARED_DB socket on every peer.
		let retries = 0;
		while (true) {
			const responses = await Promise.all(
				ctx.nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }))
			);
			const allConnected = responses.every(
				(response) =>
					Array.isArray(response?.connections) &&
					response.connections.length >= 1 &&
					response.connections.every((conn) =>
						conn.database_sockets?.some((s) => s.connected && s.database === SHARED_DB)
					)
			);
			if (allConnected) break;
			if (retries++ > 30) {
				console.log('Cluster did not converge', JSON.stringify(responses, null, 2));
				throw new Error('Timed out waiting for SHARED_DB sockets on every node');
			}
			await delay(300);
		}
	});

	test('writes to a non-replicated database stay on origin; replicated database converges', async () => {
		const [nodeA, nodeB, nodeC] = ctx.nodes;

		// Replicated write: SharedTable on node A must reach B and C.
		await sendOperation(nodeA, {
			operation: 'insert',
			database: SHARED_DB,
			table: 'SharedTable',
			records: [{ id: 'shared-1', value: 'replicated-from-A' }],
			replicatedConfirmation: NODE_COUNT - 1,
		});
		for (const peer of [nodeB, nodeC]) {
			let response;
			let retries = 0;
			do {
				await delay(150);
				response = await sendOperation(peer, {
					operation: 'search_by_id',
					database: SHARED_DB,
					table: 'SharedTable',
					ids: ['shared-1'],
					get_attributes: ['id', 'value'],
				});
			} while (response.length === 0 && retries++ < 20);
			equal(response.length, 1, `SharedTable record should replicate to ${peer.hostname}`);
			equal(response[0].value, 'replicated-from-A');
		}

		// Non-replicated write: Jobs in LOCAL_DB on node A must NOT reach B or C.
		// We can't use replicatedConfirmation here — the local database has no
		// peers to confirm against — so just insert and rely on the locality window.
		await sendOperation(nodeA, {
			operation: 'insert',
			database: LOCAL_DB,
			table: 'Jobs',
			records: [{ id: 'job-only-on-A', payload: 'render task 1' }],
		});

		// Confirm the record IS on the origin.
		const onOrigin = await sendOperation(nodeA, {
			operation: 'search_by_id',
			database: LOCAL_DB,
			table: 'Jobs',
			ids: ['job-only-on-A'],
			get_attributes: ['id', 'payload'],
		});
		equal(onOrigin.length, 1, 'Local-DB write must be present on origin');
		equal(onOrigin[0].payload, 'render task 1');

		// Poll B and C for the full locality window. The record must never show up.
		const deadline = Date.now() + LOCALITY_WINDOW_MS;
		while (Date.now() < deadline) {
			const [onB, onC] = await Promise.all(
				[nodeB, nodeC].map((peer) =>
					sendOperation(peer, {
						operation: 'search_by_id',
						database: LOCAL_DB,
						table: 'Jobs',
						ids: ['job-only-on-A'],
						get_attributes: ['id'],
					})
				)
			);
			equal(onB.length, 0, `LOCAL_DB record leaked to ${nodeB.hostname}`);
			equal(onC.length, 0, `LOCAL_DB record leaked to ${nodeC.hostname}`);
			await delay(LOCALITY_POLL_MS);
		}
	});

	test('per-node local job queue stays isolated while shared state converges', async () => {
		// Job-queue pattern: each node enqueues a job into its own LOCAL_DB.Jobs.
		// Every node should see only the job it wrote; SHARED_DB writes from each
		// node should still converge to every peer.
		const jobIds = ctx.nodes.map((_, i) => `job-${i}`);
		const sharedIds = ctx.nodes.map((_, i) => `shared-from-${i}`);

		// Star topology (system DB doesn't replicate): leaf nodes only have 1 direct
		// peer, so we can't use a one-size-fits-all replicatedConfirmation here.
		// Rely on polling for convergence instead. Transitive forwarding through the
		// hub still gets the writes to every node — same pattern as
		// replicationTopology.test.mjs.
		await Promise.all(
			ctx.nodes.map((node, i) =>
				Promise.all([
					sendOperation(node, {
						operation: 'insert',
						database: LOCAL_DB,
						table: 'Jobs',
						records: [{ id: jobIds[i], payload: `payload-${i}` }],
					}),
					sendOperation(node, {
						operation: 'insert',
						database: SHARED_DB,
						table: 'SharedTable',
						records: [{ id: sharedIds[i], value: `from-${i}` }],
					}),
				])
			)
		);

		// SHARED_DB converges: every node must see every shared write.
		for (let i = 0; i < NODE_COUNT; i++) {
			let response;
			let retries = 0;
			do {
				await delay(150);
				response = await sendOperation(ctx.nodes[i], {
					operation: 'search_by_id',
					database: SHARED_DB,
					table: 'SharedTable',
					ids: sharedIds,
					get_attributes: ['id', 'value'],
				});
			} while (response.length < sharedIds.length && retries++ < 20);
			equal(
				response.length,
				sharedIds.length,
				`Node ${i} ${ctx.nodes[i].hostname} missing shared writes (got ${response.length}/${sharedIds.length})`
			);
		}

		// LOCAL_DB stays isolated for the full locality window: each node sees only its
		// own job, never any peer's. We only check the IDs written in this test, so the
		// `job-only-on-A` record left on node 0 by the previous test is not in scope.
		const deadline = Date.now() + LOCALITY_WINDOW_MS;
		while (Date.now() < deadline) {
			const responses = await Promise.all(
				ctx.nodes.map((node) =>
					sendOperation(node, {
						operation: 'search_by_id',
						database: LOCAL_DB,
						table: 'Jobs',
						ids: jobIds,
						get_attributes: ['id'],
					})
				)
			);
			for (let i = 0; i < NODE_COUNT; i++) {
				const ids = responses[i].map((r) => r.id);
				ok(
					ids.includes(jobIds[i]),
					`Node ${i} ${ctx.nodes[i].hostname} missing its own job ${jobIds[i]} (saw: ${ids.join(',')})`
				);
				for (let j = 0; j < NODE_COUNT; j++) {
					if (i === j) continue;
					ok(
						!ids.includes(jobIds[j]),
						`Node ${i} ${ctx.nodes[i].hostname} received peer job ${jobIds[j]} — LOCAL_DB should be isolated`
					);
				}
			}
			await delay(LOCALITY_POLL_MS);
		}
	});
});
