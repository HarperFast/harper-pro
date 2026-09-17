/**
 * `record_lock_apply_homes` (harper-pro#862): the retry contract and the topology change, on two
 * real nodes. The second node carries the test hook that fails an apply it coordinates between stage
 * and activate; it answers the hop from the first node normally.
 *
 * What only real nodes can prove here: that a cluster whose drain cannot prove is left staged and
 * refusing locks with a relative wait; that the attested second call activates only what was already
 * staged; that an injected failure between the phases leaves the documented safe state and the same
 * call from another node completes it; that the hop refuses an operator caller; and that a shrink
 * activates in seconds once every node can prove its drain, with the departing node staged and never
 * activated. The one ~6 minute wait (core's lease, see `recordLockApplyHomes.test.mjs`) is paid before
 * the shrink, while every node serves the current generation.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
	DB,
	apply,
	assertLocks,
	clusterStatusOf,
	connectMesh,
	lockStatus,
	nodeNames,
	operation,
	startNode,
	stopNode,
	waitForProvableDrain,
	waitForRing,
} from './recordLockShared.mjs';

/** A lower bound on the drain interval (`DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS`, ~6 min). */
const DRAIN_INTERVAL_LOWER_BOUND_MS = 300_000;

suite(
	'record_lock_apply_homes: the attested second call, the retry contract, and a shrink',
	{ timeout: 900_000 },
	(ctx) => {
		const contexts = [];
		let nodes;
		let names;

		before(async () => {
			const started = await Promise.allSettled([
				startNode(ctx.name),
				startNode(ctx.name, { HARPER_TEST_RECORD_LOCK_APPLY_FAIL_BEFORE_ACTIVATE: '1' }),
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

		test('without the attestation a cluster that cannot prove is staged, refuses locks, and reports a relative wait', async () => {
			const report = await apply(nodes[0], { homes: names });
			assert.equal(report.outcome, 'staged', JSON.stringify(report));
			assert.equal(report.generation, 1);
			assert.match(report.reason, /could not prove quiescence/);
			assert.match(report.reason, /drained: true/);
			assert.ok(
				report.retryAfterMs > DRAIN_INTERVAL_LOWER_BOUND_MS,
				`retryAfterMs ${report.retryAfterMs} must be the full drain interval`
			);
			for (const name of names) {
				assert.equal(report.nodes[name].stage.action, 'staged');
				assert.equal(report.nodes[name].stage.proven, false);
				assert.equal(report.nodes[name].activate, undefined, 'nothing activates on an unproven drain');
			}
			await assertLocks(nodes, 503, 'staged and not active: every cluster lock fails closed');
		});

		test('the attested call needs the generation, completes the transition, and repeating it is a noop', async () => {
			const missing = await operation(nodes[0], {
				operation: 'record_lock_apply_homes',
				database: DB,
				homes: names,
				drained: true,
			});
			assert.equal(missing.status, 400, JSON.stringify(missing.body));
			const report = await apply(nodes[0], { homes: names, generation: 1, drained: true });
			assert.equal(report.outcome, 'activated', JSON.stringify(report));
			for (const name of names) {
				assert.equal(report.nodes[name].stage.action, 'noop', 'already staged when this call surveyed it');
				assert.deepEqual(report.nodes[name].activate, { action: 'activated' });
			}
			await waitForRing(nodes, nodes.length);
			await assertLocks(nodes, 200, 'generation 1 active');
			const again = await apply(nodes[0], { homes: names, generation: 1, drained: true });
			assert.equal(again.outcome, 'activated');
			for (const name of names) {
				assert.deepEqual(again.nodes[name].stage, { action: 'already-active' });
				assert.deepEqual(again.nodes[name].activate, { action: 'noop' });
			}
		});

		test('a failure between stage and activate leaves every node staged and refusing, and the same call from another node completes it', async () => {
			// Generation 2 explicitly: with every node active at 1 for this same set, an unnumbered call is
			// the idempotent re-apply (every phase noops) and there would be nothing to interrupt.
			const { status, body } = await operation(nodes[1], {
				operation: 'record_lock_apply_homes',
				database: DB,
				homes: names,
				generation: 2,
			});
			assert.equal(status, 503, JSON.stringify(body));
			assert.equal(body.outcome, 'incomplete');
			assert.match(body.error, /injected failure between stage and activate/);
			assert.equal(body.generation, 2);
			for (const name of names) {
				assert.equal(body.nodes[name].stage.action, 'staged', JSON.stringify(body.nodes[name]));
				assert.deepEqual(
					body.nodes[name].survey.staged.quiesce,
					[...names].sort(),
					'the stage persisted the participant set'
				);
				assert.equal(body.nodes[name].activate, undefined);
			}
			await assertLocks(nodes, 503, 'half-applied means quiesced everywhere and granting nowhere');
			const report = await apply(nodes[0], { homes: names, generation: 2, drained: true });
			assert.equal(report.outcome, 'activated', JSON.stringify(report));
			for (const name of names) {
				assert.equal(report.nodes[name].stage.action, 'noop');
				assert.deepEqual(report.nodes[name].activate, { action: 'activated' });
			}
			await waitForRing(nodes, nodes.length);
			await assertLocks(nodes, 200, 'generation 2 active after the retry');
		});

		test('an attested call that has to stage a node itself reports staged again: the wait cannot have covered it', async () => {
			const report = await apply(nodes[0], { homes: names, generation: 3, drained: true });
			assert.equal(report.outcome, 'staged', JSON.stringify(report));
			assert.match(report.reason, /were staged by this call/);
			assert.ok(report.retryAfterMs > DRAIN_INTERVAL_LOWER_BOUND_MS);
			for (const name of names) assert.equal(report.nodes[name].stage.action, 'staged');
			await assertLocks(nodes, 503, 'staged and refusing until the next attested call');
			const completed = await apply(nodes[0], { homes: names, generation: 3, drained: true });
			assert.equal(completed.outcome, 'activated', JSON.stringify(completed));
			await waitForRing(nodes, nodes.length);
			await assertLocks(nodes, 200, 'generation 3 active');
		});

		test('the peer hop refuses an operator caller: it is for node principals only', async () => {
			const { status, body } = await operation(nodes[0], {
				operation: 'record_lock_transition',
				database: DB,
				action: 'survey',
			});
			assert.equal(status, 403, JSON.stringify(body));
			assert.match(body.error, /cluster nodes only/);
		});

		test('a shrink activates immediately once every node proves its drain: the outage is the drain, not the lease', async () => {
			await waitForProvableDrain(nodes);
			const [keep, departing] = names;
			const started = Date.now();
			const report = await apply(nodes[0], { homes: [keep], quiesce: names });
			const elapsed = Date.now() - started;
			assert.equal(report.outcome, 'activated', JSON.stringify(report));
			assert.equal(report.generation, 4);
			assert.equal(report.retryAfterMs, undefined);
			assert.ok(
				elapsed < 60_000,
				`the transition took ${elapsed}ms; it must be bounded by the drain, not the ~6 minute lease`
			);
			assert.equal(report.nodes[keep].role, 'home');
			assert.equal(report.nodes[keep].stage.proven, true, JSON.stringify(report.nodes[keep]));
			assert.deepEqual(report.nodes[keep].activate, { action: 'activated' });
			assert.equal(report.nodes[departing].role, 'departing');
			assert.equal(report.nodes[departing].stage.proven, true, JSON.stringify(report.nodes[departing]));
			assert.deepEqual(report.nodes[departing].activate, { action: 'skipped' });
			await waitForRing([nodes[0]], 1);
			assert.equal(await lockStatus(nodes[0], 'kept-' + Date.now()), 200, 'the new ring serves generation 4');
			assert.equal(
				await lockStatus(nodes[1], 'departed-' + Date.now()),
				503,
				'a departing node is staged, never activated'
			);
			assert.equal((await clusterStatusOf(nodes[1])).recordLocks?.[DB]?.members, undefined);
		});
	}
);
