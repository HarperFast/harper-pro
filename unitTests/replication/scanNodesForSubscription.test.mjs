/**
 * Coverage for the OUTBOUND subscription scan resilience to an hdb_nodes decode miss (harper-pro#460).
 *
 * Root cause: a `deploy_component` reloads the worker pool, which re-invokes
 * `replicator.startOnMainThread()` on the SAME already-resolved main-thread module instance. Its
 * `whenThreadsStarted.then()` fires immediately — with NO base-copy (unlike a full restart, where
 * `hdb_nodes` is base-copied first) — so the post-reload subscription scan runs while a follower's
 * replicated `hdb_nodes` rows still fail to decode (a v5-era shared-structure row misreading; the
 * harper-pro#352 / harper#1163 family). The old scan did `if (!node) continue`, silently skipping
 * every undecodable peer, so the follower built ZERO outbound subscriptions and stopped receiving
 * all replicated writes (the observed cache-clear-not-propagating incident) until a full restart.
 *
 * The #352 `{ name }` fallback in `resolveNodeForAuth` is auth-only / inbound and is never reached
 * by this outbound path. The fix mirrors it for the subscription scan: when a key is range-visible
 * but its value decodes to null, reconstruct a minimal descriptor from the key and still drive
 * `onNode` so the outbound subscription is (re)established. Unlike the auth path, the subscription
 * path gates on `node.replicates`, so the reconstructed descriptor carries `replicates: true`.
 *
 * These tests exercise the pure seams (`reconstructNodeFromKey`, `resolveScannedNode`) and the IO
 * loop (`scanNodesForSubscription`) against a fake store, asserting the without-fix vs with-fix
 * behavior: an all-undecodable follower drives ZERO subscriptions under the old skip and one per
 * range-visible peer under the fix.
 */

import { expect } from 'chai';
import {
	reconstructNodeFromKey,
	resolveScannedNode,
	scanNodesForSubscription,
	probeNodeRow,
	runNodeUpdateWatcher,
	stopNodeUpdateWatcher,
} from '#src/replication/knownNodes';

// Sentinel meaning "the POINT lookup throws for this key" — the present-but-undecodable (#352/#1163)
// state, distinct from a clean null (a genuine remove_node tombstone).
const DECODE_THROWS = Symbol('decode-throws');

/**
 * Minimal store stub modeling lmdb-js getRange + get. `rows` maps key -> decoded range value (use
 * `null` to model a range-visible row whose decoded scan value is null — both the decode-miss and
 * the tombstone present this way in the scan). The point lookup (`get`) is what disambiguates:
 * `DECODE_THROWS` ⇒ get() throws (decode failure, reconstruct); a `null` row value ⇒ get() returns
 * null (genuine tombstone, skip); any object ⇒ get() returns it.
 */
function fakeStore(rows) {
	return {
		getRange() {
			return Object.keys(rows)
				.sort()
				.map((key) => ({ key, value: rows[key] === DECODE_THROWS ? null : rows[key] }));
		},
		get(key) {
			const row = rows[key];
			if (row === DECODE_THROWS) throw new Error('missing shared structure');
			return row ?? null;
		},
	};
}

describe('reconstructNodeFromKey (harper-pro#460)', () => {
	it('reconstructs a replicating descriptor from a peer name key', () => {
		// Must carry replicates:true — the outbound subscription path gates on node.replicates
		// (shouldReplicateFromNode / onNodeUpdate early-return), unlike the auth-only { name } fallback.
		expect(reconstructNodeFromKey('peer-a')).to.deep.equal({ name: 'peer-a', replicates: true });
	});

	it('returns undefined for a non-string / empty key (nothing usable to subscribe to)', () => {
		expect(reconstructNodeFromKey('')).to.equal(undefined);
		expect(reconstructNodeFromKey(undefined)).to.equal(undefined);
		expect(reconstructNodeFromKey(null)).to.equal(undefined);
		expect(reconstructNodeFromKey(42)).to.equal(undefined);
		expect(reconstructNodeFromKey({})).to.equal(undefined);
	});
});

describe('resolveScannedNode (harper-pro#460)', () => {
	// A probe modeling the store-backed probeNodeRow outcome for tests of the pure resolution logic.
	const decodeFailure = () => ({ outcome: 'decode-failure' });
	const tombstone = () => ({ outcome: 'deleted' });

	it('returns the decoded record as-is when present', () => {
		const decoded = { name: 'peer-a', url: 'wss://peer-a:9933', replicates: true, shard: 2 };
		expect(resolveScannedNode(decoded, 'peer-a', decodeFailure)).to.equal(decoded);
	});

	it('reconstructs from the key on a decode failure (probe says decode-failure)', () => {
		expect(resolveScannedNode(null, 'peer-a', decodeFailure)).to.deep.equal({ name: 'peer-a', replicates: true });
		expect(resolveScannedNode(undefined, 'peer-a', decodeFailure)).to.deep.equal({ name: 'peer-a', replicates: true });
	});

	it('does NOT reconstruct a genuine tombstone (probe says deleted) — no reviving removed nodes', () => {
		// harper-pro#460 review (Codex P1): a remove_node leaves a null tombstone; reviving it would
		// resubscribe a removed peer.
		expect(resolveScannedNode(null, 'peer-a', tombstone)).to.equal(undefined);
	});

	it('without a probe, preserves the original reconstruct-on-null behavior (pure seam)', () => {
		expect(resolveScannedNode(null, 'peer-a')).to.deep.equal({ name: 'peer-a', replicates: true });
		expect(resolveScannedNode(null, '')).to.equal(undefined);
	});

	it('returns undefined when there is neither a value nor a usable key', () => {
		expect(resolveScannedNode(null, '', decodeFailure)).to.equal(undefined);
		expect(resolveScannedNode(null, undefined, decodeFailure)).to.equal(undefined);
	});
});

describe('probeNodeRow (harper-pro#460 review: tombstone vs decode failure)', () => {
	it('classifies a point lookup that THROWS as a decode failure', () => {
		const store = {
			get: () => {
				throw new Error('missing shared structure');
			},
		};
		expect(probeNodeRow(store, 'peer-a')).to.deep.equal({ outcome: 'decode-failure' });
	});

	it('classifies a clean null point lookup as a genuine tombstone (deleted)', () => {
		const store = { get: () => null };
		expect(probeNodeRow(store, 'peer-a')).to.deep.equal({ outcome: 'deleted' });
	});

	it('classifies undefined (physically absent) as deleted', () => {
		const store = { get: () => undefined };
		expect(probeNodeRow(store, 'peer-a')).to.deep.equal({ outcome: 'deleted' });
	});

	it('returns the recovered record when the point lookup succeeds where the range value was null', () => {
		const rec = { name: 'peer-a', replicates: true };
		const store = { get: () => rec };
		expect(probeNodeRow(store, 'peer-a')).to.deep.equal({ outcome: 'decode-failure', record: rec });
	});
});

describe('scanNodesForSubscription end-to-end (harper-pro#460 wedge close)', () => {
	it('THE BUG (old behavior): a follower whose every hdb_nodes peer decodes to null gets ZERO subscriptions', () => {
		// Reproduce the old `if (!node) continue` skip to show the failure mode the fix closes.
		const store = fakeStore({ 'peer-a': DECODE_THROWS, 'peer-b': DECODE_THROWS, 'peer-c': DECODE_THROWS });
		const subscribed = [];
		for (const { value, key } of store.getRange({})) {
			if (!value) continue; // <-- the old skip
			subscribed.push(key);
		}
		expect(subscribed).to.deep.equal([]); // zero outbound subscriptions — the silent data-loss state
	});

	it('THE FIX: the same all-undecodable follower drives one subscription per range-visible peer', () => {
		const store = fakeStore({ 'peer-a': DECODE_THROWS, 'peer-b': DECODE_THROWS, 'peer-c': DECODE_THROWS });
		const driven = [];
		scanNodesForSubscription(store, (node, key) => driven.push({ node, key }));
		expect(driven).to.deep.equal([
			{ node: { name: 'peer-a', replicates: true }, key: 'peer-a' },
			{ node: { name: 'peer-b', replicates: true }, key: 'peer-b' },
			{ node: { name: 'peer-c', replicates: true }, key: 'peer-c' },
		]);
	});

	it('skips genuine tombstones (deleted nodes) while still reconstructing decode-miss peers (mixed)', () => {
		// harper-pro#460 review (Codex P1): peer-b is a removed node (clean-null tombstone) and must NOT
		// be resubscribed; peer-c is a transient decode miss and must be reconstructed.
		const store = fakeStore({ 'peer-b': null, 'peer-c': DECODE_THROWS });
		const driven = [];
		scanNodesForSubscription(store, (node, key) => driven.push({ node, key }));
		expect(driven).to.deep.equal([{ node: { name: 'peer-c', replicates: true }, key: 'peer-c' }]);
	});

	it('passes decoded records through unchanged and reconstructs only the undecodable ones (mixed)', () => {
		const peerA = { name: 'peer-a', url: 'wss://peer-a:9933', replicates: true, shard: 1 };
		const store = fakeStore({ 'peer-a': peerA, 'peer-b': DECODE_THROWS });
		const driven = [];
		scanNodesForSubscription(store, (node, key) => driven.push({ node, key }));
		expect(driven).to.have.length(2);
		expect(driven[0]).to.deep.equal({ node: peerA, key: 'peer-a' }); // full record preserved (url/shard kept)
		expect(driven[1]).to.deep.equal({ node: { name: 'peer-b', replicates: true }, key: 'peer-b' });
	});
});

/**
 * A controllable hdb_nodes change-subscription stand-in. `next()` resolves once `push()` is called,
 * so the watcher loop parks on it exactly like the real change stream. `return()` (what
 * stopNodeUpdateWatcher invokes to cancel a superseded watcher) flips `closed` and unblocks any
 * pending `next()` with `{ done: true }`, so we can assert that starting a new watcher of the same
 * key actually closed the prior one.
 */
function controllableSubscription() {
	let pending;
	const queue = [];
	const iterator = {
		closed: false,
		next() {
			if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
			if (this.closed) return Promise.resolve({ value: undefined, done: true });
			return new Promise((resolve) => {
				pending = resolve;
			});
		},
		return() {
			this.closed = true;
			if (pending) {
				pending({ value: undefined, done: true });
				pending = undefined;
			}
			return Promise.resolve({ value: undefined, done: true });
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	};
	return {
		iterator,
		push(event) {
			if (pending) {
				pending({ value: event, done: false });
				pending = undefined;
			} else {
				queue.push(event);
			}
		},
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('runNodeUpdateWatcher idempotency (harper-pro#460 reload double-registration)', () => {
	afterEach(() => {
		// Tear down anything the tests left running so a lingering watcher can't bleed across cases.
		stopNodeUpdateWatcher('test-key');
		stopNodeUpdateWatcher('test-key-a');
		stopNodeUpdateWatcher('test-key-b');
	});

	it('re-invoking the SAME key supersedes (closes) the prior watcher instead of stacking one', async () => {
		const first = controllableSubscription();
		const firstEvents = [];
		runNodeUpdateWatcher((node) => firstEvents.push(node), {
			key: 'test-key',
			subscribe: () => first.iterator,
			processEvent: (event, listener) => listener(event, event?.name),
		});
		await flush();
		first.push({ name: 'peer-a', replicates: true });
		await flush();
		expect(firstEvents).to.have.length(1);
		expect(first.iterator.closed).to.equal(false);

		// Reload: same key, fresh subscription. The first watcher must be superseded and closed.
		const second = controllableSubscription();
		const secondEvents = [];
		runNodeUpdateWatcher((node) => secondEvents.push(node), {
			key: 'test-key',
			subscribe: () => second.iterator,
			processEvent: (event, listener) => listener(event, event?.name),
		});
		await flush();
		expect(first.iterator.closed).to.equal(true); // prior watcher torn down — no accumulation

		// An event on the superseded subscription must NOT reach the old listener anymore.
		first.push({ name: 'stale', replicates: true });
		await flush();
		expect(firstEvents).to.have.length(1);

		// The new watcher is the only live one.
		second.push({ name: 'peer-b', replicates: true });
		await flush();
		expect(secondEvents).to.have.length(1);
		expect(secondEvents[0]).to.deep.equal({ name: 'peer-b', replicates: true });
	});

	it('distinct keys run concurrently and do not supersede each other', async () => {
		const a = controllableSubscription();
		const b = controllableSubscription();
		const aEvents = [];
		const bEvents = [];
		runNodeUpdateWatcher((node) => aEvents.push(node), {
			key: 'test-key-a',
			subscribe: () => a.iterator,
			processEvent: (event, listener) => listener(event, event?.name),
		});
		runNodeUpdateWatcher((node) => bEvents.push(node), {
			key: 'test-key-b',
			subscribe: () => b.iterator,
			processEvent: (event, listener) => listener(event, event?.name),
		});
		await flush();
		// Neither watcher closed the other (this is the subscription-vs-confirmation coexistence case).
		expect(a.iterator.closed).to.equal(false);
		expect(b.iterator.closed).to.equal(false);

		a.push({ name: 'peer-a' });
		b.push({ name: 'peer-b' });
		await flush();
		expect(aEvents).to.deep.equal([{ name: 'peer-a' }]);
		expect(bEvents).to.deep.equal([{ name: 'peer-b' }]);
	});

	it('stopNodeUpdateWatcher closes the active watcher and stops further delivery', async () => {
		const sub = controllableSubscription();
		const events = [];
		runNodeUpdateWatcher((node) => events.push(node), {
			key: 'test-key',
			subscribe: () => sub.iterator,
			processEvent: (event, listener) => listener(event, event?.name),
		});
		await flush();
		sub.push({ name: 'peer-a' });
		await flush();
		expect(events).to.have.length(1);

		stopNodeUpdateWatcher('test-key');
		await flush();
		expect(sub.iterator.closed).to.equal(true);

		sub.push({ name: 'after-stop' });
		await flush();
		expect(events).to.have.length(1); // nothing delivered after stop
	});
});
