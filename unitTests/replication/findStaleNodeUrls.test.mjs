/**
 * Regression coverage for the broken-chain detection used by subscriptionManager's
 * periodic reconcile pass. Before this fix, a subscription entry pinned to a worker
 * that had exited would never be reassigned — the per-database `worker.on('exit')`
 * handler could miss the transition (identity check failure, dropped setTimeout,
 * shouldSubscribe early-return), and there was no other code path that would
 * notice and recover. `findStaleNodeUrls` is the read-side check that drives the
 * reconcile, and these tests verify it identifies stale-only entries correctly.
 */

import { expect } from 'chai';
import { findStaleNodeUrls } from '#src/replication/subscriptionManager';

function makeWorker(name) {
	return { name };
}

function makeConnectionMap(entries) {
	// entries: Array<[url, Array<[databaseName, { worker }]>]>
	const map = new Map();
	for (const [url, dbEntries] of entries) {
		const dbMap = new Map();
		for (const [db, entry] of dbEntries) dbMap.set(db, entry);
		map.set(url, dbMap);
	}
	return map;
}

describe('findStaleNodeUrls', () => {
	it('returns an empty set when every entry references a live http worker', () => {
		const w1 = makeWorker('http');
		const w2 = makeWorker('http');
		const map = makeConnectionMap([
			['ws://a:9933', [['data', { worker: w1 }]]],
			[
				'ws://b:9933',
				[
					['data', { worker: w1 }],
					['system', { worker: w2 }],
				],
			],
		]);

		expect(findStaleNodeUrls(map, [w1, w2])).to.deep.equal(new Set());
	});

	it('flags a node whose entry points at a worker no longer in the pool', () => {
		const live = makeWorker('http');
		const dead = makeWorker('http'); // still named http but not in the live pool
		const map = makeConnectionMap([
			['ws://a:9933', [['data', { worker: live }]]],
			['ws://b:9933', [['data', { worker: dead }]]],
		]);

		expect(findStaleNodeUrls(map, [live])).to.deep.equal(new Set(['ws://b:9933']));
	});

	it('flags a node when any of its database entries is stale (one bad apple)', () => {
		const live = makeWorker('http');
		const dead = makeWorker('http');
		const map = makeConnectionMap([
			[
				'ws://b:9933',
				[
					['data', { worker: live }],
					['system', { worker: dead }],
				],
			],
		]);

		expect(findStaleNodeUrls(map, [live])).to.deep.equal(new Set(['ws://b:9933']));
	});

	it('flags entries with no worker assigned when live workers are available (workers came back after startup)', () => {
		// onDatabase stores `worker: undefined` if it ran during a window when no http
		// workers existed. Once workers come back, the reconcile must flag these so they
		// get rebound — otherwise the subscription is silently dead for the process life.
		const live = makeWorker('http');
		const map = makeConnectionMap([
			['ws://a:9933', [['data', { worker: undefined }]]],
			['ws://b:9933', [['data', { worker: live }]]],
		]);

		expect(findStaleNodeUrls(map, [live])).to.deep.equal(new Set(['ws://a:9933']));
	});

	it('returns empty when no live workers exist (no point reassigning to nothing)', () => {
		// Guard against endless no-op reassignment loops when the http pool is momentarily
		// empty (or during workerless unit-test scenarios).
		const map = makeConnectionMap([
			['ws://a:9933', [['data', { worker: undefined }]]],
			['ws://b:9933', [['data', { worker: makeWorker('http') /* dead — not in pool */ }]]],
		]);

		expect(findStaleNodeUrls(map, [])).to.deep.equal(new Set());
	});

	it('flags all stale node urls and ignores the live ones in a mixed map', () => {
		const live = makeWorker('http');
		const dead1 = makeWorker('http');
		const dead2 = makeWorker('http');
		const map = makeConnectionMap([
			['ws://a:9933', [['data', { worker: live }]]],
			['ws://b:9933', [['data', { worker: dead1 }]]],
			['ws://c:9933', [['data', { worker: dead2 }]]],
		]);

		expect(findStaleNodeUrls(map, [live])).to.deep.equal(new Set(['ws://b:9933', 'ws://c:9933']));
	});
});
