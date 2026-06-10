/**
 * Integration test: add_node { isLeader: true } must NOT leak the leader designation to the mesh
 * (harper-pro#246).
 *
 * Background: the v4->v5 migration bridge issues `add_node { isLeader: true }` against a v4 source.
 * `isLeader` is meant as NODE-LOCAL intent ("I, the bridge, should full-copy from this peer"). The
 * bug was that `isLeader` got persisted onto the bridge's replicated `system.hdb_nodes` record of
 * the peer. That record replicates to the rest of the v5 mesh; every other v5 node then read
 * `isLeader: true` and adopted the source as ITS OWN leader, opening a direct full-copy
 * subscription that fails cert validation in a reconnect loop. At scale, the whole cluster dials
 * the production source.
 *
 * The leak is v5-mesh-internal, so it reproduces with only v5 nodes (no v4/docker needed).
 *
 * Topology:
 *   - L (leader/source): holds pre-existing data.
 *   - B (bridge): meshes with M (normal add_node, SYSTEM replication ON), then designates L as its
 *     leader via add_node { isLeader: true }.
 *   - M (other mesh node): meshed with B. Must NEVER adopt L as its leader purely because B did.
 *
 * IMPORTANT: B<->M replication is full system replication (we do NOT pin databases:['data'] —
 * that would stop B's hdb_nodes record of L from replicating to M and would mask the bug).
 *
 * Assertions:
 *   - (negative / the bug) The hdb_nodes record of L DOES replicate to M (we poll until it appears,
 *     proving the replication path that carried the leak is live), and it must NOT carry isLeader.
 *     In the buggy code this field is `true` on M — that replicated flag is literally what made
 *     every other mesh node adopt L as its own leader and open a direct full-copy subscription that
 *     fails cert validation in a reconnect loop. Its absence is the decisive proof the leak is gone.
 *   - (positive) B still full-copies L's pre-existing data (startTime=0): all N records arrive.
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

suite('add_node isLeader does not leak leader designation to mesh', { timeout: 240000 }, (ctx) => {
	before(async () => {
		const hostnameL = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		const hostnameM = await getNextAvailableLoopbackAddress();

		const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });

		// Full system replication (no databases pin) so B's hdb_nodes record of L replicates to M —
		// that replication path is exactly what carried the isLeader leak.
		const commonConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: {
					port: hostname + ':9933',
					securePort: null,
				},
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const ctxL = makeNodeCtx(hostnameL);
		const ctxB = makeNodeCtx(hostnameB);
		const ctxM = makeNodeCtx(hostnameM);

		await Promise.all([
			startHarper(ctxL, commonConfig(hostnameL)),
			startHarper(ctxB, commonConfig(hostnameB)),
			startHarper(ctxM, commonConfig(hostnameM)),
		]);

		ctx.nodeL = ctxL.harper;
		ctx.nodeB = ctxB.harper;
		ctx.nodeM = ctxM.harper;

		// Create table and write pre-existing records on L *before* B connects, so a full copy
		// (startTime=0) is the only way B can obtain them.
		await sendOperation(ctx.nodeL, {
			operation: 'create_table',
			database: 'data',
			table: 'leak_test',
			primary_key: 'id',
		});
		const records = Array.from({ length: PRE_EXISTING_RECORD_COUNT }, (_, i) => ({
			id: `pre-existing-${i}`,
			value: `v${i}`,
		}));
		await sendOperation(ctx.nodeL, {
			operation: 'upsert',
			database: 'data',
			table: 'leak_test',
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

	test('M does not adopt L as leader; B still full-copies pre-existing data', async () => {
		const { nodeL, nodeB, nodeM } = ctx;

		// 1. Mesh B and M with normal (non-leader) full replication. System replication is ON, so
		//    B's hdb_nodes record of L replicates to M — the exact path that carried the isLeader
		//    leak. We deliberately do NOT pin databases:['data']; that would suppress this path and
		//    mask the bug.
		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeM.hostname,
			rejectUnauthorized: false,
			authorization: nodeM.admin,
		});

		// Wait for the B<->M system connection to come up so subsequent records replicate.
		let meshUp = false;
		for (let i = 0; i < 60 && !meshUp; i++) {
			await delay(500);
			const [statusB, statusM] = await Promise.all([
				sendOperation(nodeB, { operation: 'cluster_status' }).catch(() => null),
				sendOperation(nodeM, { operation: 'cluster_status' }).catch(() => null),
			]);
			const bOk = statusB?.connections?.some?.((c) =>
				c.database_sockets?.some?.((s) => s.connected && s.database === 'system')
			);
			const mOk = statusM?.connections?.some?.((c) =>
				c.database_sockets?.some?.((s) => s.connected && s.database === 'system')
			);
			meshUp = bOk && mOk;
		}
		ok(meshUp, 'B and M should show a connected system-database socket');

		// 2. From B, designate L as B's leader and request a full copy.
		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeL.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: nodeL.admin,
		});

		// 3. POSITIVE: B full-copies L's pre-existing data (startTime=0).
		let received = [];
		for (let i = 0; i < 120 && received.length < PRE_EXISTING_RECORD_COUNT; i++) {
			await delay(500);
			const result = await sendOperation(nodeB, {
				operation: 'search_by_value',
				database: 'data',
				table: 'leak_test',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['id', 'value'],
			}).catch(() => []);
			received = result ?? [];
		}
		equal(
			received.length,
			PRE_EXISTING_RECORD_COUNT,
			`(positive) Expected B to full-copy ${PRE_EXISTING_RECORD_COUNT} pre-existing records from L, got ${received.length}`
		);
		ok(received.map((r) => r.id).includes('pre-existing-0'), 'pre-existing-0 must be present on B');

		// 4a. NEGATIVE (PRIMARY): poll until B's hdb_nodes record of L replicates to M (proving the
		//     leak-carrying path is live), then assert it does NOT carry isLeader. In the buggy code
		//     this field is `true` on M — exactly the replicated flag that made other mesh nodes adopt
		//     L as their leader. We give the mesh ample time for any leaked flag to land.
		let lRecordOnM = null;
		for (let i = 0; i < 60 && !lRecordOnM; i++) {
			await delay(500);
			const nodesOnM = await sendOperation(nodeM, {
				operation: 'search_by_value',
				search_attribute: 'name',
				search_value: '*',
				database: 'system',
				table: 'hdb_nodes',
				get_attributes: ['name', 'isLeader'],
			}).catch(() => []);
			lRecordOnM = (nodesOnM ?? []).find((n) => n.name === nodeL.hostname) ?? null;
		}
		ok(
			lRecordOnM,
			"L's hdb_nodes record must replicate to M (otherwise the test cannot observe the leak-carrying path)"
		);
		ok(
			!lRecordOnM.isLeader,
			`(negative) L's hdb_nodes record replicated to M must NOT carry isLeader (got isLeader=${lRecordOnM.isLeader})`
		);
	});
});
