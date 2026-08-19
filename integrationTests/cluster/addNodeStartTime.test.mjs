/**
 * Integration test: add_node { start_time } limits a user database to records written after that time.
 *
 * add_node persists the operator's start point as `start_time` (snake_case); the copy-start gate in
 * replicationConnection read `startTime` (camelCase). The two never matched, so an add_node start point
 * was silently ignored and every fresh join full-copied everything. This pins the fixed behavior:
 * the cutoff is exclusive (data strictly after start_time), so records at or before it are not copied
 * and records after it are. Fails on base (all records arrive), passes with the fix.
 *
 * The second suite guards the system database, which carries cluster metadata (auth, roles, membership)
 * a joining node must have in full: start_time must NOT filter it even when a user database is filtered.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
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

const PRE_COUNT = 5;
const POST_COUNT = 4;

suite('add_node start_time limits the base copy', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });
		const commonConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: { port: hostname + ':9933', securePort: null, databases: ['data'] },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const ctxA = makeNodeCtx(hostnameA);
		const ctxB = makeNodeCtx(hostnameB);
		await Promise.all([startHarper(ctxA, commonConfig(hostnameA)), startHarper(ctxB, commonConfig(hostnameB))]);
		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;

		await sendOperation(ctx.nodeA, {
			operation: 'create_table',
			database: 'data',
			table: 'start_time_test',
			primary_key: 'id',
		});

		// Pre-cutover records (must NOT be copied).
		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'start_time_test',
			records: Array.from({ length: PRE_COUNT }, (_, i) => ({ id: `pre-${i}` })),
		});
		// Separate the two batches so the cutover timestamp sits cleanly between them.
		await delay(1500);
		ctx.cutover = Date.now();
		await delay(1500);
		// Post-cutover records (must be copied).
		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'start_time_test',
			records: Array.from({ length: POST_COUNT }, (_, i) => ({ id: `post-${i}` })),
		});
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('records at or before start_time are skipped, records after are copied', async () => {
		const { nodeA, nodeB, cutover } = ctx;

		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			// Documented contract: ISO 8601 UTC string, exclusive (data strictly after this instant).
			start_time: new Date(cutover).toISOString(),
			authorization: nodeA.admin,
		});

		const idsOnB = async () =>
			(
				(await sendOperation(nodeB, {
					operation: 'search_by_value',
					database: 'data',
					table: 'start_time_test',
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['id'],
				}).catch(() => [])) ?? []
			).map((r) => r.id);

		// Wait until the post-cutover records have arrived (the copy has run and delivered what it will).
		let ids = [];
		for (let i = 0; i < 90 && ids.filter((id) => id.startsWith('post-')).length < POST_COUNT; i++) {
			await delay(500);
			ids = await idsOnB();
		}
		// Settle: on base (unfixed) the full copy also delivers the pre-cutover records; give them time to
		// arrive so a regression fails here rather than passing on a copy-order race.
		await delay(3000);
		ids = await idsOnB();

		equal(ids.filter((id) => id.startsWith('post-')).length, POST_COUNT, 'all post-start_time records must arrive');
		equal(ids.filter((id) => id.startsWith('pre-')).length, 0, 'no pre-start_time records may be copied');
	});

	test('a non-ISO-UTC start_time is rejected at the operation boundary (400)', async () => {
		// setNode must reject not only garbage but also parseable-but-ambiguous strings (a locale form, or a
		// zone-less datetime parsed in the host's local time), rather than applying a host-dependent cutoff.
		const reject = async (start_time) => {
			const res = await fetch(ctx.nodeB.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: 'add_node',
					hostname: ctx.nodeA.hostname,
					rejectUnauthorized: false,
					isLeader: true,
					start_time,
					authorization: ctx.nodeA.admin,
				}),
			});
			equal(res.status, 400, `start_time ${JSON.stringify(start_time)} must be rejected with 400`);
		};
		await reject('not-a-date');
		await reject('01/02/2024'); // parseable by Date, ambiguous locale form
		await reject('2024-01-01T00:00:00'); // parseable by Date, no zone (host-local)
	});
});

suite('add_node start_time does not filter the system database', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });
		const commonConfig = (hostname) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true },
				replication: { port: hostname + ':9933', securePort: null, databases: ['data', 'system'] },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});

		const ctxA = makeNodeCtx(hostnameA);
		const ctxB = makeNodeCtx(hostnameB);
		await Promise.all([startHarper(ctxA, commonConfig(hostnameA)), startHarper(ctxB, commonConfig(hostnameB))]);
		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;

		await sendOperation(ctx.nodeA, {
			operation: 'create_table',
			database: 'data',
			table: 'system_guard_test',
			primary_key: 'id',
		});
		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'system_guard_test',
			records: Array.from({ length: PRE_COUNT }, (_, i) => ({ id: `pre-${i}` })),
		});
		// A system-database row (a role) written BEFORE the cutoff. If start_time wrongly filtered the
		// system db this would be skipped, leaving the joining node without cluster metadata.
		await sendOperation(ctx.nodeA, { operation: 'add_role', role: 'prerole', permission: { super_user: false } });
		await delay(1500);
		ctx.cutover = Date.now();
		await delay(1500);
		await sendOperation(ctx.nodeA, {
			operation: 'upsert',
			database: 'data',
			table: 'system_guard_test',
			records: Array.from({ length: POST_COUNT }, (_, i) => ({ id: `post-${i}` })),
		});
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('the user database is filtered but the system database is copied in full', async () => {
		const { nodeA, nodeB, cutover } = ctx;

		await sendOperation(nodeB, {
			operation: 'add_node',
			hostname: nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			start_time: new Date(cutover).toISOString(),
			authorization: nodeA.admin,
		});

		const dataIds = async () =>
			(
				(await sendOperation(nodeB, {
					operation: 'search_by_value',
					database: 'data',
					table: 'system_guard_test',
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['id'],
				}).catch(() => [])) ?? []
			).map((r) => r.id);
		const preroleReplicated = async () =>
			((await sendOperation(nodeB, { operation: 'list_roles' }).catch(() => [])) ?? []).some((r) => r.role === 'prerole');

		let ids = [];
		let hasPrerole = false;
		for (let i = 0; i < 90 && !(ids.filter((id) => id.startsWith('post-')).length >= POST_COUNT && hasPrerole); i++) {
			await delay(500);
			ids = await dataIds();
			hasPrerole = await preroleReplicated();
		}
		await delay(3000);
		ids = await dataIds();

		equal(ids.filter((id) => id.startsWith('post-')).length, POST_COUNT, 'post-start_time user rows must arrive');
		equal(ids.filter((id) => id.startsWith('pre-')).length, 0, 'pre-start_time user rows must be filtered');
		ok(await preroleReplicated(), 'a role created before start_time must still replicate (system db is never filtered)');
	});
});
