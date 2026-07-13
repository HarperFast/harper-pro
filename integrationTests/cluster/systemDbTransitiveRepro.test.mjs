/**
 * REPRO (not a shipping test): does replicating the `system` database break tight transitive
 * topology even when directional (#498) routes are configured?
 *
 * Topology intended (upstream-only aggregation, like Toyota roadside->middle->core):
 *
 *   R (roadside)  --sends-->  M (middle)  --sends-->  C (core)
 *
 * Each node has a directional config route ONLY to its immediate neighbor. R has NO route to C.
 * We replicate BOTH `data` and `system` (databases: ['data','system']) and then inspect
 * cluster_status on each node to see whether R forms a DIRECT connection to C (mesh reformed) or
 * whether the topology stays a chain.
 *
 * Run:
 *   HARPER_INTEGRATION_TEST_INSTALL_SCRIPT=<main>/dist/bin/harper.js \
 *   node --test integrationTests/cluster/systemDbTransitiveRepro.test.mjs
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT =
	process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ||
	join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DB = 'data';
const TABLE = 'flow';

const optionsFor = (hostname, routes, databases) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true, level: 'info' },
		replication: {
			port: hostname + ':9933',
			securePort: null,
			databases,
			routes,
		},
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

async function insertRecord(node, id) {
	return sendOperation(node, { operation: 'insert', database: DB, table: TABLE, records: [{ id, name: id }] });
}
async function hasRecord(node, id) {
	const result = await sendOperation(node, {
		operation: 'search_by_id',
		database: DB,
		table: TABLE,
		ids: [id],
		get_attributes: ['id'],
	}).catch(() => null);
	return Array.isArray(result) && result.some((r) => r?.id === id);
}
async function waitForRecord(node, id, { timeoutMs = 60000, pollMs = 300 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await hasRecord(node, id)) return true;
		await delay(pollMs);
	}
	return false;
}
async function clusterStatus(node) {
	return sendOperation(node, { operation: 'cluster_status' }).catch((e) => ({ error: String(e) }));
}

suite('REPRO: system-db replication vs directional topology', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const C = await getNextAvailableLoopbackAddress(); // core
		const M = await getNextAvailableLoopbackAddress(); // middle
		const R = await getNextAvailableLoopbackAddress(); // roadside
		ctx.C = C;
		ctx.M = M;
		ctx.R = R;
		ctx.names = { [`http://${C}:9933`]: 'C', [`http://${M}:9933`]: 'M', [`http://${R}:9933`]: 'R' };

		const DBS = process.env.REPRO_SYSTEM === '0' ? ['data'] : ['data', 'system'];
		console.log(`\n[CONFIG] replication.databases = ${JSON.stringify(DBS)}`);

		const ctxC = { name: ctx.name, harper: { hostname: C } };
		const ctxM = { name: ctx.name, harper: { hostname: M } };
		const ctxR = { name: ctx.name, harper: { hostname: R } };

		await Promise.all([
			// Core receives from Middle only
			startHarper(
				ctxC,
				optionsFor(C, [{ hostname: M, port: 9933, replicates: { sends: false, receives: true } }], DBS)
			),
			// Middle sends up to Core, receives from Roadside
			startHarper(
				ctxM,
				optionsFor(
					M,
					[
						{ hostname: C, port: 9933, replicates: { sends: true, receives: false } },
						{ hostname: R, port: 9933, replicates: { sends: false, receives: true } },
					],
					DBS
				)
			),
			// Roadside sends up to Middle only (NO route to Core)
			startHarper(
				ctxR,
				optionsFor(R, [{ hostname: M, port: 9933, replicates: { sends: true, receives: false } }], DBS)
			),
		]);

		ctx.nodeC = ctxC.harper;
		ctx.nodeM = ctxM.harper;
		ctx.nodeR = ctxR.harper;

		await Promise.all(
			[ctx.nodeC, ctx.nodeM, ctx.nodeR].map((node) =>
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
	});

	after(async () => {
		await Promise.all([
			ctx.nodeC && teardownHarper({ harper: ctx.nodeC }),
			ctx.nodeM && teardownHarper({ harper: ctx.nodeM }),
			ctx.nodeR && teardownHarper({ harper: ctx.nodeR }),
		]);
	});

	test('observe topology after replicating system + data through a chain', async () => {
		const { nodeC, nodeM, nodeR, names } = ctx;

		// Give sockets time to establish before probing dataflow.
		await delay(6000);

		// (1) transitive upstream: roadside write should reach core via middle
		const rec = 'up-' + Date.now();
		await insertRecord(nodeR, rec);
		const reachedM = await waitForRecord(nodeM, rec, { timeoutMs: 60000 });
		const reachedC = await waitForRecord(nodeC, rec, { timeoutMs: 60000 });
		console.log(`\n[DATAFLOW transitive R->M->C] reached Middle=${reachedM} Core=${reachedC}`);

		// (2) direct upstream edge: a MIDDLE write should reach core (M sends, C receives)
		const mid = 'mid-' + Date.now();
		await insertRecord(nodeM, mid);
		const midReachedC = await waitForRecord(nodeC, mid, { timeoutMs: 60000 });
		console.log(`[DATAFLOW direct M->C] middle write reached Core=${midReachedC}`);

		await delay(4000);

		const [sc, sm, sr] = await Promise.all([clusterStatus(nodeC), clusterStatus(nodeM), clusterStatus(nodeR)]);
		console.log('\n===== FULL CLUSTER STATUS =====');
		const dbSockets = (label, s) => {
			const conns = s?.connections || [];
			for (const c of conns) {
				const nm = names[c.url] || c.name;
				const socks = (c.database_sockets || []).map((d) => `${d.database}:${d.connected ? 'up' : 'DOWN'}`).join(',');
				console.log(`  ${label} -> ${nm}: replicates=${JSON.stringify(c.replicates)} sockets=[${socks || 'none'}]`);
			}
		};
		console.log('C(core)   node_name=' + sc?.node_name);
		dbSockets('C', sc);
		console.log('M(middle) node_name=' + sm?.node_name);
		dbSockets('M', sm);
		console.log('R(roadside) node_name=' + sr?.node_name);
		dbSockets('R', sr);

		// hdb_nodes convergence: how many node rows does each node know about?
		for (const [label, node] of [
			['C', nodeC],
			['M', nodeM],
			['R', nodeR],
		]) {
			const rows = await sendOperation(node, {
				operation: 'search_by_conditions',
				database: 'system',
				table: 'hdb_nodes',
				conditions: [{ search_attribute: 'name', search_type: 'greater_than_equal', search_value: '' }],
				get_attributes: ['name', 'replicates', 'url'],
			}).catch((e) => [{ error: String(e) }]);
			console.log(`[hdb_nodes on ${label}] ${JSON.stringify(rows)}`);
		}

		// Does a NON-hdb_nodes system-table row relay R->M->C? (roles/users/schema are the real reason
		// to replicate system). If a role created on Roadside reaches Core, then only hdb_nodes-driven
		// CONNECTIONS are constrained and global config still propagates — the ideal outcome.
		const roleName = 'repro_role_' + Date.now();
		await sendOperation(nodeR, {
			operation: 'add_role',
			role: roleName,
			permission: { super_user: false },
		}).catch((e) => console.log('[ROLE] add_role on R failed:', String(e)));
		let roleOnCore = false;
		for (let i = 0; i < 40; i++) {
			const roles = await sendOperation(nodeC, { operation: 'list_roles' }).catch(() => null);
			if (Array.isArray(roles) && roles.some((r) => r?.role === roleName)) {
				roleOnCore = true;
				console.log(`[ROLE] role created on Roadside reached Core after ~${i * 0.5}s`);
				break;
			}
			await delay(500);
		}
		if (!roleOnCore) console.log('[ROLE] role created on Roadside NEVER reached Core (system config relay truncated)');

		// Disambiguation: does Core eventually LEARN about Roadside (transitive hdb_nodes relay)?
		// If yes + no direct socket => the receive-gate is doing the work (intended, discovery preserved).
		// If Core never learns R => mesh averted only by non-propagation (weaker; central visibility lost).
		const rName = ctx.R;
		let coreKnowsRoadside = false;
		// Diagnostic only (central visibility of a far leaf is NOT guaranteed — the hdb_nodes registry
		// relay differs from data relay), so keep this probe short.
		for (let i = 0; i < 24; i++) {
			const rows = await sendOperation(nodeC, {
				operation: 'search_by_id',
				database: 'system',
				table: 'hdb_nodes',
				ids: [rName],
				get_attributes: ['name', 'replicates'],
			}).catch(() => null);
			if (Array.isArray(rows) && rows.some((r) => r?.name === rName)) {
				coreKnowsRoadside = true;
				console.log(`[PROBE] Core learned Roadside after ~${i * 0.5}s: ${JSON.stringify(rows)}`);
				break;
			}
			await delay(500);
		}
		if (!coreKnowsRoadside) console.log('[PROBE] Core NEVER learned Roadside in 60s (hdb_nodes relay did not deliver)');
		await delay(3000); // give any (buggy) mesh connection time to establish after discovery
		const ipName = (u = '') => (u.match(/127\.0\.0\.\d+/) || [u])[0];
		const scAfter = await clusterStatus(nodeC);
		console.log('[PROBE] Core connections AFTER discovery + settle:');
		let coreHasRoadsideSocket = false;
		for (const c of scAfter?.connections || []) {
			const ip = ipName(c.url);
			const label = ip === ctx.R ? 'ROADSIDE' : ip === ctx.M ? 'middle' : ip;
			const socks = (c.database_sockets || []).map((d) => `${d.database}:${d.connected ? 'up' : 'DOWN'}`);
			if (ip === ctx.R && socks.length) coreHasRoadsideSocket = true;
			console.log(`   Core -> ${label} (${ip}): sockets=[${socks.join(',') || 'NONE (registry-only)'}]`);
		}
		console.log(
			coreHasRoadsideSocket
				? '[PROBE] >>> Core has ACTIVE sockets to Roadside — MESH REFORMED (gate bypassed)'
				: '[PROBE] >>> Core has NO active socket to Roadside — gate held (R is registry-only)'
		);

		// Decisive check: is there ANY direct Core<->Roadside socket (either direction)?
		const peerSet = (s) => new Set((s?.connections || []).map((c) => names[c.url] || c.name));
		const cPeers = peerSet(sc);
		const rPeers = peerSet(sr);
		const coreTouchesRoadside = cPeers.has('R') || rPeers.has('C');
		console.log(`\n[VERDICT] Core peers=[${[...cPeers]}]  Roadside peers=[${[...rPeers]}]`);
		console.log(
			coreTouchesRoadside
				? '[VERDICT] MESH REFORMED: a direct Core<->Roadside socket exists (system propagation defeats tight topology)'
				: '[VERDICT] TOPOLOGY HELD: no direct Core<->Roadside socket (chain preserved)'
		);

		// Assertions — the durable invariants (the role/discovery probes above stay diagnostics: central
		// visibility of every far leaf is intentionally NOT guaranteed, and the hdb_nodes relay is racy).
		ok(reachedM, 'roadside data write should reach middle');
		ok(reachedC, 'roadside data write should reach core transitively (R->M->C)');
		ok(midReachedC, 'middle data write should reach core (direct up edge)');
		ok(!coreTouchesRoadside, 'no direct Core<->Roadside replication socket should form even with `system` replicated');
	});
});
