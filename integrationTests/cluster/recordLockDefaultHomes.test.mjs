/** Fresh nodes are in their first incarnation, so the first default proves its drain at once. */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureTableExists, sendOperation, waitForCondition } from './clusterShared.mjs';
import {
	DB,
	CONVERGE_TIMEOUT_MS,
	call,
	clusterStatusOf,
	connectMesh,
	lockStatus,
	nodeNames,
	operation,
	putCounter,
	startNode,
	stopNode,
	waitForCounter,
} from './recordLockShared.mjs';

const FRESH = 'fresh';
const ITEM = 'Item';

function applyDefault(node, fields) {
	return operation(node, { operation: 'record_lock_apply_homes', default: true, ...fields });
}

function lockedIncrementIn(node, id, signal) {
	return call(node, 'LockedIncrementIn/', { database: FRESH, table: ITEM, id, timeout: 2_000 }, signal);
}

async function itemCount(node, id, signal) {
	const rows = await sendOperation(
		node,
		{
			operation: 'search_by_id',
			database: FRESH,
			table: ITEM,
			ids: [id],
			get_attributes: ['*'],
			authorization: node.admin,
		},
		{ signal }
	);
	return rows[0]?.n;
}

function waitForItem(nodes, id, expected) {
	return waitForCondition(
		async (signal) =>
			(await Promise.all(nodes.map((node) => itemCount(node, id, signal)))).every((n) => n === expected)
				? true
				: undefined,
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: `${FRESH}.${ITEM}/${id} to read ${expected} on every node` }
	);
}

async function recordLocksOf(node, database, signal) {
	return (await clusterStatusOf(node, signal)).recordLocks?.[database];
}

function waitForProvable(nodes, database) {
	return waitForCondition(
		async (signal) => {
			const stats = await Promise.all(nodes.map((node) => recordLocksOf(node, database, signal)));
			return stats.every((entry) => entry?.unprovenMs === 0) ? stats : undefined;
		},
		{ timeoutMs: 420_000, pollMs: 5_000, description: `${database} to be able to prove a drain on every node` }
	);
}

suite('record lock default home map on a three-node cluster', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	let nodes;
	let names;

	before(async () => {
		const started = await Promise.allSettled([0, 1, 2].map(() => startNode(ctx.name, {}, 1, undefined, true, [FRESH])));
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes);
		names = await nodeNames(nodes);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('one default apply on two fresh nodes activates in seconds; the node it does not name cannot lock', async () => {
		const started = Date.now();
		const { status, body } = await applyDefault(nodes[0], { homes: names.slice(0, 2), quiesce: names });
		assert.equal(status, 200, JSON.stringify(body));
		assert.equal(body.outcome, 'activated', JSON.stringify(body));
		assert.equal(body.default, true);
		assert.equal(body.database, undefined);
		assert.equal(body.generation, 1);
		assert.ok(Date.now() - started < 60_000, `took ${Date.now() - started}ms`);
		for (const name of names) assert.equal(body.nodes[name].stage.proven, true, JSON.stringify(body.nodes[name]));
		assert.equal(body.nodes[names[2]].role, 'departing');
		const id = 'default-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		await waitForCondition(
			async (signal) => (await call(nodes[0], 'LockedIncrement/', { id }, signal)).status === 200,
			{ timeoutMs: 30_000, description: `${DB} to be lockable on ${names[0]} under the default` }
		);
		assert.equal((await call(nodes[1], 'LockedIncrement/', { id })).status, 200);
		await waitForCounter(nodes, id, 2);
		assert.equal(await lockStatus(nodes[2], id), 503, 'a node the default does not name has no map');
		const stats = await recordLocksOf(nodes[0], DB);
		assert.equal(stats.homeMapSource, 'default');
		assert.deepEqual(stats.members, names.slice(0, 2).sort());
	});

	test('a database created afterwards is lockable within seconds on every default node, with no apply of its own', async () => {
		for (const node of nodes)
			await ensureTableExists(node, { database: FRESH, table: ITEM, primary_key: 'id', authorization: node.admin });
		const created = Date.now();
		const id = 'fresh-' + created;
		await sendOperation(nodes[0], {
			operation: 'insert',
			database: FRESH,
			table: ITEM,
			records: [{ id, n: 0 }],
			authorization: nodes[0].admin,
		});
		await waitForItem(nodes, id, 0);
		let last;
		await waitForCondition(
			async (signal) => {
				last = await lockedIncrementIn(nodes[0], id, signal);
				return last.status === 200 ? last : undefined;
			},
			{ timeoutMs: 30_000, description: () => `${FRESH} to be lockable on ${names[0]}: ${JSON.stringify(last)}` }
		);
		const elapsed = Date.now() - created;
		assert.ok(elapsed < 30_000, `the new database took ${elapsed}ms to become lockable`);
		const second = await lockedIncrementIn(nodes[1], id);
		assert.equal(second.status, 200, JSON.stringify(second.body));
		await waitForItem(nodes, id, 2);
		assert.equal((await recordLocksOf(nodes[1], FRESH)).homeMapSource, 'default');
	});

	test('a map of its own takes precedence, and must cover the default ring it leaves', async () => {
		const refused = await operation(nodes[0], {
			operation: 'record_lock_apply_homes',
			database: FRESH,
			homes: [names[0]],
		});
		assert.equal(refused.status, 409, JSON.stringify(refused.body));
		assert.match(refused.body.error, new RegExp(`${names[1]} \\(in .*'s ring\\)`));
		assert.equal(refused.body.nodes[names[0]].survey.inherited, true);
		await waitForProvable(nodes.slice(0, 2), FRESH);
		const { status, body } = await operation(nodes[0], {
			operation: 'record_lock_apply_homes',
			database: FRESH,
			homes: names.slice(0, 2),
		});
		assert.equal(status, 200, JSON.stringify(body));
		assert.equal(body.outcome, 'activated', JSON.stringify(body));
		assert.equal(body.generation, 2, 'above the default generation it inherited');
		for (const node of nodes.slice(0, 2)) assert.equal((await recordLocksOf(node, FRESH)).homeMapSource, 'database');
	});

	test('a default that names the third node lets it lock every inheriting database, and not one with its own map', async () => {
		const { status, body } = await applyDefault(nodes[0], { homes: names });
		assert.equal(status, 200, JSON.stringify(body));
		assert.equal(body.outcome, 'activated', JSON.stringify(body));
		assert.equal(body.generation, 2);
		const id = 'join-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		await waitForCondition(
			async (signal) => (await call(nodes[2], 'LockedIncrement/', { id }, signal)).status === 200,
			{ timeoutMs: 30_000, description: `${DB} to be lockable on the joined node` }
		);
		await waitForCounter(nodes, id, 1);
		for (const node of nodes) assert.deepEqual((await recordLocksOf(node, DB)).members, [...names].sort());
		const fresh = 'joined-' + Date.now();
		await sendOperation(nodes[0], {
			operation: 'insert',
			database: FRESH,
			table: ITEM,
			records: [{ id: fresh, n: 0 }],
			authorization: nodes[0].admin,
		});
		await waitForItem(nodes, fresh, 0);
		assert.equal((await lockedIncrementIn(nodes[2], fresh)).status, 503, 'the joiner holds a marker, not the default');
		assert.equal((await recordLocksOf(nodes[2], FRESH)).homeMapSource, 'database');
		// The first lock under FRESH's own map, after the default activation refreshed it on every thread and
		// re-announced its digest to peers, so it polls like every other lockability check after a map change.
		let last;
		await waitForCondition(
			async (signal) => {
				last = await lockedIncrementIn(nodes[0], fresh, signal);
				return last.status === 200 ? last : undefined;
			},
			{ timeoutMs: 30_000, description: () => `its own map to still serve on its members: ${JSON.stringify(last)}` }
		);
	});

	test('a shrink moves the inheriting database only after a lock held on the leaver commits', async () => {
		const id = 'shrink-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		// Poll (4 s), linger and rival (4 s) fit inside the lease, which fits inside the 10 s stage drain budget.
		const held = await call(nodes[2], 'LockHold/', { id, lease: 9_000, timeout: 10_000 });
		assert.equal(held.status, 200, JSON.stringify(held.body));
		let settled = false;
		const shrinking = applyDefault(nodes[0], { homes: names.slice(0, 2), quiesce: names }).finally(
			() => (settled = true)
		);
		await waitForCondition(
			async (signal) => {
				const entry = await recordLocksOf(nodes[2], DB, signal);
				return entry && entry.members === undefined ? true : undefined;
			},
			{ timeoutMs: 4_000, pollMs: 100, description: 'the leaver to stop serving the default while it holds the lock' }
		);
		// Long enough for an activation after a drain that proved early to have finished (the fixture's backstop is 0).
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		assert.equal(settled, false, 'the shrink waits for the held lock to drain');
		assert.notEqual(
			(await call(nodes[0], 'LockedIncrement/', { id, timeout: 1_000 })).status,
			200,
			'no successor is admitted while the leaver holds the lock'
		);
		const wrote = await call(nodes[2], 'LockWrite/', { token: held.body.token, n: 10 });
		assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
		assert.equal((await call(nodes[2], 'LockRelease/', { token: held.body.token })).status, 200);
		const { status, body } = await shrinking;
		assert.equal(status, 200, JSON.stringify(body));
		assert.equal(body.outcome, 'activated', JSON.stringify(body));
		assert.equal(body.generation, 3);
		assert.equal(body.nodes[names[2]].role, 'departing');
		assert.equal(body.nodes[names[2]].stage.proven, true, JSON.stringify(body.nodes[names[2]]));
		assert.deepEqual(body.nodes[names[2]].activate, { action: 'skipped' });
		const next = await call(nodes[0], 'LockedIncrement/', { id });
		assert.equal(next.status, 200, JSON.stringify(next.body));
		assert.equal(next.body.n, 11, 'the successor saw the leaver’s committed write');
		await waitForCounter(nodes, id, 11);
		assert.equal(await lockStatus(nodes[2], id), 503, 'the leaver is staged and serves no lock');
	});

	test('refuses, before staging anything, a default change that does not survey every known node', async () => {
		const { status, body } = await applyDefault(nodes[0], { homes: [names[0]] });
		assert.equal(status, 409, JSON.stringify(body));
		assert.equal(body.outcome, 'refused');
		assert.match(body.error, /every node this one knows, and this node, must be in quiesce/);
		for (const name of names.slice(1)) assert.match(body.error, new RegExp(name));
		assert.equal(body.nodes[names[0]].stage, undefined, 'nothing was staged');
		for (const node of nodes.slice(0, 2)) assert.equal(await lockStatus(node, 'still-' + Date.now()), 200);
	});

	test('the node a shrink left out can still take a map of its own for a database that inherited', async () => {
		await waitForProvable(nodes, DB);
		const { status, body } = await operation(nodes[1], {
			operation: 'record_lock_apply_homes',
			database: DB,
			homes: names.slice(1),
			quiesce: names,
		});
		assert.equal(status, 200, JSON.stringify(body));
		assert.equal(body.outcome, 'activated', JSON.stringify(body));
		assert.equal(body.generation, 4, 'above the default generation it inherited');
		const id = 'own-' + Date.now();
		await putCounter(nodes[1], id, 0);
		await waitForCounter(nodes, id, 0);
		assert.equal((await call(nodes[2], 'LockedIncrement/', { id })).status, 200);
		assert.equal(await lockStatus(nodes[0], id), 503, 'the node its map leaves out is staged');
	});
});
