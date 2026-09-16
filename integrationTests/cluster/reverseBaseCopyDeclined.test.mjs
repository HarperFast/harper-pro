/**
 * Integration test: a base copy must not return the requesting peer's own records to it while this node
 * is being cloned from that peer or has just completed that clone.
 *
 * While B is mid-clone from A, the records A originated are ones A already has, and re-applying them on
 * a legacy v4 leader mints audit entries it can no longer parse, wedging its own audit-log forwarding
 * (harper-pro#737). B carries the on-disk marker and the process variable cloneNode holds through
 * the bounded post-completion grace.
 *
 * The topology exists to make the reverse copy deterministic and its outcome legible. A peer only asks
 * for a base copy while it has no resume cursor for this node, and the first record of any origin that
 * reaches it from us gives it one — so B is populated through a relay, D, and A meets B for the first
 * time already holding data. That also puts two origins in B: A's rows, which must be withheld, and D's,
 * which must not.
 *
 *   A  — 5 records, all A-origin
 *   D  — joins A, receives them with their origin preserved, then writes one of its own
 *   B  — mid-clone from A per its marker, but populated by joining D
 *   C  — joins B afterwards, and must receive everything B holds
 *
 * D is then detached from both, before B exists to it and after B is full. Otherwise D relays B's
 * membership to A, which connects them early and leaves A with a cursor — no base copy, nothing under
 * test — and B would still have a second peer to ship to, which the per-record oracle cannot tell apart.
 *
 * The assertions count the records B ships, not the log line the filter emits: a v5 receiver elides
 * re-streamed duplicates before logging them, so the receiving side cannot tell a filtered copy from a
 * full one.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { renameSync, writeFileSync } from 'node:fs';
import { sendOperation, readLog } from './clusterShared.mjs';

const CLONE_COMPLETION_GRACE_MS = 60_000;

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const A_RECORD_COUNT = 5;
const TABLE = 'reverse_copy_test';

const shipped = (log, prefix) => (log.match(new RegExp(`sent record from table ${prefix}`, 'g')) ?? []).length;

async function recordsIn(node, expected) {
	let received = [];
	for (let i = 0; i < 120 && received.length < expected; i++) {
		await delay(500);
		received =
			(await sendOperation(node, {
				operation: 'search_by_value',
				database: 'data',
				table: TABLE,
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['id'],
			}).catch(() => [])) ?? [];
	}
	return received;
}

const joinAsFollower = (node, leader) =>
	sendOperation(node, {
		operation: 'add_node',
		hostname: leader.hostname,
		rejectUnauthorized: false,
		isLeader: true,
		authorization: leader.admin,
	});

function registerReverseCopySuite({ title, completionAgeMs, withholdsSourceRecords, checksOtherPeer }) {
	suite(title, { timeout: 300000 }, (ctx) => {
		before(async () => {
			const hostnames = await Promise.all(
				Array.from({ length: checksOtherPeer ? 4 : 3 }, () => getNextAvailableLoopbackAddress())
			);

			const nodeConfig = (hostname, env) => ({
				config: {
					analytics: { aggregatePeriod: -1 },
					// the oracle below counts a per-record debug line, so the level is pinned rather than inherited
					logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
					replication: { port: hostname + ':9933', securePort: null, databases: ['data'] },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
			});

			const contexts = hostnames.map((hostname) => ({ name: ctx.name, harper: { hostname } }));
			// B stands in for a node whose worker still has the clone-attempt process variable and whose
			// marker names what it cloned from.
			const envs = [undefined, { HARPER_CLONE_ATTEMPT: 'reverse-copy-test-attempt' }, undefined, undefined];
			await Promise.all(contexts.map((nodeCtx, i) => startHarper(nodeCtx, nodeConfig(hostnames[i], envs[i]))));
			if (checksOtherPeer) [ctx.nodeA, ctx.nodeB, ctx.nodeC, ctx.nodeD] = contexts.map((nodeCtx) => nodeCtx.harper);
			else [ctx.nodeA, ctx.nodeB, ctx.nodeD] = contexts.map((nodeCtx) => nodeCtx.harper);

			ctx.cloneAttemptPath = join(ctx.nodeB.dataRootDir, '.cloneAttempt.json');

			await sendOperation(ctx.nodeA, {
				operation: 'create_table',
				database: 'data',
				table: TABLE,
				primary_key: 'id',
			});
			await sendOperation(ctx.nodeA, {
				operation: 'upsert',
				database: 'data',
				table: TABLE,
				records: Array.from({ length: A_RECORD_COUNT }, (_, i) => ({ id: `a-origin-${i}` })),
			});

			// D relays A's records to B, so B holds them without A ever having connected to B.
			await joinAsFollower(ctx.nodeD, ctx.nodeA);
			assert.equal((await recordsIn(ctx.nodeD, A_RECORD_COUNT)).length, A_RECORD_COUNT, 'D must receive A records');
			await sendOperation(ctx.nodeD, {
				operation: 'upsert',
				database: 'data',
				table: TABLE,
				records: [{ id: 'd-origin-0' }],
			});
			// Detach D from A before B joins it, so B's membership cannot reach A through D.
			await sendOperation(ctx.nodeD, { operation: 'remove_node', hostname: ctx.nodeA.hostname });
			await joinAsFollower(ctx.nodeB, ctx.nodeD);
			assert.equal(
				(await recordsIn(ctx.nodeB, A_RECORD_COUNT + 1)).length,
				A_RECORD_COUNT + 1,
				'B must hold both origins before A meets it'
			);
			// Leave B with no peer at all, so every record it ships from here is one going to A.
			await sendOperation(ctx.nodeB, { operation: 'remove_node', hostname: ctx.nodeD.hostname });
			await delay(2000);
		});

		after(async () => {
			await Promise.all(
				[ctx.nodeA, ctx.nodeB, ctx.nodeC, ctx.nodeD].filter(Boolean).map((harper) => teardownHarper({ harper }))
			);
		});

		test(
			withholdsSourceRecords
				? 'B withholds A own records during the completed-at grace, and ships the rest'
				: 'B copies A own records after the completed-at grace expires',
			async () => {
				const { nodeA, nodeB } = ctx;
				const before = await readLog(nodeB);
				let markerWrittenAt;
				const writeAttemptMarker = () => {
					markerWrittenAt = Date.now();
					const temporaryPath = `${ctx.cloneAttemptPath}.test.tmp`;
					writeFileSync(
						temporaryPath,
						JSON.stringify({
							attemptId: 'reverse-copy-test-attempt',
							leaderHost: nodeA.hostname,
							completedAt: markerWrittenAt - completionAgeMs,
						})
					);
					renameSync(temporaryPath, ctx.cloneAttemptPath);
				};
				writeAttemptMarker();

				// A meets B for the first time here, so it has no resume cursor for B and asks for a base copy.
				await joinAsFollower(nodeB, nodeA);

				// D's record is the last thing B can ship, so its arrival marks the copy as served.
				let after = before;
				for (let i = 0; i < 240 && shipped(after, 'd-origin-') === shipped(before, 'd-origin-'); i++) {
					if (withholdsSourceRecords) writeAttemptMarker();
					await delay(500);
					after = await readLog(nodeB);
				}
				assert.ok(
					shipped(after, 'd-origin-') > shipped(before, 'd-origin-'),
					'B must have served A a base copy carrying the record D originated'
				);
				const sourceRecordsShipped = shipped(after, 'a-origin-') - shipped(before, 'a-origin-');
				if (withholdsSourceRecords)
					assert.equal(
						sourceRecordsShipped,
						0,
						'B must ship none of A own records back to it during the completion grace'
					);
				else
					assert.ok(sourceRecordsShipped > 0, 'B must fail open to shipping A own records after the completion grace');
				assert.equal(
					(await recordsIn(nodeA, A_RECORD_COUNT + 1)).length,
					A_RECORD_COUNT + 1,
					'A must end up holding every record'
				);
			}
		);

		if (checksOtherPeer)
			test('B copies everything it holds to a peer that is not the node it cloned from', async () => {
				const { nodeB, nodeC } = ctx;

				await joinAsFollower(nodeC, nodeB);
				assert.equal(
					(await recordsIn(nodeC, A_RECORD_COUNT + 1)).length,
					A_RECORD_COUNT + 1,
					'C must receive every record from B base copy'
				);
			});
	});
}

registerReverseCopySuite({
	title: 'Reverse base copy during the clone-completion grace',
	completionAgeMs: 0,
	withholdsSourceRecords: true,
	checksOtherPeer: true,
});

registerReverseCopySuite({
	title: 'Reverse base copy after the clone-completion grace',
	completionAgeMs: CLONE_COMPLETION_GRACE_MS + 1,
	withholdsSourceRecords: false,
	checksOtherPeer: false,
});
