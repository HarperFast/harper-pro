/**
 * `record_lock_apply_homes { fenced }` on real nodes: a ring member is killed while holding
 * delegations from both survivors, one call with it fenced completes the transition, its exact keys
 * are served by their unchanged homes at once, and restarted with its old row it has no home map.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { homeFor, ringKeyFor } from '../../dist/core/resources/recordLockCoordinator.js';
import { readNodePid, stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import {
	DB,
	apply,
	call,
	clusterStatusOf,
	connectMesh,
	currentRow,
	lockStatus,
	nodeNames,
	operation,
	putCounter,
	restartStoppedNode,
	startNode,
	stopNode,
	waitForCounter,
	waitForMesh,
	waitForProvableDrain,
	waitForRing,
} from './recordLockShared.mjs';

/** Ids homed evenly over `names` under generation 1. Picked, not sampled: a short run of sequential
 * ids can home on one node, and the test needs keys the stopped node held from each survivor. */
function idsHomedOnEach(names, perNode) {
	const ids = [];
	const counts = new Map(names.map((name) => [name, 0]));
	for (let i = 0; ids.length < names.length * perNode; i++) {
		const id = `fenced-${i}`;
		const home = homeFor(ringKeyFor(DB, 'Counter', id), names);
		if (counts.get(home) < perNode) {
			counts.set(home, counts.get(home) + 1);
			ids.push(id);
		}
	}
	return ids;
}

suite('record_lock_apply_homes with a fenced node on a three-node cluster', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	let nodes;
	let names;
	let ids;
	const heldFrom = {};

	before(async () => {
		const started = await Promise.allSettled([startNode(ctx.name), startNode(ctx.name), startNode(ctx.name)]);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes);
		names = await nodeNames(nodes);
		ids = idsHomedOnEach(names, 8);
		await waitForProvableDrain(nodes);
		const bootstrap = await apply(nodes[0], { homes: names });
		assert.equal(bootstrap.outcome, 'activated', JSON.stringify(bootstrap));
		await waitForRing(nodes, nodes.length);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('one call with the stopped node fenced activates, and its delegated keys are served at once', async () => {
		for (const id of ids) await putCounter(nodes[0], id, 0);
		for (const id of ids) await waitForCounter(nodes, id, 0);
		// The third node locks every key; for the ones homed on the survivors it now holds a delegation,
		// which a release keeps (delegations are amortized), so each survivor has a grant to it.
		for (const id of ids) assert.equal(await lockStatus(nodes[2], id), 200, id);
		const before = await Promise.all(nodes.map((node) => clusterStatusOf(node)));
		const counts = before.map((status) => status.recordLocks?.[DB]);
		assert.ok(
			counts[0]?.granted > 0 && counts[1]?.granted > 0 && counts[2]?.delegations > 0,
			`each survivor granted the third node a delegation: ${JSON.stringify(counts)}`
		);
		// Killed, not stopped: a node that is gone for good never runs its shutdown.
		const pid = await readNodePid(nodes[2]);
		process.kill(pid, 'SIGKILL');
		await stopNodeProcess(nodes[2]);
		await waitForCondition(
			async (signal) => {
				const statuses = await Promise.all(nodes.slice(0, 2).map((node) => clusterStatusOf(node, signal)));
				return statuses.every((status) =>
					status.connections.every(
						(connection) =>
							connection.name !== names[2] || !connection.database_sockets.some((socket) => socket.connected)
					)
				)
					? statuses
					: undefined;
			},
			{ timeoutMs: 60_000, description: 'the survivors to notice the stopped node is gone' }
		);
		const survivors = names.slice(0, 2);
		const unfenced = await operation(nodes[0], {
			operation: 'record_lock_apply_homes',
			database: DB,
			homes: survivors,
			quiesce: names,
		});
		assert.equal(unfenced.status, 503, JSON.stringify(unfenced.body));
		assert.match(unfenced.body.error, /not every named node answered/);

		const started = Date.now();
		const report = await apply(nodes[0], { homes: survivors, quiesce: names, fenced: [names[2]] });
		const elapsed = Date.now() - started;
		assert.equal(report.outcome, 'activated', JSON.stringify(report));
		assert.equal(report.generation, 2);
		assert.ok(elapsed < 60_000, `the fenced call took ${elapsed}ms; nothing here waits out the lease`);
		assert.deepEqual(report.nodes[names[2]], { role: 'fenced' });
		for (const name of survivors) {
			const { stage } = report.nodes[name];
			assert.equal(stage.proven, true, JSON.stringify(stage));
			const outstanding = stage.quiesced.outstanding;
			assert.ok(
				outstanding.every((entry) => entry.delegate === names[2]),
				`only recalls to the fenced node are outstanding: ${JSON.stringify(report)}`
			);
			heldFrom[name] = outstanding.map((entry) => entry.key);
			assert.ok(heldFrom[name].length > 0, `${name} had delegated keys to the stopped node: ${JSON.stringify(report)}`);
			const row = await currentRow(nodes[names.indexOf(name)]);
			assert.equal(row.active?.generation, 2);
			assert.deepEqual(
				row.fenced.filter((entry) => entry.generation === 2).map((entry) => entry.node),
				[names[2]],
				`${name} recorded the fence with its stage`
			);
		}
		await waitForRing(nodes.slice(0, 2), 2);
		// Each survivor still homes the keys it had delegated; asked from the other survivor, so the
		// home's own grant table is what answers. `lockStatus` waits 2 s, far under the ~6 minute lease.
		for (const [index, name] of survivors.entries()) {
			const other = nodes[1 - index];
			for (const id of heldFrom[name]) assert.equal(await lockStatus(other, id), 200, `${id} homed on ${name}`);
		}
		const id = heldFrom[survivors[0]][0];
		for (const node of nodes.slice(0, 2)) {
			const result = await call(node, 'LockedIncrement/', { id });
			assert.equal(result.status, 200, JSON.stringify(result.body));
		}
		await waitForCounter(nodes.slice(0, 2), id, 2);
	});

	test('the fenced node restarted with its old row has no home map, and the survivors keep theirs', async () => {
		const restarted = await restartStoppedNode(contexts[2]);
		nodes[2] = restarted;
		await waitForMesh(nodes);
		const row = await currentRow(restarted);
		assert.equal(row.active?.generation, 1, 'its own row still holds the ring it was stopped under');
		assert.equal(row.staged, undefined);
		// Its peers announce generation 2's digest, so it agrees with none of them and withholds the
		// whole map: `members` is `homeMap()?.homes`.
		const status = await clusterStatusOf(restarted);
		assert.equal(status.recordLocks?.[DB]?.members, undefined, JSON.stringify(status.recordLocks));
		for (const id of ids.slice(0, 5)) assert.equal(await lockStatus(restarted, id), 503, id);
		for (const node of nodes.slice(0, 2)) {
			const survivorStatus = await clusterStatusOf(node);
			assert.deepEqual([...(survivorStatus.recordLocks?.[DB]?.members ?? [])].sort(), names.slice(0, 2).sort());
			assert.equal(await lockStatus(node, ids[0]), 200);
		}
	});
});
