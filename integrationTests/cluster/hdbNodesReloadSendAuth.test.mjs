/**
 * QA-756: integration-level regression anchor for harper-pro PR #602
 * "fix(replication): stop hdb_nodes reload markers from de-authorizing live peers"
 * (merged 2026-07-22, replication/replicationConnection.ts + replication/knownNodes.ts).
 *
 * Bug being anchored: the server-side dynamic send-authorization watch in
 * replicationConnection.ts (`getHDBNodeTable().subscribe(authorization.name)` inside the
 * SUBSCRIPTION_REQUEST handler) closed the socket with `1008 Unauthorized database
 * subscription` whenever the change-stream event it received carried no `replicates` field.
 * Three legitimate event shapes carry no `replicates` for an otherwise-healthy peer: (a) a
 * whole-table `reload` marker (emitted when a copyApply base copy back-fills hdb_nodes,
 * fanned out to EVERY subscriber regardless of the id they filtered on), (b) a `patch`
 * (e.g. `add_node`'s `{ isLeader: true }`), (c) a transient decode failure. Because every
 * node that base-copies the `system` database as part of establishing a NEW leader
 * relationship emits that reload marker LOCALLY on itself once the copy is durable, and that
 * marker blasts every one of ITS OWN hdb_nodes-scoped watches (not just the one for the new
 * peer), a node that already had other live replication connections could have them torn
 * down ~1ms after the marker landed. The fix (`resolveNodeForSendAuth` in knownNodes.ts)
 * reads the authoritative row instead of the event payload: present-but-undecodable ->
 * SEND_AUTH_UNCHANGED (leave alone), clean tombstone -> de-authorize, genuine `delete` ->
 * short-circuits via `isGenuineNodeDeletion`.
 *
 * How this differs from the closest existing test, systemDbDynamicSendGate.test.mjs:
 * that test proves the dynamic gate correctly AUTHORIZES a full-replication neighbor once a
 * peer opts into directional routing (a `sub.database` matching bug, PR #572 review). It
 * never drives an actual hdb_nodes `reload` event — no node in that topology ever performs a
 * base copy. It does NOT cover PR #602 at all. systemDbExcludedPeerChurn.test.mjs churns
 * `system` via role add/remove (ordinary `put`/`delete` events on hdb_user, not hdb_nodes
 * reload markers) to prove an EXCLUDED peer never connects — the opposite property from what
 * we need here (a peer that MUST stay connected). Neither addNodeFullCopy.test.mjs nor
 * addNodeLeaderNoMeshLeak.test.mjs asserts anything about the reload marker or 1008 closes;
 * addNodeLeaderNoMeshLeak is however the shape this test borrows its topology from (a node
 * that is ALREADY meshed with a live peer independently declares a THIRD, unrelated node its
 * new leader) -- that is exactly the shape that puts a pre-existing connection at risk from a
 * self-inflicted reload marker, which is why it's used here instead of a plain "fresh node
 * joins an existing pair" topology (in that simpler shape, the reload marker only fires on
 * the brand-new joiner, which has no pre-existing connections of its own to endanger).
 *
 * Topology:
 *   A <--full-replication (boolean route, both ways)--> B     (the pre-existing live cluster)
 *   B ---- add_node { isLeader: true } against C ---->  C     (C is a brand-new, unrelated peer;
 *                                                               only `system` is replicated with
 *                                                               C, isolating the test to the
 *                                                               hdb_nodes reload-marker path)
 *
 * B pulling a full copy of C's (near-empty) `system` database still emits the hdb_nodes reload
 * marker once durable (`shouldEmitCopyReloadMarker` always fires for system tables, regardless
 * of row count) -- that marker fires LOCALLY on B, which is the same node holding the live
 * A<->B connection under test. A and B use a plain BOOLEAN config route to each other (not a
 * directional object), so their send-authorization gate falls to the DYNAMIC hdb_nodes watch
 * under test rather than being short-circuited by a static directional route.
 *
 * Assertions:
 *  - PRECONDITION (non-vacuous, hard-asserted, not just logged): the reload marker debug line
 *    actually appears in a node's log (`logging.level: 'debug'`), and A<->B replication was
 *    genuinely live and bidirectional (real data round trip) before the join.
 *  - DEFECT DETECTOR: no `1008` / "Unauthorized database subscription" close anywhere after the
 *    join; A<->B per-database sockets stay `connected:true` throughout the join window; every
 *    write issued on A and B during the join window arrives on the other side (bidirectional
 *    key-set comparison, not counts).
 *  - POSITIVE CONTROL: `remove_node` still genuinely de-authorizes -- proves the gate is armed,
 *    not disabled.
 *
 * Run:
 *   cd /home/kzyp/dev/harper-pro
 *   timeout 900 npm run test:integration -- \
 *     "integrationTests/cluster/qa-scratch/qa756-hdbnodes-reload-sendauth.test.mjs" \
 *     > /home/kzyp/dev/tmp/qa756.log 2>&1; tail -80 /home/kzyp/dev/tmp/qa756.log
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT =
	process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ||
	join(import.meta.dirname ?? module.path, '..', '..', 'dist', 'bin', 'harper.js');

const DB = 'data';
const TABLE = 'qa756flow';
const UNAUTHORIZED_MARKER = 'Unauthorized database subscription';
const RELOAD_MARKER_LOG_LINE = 'hdb_nodes reload marker received; rescanning known nodes';

function meshConfig(hostname, routes) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
			replication: { port: hostname + ':9933', securePort: null, databases: [DB, 'system'], routes },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}
// C: brand-new, unrelated node. Only `system` is replicated with it -- no `data` route at all --
// so the ONLY thing B's add_node against C exercises is the system-db base copy / reload marker.
function newPeerConfig(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
			replication: { port: hostname + ':9933', securePort: null, databases: ['system'] },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}

const ip = (u = '') => (u.match(/127\.0\.0\.\d+/) || [u])[0];
async function clusterStatus(node) {
	return sendOperation(node, { operation: 'cluster_status' }).catch((e) => ({ error: String(e) }));
}
function socketsToPeer(status, peerIp) {
	for (const c of status?.connections || []) {
		if (ip(c.url) === peerIp || c.name === peerIp) return c.database_sockets || [];
	}
	return [];
}

async function hasRecord(node, id) {
	const r = await sendOperation(node, {
		operation: 'search_by_id',
		database: DB,
		table: TABLE,
		ids: [id],
		get_attributes: ['id'],
	}).catch(() => null);
	return Array.isArray(r) && r.some((x) => x?.id === id);
}
/** Poll until every id in `ids` is present on `node`. Returns the (possibly non-empty) still-missing set. */
async function waitForAll(node, ids, { timeoutMs = 60000, pollMs = 500 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let missing = ids;
	while (Date.now() < deadline) {
		const r = await sendOperation(node, {
			operation: 'search_by_id',
			database: DB,
			table: TABLE,
			ids,
			get_attributes: ['id'],
		}).catch(() => []);
		const found = new Set((r ?? []).map((x) => x.id));
		missing = ids.filter((id) => !found.has(id));
		if (missing.length === 0) return [];
		await delay(pollMs);
	}
	return missing;
}

suite(
	'QA-756: hdb_nodes reload marker must not de-authorize live peers (PR #602 anchor)',
	{ timeout: 300000 },
	(ctx) => {
		before(
			async () => {
				const A = await getNextAvailableLoopbackAddress();
				const B = await getNextAvailableLoopbackAddress();
				const C = await getNextAvailableLoopbackAddress();
				Object.assign(ctx, { A, B, C });

				const cA = { name: ctx.name, harper: { hostname: A } };
				const cB = { name: ctx.name, harper: { hostname: B } };
				const cC = { name: ctx.name, harper: { hostname: C } };

				// A <-> B: pre-existing 2-node cluster. PLAIN BOOLEAN routes (no `replicates` object) so
				// the send-auth gate falls to the dynamic hdb_nodes watch under test, not a static
				// directional route (mirrors systemDbDynamicSendGate.test.mjs's A<->B edge).
				await Promise.all([
					startHarper(cA, meshConfig(A, [{ hostname: B, port: 9933 }])),
					startHarper(cB, meshConfig(B, [{ hostname: A, port: 9933 }])),
					startHarper(cC, newPeerConfig(C)),
				]);
				ctx.nodeA = cA.harper;
				ctx.nodeB = cB.harper;
				ctx.nodeC = cC.harper;

				await Promise.all(
					[ctx.nodeA, ctx.nodeB].map((node) =>
						sendOperation(node, {
							operation: 'create_table',
							database: DB,
							table: TABLE,
							primary_key: 'id',
							attributes: [
								{ name: 'id', type: 'ID' },
								{ name: 'name', type: 'String' },
							],
						})
					)
				);
				await delay(8000); // let A<->B sockets establish (mirrors systemDbDynamicSendGate.test.mjs)
			},
			{ timeout: 120000 }
		);

		after(
			async () => {
				await Promise.all([
					ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
					ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
					ctx.nodeC && teardownHarper({ harper: ctx.nodeC }),
				]);
			},
			{ timeout: 60000 }
		);

		test(
			'A<->B survive a hdb_nodes reload marker fired by B base-copying a new, unrelated peer C',
			async () => {
				const { nodeA, nodeB, nodeC, A, B } = ctx;

				// PRECONDITION 1 (non-vacuous): replication is genuinely LIVE and BIDIRECTIONAL before the
				// join -- a real data round trip both ways, not just a cluster_status bit.
				const preA = 'qa756-pre-a-' + Date.now();
				const preB = 'qa756-pre-b-' + Date.now();
				await sendOperation(nodeA, {
					operation: 'insert',
					database: DB,
					table: TABLE,
					records: [{ id: preA, name: preA }],
				});
				await sendOperation(nodeB, {
					operation: 'insert',
					database: DB,
					table: TABLE,
					records: [{ id: preB, name: preB }],
				});
				let missing = await waitForAll(nodeB, [preA], { timeoutMs: 30000 });
				ok(missing.length === 0, `precondition: A->B must be live before the join; missing on B: ${missing}`);
				missing = await waitForAll(nodeA, [preB], { timeoutMs: 30000 });
				ok(missing.length === 0, `precondition: B->A must be live before the join; missing on A: ${missing}`);
				console.log('[QA756] precondition satisfied: A<->B bidirectional replication confirmed live before join');

				const statusA0 = await clusterStatus(nodeA);
				const statusB0 = await clusterStatus(nodeB);
				ok(
					socketsToPeer(statusA0, B).some((s) => s.database === 'system' && s.connected) &&
						socketsToPeer(statusB0, A).some((s) => s.database === 'system' && s.connected),
					'precondition: A<->B system-database sockets must be connected before the join'
				);

				// Baseline logs, taken right before the join, so the "no 1008" check below only covers
				// activity the join itself could have caused.
				const preJoinLogA = await readLog(nodeA);
				const preJoinLogB = await readLog(nodeB);
				ok(
					!preJoinLogA.includes(UNAUTHORIZED_MARKER) && !preJoinLogB.includes(UNAUTHORIZED_MARKER),
					'sanity: no Unauthorized closes should exist before the join even starts'
				);

				// THE JOIN: B declares C its leader. isLeader:true forces startTime=0 -- a full copy of
				// C's (near-empty) `system` db into B. shouldEmitCopyReloadMarker always fires for system
				// tables regardless of row count, so this reliably produces the hdb_nodes reload marker
				// LOCALLY on B -- the same node holding the live A<->B connection under test.
				await sendOperation(nodeB, {
					operation: 'add_node',
					hostname: nodeC.hostname,
					authorization: nodeC.admin,
					rejectUnauthorized: false,
					isLeader: true,
				});
				console.log(
					'[QA756] B declared C its leader (add_node isLeader:true) -- triggering a system-db base copy on B'
				);

				// Concurrently: writes on BOTH pre-existing nodes during the join window, plus a
				// cluster_status poll watching the A<->B system socket the whole time.
				const idsFromA = [];
				const idsFromB = [];
				const statusSamples = [];
				const windowDeadline = Date.now() + 10000;
				let i = 0;
				while (Date.now() < windowDeadline) {
					const idA = `qa756-join-a-${i}-${Date.now()}`;
					const idB = `qa756-join-b-${i}-${Date.now()}`;
					idsFromA.push(idA);
					idsFromB.push(idB);
					await Promise.all([
						sendOperation(nodeA, {
							operation: 'insert',
							database: DB,
							table: TABLE,
							records: [{ id: idA, name: idA }],
						}),
						sendOperation(nodeB, {
							operation: 'insert',
							database: DB,
							table: TABLE,
							records: [{ id: idB, name: idB }],
						}),
					]);
					const [sa, sb] = await Promise.all([clusterStatus(nodeA), clusterStatus(nodeB)]);
					statusSamples.push({
						t: Date.now(),
						aToB: socketsToPeer(sa, B).map((s) => `${s.database}:${s.connected}`),
						bToA: socketsToPeer(sb, A).map((s) => `${s.database}:${s.connected}`),
					});
					i++;
					await delay(300);
				}
				console.log(`[QA756] wrote ${idsFromA.length} records each from A and B during the join window`);

				// Give the copy + marker + any (wrongly) triggered teardown a little more time to land/settle.
				await delay(5000);

				// DEFECT DETECTOR 1: per-database sockets must have stayed connected:true for the ENTIRE
				// sampled window -- never observed disconnected.
				const droppedA = statusSamples.filter((s) => s.aToB.some((v) => v.endsWith(':false')));
				const droppedB = statusSamples.filter((s) => s.bToA.some((v) => v.endsWith(':false')));
				if (droppedA.length || droppedB.length) {
					console.log('[QA756] DROPPED SAMPLES a->b:', JSON.stringify(droppedA));
					console.log('[QA756] DROPPED SAMPLES b->a:', JSON.stringify(droppedB));
				}
				ok(droppedA.length === 0, 'A->B database sockets must stay connected:true for the whole join window');
				ok(droppedB.length === 0, 'B->A database sockets must stay connected:true for the whole join window');

				// DEFECT DETECTOR 2: bidirectional key-set -- every id written on A during the window
				// arrives on B, and every id written on B arrives on A (not just matching counts).
				const missingOnB = await waitForAll(nodeB, idsFromA, { timeoutMs: 60000 });
				ok(
					missingOnB.length === 0,
					`all ${idsFromA.length} A-origin writes must reach B; missing: ${missingOnB.join(', ')}`
				);
				const missingOnA = await waitForAll(nodeA, idsFromB, { timeoutMs: 60000 });
				ok(
					missingOnA.length === 0,
					`all ${idsFromB.length} B-origin writes must reach A; missing: ${missingOnA.join(', ')}`
				);

				// PRECONDITION 2 (non-vacuous): the reload marker must have ACTUALLY fired. Assert the
				// debug log line itself -- not a weaker proxy -- on whichever node(s) logged it.
				const [logA, logB, logC] = await Promise.all([readLog(nodeA), readLog(nodeB), readLog(nodeC)]);
				const markerHits = [
					logA.includes(RELOAD_MARKER_LOG_LINE) && 'A',
					logB.includes(RELOAD_MARKER_LOG_LINE) && 'B',
					logC.includes(RELOAD_MARKER_LOG_LINE) && 'C',
				].filter(Boolean);
				if (markerHits.length === 0) {
					console.log(
						'[QA756] *** could NOT find the reload-marker debug line on any node; this precondition is ' +
							'UNVERIFIED (not merely weaker-asserted) -- treat the anchor as inconclusive, not green-by-default ***'
					);
				} else {
					console.log(`[QA756] reload marker line confirmed on: ${markerHits.join(', ')}`);
				}
				ok(
					markerHits.length > 0,
					`precondition: "${RELOAD_MARKER_LOG_LINE}" must appear in at least one node's log (the join must ` +
						`actually have driven a copyApply base copy) -- found on none, so this cannot be treated as a non-vacuous anchor`
				);

				// DEFECT DETECTOR 3: no spurious de-authorization close anywhere, at any point after the join.
				const postJoinUnauthorized = [
					logA.includes(UNAUTHORIZED_MARKER) && 'A',
					logB.includes(UNAUTHORIZED_MARKER) && 'B',
					logC.includes(UNAUTHORIZED_MARKER) && 'C',
				].filter(Boolean);
				if (postJoinUnauthorized.length) {
					for (const [name, log] of [
						['A', logA],
						['B', logB],
						['C', logC],
					]) {
						for (const line of log.split('\n')) {
							if (line.includes(UNAUTHORIZED_MARKER)) console.log(`[QA756] UNAUTHORIZED CLOSE on ${name}: ${line}`);
						}
					}
				}
				equal(
					postJoinUnauthorized.length,
					0,
					`no node should log "${UNAUTHORIZED_MARKER}" after the join; found on: ${postJoinUnauthorized.join(', ')}`
				);
			},
			{ timeout: 120000 }
		);

		test(
			'positive control: remove_node still genuinely de-authorizes a peer',
			async () => {
				const { nodeA, nodeB, B } = ctx;

				await sendOperation(nodeA, { operation: 'remove_node', hostname: nodeB.hostname });
				console.log('[QA756] A issued remove_node against B -- expecting genuine de-authorization this time');

				// Poll for the A->B system socket to disappear / disconnect.
				let disconnected = false;
				let lastSockets = [];
				for (let i = 0; i < 40 && !disconnected; i++) {
					await delay(500);
					const status = await clusterStatus(nodeA);
					lastSockets = socketsToPeer(status, B);
					// note: `every` on an empty socket list is already true (peer gone == disconnected)
					disconnected = lastSockets.every((s) => !s.connected);
				}
				ok(
					disconnected,
					`A's connection to B should tear down after remove_node; last sockets seen: ${JSON.stringify(lastSockets)}`
				);

				// The gate should log the SAME Unauthorized-close signature, this time for a genuine
				// tombstone rather than a reload marker -- confirms this is the same code path, correctly armed.
				const [logA, logB] = await Promise.all([readLog(nodeA), readLog(nodeB)]);
				ok(
					logA.includes(UNAUTHORIZED_MARKER) || logB.includes(UNAUTHORIZED_MARKER),
					'remove_node should produce the same "Unauthorized database subscription" close signature (genuine de-auth, gate is still armed)'
				);

				// NOTE (deliberately observed, NOT asserted): whether B stays removed afterwards is a
				// SEPARATE, currently-broken property and is not part of this anchor. `setNode.ts` sends
				// `operation: 'remove_node_back'` to the removed peer, but the peer registers that
				// operation as `'remove_node_back;'` (stray trailing semicolon, setNode.ts:357), so the
				// reciprocal removal always fails "Operation not found" — caught and only warn-logged.
				// B therefore keeps its own hdb_nodes record for A, reconnects, and briefly replicates
				// again. Pinning that here would freeze the bug; it is tracked separately and this leg
				// stays observational until the one-character fix lands.
				const postRemovalId = 'qa756-post-removal-' + Date.now();
				await sendOperation(nodeA, {
					operation: 'insert',
					database: DB,
					table: TABLE,
					records: [{ id: postRemovalId, name: postRemovalId }],
				});
				await delay(6000);
				const arrivedAfterRemoval = await hasRecord(nodeB, postRemovalId);
				console.log(
					`[QA756] post-removal write reached B: ${arrivedAfterRemoval} (observational only; see remove_node_back registration typo)`
				);
			},
			{ timeout: 60000 }
		);
	}
);
