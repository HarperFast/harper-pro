/**
 * REPRO (b): per-DATABASE opposite directions on one cluster, with `system` replicated.
 *
 * Toyota shape: `cardata` aggregates UPSTREAM (roadside -> middle -> core); `config` (central
 * config/schema/users) distributes DOWNSTREAM (core -> middle -> roadside). Same three nodes, same
 * per-neighbor routes, opposite direction per database. `system` is replicated for node discovery.
 *
 *   cardata:  R --send--> M --send--> C     (receivers: C<-M, M<-R)
 *   config:   C --send--> M --send--> R     (receivers: R<-M, M<-C)
 *
 * Depends on the directional-self-record patch (computeSelfReplicates) in
 * dist/replication/subscriptionManager.js.
 *
 * Asserts:
 *  - cardata write on Roadside reaches Core (UP, transitive)
 *  - config  write on Core reaches Roadside (DOWN, transitive)
 *  - config  write on Roadside does NOT reach Core (config is down-only)
 *  - no direct Core<->Roadside replication socket (topology held)
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

const UP = 'cardata'; // flows roadside -> core
const DOWN = 'config'; // flows core -> roadside
const TABLE = 't';

const optionsFor = (hostname, routes) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true, level: 'warn' },
		replication: {
			port: hostname + ':9933',
			securePort: null,
			databases: [UP, DOWN, 'system'],
			routes,
		},
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

async function insert(node, db, id) {
	return sendOperation(node, { operation: 'insert', database: db, table: TABLE, records: [{ id, name: id }] });
}
async function has(node, db, id) {
	const r = await sendOperation(node, {
		operation: 'search_by_id',
		database: db,
		table: TABLE,
		ids: [id],
		get_attributes: ['id'],
	}).catch(() => null);
	return Array.isArray(r) && r.some((x) => x?.id === id);
}
async function waitFor(node, db, id, { timeoutMs = 90000, pollMs = 300 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await has(node, db, id)) return true;
		await delay(pollMs);
	}
	return false;
}
async function clusterStatus(node) {
	return sendOperation(node, { operation: 'cluster_status' }).catch((e) => ({ error: String(e) }));
}
const ip = (u = '') => (u.match(/127\.0\.0\.\d+/) || [u])[0];

suite('REPRO(b): per-database opposite directions + system on', { timeout: 240000 }, (ctx) => {
	before(async () => {
		const C = await getNextAvailableLoopbackAddress();
		const M = await getNextAvailableLoopbackAddress();
		const R = await getNextAvailableLoopbackAddress();
		Object.assign(ctx, { C, M, R });

		// Per-database directional routes. sendsTo/receivesFrom scope by database; the peer is implicit
		// (the route's hostname), resolved by computeSelfReplicates into the propagated self-record.
		const routeC = [
			// C <-> M : C receives cardata (up), C sends config (down)
			{ hostname: M, port: 9933, replicates: { sendsTo: [{ database: DOWN }], receivesFrom: [{ database: UP }] } },
		];
		const routeM = [
			// M <-> C : M sends cardata up, M receives config down
			{ hostname: C, port: 9933, replicates: { sendsTo: [{ database: UP }], receivesFrom: [{ database: DOWN }] } },
			// M <-> R : M receives cardata up, M sends config down
			{ hostname: R, port: 9933, replicates: { sendsTo: [{ database: DOWN }], receivesFrom: [{ database: UP }] } },
		];
		const routeR = [
			// R <-> M : R sends cardata up, R receives config down
			{ hostname: M, port: 9933, replicates: { sendsTo: [{ database: UP }], receivesFrom: [{ database: DOWN }] } },
		];

		const cC = { name: ctx.name, harper: { hostname: C } };
		const cM = { name: ctx.name, harper: { hostname: M } };
		const cR = { name: ctx.name, harper: { hostname: R } };
		await Promise.all([
			startHarper(cC, optionsFor(C, routeC)),
			startHarper(cM, optionsFor(M, routeM)),
			startHarper(cR, optionsFor(R, routeR)),
		]);
		ctx.nodeC = cC.harper;
		ctx.nodeM = cM.harper;
		ctx.nodeR = cR.harper;

		// Create both tables on all nodes.
		for (const db of [UP, DOWN]) {
			await Promise.all(
				[ctx.nodeC, ctx.nodeM, ctx.nodeR].map((node) =>
					sendOperation(node, {
						operation: 'create_table',
						database: db,
						table: TABLE,
						primary_key: 'id',
						attributes: [
							{ name: 'id', type: 'ID' },
							{ name: 'name', type: 'String' },
						],
					})
				)
			);
		}
		await delay(6000); // let sockets establish
	});

	after(async () => {
		await Promise.all([
			ctx.nodeC && teardownHarper({ harper: ctx.nodeC }),
			ctx.nodeM && teardownHarper({ harper: ctx.nodeM }),
			ctx.nodeR && teardownHarper({ harper: ctx.nodeR }),
		]);
	});

	test('cardata flows up, config flows down, no direct core<->roadside socket', async () => {
		const { nodeC, nodeR } = ctx;

		const up = 'up-' + Date.now();
		await insert(nodeR, UP, up);
		const upC = await waitFor(nodeC, UP, up);
		console.log(`[UP]   cardata write on Roadside reached Core = ${upC}`);

		const down = 'down-' + Date.now();
		await insert(nodeC, DOWN, down);
		const downR = await waitFor(nodeR, DOWN, down);
		console.log(`[DOWN] config write on Core reached Roadside = ${downR}`);

		// Negative: config authored on Roadside must NOT climb to Core (config is down-only).
		const badUp = 'cfgup-' + Date.now();
		await insert(nodeR, DOWN, badUp);
		// give it as long as a real down-propagation takes, then assert absence
		const leaked = await waitFor(nodeC, DOWN, badUp, { timeoutMs: 20000 });
		console.log(`[NEG]  config write on Roadside reached Core = ${leaked} (expect false)`);

		await delay(4000);
		const sc = await clusterStatus(nodeC);
		const sr = await clusterStatus(nodeR);
		const dump = (label, s) => {
			for (const c of s?.connections || []) {
				const socks = (c.database_sockets || []).map((d) => `${d.database}:${d.connected ? 'up' : 'DOWN'}`);
				console.log(`   ${label} -> ${ip(c.url)}: [${socks.join(',') || 'registry-only'}]`);
			}
		};
		console.log('[SOCKETS] Core:');
		dump('C', sc);
		console.log('[SOCKETS] Roadside:');
		dump('R', sr);
		const coreToRoadsideSocket = (sc?.connections || []).some(
			(c) => ip(c.url) === ctx.R && (c.database_sockets || []).length > 0
		);
		const roadsideToCoreSocket = (sr?.connections || []).some(
			(c) => ip(c.url) === ctx.C && (c.database_sockets || []).length > 0
		);
		console.log(`[VERDICT] direct Core<->Roadside socket = ${coreToRoadsideSocket || roadsideToCoreSocket}`);

		ok(upC, 'cardata should flow roadside -> core (up)');
		ok(downR, 'config should flow core -> roadside (down)');
		ok(!leaked, 'config must NOT flow roadside -> core (down-only)');
		ok(!coreToRoadsideSocket && !roadsideToCoreSocket, 'no direct core<->roadside replication socket');
	});
});
