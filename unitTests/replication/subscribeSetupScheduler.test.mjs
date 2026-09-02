/**
 * Regression coverage for harper-pro#327: subscription setup used to be scheduled with a flat 200ms
 * `setTimeout` per qualifying node update — no dedup, no cap, not unref'd — so whatever re-drove
 * `onNodeUpdate` amplified 1:1 into main-thread timers, worker-side WebSocket/TLS setup, and warn
 * lines, ending in an OOM kill.
 *
 * The storm test drives input continuously *across* timer firings, which is the shape of the incident;
 * a one-shot burst would only prove coalescing. Against the flat-200ms behavior the same input
 * produces one dispatch per event and one live timer per event, so both assertions go red.
 */

import assert from 'node:assert';
import sinon from 'sinon';
import { createSubscribeSetupScheduler, dispatchSubscriptionNodes } from '#src/replication/subscriptionManager';

const URL_A = 'wss://peer-a:9933';
const URL_B = 'wss://peer-b:9933';
// Mirrors the production constants: floor NODE_SUBSCRIBE_DELAY, first ceiling 2x that, cap 30s.
const MIN_DELAY = 200;
const MAX_DELAY = 30_000;

const NODES = [{ name: 'peer-a', url: URL_A }];

function makeScheduler(random) {
	const dispatches = [];
	const scheduler = createSubscribeSetupScheduler({
		dispatch: (url, database, nodes) => dispatches.push({ url, database, nodes, at: Date.now() }),
		random,
	});
	return { scheduler, dispatches };
}

describe('subscription-setup scheduler (harper-pro#327)', () => {
	let clock;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		// clock.restore() only — a sandbox-wide sinon.restore() here re-restores the stale
		// globalThis.setTimeout that receiveWatchdog.test.mjs's manually-restored spy left registered,
		// which silently breaks real timers for every file that runs after this one.
		clock.restore();
	});

	it('bounds a 60s re-drive storm to a handful of setups with one pending timer throughout', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		let maxPending = 0;

		// 60,000 qualifying updates spread over 60s of simulated time (~1,000/s, the observed storm rate).
		for (let i = 0; i < 60_000; i++) {
			scheduler.schedule(URL_A, 'data', NODES);
			maxPending = Math.max(maxPending, scheduler.pendingCount());
			clock.tick(1);
		}

		// Ceilings double 400 → 30,000; each delay is 200 + 0.5 * (ceiling - 200).
		assert.deepEqual(
			dispatches.map((d) => d.at),
			[300, 800, 1700, 3400, 6700, 13_200, 26_100, 41_200, 56_300]
		);
		assert.equal(maxPending, 1, 'never more than one pending setup for the pair');
		assert.equal(scheduler.pendingCount(), 1, 'exactly one still armed at the end');
	});

	it('keeps every delay inside the floor and the cap', () => {
		const draws = [0, 0.999999, 0.25, 0, 0.999999, 0.5, 0.75, 0, 0.999999, 0.999999, 0.999999, 0.999999];
		let i = 0;
		const { scheduler } = makeScheduler(() => draws[i++ % draws.length]);
		for (let attempt = 0; attempt < 40; attempt++) {
			const delay = scheduler.schedule(URL_A, 'data', NODES);
			assert.ok(delay >= MIN_DELAY);
			assert.ok(delay < MAX_DELAY);
			clock.tick(delay);
		}
	});

	it('returns undefined instead of arming a second timer for the same pair', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		assert.equal(scheduler.schedule(URL_A, 'data', NODES), 300);
		assert.equal(scheduler.schedule(URL_A, 'data', NODES), undefined, 'deduped');
		assert.equal(scheduler.schedule(URL_A, 'data', NODES), undefined, 'still deduped');
		clock.tick(60_000);
		assert.equal(dispatches.length, 1);
	});

	it('tracks (url, database) pairs independently', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		assert.equal(scheduler.schedule(URL_A, 'data', NODES), 300);
		assert.equal(scheduler.schedule(URL_A, 'other', NODES), 300);
		assert.equal(scheduler.schedule(URL_B, 'data', NODES), 300);
		assert.equal(scheduler.pendingCount(), 3);
		clock.tick(300);
		assert.deepEqual(
			dispatches.map(({ url, database, at }) => ({ url, database, at })),
			[
				{ url: URL_A, database: 'data', at: 300 },
				{ url: URL_A, database: 'other', at: 300 },
				{ url: URL_B, database: 'data', at: 300 },
			]
		);
	});

	it('decorrelates two peers failing on identical timing', () => {
		const a = createSubscribeSetupScheduler({ dispatch: () => {}, random: () => 0.1 });
		const b = createSubscribeSetupScheduler({ dispatch: () => {}, random: () => 0.9 });
		const aDelays = [];
		const bDelays = [];
		for (let attempt = 0; attempt < 5; attempt++) {
			aDelays.push(a.schedule(URL_A, 'data', NODES));
			bDelays.push(b.schedule(URL_A, 'data', NODES));
			clock.tick(MAX_DELAY + MIN_DELAY);
		}
		assert.notDeepEqual(aDelays, bDelays);
		for (let i = 0; i < aDelays.length; i++) assert.ok(aDelays[i] < bDelays[i]);
	});

	// The regression that made the deduped path lose the enriched payload: onDatabase replaces
	// entry.nodes on its early-return path without running the leader/url enrichment, so the setup has
	// to carry the payload of the call that armed or last refreshed it, not whatever the entry holds.
	it('fires with the newest payload a deduped call supplied', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		const first = [{ name: 'peer-a', url: URL_A }];
		const second = [{ name: 'peer-a', url: URL_A, isLeader: true }];
		scheduler.schedule(URL_A, 'data', first);
		assert.equal(scheduler.schedule(URL_A, 'data', second), undefined);
		clock.tick(300);
		assert.equal(dispatches.length, 1);
		assert.equal(dispatches[0].nodes, second);
	});

	// onDatabase's early-return path (an already-subscribed, still-desired entry) never reaches
	// schedule(), but it does build a fresh payload — so the armed setup has to be told about it or it
	// dispatches routing/exclusion state from before the update.
	it('refreshPending replaces the payload of an armed setup without arming one', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		const armed = [{ name: 'peer-a', url: URL_A }];
		const refreshed = [{ name: 'peer-a', url: URL_A, routeReplicates: { receives: true } }];
		scheduler.schedule(URL_A, 'data', armed);
		scheduler.refreshPending(URL_A, 'data', refreshed);
		assert.equal(scheduler.pendingCount(), 1, 'no second timer');
		clock.tick(300);
		assert.equal(dispatches.length, 1);
		assert.equal(dispatches[0].nodes, refreshed);
	});

	it('refreshPending on a pair with nothing armed does not arm one', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		scheduler.refreshPending(URL_A, 'data', NODES);
		assert.equal(scheduler.pendingCount(), 0);
		clock.tick(60_000);
		assert.deepEqual(dispatches, []);
	});

	it('adds the caller-supplied stagger on top of the backoff', () => {
		const { scheduler } = makeScheduler(() => 0.5);
		assert.equal(scheduler.schedule(URL_A, 'data', NODES, 150), 450);
	});

	it('noteConnected drops the pending setup and the escalated delay', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		scheduler.schedule(URL_A, 'data', NODES);
		clock.tick(300);
		scheduler.schedule(URL_A, 'data', NODES); // second attempt: escalated to 500
		assert.equal(scheduler.pendingCount(), 1);

		scheduler.noteConnected(URL_A, 'data');
		assert.equal(scheduler.pendingCount(), 0, 'the armed setup is cancelled, not just reset');
		clock.tick(60_000);
		assert.equal(dispatches.length, 1, 'the cancelled setup never fired');

		assert.equal(scheduler.schedule(URL_A, 'data', NODES), 300, 'back to the first ceiling after success');
	});

	it('cancel() and cancelUrl() disarm pending setups', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		scheduler.schedule(URL_A, 'data', NODES);
		scheduler.schedule(URL_A, 'other', NODES);
		scheduler.schedule(URL_B, 'data', NODES);

		scheduler.cancel(URL_A, 'data');
		assert.equal(scheduler.pendingCount(), 2);
		scheduler.cancelUrl(URL_A);
		assert.equal(scheduler.pendingCount(), 1);

		clock.tick(60_000);
		assert.deepEqual(
			dispatches.map(({ url, database, at }) => ({ url, database, at })),
			[{ url: URL_B, database: 'data', at: 300 }]
		);
	});

	it('a throwing dispatch is contained instead of taking the process down', () => {
		const scheduler = createSubscribeSetupScheduler({
			dispatch: () => {
				throw new Error('uncloneable payload');
			},
			random: () => 0.5,
		});
		scheduler.schedule(URL_A, 'data', NODES);
		assert.doesNotThrow(() => clock.tick(300));
		assert.equal(scheduler.pendingCount(), 0, 'ownership released so the pair can be re-armed');
		assert.equal(scheduler.schedule(URL_A, 'data', NODES), 500);
	});
});

// Real Node timers, deliberately: hasRef() is what proves the process can still exit with a setup
// pending, and a faked timer has no such thing.
describe('subscription-setup scheduler timer refs', () => {
	it("unref's the setup timer so a pending retry cannot hold the process open", () => {
		const realSetTimeout = globalThis.setTimeout;
		let armed;
		globalThis.setTimeout = (fn, ms) => (armed = realSetTimeout(fn, ms));
		try {
			createSubscribeSetupScheduler({ dispatch: () => {}, random: () => 0.5 }).schedule(URL_A, 'data', NODES);
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
		assert.equal(armed.hasRef(), false);
		clearTimeout(armed);
	});
});

describe('self-catchup dispatch', () => {
	it('attaches the rider on a fresh payload and consumes it only after dispatch', () => {
		const nodes = [{ name: 'peer-a', url: URL_A, replicateByDefault: true }];
		let consumed = 0;
		let dispatched;
		dispatchSubscriptionNodes(nodes, {
			startTime: 123,
			nodeName: 'self',
			now: () => 456,
			dispatch: (value) => (dispatched = value),
			consume: () => consumed++,
		});

		assert.equal(nodes.length, 1);
		assert.deepEqual(dispatched, [
			nodes[0],
			{
				replicateByDefault: true,
				name: 'self',
				startTime: 123,
				endTime: 456,
				replicates: true,
			},
		]);
		assert.equal(consumed, 1);
	});

	it('retains the rider when dispatch throws', () => {
		const nodes = [{ name: 'peer-a', url: URL_A }];
		let consumed = 0;
		assert.throws(
			() =>
				dispatchSubscriptionNodes(nodes, {
					startTime: 123,
					nodeName: 'self',
					dispatch: () => {
						throw new Error('postMessage failed');
					},
					consume: () => consumed++,
				}),
			/postMessage failed/
		);
		assert.equal(nodes.length, 1);
		assert.equal(consumed, 0);
	});
});
