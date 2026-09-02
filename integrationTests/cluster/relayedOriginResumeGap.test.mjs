/**
 * Relayed-origin resume gap (harper-pro#432) — the deterministic guard for harper-pro#428.
 *
 * A node records a resume cursor only for the peers named in a connection's own subscription (Table.ts
 * `updateRecordedSequenceId` tracks `event.remoteNodeIds`, the connection's subscription list). Rows that
 * reach it RELAYED — originated by a node it has never subscribed to — leave no cursor for that origin at
 * all: no direct `seq` entry and no `lastTxnTime`. When such a node later opens a subscription naming that
 * origin as a source, the subscription build resolves `startTime === 1` (cursorless). Before #428 a
 * non-leader source then resumed from `now - 60s`, silently claiming everything older than a minute was
 * already held, so a backlog the node missed while its relay was down was never re-requested: permanent
 * divergence behind a `connected: true` link. #428 requests a full copy instead.
 *
 * Only the intermittent 4-node backlogRecovery stress test ever caught this class (node B frozen at
 * {A:800,B:553,C:800,D:800}, holding a real cursor for A and C but `start time: 1` for D, whose writes had
 * reached B only relayed). This test forces that condition on every run.
 *
 * Topology — a chain plus a witness, with `databases: ['data']` on every node so the system database never
 * relays membership and re-meshes the chain (see systemDbTransitiveRepro.test.mjs):
 *
 *   O (origin)  <-leader-  R (relay)  <-leader-  T (target)   T holds O's rows but has never subscribed to O
 *   ^
 *   '-leader-  W (witness) a direct follower of O: the same-run control that O's backlog is live
 *
 * Sequence: O writes phase 1 and the chain copies it (T's rows arrive relayed through R; asserted: T holds
 * every phase-1 row and has no connection to O). R is killed. O writes phase 2 — the [T, head] backlog —
 * which W receives live and T cannot. The backlog ages past the pre-#428 resume floor: that wait is the
 * scenario's own clock, not a poll, because the legacy loss is defined as "older than a minute". T then adds
 * O directly as a NON-leader (a leader add full-copied even before #428). Restarting R instead would heal T
 * through its DIRECT cursor for R — the co-subscription path that makes proxiedResumeBacklog.test.mjs
 * self-heal — so the restored path must be one T has never received from.
 *
 * Green (default): T converges, its log carries the resume decision (`start time: 1` for O, then the #428
 * full-copy request), a live write lands everywhere, and all four nodes converge once R returns.
 * Red-proof (HARPER_TEST_DISABLE_CURSORLESS_FULL_COPY=1 in the runner's environment; the hook is injected
 * into T and pinned off on every other node): the same scenario asserts the loss signature — the T<-O link
 * is live, T holds no phase-2 row, and T stays frozen below every peer even after R returns, because a peer
 * never relays an origin's rows to a node that is directly connected to that origin.
 *
 * W2's receive-side gap detection should turn the red-proof green again; W4's per-origin cursors
 * (harper-pro#434) should make `start time: 1` unreachable and retire the discriminator.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
	killHarper,
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const TABLE = 'relay_gap';
const PHASE1 = 20;
const PHASE2 = 30;
const TOTAL = PHASE1 + PHASE2;
const LIVE_ID = 'o3-live';
// the pre-#428 non-leader resume start was `Date.now() - 60000`
const LEGACY_RESUME_FLOOR_MS = 60000;
const AGE_MARGIN_MS = 5000;
const CONVERGE_TIMEOUT_MS = 90000;
const HOOK = 'HARPER_TEST_DISABLE_CURSORLESS_FULL_COPY';
const PROTECTION_DISABLED = process.env[HOOK] === '1';
// Every child inherits the runner's environment, so the hook is pinned off explicitly on each control node
// and injected only into the target.
const hookEnv = (isTarget) => ({ [HOOK]: isTarget && PROTECTION_DISABLED ? '1' : '0' });
const hookFired = (log) => log.includes(`${HOOK}: resuming database`);

const phase1Ids = Array.from({ length: PHASE1 }, (_, i) => `o1-${i}`);
const phase2Ids = Array.from({ length: PHASE2 }, (_, i) => `o2-${i}`);

const nodeConfig = (hostname, env) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		// the resume-decision oracle reads debug lines, so the level is pinned rather than inherited
		logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
		replication: { port: hostname + ':9933', securePort: null, databases: ['data'] },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
});

const addNode = (node, peer, extra) =>
	sendOperation(node, {
		operation: 'add_node',
		hostname: peer.hostname,
		rejectUnauthorized: false,
		authorization: peer.admin,
		...extra,
	});
const addLeader = (node, leader) => addNode(node, leader, { isLeader: true });

const upsert = (node, ids) =>
	sendOperation(node, { operation: 'upsert', database: 'data', table: TABLE, records: ids.map((id) => ({ id })) });

async function idsOn(node, signal) {
	const rows = await sendOperation(
		node,
		{
			operation: 'search_by_value',
			database: 'data',
			table: TABLE,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id'],
		},
		{ signal }
	);
	return new Set(rows.map((row) => row.id));
}

async function countsOn(nodes, signal) {
	const entries = await Promise.all(
		Object.entries(nodes).map(async ([label, node]) => {
			try {
				return [label, (await idsOn(node, signal)).size];
			} catch (error) {
				if (signal?.aborted) throw error;
				return [label, 'unreachable'];
			}
		})
	);
	return Object.fromEntries(entries);
}

// The timeout message carries the last counts, so a red run prints the frozen-count signature.
function waitForCounts(nodes, expected, what) {
	let last;
	return waitForCondition(
		async (signal) => {
			last = await countsOn(nodes, signal);
			return Object.values(last).every((count) => count === expected);
		},
		{
			timeoutMs: CONVERGE_TIMEOUT_MS,
			description: () => `${what}: every node at ${expected}, last saw ${JSON.stringify(last)}`,
		}
	);
}

const ip = (value = '') => (value.match(/127\.0\.0\.\d+/) || [value])[0];

async function connectionTo(node, peer, signal) {
	const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
	return (status.connections ?? []).find(
		(connection) => connection.name === peer.hostname || ip(connection.url) === peer.hostname
	);
}
const dataSocketConnected = (connection) =>
	(connection?.database_sockets ?? []).some((socket) => socket.database === 'data' && socket.connected);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What the subscription build on `node` decided for source `peer` (replicationConnection.ts, the
// `startTime === 1` branch): cursorless, then either the #428 full copy or the hook's legacy resume.
function resumeDecisionFor(log, peer) {
	const host = escapeRegExp(peer.hostname);
	const from = `from \\S*${host}\\S*`;
	return {
		cursorless: new RegExp(`Starting time recorded in db ${host}(:\\d+)?\\b[^\\n]* data [^\\n]*start time: 1\\b`).test(
			log
		),
		fullCopy: new RegExp(`Requesting full copy of database data ${from} \\(no resume cursor for this source\\)`).test(
			log
		),
		legacyResume: new RegExp(`HARPER_TEST_DISABLE_CURSORLESS_FULL_COPY: resuming database data ${from} at `).test(log),
	};
}

suite(
	PROTECTION_DISABLED
		? 'Relayed-origin resume gap — red-proof, cursorless full copy disabled on T (harper-pro#432)'
		: 'Relayed-origin resume gap (harper-pro#432)',
	{ timeout: 480000 },
	(ctx) => {
		before(async () => {
			const roles = ['O', 'R', 'T', 'W'];
			const hostnames = await Promise.all(roles.map(() => getNextAvailableLoopbackAddress()));
			const contexts = hostnames.map((hostname) => ({ name: ctx.name, harper: { hostname } }));
			await Promise.all(
				contexts.map((nodeCtx, i) => startHarper(nodeCtx, nodeConfig(hostnames[i], hookEnv(roles[i] === 'T'))))
			);
			[ctx.O, ctx.R, ctx.T, ctx.W] = contexts.map((nodeCtx) => nodeCtx.harper);
			const { O, R, T, W } = ctx;

			await Promise.all(
				[O, R, T, W].map((node) =>
					sendOperation(node, { operation: 'create_table', database: 'data', table: TABLE, primary_key: 'id' })
				)
			);
			await upsert(O, phase1Ids);

			// The chain is built one hop at a time so each copy has a complete source, and so every outbound
			// add_node targets a node already in O's trust chain (proxiedLeadingDuplicateSkip.test.mjs).
			await addLeader(R, O);
			await waitForCounts({ R }, PHASE1, 'R full copy from O');
			await Promise.all([addLeader(T, R), addLeader(W, O)]);
			await waitForCounts({ T, W }, PHASE1, 'T full copy from R and W full copy from O');

			// Precondition: T holds every O-origin row yet has no connection to O at all.
			const tIds = await idsOn(T);
			deepEqual(
				phase1Ids.filter((id) => !tIds.has(id)),
				[],
				'T must hold every phase-1 row, delivered relayed through R'
			);
			equal(await connectionTo(T, O), undefined, 'T must have no connection to O: its only path to O is R');
			ok(dataSocketConnected(await connectionTo(T, R)), 'T must be receiving data directly from R');
		});

		after(async () => {
			const teardownNode = async (label, node) => {
				const errors = [];
				if (!node) return errors;
				// A restarted node is not the child the harness spawned, so stop whatever pid the data dir names.
				if (node.dataRootDir) {
					try {
						await stopNodeProcess(node);
					} catch (error) {
						errors.push(new Error(`Failed to stop ${label} (${node.hostname})`, { cause: error }));
					}
				}
				try {
					await teardownHarper({ harper: node });
				} catch (error) {
					errors.push(new Error(`Failed to tear down ${label} (${node.hostname})`, { cause: error }));
				}
				return errors;
			};
			const errors = (
				await Promise.all([
					teardownNode('O', ctx.O),
					teardownNode('R', ctx.R),
					teardownNode('T', ctx.T),
					teardownNode('W', ctx.W),
				])
			).flat();
			if (errors.length) throw new AggregateError(errors, 'Failed to tear down relayed-origin resume gap nodes');
		});

		test(
			PROTECTION_DISABLED
				? 'T silently loses the backlog behind a dead relay: cursorless direct subscription resumes from now-60s'
				: 'T recovers the backlog behind a dead relay: cursorless direct subscription requests a full copy',
			async () => {
				const { O, R, T, W } = ctx;

				// no shutdown grace: SIGTERM is followed at once by SIGKILL, as close to a crash as the harness gets
				await killHarper({ harper: R }, { graceMs: 0 });
				await waitForCondition(async (signal) => !dataSocketConnected(await connectionTo(T, R, signal)), {
					description: 'T to observe its relay R down',
				});

				await upsert(O, phase2Ids);
				await waitForCounts({ O, W }, TOTAL, 'O and its direct follower W after phase 2');
				equal((await idsOn(T)).size, PHASE1, 'T must not see phase 2 while its only path to O is dead');

				await delay(LEGACY_RESUME_FLOOR_MS + AGE_MARGIN_MS);

				const logBefore = await readLog(T);
				await addNode(T, O);

				if (!PROTECTION_DISABLED) {
					await waitForCounts({ O, T, W }, TOTAL, 'T convergence through its direct O subscription');
					const tIds = await idsOn(T);
					deepEqual(
						phase2Ids.filter((id) => !tIds.has(id)),
						[],
						'T must hold every phase-2 row after the full copy'
					);
				} else {
					await waitForCondition(async (signal) => dataSocketConnected(await connectionTo(T, O, signal)), {
						description: 'T to report a connected data socket to O',
					});
				}

				// A write after the direct link is up proves the link is live in both modes; only the
				// [T, head] hole distinguishes them.
				await upsert(O, [LIVE_ID]);
				await waitForCondition(async (signal) => (await idsOn(T, signal)).has(LIVE_ID), {
					description: 'the live write to reach T over its direct O link',
				});

				const logT = await readLog(T);
				const decision = resumeDecisionFor(logT.slice(logBefore.length), O);
				ok(decision.cursorless, 'T must have resolved O cursorless (start time: 1): it never subscribed to O');
				for (const [label, node] of [
					['O', O],
					['W', W],
				]) {
					ok(
						!hookFired(await readLog(node)),
						`${label} must never take the legacy resume: the hook is pinned off there`
					);
				}
				if (!PROTECTION_DISABLED) {
					ok(decision.fullCopy, 'T must request a full copy from O when the source resolves cursorless');
					ok(!hookFired(logT), 'the legacy now-60s resume must be unreachable without the hook');
					await waitForCounts({ O, T, W }, TOTAL + 1, 'live write after the copy');
				} else {
					ok(decision.legacyResume, 'with the hook, T must resume O from now-60s instead of copying');
					ok(!decision.fullCopy, 'with the hook, T must not request a full copy from O');
					const tIds = await idsOn(T);
					deepEqual(
						phase2Ids.filter((id) => tIds.has(id)),
						[],
						'T must hold no phase-2 row: the aged backlog is never re-requested'
					);
					deepEqual(
						await countsOn({ O, T, W }),
						{ O: TOTAL + 1, T: PHASE1 + 1, W: TOTAL + 1 },
						'frozen-count signature: T stays below O and W behind a live, connected link'
					);
				}
			}
		);

		test(
			PROTECTION_DISABLED
				? 'the hole persists after R returns: R no longer relays O to a node directly connected to O'
				: 'all four nodes converge once R returns',
			async () => {
				const { O, T, W } = ctx;
				const restarted = { name: ctx.name, harper: { dataRootDir: ctx.R.dataRootDir, hostname: ctx.R.hostname } };
				await startHarper(restarted, nodeConfig(ctx.R.hostname, hookEnv(false)));
				ctx.R = restarted.harper;
				const R = ctx.R;

				if (!PROTECTION_DISABLED) {
					await waitForCounts({ O, R, T, W }, TOTAL + 1, 'all four nodes after R restarts');
				} else {
					await waitForCounts({ O, R, W }, TOTAL + 1, 'R catch-up through its direct O cursor');
					deepEqual(
						await countsOn({ O, R, T, W }),
						{ O: TOTAL + 1, R: TOTAL + 1, T: PHASE1 + 1, W: TOTAL + 1 },
						'frozen-count signature: T stays below every peer with all links up'
					);
				}
				ok(!hookFired(await readLog(R)), 'R must never take the legacy resume: the hook is pinned off there');
			}
		);
	}
);
