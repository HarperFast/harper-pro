/**
 * Proxied resume must not silently skip backlog (harper-pro#426)
 *
 * The bug (harper-pro#426): when a source resolves to NO resume cursor on reconnect
 * (`startTime === 1` — no direct seqId, no recorded `lastTxnTime`), the subscription-build used to
 * resume a non-leader source from `Date.now() - 60000`, silently claiming "I already hold everything
 * older than a minute." A follower that is actually BEHIND on records now older than that window never
 * re-requests them — permanent, silent divergence even though it reconnects cleanly. The fix requests
 * a full copy (`startTime = 0`) whenever a source resolves cursorless.
 *
 * ⚠️ WHAT THIS TEST ACTUALLY COVERS (read before trusting it as a data-loss guard):
 * This exercises the cursorless → full-copy resume DECISION and confirms the cluster still converges.
 * It is NOT a data-loss regression. In this 3-node L→B→M line, M tracks a real DIRECT cursor to its
 * bridge B (M's cursor is keyed on the connection node B, not on the relayed origin L), so even
 * pre-fix M re-acquires the aged backlog through that direct B cursor and converges — verified
 * empirically (convergence passes with the now-60s code; only the resume-decision log line differs).
 * So here the DISCRIMINATING signal is "M requests a full copy (not a now-60s incremental) when a
 * source resolves cursorless," not the record count.
 *
 * The genuine #426 data loss needs a node with NO direct cursor to an origin whose writes arrived
 * only RELAYED (emerges under churn when one node becomes the hub). That reproduction lives in the
 * 4-node `integrationTests/stress/backlogRecovery.test.mjs`; treat THAT as the data-loss guard and
 * this as a resume-decision + convergence smoke check.
 *
 * Topology (L = source, B = bridge/proxy + M's leader, M = transitive follower):
 *
 *     L (source, replicates 'data')
 *      ^  add_node { isLeader: true }   (B full-copies L)
 *      |
 *      B  <----- mesh ('data' + 'system') ----->  M   (M receives L's writes via B)
 *
 * Trust is anchored on L's CA: B adds L FIRST (B's cert signed by L's CA), then M adds B, so all
 * three share L's chain (mirrors proxiedLeadingDuplicateSkip.test.mjs).
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
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

const CONNECT_TIMEOUT_MS = 30000;
const CONVERGE_TIMEOUT_MS = 90000;
const POLL_INTERVAL_MS = 250;
// The missed batch must age past the non-leader resume window (Date.now() - 60000) so the buggy path
// would skip it. A little headroom over 60s.
const STALE_WINDOW_MS = 65000;

function meshConfig(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'debug' },
			replication: { securePort: hostname + ':9933', databases: ['data', 'system'] },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}
function sourceConfig(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'debug' },
			replication: { securePort: hostname + ':9933', databases: ['data'] },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}

async function countRecords(node) {
	const rows = await sendOperation(node, { operation: 'sql', sql: 'SELECT COUNT(*) AS c FROM data.test' }).catch(
		() => null
	);
	return rows?.[0]?.c ?? -1;
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

async function waitForSystemMesh(node, timeoutMs = CONNECT_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await sendOperation(node, { operation: 'cluster_status' }).catch(() => null);
		if (status?.connections?.some?.((c) => c.database_sockets?.some?.((s) => s.connected && s.database === 'system')))
			return true;
		await delay(POLL_INTERVAL_MS);
	}
	return false;
}

suite('Proxied resume backlog (harper-pro#426)', { timeout: 240000 }, (ctx) => {
	before(async () => {
		const ctxL = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const ctxB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const ctxM = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await Promise.all([
			startHarper(ctxL, sourceConfig(ctxL.harper.hostname)),
			startHarper(ctxB, meshConfig(ctxB.harper.hostname)),
			startHarper(ctxM, meshConfig(ctxM.harper.hostname)),
		]);
		ctx.nodeL = ctxL.harper;
		ctx.nodeB = ctxB.harper;
		ctx.nodeM = ctxM.harper;

		await Promise.all(
			[ctx.nodeL, ctx.nodeB, ctx.nodeM].map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: 'data',
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
		await Promise.all([
			ctx.nodeL && teardownHarper({ harper: ctx.nodeL }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
			ctx.nodeM && teardownHarper({ harper: ctx.nodeM }),
		]);
	});

	test('follower converges after missing a stale backlog on a proxied source', async () => {
		const { nodeL } = ctx;

		// B declares L its leader (full-copies L), then M meshes with B. Order matters for CA trust.
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: nodeL.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: nodeL.admin,
		});
		await sendOperation(ctx.nodeM, {
			operation: 'add_node',
			hostname: ctx.nodeB.hostname,
			rejectUnauthorized: false,
			authorization: ctx.nodeB.admin,
		});
		ok(await waitForSystemMesh(ctx.nodeB), 'B and M should mesh with a connected system-database socket');

		// Phase 1: a baseline batch on L relays L -> B -> M. M applying these establishes its view of the
		// data db and its DIRECT cursor to bridge B (which is what lets it converge pre-fix, see header).
		const PHASE1 = 20;
		for (let i = 0; i < PHASE1; i++) {
			await sendOperation(nodeL, {
				operation: 'insert',
				database: 'data',
				table: 'test',
				records: [{ id: `p1-${i}`, name: `phase1-${i}` }],
			});
		}
		await waitForCount(ctx.nodeM, PHASE1);

		// Sever M's only path to L by killing the bridge. B retains its data + its DIRECT cursor to L
		// across the SIGKILL, so it will catch up on restart — but M (proxied) is now frozen.
		await killHarper({ harper: ctx.nodeB });

		// Phase 2: writes M cannot see (bridge down). These are the backlog M must not lose.
		const PHASE2 = 30;
		for (let i = 0; i < PHASE2; i++) {
			await sendOperation(nodeL, {
				operation: 'insert',
				database: 'data',
				table: 'test',
				records: [{ id: `p2-${i}`, name: `phase2-${i}` }],
			});
		}

		// Age the backlog past the non-leader resume window. After this, the buggy `Date.now() - 60000`
		// start would request only writes newer than ~now — none exist — and skip all of phase 2.
		await delay(STALE_WINDOW_MS);

		// Bring the bridge back. B resumes its DIRECT subscription to L and re-acquires phase 2; M then
		// reconnects and resumes its PROXIED subscription to L with no resolved cursor.
		ctx.nodeB = (await startHarper({ harper: ctx.nodeB }, meshConfig(ctx.nodeB.hostname))).harper;
		ok(await waitForSystemMesh(ctx.nodeB), 'B and M should re-mesh after the bridge bounce');

		// The bridge itself (direct follower of L) must recover the backlog — sanity that L still has it.
		await waitForCount(ctx.nodeB, PHASE1 + PHASE2);

		// Convergence (smoke): M must reach the full set. NOTE this passes pre-fix too — M re-acquires the
		// backlog through its direct B cursor regardless of the now-60s resume (see header). It guards
		// against a gross regression, but it is NOT what discriminates the fix.
		const TOTAL = PHASE1 + PHASE2;
		await waitForCount(ctx.nodeM, TOTAL);

		// Spot-check a phase-2 record actually landed (not just a matching count).
		const sample = await sendOperation(ctx.nodeM, {
			operation: 'search_by_id',
			database: 'data',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: [`p2-${PHASE2 - 1}`],
		});
		equal(sample.length, 1, 'a phase-2 backlog record must be present on the proxied follower');

		// THE DISCRIMINATING ASSERTION (in this topology): when a source resolves cursorless, M must
		// request a full copy rather than a now-60s incremental. This is what actually fails pre-fix;
		// convergence above does not. (Genuine data-loss coverage lives in backlogRecovery.test.mjs.)
		const log = await readLog(ctx.nodeM);
		ok(
			log.includes('no resume cursor for this source') || log.includes('Requesting full copy'),
			'M should request a full copy when a source resolves to no resume cursor'
		);
	});
});
