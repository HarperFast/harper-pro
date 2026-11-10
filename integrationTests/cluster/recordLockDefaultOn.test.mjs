/**
 * Cluster record locks with no record-lock configuration (harper-pro#853): the first cluster `lock()`
 * establishes generation 1 of the home map over the replicating set, with no operator step, at more than
 * one worker per node. A node that joins afterwards fails closed and never writes a map of its own; a
 * `remove_node` of a ring member leaves the survivors refusing until an operator applies a new map.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { homeFor, ringKeyFor } from '../../dist/core/resources/recordLockCoordinator.js';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import {
	DB,
	call,
	clusterStatusOf,
	connectMesh,
	counter,
	currentRow,
	lockStatus,
	nodeNames,
	putCounter,
	startDefaultNode,
	stopNode,
	waitForCounter,
	waitForMesh,
	waitForRing,
} from './recordLockShared.mjs';

/** One id homed on each of `names` under the ring those names form. */
function idHomedOnEach(names, prefix) {
	const ids = new Map();
	for (let i = 0; ids.size < names.length; i++) {
		const id = `${prefix}-${i}`;
		const home = homeFor(ringKeyFor(DB, 'Counter', id), names);
		if (!ids.has(home)) ids.set(home, id);
	}
	return names.map((name) => ids.get(name));
}

suite('cluster record locks with no configuration (harper-pro#853)', { timeout: 600_000 }, (ctx) => {
	const contexts = [];
	let nodes;
	let names;
	let joiner;

	before(async () => {
		const started = await Promise.allSettled([
			startDefaultNode(ctx.name),
			startDefaultNode(ctx.name),
			startDefaultNode(ctx.name),
		]);
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

	test('nothing is written before the first lock', async () => {
		for (const node of nodes) {
			const row = await currentRow(node);
			assert.equal(row.active, undefined, node.hostname);
			assert.equal(row.staged, undefined, node.hostname);
		}
	});

	test('the first cluster locks, taken concurrently on every node, succeed and stay exclusive', async () => {
		const id = 'default-on-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const N = 24;
		// Default lock timeout: the first lock on each node rides core's wait while generation 1 is written.
		const results = await Promise.all(
			Array.from({ length: N }, (_, i) => call(nodes[i % nodes.length], 'LockedIncrement/', { id }))
		);
		const failed = results.filter((result) => result.status !== 200);
		assert.deepEqual(failed, [], `every first lock must succeed: ${JSON.stringify(failed)}`);
		assert.deepEqual(
			results.map((result) => result.body.n).sort((a, b) => a - b),
			Array.from({ length: N }, (_, i) => i + 1),
			'every admitted increment read its predecessor'
		);
		await waitForCounter(nodes, id, N);
	});

	test('every node holds the same generation 1 over all three', async () => {
		const digests = new Set();
		for (const node of nodes) {
			const row = await currentRow(node);
			assert.equal(row.active?.generation, 1, `${node.hostname}: ${JSON.stringify(row)}`);
			assert.deepEqual(row.active.homes, [...names].sort());
			digests.add(row.active.digest);
		}
		assert.equal(digests.size, 1);
		await waitForRing(nodes, nodes.length);
	});

	test('a key held on one node is refused on another until the hold ends', async () => {
		const id = 'held-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter(nodes, id, 0);
		const held = await call(nodes[0], 'LockHold/', { id, lease: 5_000 });
		assert.equal(held.status, 200, JSON.stringify(held.body));
		const refused = await call(nodes[1], 'LockOnce/', { id, timeout: 1_000 });
		assert.equal(refused.status, 423, `the other node waited out its timeout: ${JSON.stringify(refused.body)}`);
		const granted = await call(nodes[1], 'LockOnce/', { id, timeout: 20_000 });
		assert.equal(granted.status, 200, `granted once the lease ended: ${JSON.stringify(granted.body)}`);
	});

	test('a node that joins later refuses cluster locks, writes no map, and still receives replication', async () => {
		const started = await startDefaultNode(ctx.name);
		contexts.push(started);
		joiner = started.harper;
		const { operation_token: token } = await sendOperation(nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: nodes[0].admin,
		});
		await sendOperation(joiner, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: nodes[0].hostname,
			authorization: 'Bearer ' + token,
		});
		await waitForMesh([...nodes, joiner]);
		assert.equal(await lockStatus(joiner, 'joiner-' + Date.now()), 503);
		const status = await waitForCondition(
			async (signal) => {
				const bootstrap = (await clusterStatusOf(joiner, signal)).recordLocks?.[DB]?.bootstrap;
				return bootstrap?.state === 'refused' ? bootstrap : undefined;
			},
			{ timeoutMs: 30_000, description: "the joiner's refused attempt in cluster_status" }
		);
		assert.match(status.reason, /does not include/);
		const row = await currentRow(joiner);
		assert.equal(row.active, undefined);
		assert.equal(row.staged, undefined);
		for (const node of nodes) assert.equal(await lockStatus(node, 'members-' + Date.now()), 200, node.hostname);
		for (const node of nodes) {
			const ring = (await currentRow(node)).active;
			assert.deepEqual(ring.homes, [...names].sort(), `${node.hostname} still serves the first ring`);
		}
		const id = 'to-joiner-' + Date.now();
		await putCounter(nodes[0], id, 0);
		await waitForCounter([...nodes, joiner], id, 0);
		const increment = await call(nodes[1], 'LockedIncrement/', { id });
		assert.equal(increment.status, 200);
		await waitForCounter([joiner], id, 1);
		assert.equal((await counter(joiner, id)).n, 1);
	});

	test('remove_node of a ring member leaves the survivors refusing every key until an operator applies a map', async () => {
		const ids = idHomedOnEach(names, 'removed');
		await stopNodeProcess(nodes[2]);
		await sendOperation(nodes[0], { operation: 'remove_node', hostname: names[2], authorization: nodes[0].admin });
		for (const id of ids) assert.equal(await lockStatus(nodes[0], id), 503, `${id} on the node that ran remove_node`);
		await waitForCondition(
			async () => {
				for (const id of ids) if ((await lockStatus(nodes[1], id)) !== 503) return undefined;
				return true;
			},
			{ timeoutMs: 60_000, description: 'the other survivor to refuse once the removal replicated' }
		);
	});
});
