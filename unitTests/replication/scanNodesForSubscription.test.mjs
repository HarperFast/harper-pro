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
import { reconstructNodeFromKey, resolveScannedNode, scanNodesForSubscription } from '#src/replication/knownNodes';

/**
 * Minimal store stub modeling lmdb-js getRange. `rows` maps key -> decoded value (use `null` to
 * model a range-visible-but-undecodable row — the harper-pro#460 follower state). Keys are always
 * range-visible (that is the whole point: the scan path lists keys reliably even when the value
 * fails to decode through the record codec).
 */
function fakeStore(rows) {
	return {
		getRange() {
			return Object.keys(rows)
				.sort()
				.map((key) => ({ key, value: rows[key] }));
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
	it('returns the decoded record as-is when present', () => {
		const decoded = { name: 'peer-a', url: 'wss://peer-a:9933', replicates: true, shard: 2 };
		expect(resolveScannedNode(decoded, 'peer-a')).to.equal(decoded);
	});

	it('reconstructs from the key when the value failed to decode (null) but the key is range-visible', () => {
		expect(resolveScannedNode(null, 'peer-a')).to.deep.equal({ name: 'peer-a', replicates: true });
		expect(resolveScannedNode(undefined, 'peer-a')).to.deep.equal({ name: 'peer-a', replicates: true });
	});

	it('returns undefined when there is neither a value nor a usable key', () => {
		expect(resolveScannedNode(null, '')).to.equal(undefined);
		expect(resolveScannedNode(null, undefined)).to.equal(undefined);
	});
});

describe('scanNodesForSubscription end-to-end (harper-pro#460 wedge close)', () => {
	it('THE BUG (old behavior): a follower whose every hdb_nodes peer decodes to null gets ZERO subscriptions', () => {
		// Reproduce the old `if (!node) continue` skip to show the failure mode the fix closes.
		const store = fakeStore({ 'peer-a': null, 'peer-b': null, 'peer-c': null });
		const subscribed = [];
		for (const { value, key } of store.getRange({})) {
			if (!value) continue; // <-- the old skip
			subscribed.push(key);
		}
		expect(subscribed).to.deep.equal([]); // zero outbound subscriptions — the silent data-loss state
	});

	it('THE FIX: the same all-undecodable follower drives one subscription per range-visible peer', () => {
		const store = fakeStore({ 'peer-a': null, 'peer-b': null, 'peer-c': null });
		const driven = [];
		scanNodesForSubscription(store, (node, key) => driven.push({ node, key }));
		expect(driven).to.deep.equal([
			{ node: { name: 'peer-a', replicates: true }, key: 'peer-a' },
			{ node: { name: 'peer-b', replicates: true }, key: 'peer-b' },
			{ node: { name: 'peer-c', replicates: true }, key: 'peer-c' },
		]);
	});

	it('passes decoded records through unchanged and reconstructs only the undecodable ones (mixed)', () => {
		const peerA = { name: 'peer-a', url: 'wss://peer-a:9933', replicates: true, shard: 1 };
		const store = fakeStore({ 'peer-a': peerA, 'peer-b': null });
		const driven = [];
		scanNodesForSubscription(store, (node, key) => driven.push({ node, key }));
		expect(driven).to.have.length(2);
		expect(driven[0]).to.deep.equal({ node: peerA, key: 'peer-a' }); // full record preserved (url/shard kept)
		expect(driven[1]).to.deep.equal({ node: { name: 'peer-b', replicates: true }, key: 'peer-b' });
	});
});
