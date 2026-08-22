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
 *  - PRECONDITION (non-vacuous, hard-asserted, not just logged): B emits a new reload marker
 *    debug line after the join (`logging.level: 'debug'`), and A<->B replication was genuinely
 *    live and bidirectional (real data round trip) before the join.
 *  - DEFECT DETECTOR: no `1008` / "Unauthorized database subscription" close anywhere after the
 *    join; A<->B per-database sockets stay `connected:true` throughout the join window; every
 *    write issued on A and B during the join window arrives on the other side (bidirectional
 *    key-set comparison, not counts).
 *  - POSITIVE CONTROL: `remove_node` still genuinely de-authorizes -- proves the gate is armed,
 *    not disabled.
 *
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT =
	process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ||
	join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DB = 'data';
const TABLE = 'qa756flow';
const UNAUTHORIZED_MARKER = 'Unauthorized database subscription';
const GATE_DEAUTH_LOG_LINE = 'hdb_nodes no longer authorizes';
const RELOAD_MARKER_LOG_LINE = 'hdb_nodes reload marker received; rescanning known nodes';
const EXPECTED_SOCKET_DATABASES = ['system'];

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
	return sendOperation(node, { operation: 'cluster_status' });
}
function socketsToPeer(status, peerIp) {
	for (const c of status?.connections || []) {
		if (ip(c.url) === peerIp || c.name === peerIp) return c.database_sockets || [];
	}
	return [];
}
function expectedSocketsConnected(status, peerIp) {
	const sockets = socketsToPeer(status, peerIp);
	return EXPECTED_SOCKET_DATABASES.every((database) =>
		sockets.some((socket) => socket.database === database && socket.connected === true)
	);
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
					startHarper(cA, meshConfig(A, [{ hostname: B, port: 9933 }])).then(() => {
						ctx.nodeA = cA.harper;
					}),
					startHarper(cB, meshConfig(B, [{ hostname: A, port: 9933 }])).then(() => {
						ctx.nodeB = cB.harper;
					}),
					startHarper(cC, newPeerConfig(C)).then(() => {
						ctx.nodeC = cC.harper;
					}),
				]);

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
				const { nodeA, nodeB, nodeC, A } = ctx;

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
				const [missingOnBBeforeJoin, missingOnABeforeJoin] = await Promise.all([
					waitForAll(nodeB, [preA], { timeoutMs: 30000 }),
					waitForAll(nodeA, [preB], { timeoutMs: 30000 }),
				]);
				ok(
					missingOnBBeforeJoin.length === 0,
					`precondition: A->B must be live before the join; missing on B: ${missingOnBBeforeJoin}`
				);
				ok(
					missingOnABeforeJoin.length === 0,
					`precondition: B->A must be live before the join; missing on A: ${missingOnABeforeJoin}`
				);
				console.log('[QA756] precondition satisfied: A<->B bidirectional replication confirmed live before join');

				let statusB0;
				const socketsReadyDeadline = Date.now() + 30000;
				do {
					statusB0 = await clusterStatus(nodeB);
					if (expectedSocketsConnected(statusB0, A)) break;
					await delay(250);
				} while (Date.now() < socketsReadyDeadline);

				const socketsB0 = socketsToPeer(statusB0, A);
				if (!expectedSocketsConnected(statusB0, A)) {
					console.log('[QA756] pre-join B->A sockets:', JSON.stringify(socketsB0));
				}
				ok(
					expectedSocketsConnected(statusB0, A),
					'precondition: B must have a connected system database subscription to A before the join'
				);

				// Baseline logs, taken right before the join, so the "no 1008" check below only covers
				// activity the join itself could have caused.
				const [preJoinLogA, preJoinLogB, preJoinLogC] = await Promise.all([
					readLog(nodeA),
					readLog(nodeB),
					readLog(nodeC),
				]);
				ok(
					!preJoinLogA.includes(UNAUTHORIZED_MARKER) &&
						!preJoinLogB.includes(UNAUTHORIZED_MARKER) &&
						!preJoinLogC.includes(UNAUTHORIZED_MARKER),
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
				// cluster_status poll watching B's pre-existing subscription to A the whole time.
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
					const sb = await clusterStatus(nodeB);
					statusSamples.push({
						t: Date.now(),
						bToA: socketsToPeer(sb, A),
					});
					i++;
					await delay(300);
				}
				console.log(`[QA756] wrote ${idsFromA.length} records each from A and B during the join window`);

				// Give the copy + marker + any (wrongly) triggered teardown a little more time to land/settle.
				await delay(5000);

				// DEFECT DETECTOR 1: every sample must contain the targeted system socket connected:true.
				const unhealthyB = statusSamples.filter((sample) =>
					EXPECTED_SOCKET_DATABASES.some(
						(database) => !sample.bToA.some((socket) => socket.database === database && socket.connected === true)
					)
				);
				if (unhealthyB.length) {
					console.log('[QA756] UNHEALTHY SAMPLES b->a:', JSON.stringify(unhealthyB));
				}
				ok(
					unhealthyB.length === 0,
					'B->A system database socket must stay present and connected for the whole join window'
				);

				// DEFECT DETECTOR 2: bidirectional key-set -- every id written on A during the window
				// arrives on B, and every id written on B arrives on A (not just matching counts).
				const [missingOnB, missingOnA] = await Promise.all([
					waitForAll(nodeB, idsFromA, { timeoutMs: 60000 }),
					waitForAll(nodeA, idsFromB, { timeoutMs: 60000 }),
				]);
				ok(
					missingOnB.length === 0,
					`all ${idsFromA.length} A-origin writes must reach B; missing: ${missingOnB.join(', ')}`
				);
				ok(
					missingOnA.length === 0,
					`all ${idsFromB.length} B-origin writes must reach A; missing: ${missingOnA.join(', ')}`
				);

				// PRECONDITION 2 (non-vacuous): B must emit a new reload marker after the join.
				let logB = await readLog(nodeB);
				const markerDeadline = Date.now() + 30000;
				while (!logB.slice(preJoinLogB.length).includes(RELOAD_MARKER_LOG_LINE) && Date.now() < markerDeadline) {
					await delay(250);
					logB = await readLog(nodeB);
				}
				ok(
					logB.slice(preJoinLogB.length).includes(RELOAD_MARKER_LOG_LINE),
					`precondition: B must log a new "${RELOAD_MARKER_LOG_LINE}" after joining C`
				);
				console.log('[QA756] post-join reload marker line confirmed locally on B');

				// DEFECT DETECTOR 3: no spurious de-authorization close anywhere, at any point after the join.
				await delay(500);
				const [logA, finalLogB, logC] = await Promise.all([readLog(nodeA), readLog(nodeB), readLog(nodeC)]);
				const postJoinLogs = [
					['A', logA.slice(preJoinLogA.length)],
					['B', finalLogB.slice(preJoinLogB.length)],
					['C', logC.slice(preJoinLogC.length)],
				];
				const postJoinUnauthorized = postJoinLogs
					.filter(([, log]) => log.includes(UNAUTHORIZED_MARKER))
					.map(([name]) => name);
				if (postJoinUnauthorized.length) {
					for (const [name, log] of postJoinLogs) {
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
			{ timeout: 180000 }
		);

		test(
			'positive control: remove_node still genuinely de-authorizes a peer',
			async () => {
				const { nodeA, nodeB, A } = ctx;

				// The main scenario continuously verified B's outbound system subscription to A. Remove
				// that exact registered edge so the positive control cannot depend on a peer row that a
				// system-database base copy may have replaced on the opposite side.
				const [preRemoveLogA, preRemoveLogB] = await Promise.all([readLog(nodeA), readLog(nodeB)]);
				await sendOperation(nodeB, { operation: 'remove_node', hostname: nodeA.hostname });
				console.log('[QA756] B issued remove_node against A -- expecting genuine de-authorization this time');

				// Poll for the verified B->A system socket to disappear / disconnect.
				let disconnected = false;
				let lastSockets = [];
				for (let i = 0; i < 40 && !disconnected; i++) {
					await delay(500);
					const status = await clusterStatus(nodeB);
					lastSockets = socketsToPeer(status, A);
					// note: `every` on an empty socket list is already true (peer gone == disconnected)
					disconnected = lastSockets.every((s) => !s.connected);
				}
				ok(
					disconnected,
					`B's connection to A should tear down after remove_node; last sockets seen: ${JSON.stringify(lastSockets)}`
				);

				// The de-auth close for a genuine tombstone has one producer: B's send-auth watch, which logs
				// the warn-level "hdb_nodes no longer authorizes" line and then closes with the same
				// Unauthorized signature the reload-marker detectors above assert the absence of. Two close
				// paths race for the same sockets (the watch vs the removed peer's cooperative
				// 1008 "No longer subscribed" teardown), so poll a post-remove_node log slice for either
				// gate signature rather than sampling the full logs once.
				let sawGateDeAuth = false;
				const gateDeAuthDeadline = Date.now() + 20000;
				do {
					const [logA, logB] = await Promise.all([readLog(nodeA), readLog(nodeB)]);
					const postRemoveLogA = logA.slice(preRemoveLogA.length);
					const postRemoveLogB = logB.slice(preRemoveLogB.length);
					sawGateDeAuth =
						postRemoveLogA.includes(UNAUTHORIZED_MARKER) ||
						postRemoveLogB.includes(UNAUTHORIZED_MARKER) ||
						postRemoveLogB.includes(GATE_DEAUTH_LOG_LINE);
					if (sawGateDeAuth) break;
					await delay(250);
				} while (Date.now() < gateDeAuthDeadline);
				ok(
					sawGateDeAuth,
					`remove_node should trip the dynamic send-auth gate: no "${UNAUTHORIZED_MARKER}" close or "${GATE_DEAUTH_LOG_LINE}" warn logged after the removal (genuine de-auth, gate is still armed)`
				);

				// Full-replication remove_node_back names the remote node itself, so the reciprocal
				// operation must delete A's self row and leave replication disabled on that side.
				const aSelfRows = await sendOperation(nodeA, {
					operation: 'search_by_value',
					database: 'system',
					table: 'hdb_nodes',
					search_attribute: 'name',
					search_value: A,
					get_attributes: ['name'],
				});
				equal(
					aSelfRows.length,
					0,
					'remove_node_back must delete A self row after B removes A from a full-replication topology'
				);
			},
			{ timeout: 60000 }
		);
	}
);
