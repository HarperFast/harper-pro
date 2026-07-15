/**
 * Hardening: an aggregation node must NEVER open (or churn a reconnect to) a socket for a discovered
 * peer whose directional self-record excludes it — even under sustained hdb_nodes / system-database
 * churn, which repeatedly re-drives the node-update + wedge/reconcile backstops.
 *
 * Topology (upstream-only aggregation, `system` replicated for discovery):
 *   R (roadside) --sends--> M (middle) --sends--> C (core)
 * R has a directional route ONLY to M (no route to C). C discovers R transitively via `system`, but
 * R's propagated self-record advertises `sendsTo: M` (not C), so the #498 receive gate must keep C from
 * ever subscribing to R. This test churns R's system database (role add/remove) + data writes in a loop
 * and asserts C shows ZERO database sockets to R across the whole window — the backstops re-evaluate the
 * excluded peer repeatedly and must consistently decline to connect.
 *
 * NOTE on the assertion surface: cluster_status reports the SUBSCRIPTION topology (connectionReplication
 * map), which is exactly what the directional self-record governs. On-demand residency/retrieval
 * connections (sharded / invalidated-cache reads) are a separate mechanism driven by data residency, not
 * subscription directionality; this aggregation topology uses neither, so cluster_status is the right and
 * sufficient surface here.
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

const optionsFor = (hostname, routes) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true, level: 'warn' },
		replication: {
			port: hostname + ':9933',
			securePort: null,
			databases: [DB, 'system'],
			routes,
		},
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

const ip = (u = '') => (u.match(/127\.0\.0\.\d+/) || [u])[0];

async function clusterStatus(node) {
	return sendOperation(node, { operation: 'cluster_status' }).catch((e) => ({ error: String(e) }));
}
function socketsToPeer(status, peerIp) {
	for (const c of status?.connections || []) {
		if (ip(c.url) === peerIp)
			return (c.database_sockets || []).map((d) => `${d.database}:${d.connected ? 'up' : 'down'}`);
	}
	return [];
}

suite('hardening: excluded discovered peer never connects under churn', { timeout: 240000 }, (ctx) => {
	before(async () => {
		const C = await getNextAvailableLoopbackAddress();
		const M = await getNextAvailableLoopbackAddress();
		const R = await getNextAvailableLoopbackAddress();
		Object.assign(ctx, { C, M, R });

		const cC = { name: ctx.name, harper: { hostname: C } };
		const cM = { name: ctx.name, harper: { hostname: M } };
		const cR = { name: ctx.name, harper: { hostname: R } };
		await Promise.all([
			// Core receives from Middle only.
			startHarper(cC, optionsFor(C, [{ hostname: M, port: 9933, replicates: { sends: false, receives: true } }])),
			// Middle sends up to Core, receives from Roadside.
			startHarper(
				cM,
				optionsFor(M, [
					{ hostname: C, port: 9933, replicates: { sends: true, receives: false } },
					{ hostname: R, port: 9933, replicates: { sends: false, receives: true } },
				])
			),
			// Roadside sends up to Middle only (NO route to Core).
			startHarper(cR, optionsFor(R, [{ hostname: M, port: 9933, replicates: { sends: true, receives: false } }])),
		]);
		ctx.nodeC = cC.harper;
		ctx.nodeM = cM.harper;
		ctx.nodeR = cR.harper;

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
		await delay(6000); // let sockets establish
	});

	after(async () => {
		await Promise.all([
			ctx.nodeC && teardownHarper({ harper: ctx.nodeC }),
			ctx.nodeM && teardownHarper({ harper: ctx.nodeM }),
			ctx.nodeR && teardownHarper({ harper: ctx.nodeR }),
		]);
	});

	test('sustained system + data churn on the excluded leaf never yields a Core<->Roadside socket', async () => {
		const { nodeC, nodeR } = ctx;

		// Sanity: transitive path works (so we know discovery/replication is actually live, not silent-off).
		const seed = 'seed-' + Date.now();
		await sendOperation(nodeR, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: seed, name: seed }],
		});
		let reachedCore = false;
		for (let i = 0; i < 120 && !reachedCore; i++) {
			const r = await sendOperation(nodeC, {
				operation: 'search_by_id',
				database: DB,
				table: TABLE,
				ids: [seed],
				get_attributes: ['id'],
			}).catch(() => null);
			reachedCore = Array.isArray(r) && r.some((x) => x?.id === seed);
			if (!reachedCore) await delay(300);
		}
		ok(reachedCore, 'precondition: roadside data should reach core transitively (topology is live)');

		// Churn: repeatedly mutate the system database (roles) + data on the excluded leaf. Each role
		// add/remove writes hdb_user / propagates system updates up the chain, and each iteration polls
		// Core's topology. Assert Core NEVER shows a database socket to Roadside — the wedge/reconcile/
		// node-update backstops re-evaluate the excluded peer on every update and must keep declining.
		const ROUNDS = 14;
		let maxRoadsideSockets = 0;
		for (let i = 0; i < ROUNDS; i++) {
			const role = `churn_role_${i}_${Date.now()}`;
			await sendOperation(nodeR, { operation: 'add_role', role, permission: { super_user: false } }).catch(() => {});
			await sendOperation(nodeR, {
				operation: 'insert',
				database: DB,
				table: TABLE,
				records: [{ id: `c${i}-${Date.now()}`, name: 'x' }],
			}).catch(() => {});
			await sendOperation(nodeR, { operation: 'drop_role', role }).catch(() => {});

			const [sc, sr] = await Promise.all([clusterStatus(nodeC), clusterStatus(nodeR)]);
			const cToR = socketsToPeer(sc, ctx.R);
			const rToC = socketsToPeer(sr, ctx.C);
			maxRoadsideSockets = Math.max(maxRoadsideSockets, cToR.length, rToC.length);
			if (cToR.length || rToC.length) {
				console.log(`[CHURN ${i}] LEAK: C->R=[${cToR}] R->C=[${rToC}]`);
			}
			await delay(1000);
		}

		// Report Core's discovery state (non-vacuous: Core should know Roadside via the system relay, yet
		// still hold no socket to it — the gate, not non-propagation, is doing the work).
		const coreNodes = await sendOperation(nodeC, {
			operation: 'search_by_value',
			search_attribute: 'name',
			search_value: '*',
			database: 'system',
			table: 'hdb_nodes',
			get_attributes: ['name', 'replicates'],
		}).catch(() => []);
		console.log(`[CHURN] Core knows nodes: ${JSON.stringify(coreNodes)}`);
		console.log(`[CHURN] max roadside sockets observed on Core/Roadside during churn: ${maxRoadsideSockets}`);

		ok(maxRoadsideSockets === 0, 'Core must hold NO database socket to the excluded Roadside peer under churn');
	});
});
