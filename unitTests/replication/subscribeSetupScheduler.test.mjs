import assert from 'node:assert';
import {
	clearWorkerFromEntries,
	createSubscribeSetupScheduler,
	dispatchSubscriptionNodes,
	dispatchSubscriptionRequest,
} from '#src/replication/subscriptionManager';

const URL_A = 'wss://peer-a:9933';
const URL_B = 'wss://peer-b:9933';
const MIN_DELAY = 200;
const MAX_DELAY = 30_000;

const NODES = [{ name: 'peer-a', url: URL_A }];

function createManualTimers() {
	let now = 0;
	let nextId = 0;
	const timers = new Map();
	return {
		setTimer(callback, delay) {
			const timer = {
				id: nextId++,
				due: now + delay,
				callback,
				unref() {
					return timer;
				},
			};
			timers.set(timer.id, timer);
			return timer;
		},
		clearTimer(timer) {
			if (timer) timers.delete(timer.id);
		},
		tick(duration) {
			const target = now + duration;
			while (true) {
				let next;
				for (const timer of timers.values()) {
					if (timer.due <= target && (!next || timer.due < next.due)) next = timer;
				}
				if (!next) break;
				timers.delete(next.id);
				now = next.due;
				next.callback();
			}
			now = target;
		},
		now: () => now,
	};
}

// A slide that never terminates would hang the run instead of failing it.
class PassLimitedArray extends Array {
	passes = 0;
	[Symbol.iterator]() {
		if (++this.passes > 10) throw new Error('sweep slide did not terminate');
		return super[Symbol.iterator]();
	}
}

let timers;

function makeScheduler(random) {
	const dispatches = [];
	const scheduler = createSubscribeSetupScheduler({
		dispatch: (url, database, nodes) => dispatches.push({ url, database, nodes, at: timers.now() }),
		random,
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		now: timers.now,
	});
	return { scheduler, dispatches };
}

describe('subscription-setup scheduler (harper-pro#327)', () => {
	beforeEach(() => {
		timers = createManualTimers();
	});

	it('bounds a 60s re-drive storm to a handful of setups with one pending timer throughout', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		let maxPending = 0;

		for (let i = 0; i < 60_000; i++) {
			scheduler.schedule(URL_A, 'data', NODES);
			maxPending = Math.max(maxPending, scheduler.pendingCount());
			timers.tick(1);
		}

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
			timers.tick(delay);
		}
	});

	it('returns undefined instead of arming a second timer for the same pair', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		assert.equal(scheduler.schedule(URL_A, 'data', NODES), 300);
		assert.equal(scheduler.schedule(URL_A, 'data', NODES), undefined, 'deduped');
		assert.equal(scheduler.schedule(URL_A, 'data', NODES), undefined, 'still deduped');
		timers.tick(60_000);
		assert.equal(dispatches.length, 1);
	});

	it('tracks (url, database) pairs independently', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		assert.equal(scheduler.schedule(URL_A, 'data', NODES), 300);
		assert.equal(scheduler.schedule(URL_A, 'other', NODES), 300);
		assert.equal(scheduler.schedule(URL_B, 'data', NODES), 300);
		assert.equal(scheduler.pendingCount(), 3);
		timers.tick(300);
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
		const timerOptions = { setTimer: timers.setTimer, clearTimer: timers.clearTimer };
		const a = createSubscribeSetupScheduler({ dispatch: () => {}, random: () => 0.1, ...timerOptions });
		const b = createSubscribeSetupScheduler({ dispatch: () => {}, random: () => 0.9, ...timerOptions });
		const aDelays = [];
		const bDelays = [];
		for (let attempt = 0; attempt < 5; attempt++) {
			aDelays.push(a.schedule(URL_A, 'data', NODES));
			bDelays.push(b.schedule(URL_A, 'data', NODES));
			timers.tick(MAX_DELAY + MIN_DELAY);
		}
		assert.notDeepEqual(aDelays, bDelays);
		for (let i = 0; i < aDelays.length; i++) assert.ok(aDelays[i] < bDelays[i]);
	});

	it('fires with the newest payload a deduped call supplied', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		const first = [{ name: 'peer-a', url: URL_A }];
		const second = [{ name: 'peer-a', url: URL_A, isLeader: true }];
		scheduler.schedule(URL_A, 'data', first);
		assert.equal(scheduler.schedule(URL_A, 'data', second), undefined);
		timers.tick(300);
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
		timers.tick(300);
		assert.equal(dispatches.length, 1);
		assert.equal(dispatches[0].nodes, refreshed);
	});

	it('refreshPending on a pair with nothing armed does not arm one', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		scheduler.refreshPending(URL_A, 'data', NODES);
		assert.equal(scheduler.pendingCount(), 0);
		timers.tick(60_000);
		assert.deepEqual(dispatches, []);
	});

	function assertSpaced(delays) {
		const sorted = [...delays].sort((x, y) => x - y);
		for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= 50, `${sorted} too close`);
	}

	it('slides a sweep setup past one armed within the stagger window', () => {
		const { scheduler } = makeScheduler(() => 0.6);
		assert.equal(scheduler.schedule(URL_A, 'data', NODES, { armedAt: [300] }), 350);
	});

	it('terminates a slide whose armed time plus the stagger rounds down across a power of two', () => {
		// Below 2^13 by less than the stagger: armedAt + 50 lands in the next binade and loses its last bit.
		const armedAt = 8150 + 2 ** -40;
		assert.ok(armedAt + 50 - armedAt < 50);
		const { scheduler, dispatches } = makeScheduler(() => 0);
		timers.tick(7950);
		const sweep = { armedAt: PassLimitedArray.of(armedAt) };
		assert.equal(scheduler.schedule(URL_A, 'system', NODES, sweep), 250);
		assert.deepEqual([...sweep.armedAt], [armedAt, 8200]);
		assert.equal(scheduler.pendingCount(), 1);
		timers.tick(MAX_DELAY);
		assert.deepEqual(
			dispatches.map((d) => [d.database, d.at]),
			[['system', 8200]]
		);
	});

	it('preserves sweep spacing when independent jitter draws would collide', () => {
		const draws = [0.75, 0.5, 0.26, 0.24, 0];
		const { scheduler } = makeScheduler(() => draws.shift());
		const sweep = { armedAt: [] };
		const delays = [0, 1, 2, 3, 4].map((i) => scheduler.schedule(URL_A, `data${i}`, NODES, sweep));
		assert.deepEqual(delays, [350, 300, 400, 248, 450]);
		assertSpaced(delays);
	});

	it('spaces sweep setups by fire time when the sweep calls are made at different instants', () => {
		const draws = [0.75, 0.5];
		const { scheduler, dispatches } = makeScheduler(() => draws.shift());
		const sweep = { armedAt: [] };
		assert.equal(scheduler.schedule(URL_A, 'first', NODES, sweep), 350);
		timers.tick(20);
		assert.equal(scheduler.schedule(URL_A, 'second', NODES, sweep), 380);
		timers.tick(MAX_DELAY);
		assert.deepEqual(
			dispatches.map((d) => d.at),
			[350, 400]
		);
	});

	it('keeps spacing next to a pair drawn just past the fresh-draw window', () => {
		// 300 ms on the first attempt, then 401 ms from the 800 ms ceiling, then a fresh pair's 399 ms
		const draws = [0.5, 201 / 600, 0.995];
		const { scheduler } = makeScheduler(() => draws.shift());
		scheduler.schedule(URL_A, 'failed-once', NODES);
		timers.tick(MAX_DELAY);
		const sweep = { armedAt: [] };
		const failedOnce = scheduler.schedule(URL_A, 'failed-once', NODES, sweep);
		const fresh = scheduler.schedule(URL_A, 'fresh', NODES, sweep);
		assert.deepEqual([failedOnce, fresh], [401, 451]);
	});

	it('does not let a pair with an escalated backoff drag the rest of the sweep', () => {
		const { scheduler } = makeScheduler(() => 0.99);
		for (let attempt = 0; attempt < 8; attempt++) {
			scheduler.schedule(URL_A, 'failing', NODES);
			timers.tick(MAX_DELAY);
		}
		const sweep = { armedAt: [] };
		const escalated = scheduler.schedule(URL_A, 'failing', NODES, sweep);
		const healthy = scheduler.schedule(URL_A, 'healthy', NODES, sweep);
		assert.ok(escalated > 20_000, `escalated delay ${escalated}`);
		assert.ok(healthy < 400, `healthy delay ${healthy}`);
	});

	// A connect report cannot be attributed to the entry that armed the setup (failover subscribes on a
	// worker that is not entry.worker, and a superseded worker still reports for the same pair), so the
	// armed setup is left to fire and only the escalated delay is dropped. Escalating across reconnect
	// cycles instead is what pushed a chaos-restart peer past its 25s reconvergence budget.
	it('noteConnected resets the escalated delay and leaves the armed setup to fire', () => {
		const { scheduler, dispatches } = makeScheduler(() => 0.5);
		scheduler.schedule(URL_A, 'data', NODES);
		timers.tick(300);
		scheduler.schedule(URL_A, 'data', NODES); // second attempt: escalated to 500
		assert.equal(scheduler.pendingCount(), 1);

		scheduler.noteConnected(URL_A, 'data');
		assert.equal(scheduler.pendingCount(), 1, 'still armed');
		timers.tick(60_000);
		assert.equal(dispatches.length, 2, 'the armed setup fired');

		assert.equal(scheduler.schedule(URL_A, 'data', NODES), 300, 'back to the first ceiling after success');
	});

	it('a pair that reconnects every cycle never escalates', () => {
		const { scheduler } = makeScheduler(() => 0.5);
		const delays = [];
		for (let cycle = 0; cycle < 5; cycle++) {
			delays.push(scheduler.schedule(URL_A, 'data', NODES));
			timers.tick(1000);
			scheduler.noteConnected(URL_A, 'data');
		}
		assert.deepEqual(delays, [300, 300, 300, 300, 300]);
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

		timers.tick(60_000);
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
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		scheduler.schedule(URL_A, 'data', NODES);
		assert.doesNotThrow(() => timers.tick(300));
		assert.equal(scheduler.pendingCount(), 0, 'ownership released so the pair can be re-armed');
		assert.equal(scheduler.schedule(URL_A, 'data', NODES), 500);
	});
});

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

describe('scheduled setup ownership transitions', () => {
	it('never falls onto the main thread when its worker exits before fire', () => {
		const manual = createManualTimers();
		const oldWorker = { postMessage: () => assert.fail('exited worker received setup') };
		const replacementMessages = [];
		const replacementWorker = { postMessage: (message) => replacementMessages.push(message) };
		const entry = { worker: oldWorker, nodes: NODES };
		const connectionMap = new Map([[URL_A, new Map([['data', entry]])]]);
		const mainMessages = [];
		let liveWorkers = [oldWorker];
		const scheduler = createSubscribeSetupScheduler({
			dispatch(url, database, nodes) {
				const current = connectionMap.get(url)?.get(database);
				if (current)
					dispatchSubscriptionRequest(
						current,
						{ type: 'subscribe-to-node', url, database, nodes },
						liveWorkers,
						false,
						(message) => mainMessages.push(message)
					);
			},
			random: () => 0.5,
			setTimer: manual.setTimer,
			clearTimer: manual.clearTimer,
		});

		scheduler.schedule(URL_A, 'data', NODES);
		clearWorkerFromEntries(connectionMap, oldWorker);
		liveWorkers = [replacementWorker];
		manual.tick(300);
		assert.deepEqual(mainMessages, []);
		assert.deepEqual(replacementMessages, []);

		entry.worker = replacementWorker;
		scheduler.schedule(URL_A, 'data', NODES);
		manual.tick(500);
		assert.equal(replacementMessages.length, 1);
		assert.equal(replacementMessages[0].database, 'data');
	});

	it('uses the main thread only when it is the configured worker', () => {
		const messages = [];
		assert.equal(
			dispatchSubscriptionRequest({}, { id: 1 }, [], true, (message) => messages.push(message)),
			'main'
		);
		assert.deepEqual(messages, [{ id: 1 }]);
	});
});

describe('self-catchup dispatch', () => {
	it('attaches the rider on a fresh payload and consumes it only after dispatch', () => {
		const nodes = [{ name: 'peer-a', url: URL_A, replicateByDefault: true }];
		let consumed = 0;
		let retained;
		let dispatched;
		dispatchSubscriptionNodes(nodes, {
			startTime: 123,
			nodeName: 'self',
			now: () => 456,
			dispatch: (value) => (dispatched = value),
			retain: (value) => (retained = value),
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
		assert.strictEqual(retained, dispatched[1]);
		assert.equal(consumed, 1);
	});

	it('reattaches a retained rider on recovery without consuming it again', () => {
		const nodes = [{ name: 'peer-a', url: URL_A }];
		const selfCatchupNode = { name: 'self', startTime: 123, endTime: 456, replicates: true };
		let consumed = 0;
		let dispatched;
		dispatchSubscriptionNodes(nodes, {
			selfCatchupNode,
			dispatch: (value) => (dispatched = value),
			retain: () => assert.fail('an existing rider must not be retained again'),
			consume: () => consumed++,
		});

		assert.deepEqual(dispatched, [...nodes, selfCatchupNode]);
		assert.equal(consumed, 0);
	});

	it('leaves the rider unclaimed when dispatch throws', () => {
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
					retain: () => assert.fail('a failed dispatch must not retain the rider'),
					consume: () => consumed++,
				}),
			/postMessage failed/
		);
		assert.equal(nodes.length, 1);
		assert.equal(consumed, 0);
	});
});
