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
 */

import { expect } from 'chai';
import { runNodeUpdateWatcher } from '#src/replication/knownNodes';

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
