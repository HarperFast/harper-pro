/**
 * Leading-duplicate fast-skip (PR B, stacks on #368)
 *
 * On replication resume the leader re-streams from the follower's resume cursor, so the FIRST
 * records of a resumed stream are records the follower already applied. Today each of those flows
 * into core Table.ts's apply loop and hits the CRDT resequencing walk (per-record `auditStore.get`
 * scans) before being dropped as a duplicate. PR B recognizes these provably-already-applied leading
 * duplicates at the replication receive layer and skips dispatching them, avoiding the audit-walk
 * cost during catch-up.
 *
 * This test drives A→B replication, forces a reconnect/resume by killing and restarting the source,
 * then asserts:
 *   (a) CORRECTNESS GUARD — record-count / content convergence is unaffected (NO records dropped).
 *       The skip must only ever suppress dispatch of a record the apply loop would itself have dropped
 *       as an identity tie; if it ever dropped a real record, the post-resume content on the follower
 *       would diverge from the source and this assertion would fail.
 *   (b) ENGAGEMENT — the fast-skip path actually engaged, asserted via the distinctive trace log line
 *       the receive path emits (`leading-duplicate fast-skip`). Trace logging is enabled below.
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
import { sendOperation, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const NODE_COUNT = 2;
const CONNECT_TIMEOUT_MS = 15000;
const CONVERGE_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 200;

// Trace logging is required for the engagement assertion: the fast-skip emits at logger.trace level.
function nodeStartOptions(node) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'trace' },
			replication: {
				securePort: node.hostname + ':9933',
				databases: ['data'],
			},
		},
	};
}

async function waitForConnected(node, expectedConnectionCount) {
	const deadline = Date.now() + CONNECT_TIMEOUT_MS;
	let lastStatus;
	while (Date.now() < deadline) {
		lastStatus = await sendOperation(node, { operation: 'cluster_status' });
		if (lastStatus.connections.length === expectedConnectionCount) {
			const allConnected = lastStatus.connections.every(
				(conn) => conn.database_sockets.length > 0 && conn.database_sockets.every((s) => s.connected === true)
			);
			if (allConnected) return lastStatus;
		}
		await delay(POLL_INTERVAL_MS);
	}
	throw new Error(
		`Timed out waiting for ${expectedConnectionCount} connected connection(s): ${JSON.stringify(lastStatus)}`
	);
}

async function countRecords(node) {
	const rows = await sendOperation(node, {
		operation: 'sql',
		sql: 'SELECT COUNT(*) AS c FROM data.test',
	});
	return rows?.[0]?.c ?? 0;
}

async function waitForCount(node, expected, timeoutMs = CONVERGE_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	let last = -1;
	while (Date.now() < deadline) {
		last = await countRecords(node);
		if (last === expected) return last;
		await delay(POLL_INTERVAL_MS);
	}
	throw new Error(`Timed out waiting for count ${expected} on ${node.hostname}, last saw ${last}`);
}

suite('Leading Duplicate Fast-Skip', { timeout: 180000 }, (ctx) => {
	before(async () => {
		ctx.nodes = await Promise.all(
			Array(NODE_COUNT)
				.fill(null)
				.map(async () => {
					const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
					await startHarper(nodeCtx, nodeStartOptions(nodeCtx.harper));
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

	test('resume re-streams already-applied tail: no records dropped, fast-skip engages', async () => {
		const source = ctx.nodes[0];
		const follower = ctx.nodes[1];

		// follower subscribes to source (follower receives source's writes).
		await sendOperation(follower, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: source.hostname,
			authorization: follower.admin,
		});
		await waitForConnected(follower, 1);

		// Phase 1: write a batch on the source and let it replicate to the follower. These records become
		// the "already-applied tail" that the resumed stream will re-deliver. We include a DELETE and an
		// UPDATE so the re-streamed tail exercises non-insert operations — the fast-skip must not
		// incorrectly drop a re-delivered delete or update as though it were a harmless duplicate.
		const PHASE1_BASE = 42; // extra 2 for the delete victim + update target
		for (let i = 0; i < PHASE1_BASE; i++) {
			await sendOperation(source, {
				operation: 'insert',
				table: 'test',
				records: [{ id: `p1-${i}`, name: `phase1-${i}` }],
			});
		}
		// Delete one record — it will appear in the re-streamed tail as a delete operation.
		await sendOperation(source, { operation: 'delete', table: 'test', ids: [`p1-${PHASE1_BASE - 1}`] });
		// Update another record — it will appear in the re-streamed tail as an update operation.
		await sendOperation(source, {
			operation: 'update',
			table: 'test',
			records: [{ id: `p1-0`, name: 'phase1-updated' }],
		});
		const PHASE1 = PHASE1_BASE - 1; // net count after delete
		await waitForCount(follower, PHASE1);

		// Phase 2: kill + restart the source. The follower's outgoing WS drops; on the source's bring-up the
		// follower re-subscribes from its persisted resume cursor and the source re-streams the tail of
		// phase-1 records the follower already has — the leading duplicates the fast-skip targets.
		await killHarper({ harper: source });
		await delay(800);
		ctx.nodes[0] = (await startHarper({ harper: source }, nodeStartOptions(source))).harper;
		const restartedSource = ctx.nodes[0];
		await waitForConnected(follower, 1);

		// Phase 3: write NEW records on the restarted source. These are NOT duplicates and must flow through
		// normally — they prove the skip does not strand the live stream after the resume window.
		const PHASE3 = 10;
		for (let i = 0; i < PHASE3; i++) {
			await sendOperation(restartedSource, {
				operation: 'insert',
				table: 'test',
				records: [{ id: `p3-${i}`, name: `phase3-${i}` }],
			});
		}

		// (a) CORRECTNESS GUARD: the follower must converge to ALL records (phase1 + phase3). If the
		// fast-skip ever dropped a real record, this count would fall short.
		const TOTAL = PHASE1 + PHASE3;
		await waitForCount(follower, TOTAL);

		// Spot-check content integrity: updated record must reflect the patch, not the original insert.
		const p1Updated = await sendOperation(follower, {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['p1-0'],
		});
		equal(p1Updated.length, 1, 'updated phase-1 record must survive the resume');
		equal(p1Updated[0].name, 'phase1-updated', 'update must not be lost on re-stream');

		// Deleted record must not be present (the re-streamed delete must not be dropped by the skip).
		const p1Deleted = await sendOperation(follower, {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: [`p1-${PHASE1_BASE - 1}`],
		});
		equal(p1Deleted.length, 0, 'deleted phase-1 record must remain absent after resume');

		// A regular surviving phase-1 record and a post-resume write must both be present.
		const p1Regular = await sendOperation(follower, {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['p1-1'],
		});
		equal(p1Regular.length, 1, 'regular phase-1 record must survive the resume');
		equal(p1Regular[0].name, 'phase1-1');
		const p3 = await sendOperation(follower, {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: [`p3-${PHASE3 - 1}`],
		});
		equal(p3.length, 1, 'phase-3 (post-resume) record must replicate normally');
		equal(p3[0].name, `phase3-${PHASE3 - 1}`);

		// (b) ENGAGEMENT: the fast-skip path must have actually fired on the resumed stream. Poll the
		// follower's log for the distinctive trace line. (Trace logging enabled in nodeStartOptions.)
		const logDeadline = Date.now() + CONVERGE_TIMEOUT_MS;
		let engaged = false;
		while (Date.now() < logDeadline) {
			const log = await readLog(follower);
			if (log.includes('leading-duplicate fast-skip')) {
				engaged = true;
				break;
			}
			await delay(POLL_INTERVAL_MS);
		}
		ok(engaged, 'expected the leading-duplicate fast-skip to engage on the resumed stream (trace log not found)');
	});
});
