/**
 * Coverage for the wedged-connection detection used by subscriptionManager's periodic reconcile.
 * A connection can end up connected:false on a *live* worker with no pending retry — most notably
 * the empty-subscription delayed close (intentionallyUnsubscribed) firing during a peer restart and
 * then never re-establishing. findStaleNodeUrls does not catch this (the worker is alive), so
 * findWedgedNodeUrls drives the recovery. These tests verify it flags only genuinely-wedged,
 * still-desired entries that have stayed disconnected past the threshold. See harper-pro#233 / #289.
 */

import { expect } from 'chai';
import { findWedgedNodeUrls } from '#src/replication/subscriptionManager';

const THRESHOLD = 30_000;
const NOW = 1_000_000;

function makeWorker(name = 'http') {
	return { name };
}

// entry defaults to a desired, long-disconnected, live-worker entry; override fields per test.
function entry(worker, overrides = {}) {
	return {
		worker,
		connected: false,
		disconnectedAt: NOW - THRESHOLD,
		nodes: [{ replicates: true }],
		...overrides,
	};
}

function makeConnectionMap(entries) {
	const map = new Map();
	for (const [url, dbEntries] of entries) {
		const dbMap = new Map();
		for (const [db, e] of dbEntries) dbMap.set(db, e);
		map.set(url, dbMap);
	}
	return map;
}

describe('findWedgedNodeUrls', () => {
	it('flags a desired entry disconnected past the threshold on a live worker', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['ws://a:9933', [['data', entry(w)]]]]);
		expect(findWedgedNodeUrls(map, [w], NOW, THRESHOLD)).to.deep.equal(new Set(['ws://a:9933']));
	});

	it('does not flag a connection that just disconnected (still within retry window)', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['ws://a:9933', [['data', entry(w, { disconnectedAt: NOW - 1_000 })]]]]);
		expect(findWedgedNodeUrls(map, [w], NOW, THRESHOLD)).to.deep.equal(new Set());
	});

	it('does not flag a connected entry', () => {
		const w = makeWorker();
		const map = makeConnectionMap([
			['ws://a:9933', [['data', entry(w, { connected: true, disconnectedAt: undefined })]]],
		]);
		expect(findWedgedNodeUrls(map, [w], NOW, THRESHOLD)).to.deep.equal(new Set());
	});

	it('does not flag an entry with no disconnectedAt recorded', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['ws://a:9933', [['data', entry(w, { disconnectedAt: undefined })]]]]);
		expect(findWedgedNodeUrls(map, [w], NOW, THRESHOLD)).to.deep.equal(new Set());
	});

	it('does not flag an entry whose worker is no longer in the pool (stale path handles that)', () => {
		const live = makeWorker();
		const dead = makeWorker();
		const map = makeConnectionMap([['ws://a:9933', [['data', entry(dead)]]]]);
		expect(findWedgedNodeUrls(map, [live], NOW, THRESHOLD)).to.deep.equal(new Set());
	});

	it('does not flag a non-replicating (undesired) node — a legitimately-unsubscribed connection', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['ws://a:9933', [['data', entry(w, { nodes: [{ replicates: false }] })]]]]);
		expect(findWedgedNodeUrls(map, [w], NOW, THRESHOLD)).to.deep.equal(new Set());
	});

	it('flags a desired node that has subscriptions even without the replicates flag', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['ws://a:9933', [['data', entry(w, { nodes: [{ subscriptions: ['t'] }] })]]]]);
		expect(findWedgedNodeUrls(map, [w], NOW, THRESHOLD)).to.deep.equal(new Set(['ws://a:9933']));
	});

	it('flags the node if any one of its database entries is wedged', () => {
		const w = makeWorker();
		const map = makeConnectionMap([
			[
				'ws://a:9933',
				[
					['data', entry(w, { connected: true, disconnectedAt: undefined })],
					['system', entry(w)],
				],
			],
		]);
		expect(findWedgedNodeUrls(map, [w], NOW, THRESHOLD)).to.deep.equal(new Set(['ws://a:9933']));
	});

	it('returns empty when no live workers exist', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['ws://a:9933', [['data', entry(w)]]]]);
		expect(findWedgedNodeUrls(map, [], NOW, THRESHOLD)).to.deep.equal(new Set());
	});
});
