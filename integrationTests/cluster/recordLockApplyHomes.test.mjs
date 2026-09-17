/**
 * `record_lock_apply_homes` (harper-pro#862) on real nodes: one operator call drives the whole §4.3
 * transition over the node-principal hop, given the explicit node list.
 *
 * What only real nodes can prove: that the relay reaches every named node over the replication
 * connections and each node's own row, not the payload, decides; that a fresh cluster bootstraps in
 * one call with no per-node loop once its coordinators can prove a drain; and that every refusal
 * happens before anything is staged. Core lets a coordinator prove a drain only after it has owned
 * for a full delegation lease (~6 minutes; `unprovenOwnershipMs`), so this suite waits that out once
 * in `before` — setup, not the outage. The retry contract and the topology change live in
 * `recordLockApplyRetry.test.mjs` so the two lease waits shard separately.
 *
 * Same fixture and node shape as `recordLockCluster.test.mjs` (`threads.count: 1`, drain backstop 0).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import {
	DB,
	apply,
	assertLocks,
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
	waitForProvableDrain,
	waitForRing,
} from './recordLockShared.mjs';

suite('record_lock_apply_homes: bootstrap and refusals on a three-node cluster', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	let nodes;
	let names;

	before(async () => {
		const started = await Promise.allSettled([startNode(ctx.name), startNode(ctx.name), startNode(ctx.name)]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes);
		names = await nodeNames(nodes);
		await waitForProvableDrain(nodes);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('one call bootstraps generation 1 on a fresh cluster, and locks work with no per-node loop', async () => {
		const started = Date.now();
		const report = await apply(nodes[0], { homes: names });
		const elapsed = Date.now() - started;
		assert.equal(report.outcome, 'activated', JSON.stringify(report));
		assert.equal(report.generation, 1);
		assert.deepEqual(report.homes, [...names].sort());
		assert.deepEqual(report.quiesce, [...names].sort());
		assert.equal(typeof report.digest, 'string');
		assert.equal(report.retryAfterMs, undefined);
		assert.ok(elapsed < 60_000, `one call took ${elapsed}ms; nothing here waits out the ~6 minute lease`);
		for (const name of names) {
			const entry = report.nodes[name];
			assert.equal(entry.role, 'home');
			assert.equal(entry.stage.action, 'staged', JSON.stringify(entry));
			assert.equal(entry.stage.proven, true, `the drain proved quiescence: ${JSON.stringify(entry.stage.quiesced)}`);
			assert.deepEqual(entry.activate, { action: 'activated' });
		}
		await waitForRing(nodes, nodes.length);
		const id = 'bootstrap-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		for (const node of nodes) {
			const result = await call(node, 'LockedIncrement/', { id });
			assert.equal(result.status, 200, JSON.stringify(result.body));
		}
		await waitForCounter(nodes, id, nodes.length);
	});

	test('refuses before staging when a node reports a ring member the operator did not list', async () => {
		const listed = names.slice(0, 2);
		const { status, body } = await operation(nodes[0], {
			operation: 'record_lock_apply_homes',
			database: DB,
			homes: listed,
		});
		assert.equal(status, 409, JSON.stringify(body));
		assert.equal(body.outcome, 'refused');
		assert.match(body.error, new RegExp(`${names[2]} \\(in .*'s ring\\)`));
		for (const name of listed) {
			assert.equal(body.nodes[name].survey.active.generation, 1);
			assert.equal(body.nodes[name].stage, undefined, 'nothing was staged');
		}
		assert.equal(body.nodes[names[2]], undefined, 'only the listed nodes were asked');
		await assertLocks(nodes, 200, 'generation 1 must still be active everywhere after a refusal');
	});

	test('refuses before staging when a node already holds a different set at the target generation', async () => {
		await sendOperation(nodes[0], {
			operation: 'record_lock_stage_generation',
			database: DB,
			generation: 2,
			homes: [names[0]],
			authorization: nodes[0].admin,
		});
		const { status, body } = await operation(nodes[1], {
			operation: 'record_lock_apply_homes',
			database: DB,
			homes: names,
			generation: 2,
		});
		assert.equal(status, 409, JSON.stringify(body));
		assert.match(body.error, /already staged with a different home set/);
		assert.equal(body.nodes[names[0]].survey.staged.generation, 2);
		for (const name of names) assert.equal(body.nodes[name].stage, undefined);
		await assertLocks(nodes.slice(1), 200, 'the untouched nodes still serve generation 1');
		assert.equal(
			await lockStatus(nodes[0], 'stray-' + Date.now()),
			503,
			'the stray stage retracted active on its node'
		);
	});

	test('refuses before staging when a named node is unreachable', async () => {
		await stopNodeProcess(nodes[2]);
		await waitForCondition(
			async (signal) => {
				const status = await clusterStatusOf(nodes[1], signal);
				return status.connections.every(
					(connection) =>
						connection.name !== names[2] || !connection.database_sockets.some((socket) => socket.connected)
				)
					? status
					: undefined;
			},
			{ timeoutMs: 60_000, description: 'the surviving nodes to notice the stopped node is gone' }
		);
		const { status, body } = await operation(nodes[1], {
			operation: 'record_lock_apply_homes',
			database: DB,
			homes: names,
			generation: 3,
		});
		assert.equal(status, 503, JSON.stringify(body));
		assert.equal(body.outcome, 'refused');
		assert.match(body.error, /not every named node answered/);
		assert.ok(body.nodes[names[2]].survey.error, JSON.stringify(body.nodes[names[2]]));
		for (const name of names) assert.equal(body.nodes[name].stage, undefined, 'nothing was staged');
		assert.equal(
			await lockStatus(nodes[1], 'unreachable-' + Date.now()),
			200,
			'the live node still serves generation 1'
		);
	});
});
