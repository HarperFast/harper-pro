/**
 * Integration test: add_node { isLeader: true } against a bridge source must NOT
 * leak that source's hdb_nodes record to the rest of the mesh (harper-pro #246).
 *
 * Topology (L = leader/source, B = bridge, M = mesh peer):
 *
 *     L (source, has pre-existing data)
 *          ^  add_node { isLeader: true }
 *          |
 *          B  <----- system replication (default databases) ----->  M
 *
 * B is meshed with M with system replication ON (default config — so hdb_nodes
 * normally replicates between B and M). B then runs add_node { isLeader: true }
 * against L. The L source record carries replicates.sends, so before the fix it
 * replicated from B to M; M then opened a direct (unauthorized) subscription to L
 * in a reconnect loop, and the leaf-knows-L exclusion stalled the mesh at 0 rows.
 *
 * With the LOCAL_ONLY metadata-flag fix, B persists L's hdb_nodes row with the
 * LOCAL_ONLY bit so it lives in the normal hdb_nodes table (driving B's own
 * watcher / subscription / full-copy) but is never forwarded to M.
 *
 * Asserts:
 *   1. L is ABSENT from M's hdb_nodes (no mesh leak).
 *   2. B full-copies L's pre-existing records (the local-only row still works locally).
 *
 * This FAILS on unmodified main (L leaks to M) and PASSES with the fix.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
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

const PRE_EXISTING_RECORD_COUNT = 5;

suite('add_node isLeader does not leak source node to mesh', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const hostnameL = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		const hostnameM = await getNextAvailableLoopbackAddress();

		const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });

		// B and M replicate 'data' (bridge full-copy) AND 'system' (so hdb_nodes replicates
		// across the B<->M mesh — this is what makes a leak observable). The isLeader
		// full-copy bootstrap also requires 'data' to be listed.
		const meshConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: {
					securePort: hostname + ':9933',
					databases: ['data', 'system'],
				},
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		// L (bridge SOURCE; models a v4 origin) replicates 'data' only, so it never pushes its
		// own system.hdb_nodes self-record to B. The ONLY way L appears in B's hdb_nodes is the
		// record setNode writes during add_node — exactly the record the LOCAL_ONLY fix targets.
		const sourceConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: {
					securePort: hostname + ':9933',
					databases: ['data'],
				},
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const ctxL = makeNodeCtx(hostnameL);
		const ctxB = makeNodeCtx(hostnameB);
		const ctxM = makeNodeCtx(hostnameM);

		await Promise.all([
			startHarper(ctxL, sourceConfig(hostnameL)),
			startHarper(ctxB, meshConfig(hostnameB)),
			startHarper(ctxM, meshConfig(hostnameM)),
		]);

		ctx.nodeL = ctxL.harper;
		ctx.nodeB = ctxB.harper;
		ctx.nodeM = ctxM.harper;

		// Pre-existing data on the source (L) that the bridge (B) must full-copy.
		await sendOperation(ctx.nodeL, {
			operation: 'create_table',
			database: 'data',
			table: 'bridge_src',
			primary_key: 'id',
		});
		const records = Array.from({ length: PRE_EXISTING_RECORD_COUNT }, (_, i) => ({
			id: `src-${i}`,
			value: `v${i}`,
		}));
		await sendOperation(ctx.nodeL, {
			operation: 'upsert',
			database: 'data',
			table: 'bridge_src',
			records,
		});
	});

	after(async () => {
		await Promise.all([
			ctx.nodeL && teardownHarper({ harper: ctx.nodeL }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
			ctx.nodeM && teardownHarper({ harper: ctx.nodeM }),
		]);
	});

	test('source node stays local to bridge; bridge full-copies its data', async () => {
		const { nodeL, nodeB, nodeM } = ctx;

		// Trust is anchored on L's CA. B adds L FIRST, so B's replication cert is signed by
		// L's CA. When M then adds B, B's addNodeBack signs M's CSR with that same (L) CA, so
		// M, B and L all share L's CA chain. (The loopback harness can't sustain a node holding
		// two independently-signed certs, so B must do exactly one outbound add — to L.)

		// 1. B declares L its leader: full-copy L's data. Plain replicates:true (no route
		// exclusions) so L authorizes B's subscription. L itself only replicates 'data', so
		// L's hdb_nodes never reaches B — the ONLY L entry in B's hdb_nodes is the record
		// setNode writes, the record the LOCAL_ONLY fix marks so it never reaches M.
		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeL.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: nodeL.admin,
		});

		// 2. Mesh B <-> M (M adds B), inheriting L's CA so all three nodes trust each other.
		await sendOperation(nodeM, {
			operation: 'add_node',
			hostname: nodeB.hostname,
			rejectUnauthorized: false,
			authorization: nodeB.admin,
		});

		// Wait for the B<->M system-database socket to connect.
		let meshed = false;
		for (let i = 0; i < 40 && !meshed; i++) {
			await delay(500);
			const statusB = await sendOperation(nodeB, { operation: 'cluster_status' }).catch(() => null);
			meshed = statusB?.connections?.some?.((c) =>
				c.database_sockets?.some?.((s) => s.connected && s.database === 'system')
			);
		}
		ok(meshed, 'B and M should mesh with a connected system-database socket');

		// 3. B should full-copy L's pre-existing records.
		let receivedOnB = [];
		for (let i = 0; i < 90 && receivedOnB.length < PRE_EXISTING_RECORD_COUNT; i++) {
			await delay(500);
			const result = await sendOperation(nodeB, {
				operation: 'search_by_value',
				database: 'data',
				table: 'bridge_src',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['id', 'value'],
			}).catch(() => []);
			receivedOnB = result ?? [];
		}
		equal(
			receivedOnB.length,
			PRE_EXISTING_RECORD_COUNT,
			`Bridge B should full-copy ${PRE_EXISTING_RECORD_COUNT} records from L, got ${receivedOnB.length}`
		);

		// 4. Barrier (not an arbitrary sleep): wait until L's data reaches M transitively through the
		// bridge. hdb_nodes rides the SAME system-DB stream B->M, so once L's data has landed on M the
		// system stream is demonstrably flowing and caught up — if L's node record were going to leak
		// into M's hdb_nodes, it would have arrived by now. This is a real happens-after barrier.
		let srcOnM = [];
		for (let i = 0; i < 60 && srcOnM.length < PRE_EXISTING_RECORD_COUNT; i++) {
			await delay(500);
			const result = await sendOperation(nodeM, {
				operation: 'search_by_value',
				database: 'data',
				table: 'bridge_src',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['id'],
			}).catch(() => []);
			srcOnM = result ?? [];
		}
		equal(
			srcOnM.length,
			PRE_EXISTING_RECORD_COUNT,
			`M should receive L's ${PRE_EXISTING_RECORD_COUNT} source records via the bridge, got ${srcOnM.length}`
		);

		// Leak gate (inverted poll, fail-fast): over a window, M's hdb_nodes must NEVER contain L. A
		// fixed sleep could false-pass on a slow host (leak just hasn't arrived yet); this fails the
		// instant L appears and passes only after the window stays clean.
		const namesOnM = async () =>
			(
				await sendOperation(nodeM, {
					operation: 'search_by_value',
					search_attribute: 'name',
					search_value: '*',
					database: 'system',
					table: 'hdb_nodes',
					get_attributes: ['name'],
				}).catch(() => [])
			).map((n) => n.name);
		const assertLNeverLeaks = async (phase) => {
			for (let i = 0; i < 16; i++) {
				const names = await namesOnM();
				ok(
					!names.includes(nodeL.hostname),
					`[${phase}] source L (${nodeL.hostname}) must NOT leak into M's hdb_nodes; found: ${names.join(', ')}`
				);
				await delay(500);
			}
		};
		await assertLNeverLeaks('after full-copy');

		// 5. Regression for #246 stickiness: re-running add_node against L WITHOUT isLeader must NOT clear
		// the LOCAL_ONLY flag and re-leak L. The metadata bit is per-write, so ensureNode must re-assert
		// it from the existing row (which still has isLeader:true); a naive implementation drops it on
		// the next plain patch. Re-issue add_node (no isLeader), push a delta on L, wait for the delta to
		// reach M (barrier), then re-assert L is still absent from M's hdb_nodes.
		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeL.hostname,
			rejectUnauthorized: false,
			authorization: nodeL.admin,
		});
		await sendOperation(nodeL, {
			operation: 'upsert',
			database: 'data',
			table: 'bridge_src',
			records: [{ id: 'post-update-1', value: 'after update_node without isLeader' }],
		});
		let deltaOnM = [];
		for (let i = 0; i < 60 && deltaOnM.length === 0; i++) {
			await delay(500);
			deltaOnM = (
				await sendOperation(nodeM, {
					operation: 'search_by_id',
					database: 'data',
					table: 'bridge_src',
					ids: ['post-update-1'],
					get_attributes: ['id'],
				}).catch(() => [])
			) ?? [];
		}
		equal(deltaOnM.length, 1, 'post-update delta from L should still reach M via the bridge');
		await assertLNeverLeaks('after re-add without isLeader');
	});
});
