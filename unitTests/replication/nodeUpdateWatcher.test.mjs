/**
 * Regression coverage for the hdb_nodes watcher loop. Before this fix, any throw inside
 * the `for await (const event of events)` body silently terminated the watcher's async
 * iterator with no recovery path. Combined with the subscriptionManager exit-handler
 * chain being the only other route to `onDatabase`, an affected node permanently lost
 * the ability to (re)establish outbound replication subscriptions.
 *
 * These tests exercise `runNodeUpdateWatcher` directly with an injectable subscribe()
 * and per-event processor, asserting:
 *   - the loop restarts after `subscribe()` throws
 *   - the loop restarts after the events iterable ends normally
 *   - a per-event processor throw does NOT tear down the loop (continues consuming)
 *   - the optional `maxRestarts` knob is observed (used here to bound the test)
 *   - the restart backoff escalates on a failure cycle and only resets on a healthy run (harper-pro#327)
 */

import { expect } from 'chai';
import { runNodeUpdateWatcher } from '#src/replication/knownNodes';

// The restart delay is awaited through a bare setTimeout inside the watcher, so the delays it asks for
// are the only observable of its backoff.
function captureTimerDelays() {
	const realSetTimeout = globalThis.setTimeout;
	const values = [];
	globalThis.setTimeout = (fn, ms) => {
		values.push(ms);
		return realSetTimeout(fn, ms);
	};
	return {
		values,
		restore() {
			globalThis.setTimeout = realSetTimeout;
		},
	};
}

function makeAsyncIterableFromArray(items) {
	return {
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				async next() {
					if (i >= items.length) return { value: undefined, done: true };
					return { value: items[i++], done: false };
				},
			};
		},
	};
}

describe('runNodeUpdateWatcher restart loop', () => {
	it('restarts the watcher after subscribe() throws', async () => {
		let subscribeCalls = 0;
		const subscribe = async () => {
			subscribeCalls++;
			if (subscribeCalls === 1) throw new Error('transient subscribe failure');
			return makeAsyncIterableFromArray([]); // second call succeeds with empty stream
		};
		const processEvent = () => {};

		await runNodeUpdateWatcher(() => {}, {
			subscribe,
			processEvent,
			restartDelayMs: 1,
			maxRestarts: 2,
		});

		expect(subscribeCalls).to.equal(2);
	});

	it('restarts the watcher after the events iterable ends normally', async () => {
		let subscribeCalls = 0;
		const subscribe = async () => {
			subscribeCalls++;
			return makeAsyncIterableFromArray([]); // iterator returns done immediately each time
		};
		const processEvent = () => {};

		await runNodeUpdateWatcher(() => {}, {
			subscribe,
			processEvent,
			restartDelayMs: 1,
			maxRestarts: 3,
		});

		expect(subscribeCalls).to.equal(3);
	});

	it('continues consuming events when the per-event processor throws (does not tear down the loop)', async () => {
		const events = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		const processed = [];
		let subscribeCalls = 0;
		const subscribe = async () => {
			subscribeCalls++;
			if (subscribeCalls === 1) return makeAsyncIterableFromArray(events);
			return makeAsyncIterableFromArray([]); // subsequent restarts have no events
		};
		const processEvent = (event) => {
			if (event.id === 'b') throw new Error('bad event b');
			processed.push(event.id);
		};

		await runNodeUpdateWatcher(() => {}, {
			subscribe,
			processEvent,
			restartDelayMs: 1,
			maxRestarts: 2,
		});

		// a and c were processed despite b throwing — the loop did not die mid-iteration
		expect(processed).to.deep.equal(['a', 'c']);
		// the loop also restarted (subscribed twice) after the iterable ended
		expect(subscribeCalls).to.equal(2);
	});

	// harper-pro#327: the marker used to be set the instant subscribe() resolved, so a subscription that
	// resolved and then immediately threw counted as a success on every pass, reset the backoff, and
	// pinned the restart at restartDelayMs forever. Against that code the delays below are [4, 4, 4, 4].
	it('escalates when subscribe() resolves and iteration immediately throws', async () => {
		const delays = captureTimerDelays();
		try {
			await runNodeUpdateWatcher(() => {}, {
				subscribe: async () => ({
					[Symbol.asyncIterator]: () => ({
						next: async () => {
							throw new Error('stream died immediately');
						},
					}),
				}),
				restartDelayMs: 4,
				maxDelayMs: 256,
				random: () => 0.999999,
				maxRestarts: 5,
			});
		} finally {
			delays.restore();
		}

		expect(delays.values).to.deep.equal([4, 7, 15, 31]);
	});

	it('resets the backoff once an iteration survives the healthy-uptime threshold', async () => {
		let subscribeCalls = 0;
		let fakeNow = 0;
		const delays = captureTimerDelays();
		try {
			await runNodeUpdateWatcher(() => {}, {
				subscribe: async () => {
					subscribeCalls++;
					fakeNow += 60_000; // every run stays up well past healthyUptimeMs
					return makeAsyncIterableFromArray([]);
				},
				restartDelayMs: 4,
				maxDelayMs: 256,
				healthyUptimeMs: 10_000,
				now: () => fakeNow,
				random: () => 0.999999,
				maxRestarts: 4,
			});
		} finally {
			delays.restore();
		}

		expect(subscribeCalls).to.equal(4);
		expect(delays.values, 'a healthy run never escalates').to.deep.equal([4, 4, 4]);
	});

	it('forwards events to the listener via the default processEvent path', async () => {
		// Smoke test the default processor at the parameter-passing level using an
		// injected subscribe that yields a single put event for a foreign node.
		// We avoid the full path (it touches the hdb_nodes table) by passing our
		// own processEvent — this case primarily proves the watcher passes the
		// listener argument through to the processor.
		const seenListener = [];
		const listener = (value, id) => seenListener.push({ value, id });
		const subscribe = async () =>
			makeAsyncIterableFromArray([{ type: 'put', id: 'peer-a', value: { name: 'peer-a' } }]);
		const processEvent = (event, l) => {
			if (event.type === 'put' || event.type === 'delete') l(event.value, event.id);
		};

		await runNodeUpdateWatcher(listener, {
			subscribe,
			processEvent,
			restartDelayMs: 1,
			maxRestarts: 1,
		});

		expect(seenListener).to.deep.equal([{ value: { name: 'peer-a' }, id: 'peer-a' }]);
	});
});
