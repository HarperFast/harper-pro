/**
 * SCOPE — read first (what this pins, and what it does NOT).
 *   PINS: the general guarantees around harper-pro#431 / PR #523 that ARE black-box observable —
 *   across repeated genuine SIGKILL + restart churn under write/admin load on a 6-database
 *   fan-out, the connected bit never wedges stuck-false, never reports a false green (recovery is
 *   proven by a real data round-trip, not by the bit), and recovery still holds when the outage is
 *   held past WEDGE_RECONCILE_THRESHOLD_MS (30s) so the disruptive `findWedgedNodeUrls` net fires
 *   (asserted to fire, with #525's structured telemetry present).
 *   DOES NOT PIN: #523's actual up-correction path. `connectedToNode()` only fires on WS 'open'
 *   when `this.nodeSubscriptions` is already populated (replicationConnection.ts:1388), which is
 *   only unset for a FRESH connection object (built by wedge-reconcile's `forceResubscribe`, not a
 *   routine reconnect). The correction line "Corrected replication connection state
 *   (disconnected -> up)" was NOT observed in any run — the race window is sub-millisecond (WS
 *   handshake vs async subscribe()) and there is no fault-injection hook for it. That path's only
 *   coverage remains unitTests/replication/reconcileEntryWithTruth.test.mjs. Deterministic
 *   end-to-end coverage would need a test-only hook mirroring `armReplicationWedgeForTest` /
 *   `maybeStallCopyForTest`. The log evidence is therefore reported, never asserted — do not
 *   "strengthen" it into an assertion, it would flake.
 */
/**
 * QA-587: does the replication "connected bit" reconcile UP from shared-memory truth,
 * or can it wedge stuck at connected:false?
 *
 * Regression anchor for harper-pro PR #523 "fix(replication): reconcile connected bit UP
 * from shared-memory truth; log corrections (#431)" (merged 2026-07-21, commit 3157984c),
 * plus follow-ups 68887089 ("route W1 up-correction through connectedToNode restore path")
 * and 3a780724 ("structured fire telemetry for recovery nets").
 *
 * harper-pro SHA: 86f2955e ("feat: Sync Core (#607)")
 * core submodule SHA: cda8d63f6 ("Fix indentation drift in getStringPrefixUpperBound")
 *
 * Background (replication/subscriptionManager.ts):
 *   `connectionReplicationMap`'s per-(url,database) `entry.connected` is an EDGE-TRIGGERED
 *   bit, flipped by the 'connected-to-node' / 'disconnected-from-node' worker->main IPC
 *   messages. It is distinct from the shared-memory TRUTH the owning worker writes
 *   synchronously on WS open/close (readConnectionTruth / deriveConnectionTruth), which
 *   `cluster_status` itself already overlays onto `socket.connected` at read time (an
 *   earlier fix, #445) -- so the externally-visible cluster_status API mostly mirrors
 *   truth directly and largely MASKS the internal bit's staleness from a client's view.
 *
 *   The internal bit still matters: `findWedgedNodeUrls` keys off `entry.connected ===
 *   false` + `disconnectedAt` older than WEDGE_RECONCILE_THRESHOLD_MS (30_000ms) to force
 *   a DISRUPTIVE reconnect. Before #431, if the connect edge was lost/never processed
 *   (harper-pro#289) -- entry.connected stuck false while truth already reports connected
 *   -- nothing corrected it until that 30s wedge-reconcile fired and forcibly reconnected
 *   an already-healthy link. #431's `reconcileEntryWithTruth`, run every
 *   RECONCILE_INTERVAL_MS (5_000ms) by `reconcileWorkers()`, now corrects the bit UP in
 *   place (routed through the same `connectedToNode` restore path the real connect edge
 *   uses, per 68887089) well before the 30s threshold, avoiding the disruptive reconnect,
 *   and logs the correction:
 *     "Corrected replication connection state (disconnected -> up) from shared-memory
 *      truth for <db> from <node>: state=<n>, liveness <ms>ms ago"
 *   -- the ONLY externally-observable trace of the internal bit's state, since
 *   cluster_status's own display is already truth-derived independent of this fix.
 *
 * Technique: SIGKILL (genuine, by process group) the leader repeatedly while the follower
 * is fanned out across several databases (multiplying simultaneous reconnect-edge IPC
 * messages on the follower's main thread) and under concurrent write + admin-API load on
 * both nodes (to congest the follower's main-thread message queue) -- the same class of
 * race the shipped fix's commit message describes ("the connect edge was lost or never
 * processed"). This is a best-effort stress recipe, not a deterministic fault-injection
 * hook (none exists for this specific race in replicationConnection.ts); the hard,
 * non-blind assertions do not depend on hitting the exact race every run:
 *   1. every kill is a genuine SIGKILL (captured process exit signal) and every cycle
 *      genuinely observes connected:false via tight cluster_status polling -- proves the
 *      precondition (a real fault) actually occurred, not a no-op test.
 *   2. every cycle reconciles back to ALL database_sockets connected:true within a bound
 *      well under the 30s disruptive-wedge threshold -- proves it never wedges stuck-false.
 *   3. a fresh write after each recovery actually replicates -- proves connected:true is
 *      not a false green.
 *   4. hdb.log is inspected for the exact up-correction line; if the race was hit, its
 *      timing is cross-checked against the disruptive "Reconciling N wedged
 *      subscription(s)" line to confirm which path (graceful #431 correction vs. the old
 *      30s forced-reconnect) actually recovered the link.
 *
 * Reproduction:
 *   cd /home/kzyp/dev/harper-pro && timeout 900 npm run test:integration -- \
 *     "integrationTests/cluster/connectedBitRestartChurn.test.mjs"
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog, concurrent } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const DB_NAMES = ['data0', 'data1', 'data2', 'data3', 'data4', 'data5'];
const KILL_CYCLES = Number(process.env.HARPER_TEST_CONNECTED_BIT_KILL_CYCLES) || 3;
const POLL_INTERVAL_MS = 150;
const CONVERGENCE_TIMEOUT_MS = 25000; // well under WEDGE_RECONCILE_THRESHOLD_MS (30_000ms, subscriptionManager.ts)
const DATA_FLOW_TIMEOUT_MS = 15000;
const KILL_WAIT_MS = 15000;
const WRITE_BURST_COUNT = 150;
const WRITE_BURST_CONCURRENCY = 20;
const FLOOD_COUNT = 60;
const FLOOD_CONCURRENCY = 15;
// A first pass of this test (plain SIGKILL + immediate restart on an already-established
// subscription) converged in ~1.8s every cycle with ZERO up-correction log lines: the
// automatic retry reuses the SAME long-lived NodeReplicationConnection object, whose
// `nodeSubscriptions` was already populated by the original add_node and never gets
// cleared across a routine reconnect -- so `connectedToNode()`'s `if (this.nodeSubscriptions)`
// guard (replicationConnection.ts:1388) is always true and the edge fires cleanly every
// time. That test recipe only re-covers the ALREADY-covered normal retry path
// (replicationReconnect.test.mjs), not harper-pro#289's "connect edge lost" race.
// The race requires a FRESH connection object (new `nodeSubscriptions` populated
// asynchronously, after `connect()` -- i.e. after the WS may have already opened), which
// only happens on: (a) the very first subscribe, or (b) the wedge-reconcile's
// forceResubscribe path when a peer has been connected:false past
// WEDGE_RECONCILE_THRESHOLD_MS (30_000ms) -- `replicator.isReusableConnection` may decide
// the stale connection is not reusable and build a new one. So this pass deliberately
// holds the leader down PAST the 30s wedge threshold before restarting, to force that
// disruptive path to engage and (maybe) construct a fresh, race-eligible connection object
// right as the leader comes back -- the same conditions the task's "kill a peer... while
// subscription churn is happening" and "restart mid-catch-up" hints are gesturing at.
const WEDGE_RECONCILE_THRESHOLD_MS = 30000; // subscriptionManager.ts WEDGE_RECONCILE_THRESHOLD_MS
const RECONCILE_INTERVAL_MS = 5000; // subscriptionManager.ts RECONCILE_INTERVAL_MS (the sweep period)
// Hold the leader down long enough that the sweep CANNOT miss the threshold. 34_000 was too tight and
// flaked 1-in-3: the 30s threshold is measured from the disconnect stamp, which lands only once the peer
// notices the SIGKILL (WS close 1006), and the sweep only ticks every RECONCILE_INTERVAL_MS -- so the real
// margin was ~1-4s and a late stamp pushed the first qualifying tick past the restart. Budget the
// threshold + detection lag + two full sweep ticks.
const WEDGE_TRIGGER_WAIT_MS = WEDGE_RECONCILE_THRESHOLD_MS + 5000 + 2 * RECONCILE_INTERVAL_MS + 3000; // 48s
// Generous convergence window used by the long-outage cycle below (observed ~27.5s in a
// diagnostic run). Hoisted here (rather than a local const in the test) so the test's own
// timeout can be derived from the same budget it polls against, instead of a hand-picked
// number that can silently fall out of sync.
const GENEROUS_CONVERGENCE_TIMEOUT_MS = 90000;
// Worst case: the full outage wait, then the full convergence window, then a sequential
// post-recovery data-flow probe per database -- each of those phases can legitimately consume
// its entire budget before the assertion that would fail fires. Without summing them the test's
// own { timeout } can (and did) fire first, so the run reports a timeout instead of the
// intended false-green/wedge assertion.
const LONG_OUTAGE_TEST_TIMEOUT_MS =
	WEDGE_TRIGGER_WAIT_MS + GENEROUS_CONVERGENCE_TIMEOUT_MS + DB_NAMES.length * DATA_FLOW_TIMEOUT_MS + 20000;

function nodeStartOptions(node) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'debug' },
			replication: {
				securePort: node.hostname + ':9933',
				databases: DB_NAMES,
			},
		},
	};
}

function socketsForPeer(status, peerHostname) {
	const conn = (status?.connections ?? []).find((c) => (c.url ?? c.name ?? '').includes(peerHostname));
	return conn?.database_sockets ?? [];
}

function allDbsConnected(status, peerHostname, dbNames) {
	const sockets = socketsForPeer(status, peerHostname);
	if (sockets.length < dbNames.length) return false;
	return dbNames.every((db) => sockets.some((s) => s.database === db && s.connected === true));
}

function anyDbDisconnected(status, peerHostname) {
	const sockets = socketsForPeer(status, peerHostname);
	return sockets.some((s) => s.connected === false);
}

async function writeBurst(node, dbNames, count, concurrency, idPrefix) {
	const { execute, finish } = concurrent(() => {
		const db = dbNames[Math.floor(Math.random() * dbNames.length)];
		const id = `${idPrefix}-${Math.random().toString(36).slice(2)}`;
		return sendOperation(node, {
			operation: 'upsert',
			database: db,
			table: 'test',
			records: [{ id, name: 'load' }],
		}).catch(() => {});
	}, concurrency);
	for (let i = 0; i < count; i++) await execute();
	await finish();
}

// Extra admin-API flood against `node` itself, purely to congest its own main-thread
// message queue (HTTP worker -> main thread IPC) at the exact moment reconnect-edge
// messages are also trying to land -- widening the window for the edge-vs-truth race.
async function adminFlood(node, count, concurrency) {
	const { execute, finish } = concurrent(
		() => sendOperation(node, { operation: 'cluster_status' }).catch(() => {}),
		concurrency
	);
	for (let i = 0; i < count; i++) await execute();
	await finish();
}

// Genuine, immediate SIGKILL by process group (Harper is spawned detached / group leader
// by @harperfast/integration-testing) -- no SIGTERM grace period, matching the task's
// "kill a peer with SIGKILL" ask and avoiding a clean-shutdown close handshake.
async function sigkillNode(node, timeoutMs = KILL_WAIT_MS) {
	const proc = node.process;
	const pid = proc.pid;
	const exitPromise = new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`process ${pid} did not exit within ${timeoutMs}ms after SIGKILL`)),
			timeoutMs
		);
		proc.once('exit', (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		proc.kill('SIGKILL');
	}
	return exitPromise;
}

suite(
	'QA-587: replication connected bit never wedges stuck-false across crash-restart churn (harper-pro#431/PR#523 general guarantees)',
	{ timeout: 480000 },
	(ctx) => {
		before(async () => {
			const hostLeader = await getNextAvailableLoopbackAddress();
			const hostFollower = await getNextAvailableLoopbackAddress();
			const leaderCtx = { name: ctx.name, harper: { hostname: hostLeader } };
			const followerCtx = { name: ctx.name, harper: { hostname: hostFollower } };
			await Promise.all([
				startHarper(leaderCtx, nodeStartOptions(leaderCtx.harper)),
				startHarper(followerCtx, nodeStartOptions(followerCtx.harper)),
			]);
			ctx.leader = leaderCtx.harper;
			ctx.follower = followerCtx.harper;

			for (const db of DB_NAMES) {
				await sendOperation(ctx.leader, {
					operation: 'create_table',
					database: db,
					table: 'test',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				});
				await sendOperation(ctx.follower, {
					operation: 'create_table',
					database: db,
					table: 'test',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				});
			}
			ctx.cycles = [];
		});

		after(async () => {
			await Promise.all(
				[ctx.leader, ctx.follower].filter(Boolean).map((node) => teardownHarper({ harper: node }))
			).catch(() => null);
		});

		test(
			'setup: follower subscribes to leader across all databases and baseline data flows',
			{ timeout: 60000 },
			async () => {
				await sendOperation(ctx.follower, {
					operation: 'add_node',
					hostname: ctx.leader.hostname,
					authorization: ctx.follower.admin,
					rejectUnauthorized: false,
				});

				const deadline = Date.now() + 30000;
				let status;
				while (Date.now() < deadline) {
					status = await sendOperation(ctx.follower, { operation: 'cluster_status' });
					if (allDbsConnected(status, ctx.leader.hostname, DB_NAMES)) break;
					await delay(POLL_INTERVAL_MS);
				}
				ok(
					allDbsConnected(status, ctx.leader.hostname, DB_NAMES),
					`baseline: follower must connect to leader across all ${DB_NAMES.length} databases; last status: ${JSON.stringify(status)}`
				);

				// Prove data actually flows before any chaos (baseline, not just a bit flip).
				const marker = 'baseline-' + Date.now();
				for (const db of DB_NAMES) {
					await sendOperation(ctx.leader, {
						operation: 'upsert',
						database: db,
						table: 'test',
						records: [{ id: marker, name: 'baseline' }],
					});
				}
				for (const db of DB_NAMES) {
					let seen = false;
					const dDeadline = Date.now() + DATA_FLOW_TIMEOUT_MS;
					while (Date.now() < dDeadline) {
						const res = await sendOperation(ctx.follower, {
							operation: 'search_by_id',
							database: db,
							table: 'test',
							ids: [marker],
							get_attributes: ['id'],
						});
						if (Array.isArray(res) && res.some((r) => r.id === marker)) {
							seen = true;
							break;
						}
						await delay(200);
					}
					ok(seen, `baseline write on ${db} did not replicate to follower`);
				}
			}
		);

		test(
			'chaos: repeated genuine SIGKILL + restart under write/admin load never wedges the connected bit',
			{ timeout: 300000 },
			async () => {
				for (let cycle = 1; cycle <= KILL_CYCLES; cycle++) {
					const cycleResult = {
						cycle,
						signal: null,
						sawDisconnected: false,
						convergedAt: null,
						dataFlowed: false,
						timeline: [],
					};
					ctx.cycles.push(cycleResult);

					// Pre-kill write burst so there is in-flight replication state at the moment of the kill.
					await writeBurst(ctx.leader, DB_NAMES, WRITE_BURST_COUNT, WRITE_BURST_CONCURRENCY, `pre${cycle}`);

					const killedAt = Date.now();
					const { signal } = await sigkillNode(ctx.leader);
					cycleResult.signal = signal;
					equal(signal, 'SIGKILL', `cycle ${cycle}: leader must have been terminated by a genuine SIGKILL`);

					// Non-blind proof #1: tight-poll until we genuinely observe connected:false. Kept a
					// SHORT outage here (well under WEDGE_RECONCILE_THRESHOLD_MS) so recovery goes
					// through the SAME long-lived NodeReplicationConnection object's own retry (fast,
					// deterministic) rather than the disruptive 30s forceResubscribe path -- that path
					// has its own exponential-backoff dynamics (retryTime doubles to a 30s cap) that make
					// "converged within N seconds" a poor discriminator once crossed (see the separate
					// long-outage test below, which hunts the specific race with a generous bound instead).
					const disconnectDeadline = killedAt + 8000;
					while (Date.now() < disconnectDeadline) {
						const status = await sendOperation(ctx.follower, { operation: 'cluster_status' }).catch(() => null);
						const t = Date.now();
						if (status) {
							const disconnected = anyDbDisconnected(status, ctx.leader.hostname);
							cycleResult.timeline.push({ t, phase: 'outage', disconnected });
							if (disconnected) {
								cycleResult.sawDisconnected = true;
								break;
							}
						}
						await delay(POLL_INTERVAL_MS);
					}
					ok(
						cycleResult.sawDisconnected,
						`cycle ${cycle}: never observed connected:false after a genuine SIGKILL of the leader`
					);

					// Restart re-passing the ORIGINAL config (critical gotcha: omitting it wipes
					// replication.databases and silently breaks replication on the restarted node).
					await delay(300); // let the OS finish releasing the ports
					ctx.leader = (await startHarper({ harper: ctx.leader }, nodeStartOptions(ctx.leader))).harper;
					const restartedAt = Date.now();

					// Concurrently: resume write load on the leader, flood the follower's own admin
					// API (main-thread IPC pressure), and tight-poll cluster_status for convergence --
					// all in the foreground of this same async function, run together via Promise.all.
					// This marker is deliberately written while reconnection is still in flight. It covers
					// a write during catch-up; the post-convergence marker below remains the isolated
					// check that a later write cannot hide a missed audit-tail wakeup.
					const inFlightMarker = `post${cycle}-in-flight-${Date.now()}`;
					const inFlightMarkerPromise = Promise.all(
						DB_NAMES.map((db) =>
							sendOperation(ctx.leader, {
								operation: 'upsert',
								database: db,
								table: 'test',
								records: [{ id: inFlightMarker, name: 'post-restart' }],
							})
						)
					);
					const convergencePromise = (async () => {
						const deadline = restartedAt + CONVERGENCE_TIMEOUT_MS;
						while (Date.now() < deadline) {
							const status = await sendOperation(ctx.follower, { operation: 'cluster_status' }).catch(() => null);
							const t = Date.now();
							const converged = status ? allDbsConnected(status, ctx.leader.hostname, DB_NAMES) : false;
							if (status) cycleResult.timeline.push({ t, phase: 'post-restart', converged });
							if (converged) return t;
							await delay(POLL_INTERVAL_MS);
						}
						return null;
					})();

					const [convergedAt] = await Promise.all([
						convergencePromise,
						inFlightMarkerPromise,
						writeBurst(ctx.leader, DB_NAMES, WRITE_BURST_COUNT, WRITE_BURST_CONCURRENCY, `post${cycle}`),
						adminFlood(ctx.follower, FLOOD_COUNT, FLOOD_CONCURRENCY),
					]);
					cycleResult.convergedAt = convergedAt;
					cycleResult.convergenceMs = convergedAt ? convergedAt - restartedAt : null;
					ok(
						convergedAt,
						`cycle ${cycle}: replication did not reconcile back to connected:true within ${CONVERGENCE_TIMEOUT_MS}ms of restart -- wedged stuck-false`
					);
					console.log(`[qa587] cycle ${cycle}: converged in ${cycleResult.convergenceMs}ms after restart`);

					for (const db of DB_NAMES) {
						let seen = false;
						const dDeadline = Date.now() + DATA_FLOW_TIMEOUT_MS;
						while (Date.now() < dDeadline) {
							const res = await sendOperation(ctx.follower, {
								operation: 'search_by_id',
								database: db,
								table: 'test',
								ids: [inFlightMarker],
								get_attributes: ['id'],
							}).catch(() => []);
							if (Array.isArray(res) && res.some((r) => r.id === inFlightMarker)) {
								seen = true;
								break;
							}
							await delay(200);
						}
						ok(
							seen,
							`cycle ${cycle}: post-restart in-flight write on ${db} did not replicate to follower (false-green connected:true)`
						);
					}

					// Non-blind proof #2 / no-false-green check: a fresh write made AFTER convergence
					// must actually replicate, not just flip the bit.
					const marker = `chaos${cycle}-${Date.now()}`;
					for (const db of DB_NAMES) {
						await sendOperation(ctx.leader, {
							operation: 'upsert',
							database: db,
							table: 'test',
							records: [{ id: marker, name: 'chaos' }],
						});
					}
					let allFlowed = true;
					for (const db of DB_NAMES) {
						let seen = false;
						const dDeadline = Date.now() + DATA_FLOW_TIMEOUT_MS;
						while (Date.now() < dDeadline) {
							const res = await sendOperation(ctx.follower, {
								operation: 'search_by_id',
								database: db,
								table: 'test',
								ids: [marker],
								get_attributes: ['id'],
							}).catch(() => []);
							if (Array.isArray(res) && res.some((r) => r.id === marker)) {
								seen = true;
								break;
							}
							await delay(200);
						}
						if (!seen) allFlowed = false;
						ok(
							seen,
							`cycle ${cycle}: fresh post-recovery write on ${db} did not replicate to follower (false-green connected:true)`
						);
					}
					cycleResult.dataFlowed = allFlowed;
				}
			}
		);

		test(
			'long outage: holding the leader down past the 30s wedge threshold still recovers (best-effort race hunt)',
			{ timeout: LONG_OUTAGE_TEST_TIMEOUT_MS },
			async () => {
				// The fast cycles above (KILL_CYCLES) confirm the general "never wedges, no false
				// green, genuine SIGKILL" guarantees via the connection's own fast retry -- which
				// never gives the internal edge-vs-truth desync (harper-pro#289) a chance to occur,
				// since `this.nodeSubscriptions` is already populated on that long-lived connection
				// object and `connectedToNode()`'s guard (replicationConnection.ts:1388) always
				// passes on an ordinary reconnect. The specific race this fix (#431/PR#523) exists
				// for requires a FRESH connection object whose async `subscribe()` call races the
				// WS 'open' event -- which this codebase only constructs via the wedge-reconcile's
				// forceResubscribe path (findWedgedNodeUrls, WEDGE_RECONCILE_THRESHOLD_MS = 30s).
				// So this cycle deliberately holds the leader down past that threshold to give the
				// disruptive path -- and the narrow race inside it -- a chance to fire.
				//
				// A prior diagnostic run (not committed) confirmed this outage length reliably
				// triggers the disruptive "Reconciling N wedged subscription(s)" log line, but
				// convergence afterward is legitimately governed by the connection's own
				// exponential retry backoff (capped at 30s) rather than a fixed bound -- so this
				// check uses a generous window and treats the up-correction log line as
				// informational evidence, not a hard requirement (a black-box SIGKILL cannot force
				// the sub-millisecond IPC-vs-shared-memory race that #289 describes on demand).
				const cycleResult = {
					cycle: 'long-outage',
					signal: null,
					sawDisconnected: false,
					convergedAt: null,
					dataFlowed: false,
				};
				ctx.longOutageCycle = cycleResult;

				await writeBurst(ctx.leader, DB_NAMES, WRITE_BURST_COUNT, WRITE_BURST_CONCURRENCY, 'preLong');

				const killedAt = Date.now();
				const { signal } = await sigkillNode(ctx.leader);
				cycleResult.signal = signal;
				equal(signal, 'SIGKILL', 'long outage: leader must have been terminated by a genuine SIGKILL');

				const wedgeWaitDeadline = killedAt + WEDGE_TRIGGER_WAIT_MS;
				while (Date.now() < wedgeWaitDeadline) {
					const status = await sendOperation(ctx.follower, { operation: 'cluster_status' }).catch(() => null);
					if (status && anyDbDisconnected(status, ctx.leader.hostname)) cycleResult.sawDisconnected = true;
					await delay(1000);
				}
				ok(
					cycleResult.sawDisconnected,
					'long outage: never observed connected:false after a genuine SIGKILL of the leader'
				);
				const outageLog = await readLog(ctx.follower);
				cycleResult.wedgeReconcileFiredDuringOutage = /Reconciling \d+ wedged subscription/.test(outageLog);
				console.log(
					`[qa587] long outage: held leader down ${WEDGE_TRIGGER_WAIT_MS}ms (past the ${WEDGE_RECONCILE_THRESHOLD_MS}ms wedge threshold); ` +
						`disruptive wedge-reconcile fired during outage: ${cycleResult.wedgeReconcileFiredDuringOutage}`
				);

				ctx.leader = (await startHarper({ harper: ctx.leader }, nodeStartOptions(ctx.leader))).harper;
				const restartedAt = Date.now();

				let convergedAt = null;
				while (Date.now() < restartedAt + GENEROUS_CONVERGENCE_TIMEOUT_MS) {
					const status = await sendOperation(ctx.follower, { operation: 'cluster_status' }).catch(() => null);
					if (status && allDbsConnected(status, ctx.leader.hostname, DB_NAMES)) {
						convergedAt = Date.now();
						break;
					}
					await delay(500);
				}
				cycleResult.convergedAt = convergedAt;
				cycleResult.convergenceMs = convergedAt ? convergedAt - restartedAt : null;
				ok(
					convergedAt,
					`long outage: never reconciled back to connected:true within ${GENEROUS_CONVERGENCE_TIMEOUT_MS}ms of restart -- genuinely wedged stuck-false`
				);
				console.log(`[qa587] long outage: converged in ${cycleResult.convergenceMs}ms after restart`);

				const marker = `chaosLong-${Date.now()}`;
				for (const db of DB_NAMES) {
					await sendOperation(ctx.leader, {
						operation: 'upsert',
						database: db,
						table: 'test',
						records: [{ id: marker, name: 'chaos' }],
					});
				}
				let allFlowed = true;
				for (const db of DB_NAMES) {
					let seen = false;
					const dDeadline = Date.now() + DATA_FLOW_TIMEOUT_MS;
					while (Date.now() < dDeadline) {
						const res = await sendOperation(ctx.follower, {
							operation: 'search_by_id',
							database: db,
							table: 'test',
							ids: [marker],
							get_attributes: ['id'],
						}).catch(() => []);
						if (Array.isArray(res) && res.some((r) => r.id === marker)) {
							seen = true;
							break;
						}
						await delay(200);
					}
					if (!seen) allFlowed = false;
					ok(
						seen,
						`long outage: fresh post-recovery write on ${db} did not replicate to follower (false-green connected:true)`
					);
				}
				cycleResult.dataFlowed = allFlowed;
			}
		);

		test('non-blind summary + wedge-reconcile telemetry evidence', { timeout: 30000 }, async () => {
			ok(ctx.cycles.length === KILL_CYCLES, 'chaos cycles did not run to completion');
			ok(ctx.longOutageCycle, 'long-outage cycle did not run to completion');

			// Aggregate non-blind proof: every cycle was a genuine SIGKILL, and every cycle
			// genuinely observed connected:false -- a test that never injects a real fault
			// (and would therefore stay green if the fix were reverted) is worthless.
			for (const c of ctx.cycles) {
				equal(c.signal, 'SIGKILL', `cycle ${c.cycle}: not a genuine SIGKILL`);
				ok(c.sawDisconnected, `cycle ${c.cycle}: connected:false was never genuinely observed`);
				ok(c.convergedAt, `cycle ${c.cycle}: never converged back to connected:true`);
				ok(c.dataFlowed, `cycle ${c.cycle}: recovered connection did not carry real data`);
			}

			const log = await readLog(ctx.follower);
			const correctionLines = log
				.split('\n')
				.filter((l) => l.includes('Corrected replication connection state (disconnected -> up)'));
			const downCorrectionLines = log
				.split('\n')
				.filter((l) => l.includes('Corrected replication connection state (connected -> down)'));
			const wedgeReconcileLines = log.split('\n').filter((l) => /Reconciling \d+ wedged subscription/.test(l));

			// The long-outage cycle must also meet the non-blind + no-wedge-forever + no-false-green bar.
			const lo = ctx.longOutageCycle;
			equal(lo.signal, 'SIGKILL', 'long outage: not a genuine SIGKILL');
			ok(lo.sawDisconnected, 'long outage: connected:false was never genuinely observed');
			ok(lo.convergedAt, 'long outage: never converged back to connected:true (genuinely wedged)');
			ok(lo.dataFlowed, 'long outage: recovered connection did not carry real data');
			ok(
				lo.wedgeReconcileFiredDuringOutage,
				`long outage: the disruptive wedge-reconcile net never fired despite a ${WEDGE_TRIGGER_WAIT_MS / 1000}s outage -- WEDGE_RECONCILE_THRESHOLD_MS behavior may have changed`
			);

			console.log(`[qa587] up-correction log lines observed: ${correctionLines.length}`);
			for (const l of correctionLines) console.log('[qa587]   ' + l.trim());
			console.log(`[qa587] down-correction log lines observed: ${downCorrectionLines.length}`);
			console.log(`[qa587] disruptive wedge-reconcile log lines observed: ${wedgeReconcileLines.length}`);
			for (const l of wedgeReconcileLines) console.log('[qa587]   ' + l.trim());
			console.log(`[qa587] fast-cycle convergence timings: ${JSON.stringify(ctx.cycles.map((c) => c.convergenceMs))}`);
			console.log(
				`[qa587] long-outage convergence: ${lo.convergenceMs}ms after restart (wedge-reconcile fired during outage: ${lo.wedgeReconcileFiredDuringOutage})`
			);

			if (correctionLines.length > 0) {
				// We caught the exact race: the internal bit genuinely desynced (stuck false while
				// truth already read connected) and #431's reconcileEntryWithTruth corrected it UP.
				console.log(
					'[qa587] CONFIRMED: hit the exact W1 race -- connected bit desynced and reconciled UP via reconcileEntryWithTruth (harper-pro#289).'
				);
			} else {
				console.log(
					'[qa587] the exact internal edge-vs-truth desync (harper-pro#289, the specific race #431 fixes) was not observed this run -- ' +
						'the stress recipe (multi-db fan-out SIGKILL, write/admin load, and deliberately crossing the 30s wedge ' +
						'threshold to force the disruptive forceResubscribe path) did not hit the sub-millisecond IPC-vs-shared-memory ' +
						`race window. General fix guarantees (no wedge, no false green, genuine fault every cycle including a ${WEDGE_TRIGGER_WAIT_MS / 1000}s ` +
						'outage past the wedge threshold) are still confirmed above.'
				);
			}
		});
	}
);
