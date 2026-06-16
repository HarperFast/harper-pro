/**
 * Proxied leading-duplicate fast-skip (harper-pro #399)
 *
 * #370 armed the leading-duplicate fast-skip only for DIRECT subscriptions (`hasPersistedResumeCursor`
 * checks the direct sequence cursor). A transitive/proxied subscription — where a follower receives a
 * source's writes relayed through a bridge node — derives its resume start from the proxy's per-source
 * seqId and was deliberately left un-armed. That proxied path is exactly the high-volume out-of-order
 * re-delivery source in #399: on resume the bridge re-streams the source's already-applied tail and each
 * record forced the core resequencing walk before being dropped as a duplicate.
 *
 * This test builds an L -> B -> M relay (M receives L's writes transitively via bridge B), forces M to
 * resume its PROXIED subscription by bouncing B, then asserts:
 *   (a) CORRECTNESS GUARD — M converges to every record (the skip never drops a real write); and
 *   (b) ENGAGEMENT — the fast-skip fired on the proxied stream, via the distinctive trace log line.
 *
 * Topology (L = source, B = bridge/proxy, M = transitive follower):
 *
 *     L (source, replicates 'data')
 *      ^  add_node { isLeader: true }   (B full-copies L)
 *      |
 *      B  <----- mesh ('data' + 'system') ----->  M   (M receives L's writes via B)
 *
 * Trust is anchored on L's CA: B adds L FIRST (B's cert signed by L's CA), then M adds B (B's
 * addNodeBack signs M's CSR with that same CA), so all three share L's chain. The loopback harness
 * can't sustain a node holding two independently-signed certs, so B does exactly one outbound add.
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
const CONVERGE_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 250;

// Trace logging is required for the engagement assertion (the fast-skip emits at logger.trace), and
// stdStreams routes it where readLog can find it. M and B mesh on 'data' + 'system'; L replicates 'data'.
function meshConfig(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'trace' },
			replication: { securePort: hostname + ':9933', databases: ['data', 'system'] },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}
function sourceConfig(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'trace' },
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

suite('Proxied Leading Duplicate Fast-Skip', { timeout: 240000 }, (ctx) => {
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

		// The table must exist on every node (M's transitive subscription applies into it).
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

	test('proxied resume re-streams already-applied tail: no records dropped, fast-skip engages', async () => {
		const { nodeL, nodeB } = ctx;

		// 1. B declares L its leader (full-copies L), then M meshes with B. Order matters for CA trust.
		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeL.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: nodeL.admin,
		});
		await sendOperation(ctx.nodeM, {
			operation: 'add_node',
			hostname: nodeB.hostname,
			rejectUnauthorized: false,
			authorization: nodeB.admin,
		});

		// Wait for the B<->M system socket to connect (proves the mesh that carries the relayed stream).
		let meshed = false;
		const meshDeadline = Date.now() + CONNECT_TIMEOUT_MS;
		while (Date.now() < meshDeadline && !meshed) {
			const statusB = await sendOperation(nodeB, { operation: 'cluster_status' }).catch(() => null);
			meshed = statusB?.connections?.some?.((c) =>
				c.database_sockets?.some?.((s) => s.connected && s.database === 'system')
			);
			if (!meshed) await delay(POLL_INTERVAL_MS);
		}
		ok(meshed, 'B and M should mesh with a connected system-database socket');

		// Phase 1: write a batch on L. It full-copies/replicates L -> B -> M. These become the
		// already-applied tail M will see re-streamed (via B) on the proxied resume. Include a DELETE and
		// an UPDATE so the re-streamed tail exercises non-insert ops the skip must not mishandle.
		const PHASE1_BASE = 42; // +2 for the delete victim and update target
		for (let i = 0; i < PHASE1_BASE; i++) {
			await sendOperation(nodeL, {
				operation: 'insert',
				database: 'data',
				table: 'test',
				records: [{ id: `p1-${i}`, name: `phase1-${i}` }],
			});
		}
		await sendOperation(nodeL, {
			operation: 'delete',
			database: 'data',
			table: 'test',
			ids: [`p1-${PHASE1_BASE - 1}`],
		});
		await sendOperation(nodeL, {
			operation: 'update',
			database: 'data',
			table: 'test',
			records: [{ id: 'p1-0', name: 'phase1-updated' }],
		});
		const PHASE1 = PHASE1_BASE - 1; // net count after the delete

		// M must receive the full phase-1 tail transitively before we bounce the proxy — this is what
		// persists M's proxied resume cursor for L (keyed under B's seqId.nodes[L]).
		await waitForCount(ctx.nodeM, PHASE1);

		// Phase 2: bounce the bridge/proxy B. M's connection to B drops; on B's bring-up M re-subscribes
		// and rebuilds its PROXIED subscription to L from the persisted proxy cursor. B (which holds L's
		// data) re-streams L's already-applied tail to M — the proxied leading duplicates #399 targets.
		await killHarper({ harper: nodeB });
		await delay(1000);
		ctx.nodeB = (await startHarper({ harper: nodeB }, meshConfig(nodeB.hostname))).harper;

		// Re-wait for the mesh to come back so the relay is flowing again.
		meshed = false;
		const remeshDeadline = Date.now() + CONNECT_TIMEOUT_MS;
		while (Date.now() < remeshDeadline && !meshed) {
			const statusB = await sendOperation(ctx.nodeB, { operation: 'cluster_status' }).catch(() => null);
			meshed = statusB?.connections?.some?.((c) =>
				c.database_sockets?.some?.((s) => s.connected && s.database === 'system')
			);
			if (!meshed) await delay(POLL_INTERVAL_MS);
		}
		ok(meshed, 'B and M should re-mesh after the bridge bounce');

		// Phase 3: write NEW records on L. They must traverse L -> B -> M normally — proving the skip does
		// not strand the live proxied stream after the resume window.
		const PHASE3 = 10;
		for (let i = 0; i < PHASE3; i++) {
			await sendOperation(nodeL, {
				operation: 'insert',
				database: 'data',
				table: 'test',
				records: [{ id: `p3-${i}`, name: `phase3-${i}` }],
			});
		}

		// (a) CORRECTNESS GUARD: M converges to ALL records (phase1 + phase3). A dropped real record by the
		// skip would leave this short.
		const TOTAL = PHASE1 + PHASE3;
		await waitForCount(ctx.nodeM, TOTAL);

		// Content integrity spot-checks against the re-streamed tail.
		const updated = await sendOperation(ctx.nodeM, {
			operation: 'search_by_id',
			database: 'data',
			table: 'test',
			get_attributes: ['id', 'name'],
			ids: ['p1-0'],
		});
		equal(updated.length, 1, 'updated phase-1 record must survive the proxied resume');
		equal(updated[0].name, 'phase1-updated', 'update must not be lost on the proxied re-stream');
		const deleted = await sendOperation(ctx.nodeM, {
			operation: 'search_by_id',
			database: 'data',
			table: 'test',
			get_attributes: ['id'],
			ids: [`p1-${PHASE1_BASE - 1}`],
		});
		equal(deleted.length, 0, 'deleted phase-1 record must remain absent after the proxied resume');

		// (b) ENGAGEMENT: the fast-skip must have fired on the resumed PROXIED stream. Poll M's log for the
		// distinctive trace line. If this never appears, the proxied arming did not take effect.
		const logDeadline = Date.now() + CONVERGE_TIMEOUT_MS;
		let engaged = false;
		while (Date.now() < logDeadline) {
			const log = await readLog(ctx.nodeM);
			if (log.includes('leading-duplicate fast-skip')) {
				engaged = true;
				break;
			}
			await delay(POLL_INTERVAL_MS);
		}
		ok(
			engaged,
			'expected the leading-duplicate fast-skip to engage on the resumed proxied stream (trace log not found)'
		);
	});
});
