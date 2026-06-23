/**
 * Coverage for the connected:true / Receiving / no-progress stall detection used by subscriptionManager's
 * periodic reconcile as a defense-in-depth net behind the worker-local copy-progress watchdog
 * (harper-pro#454 / #453). findWedgedNodeUrls only catches connected:false entries; a base copy that parks
 * connected:true with the received-version watermark frozen — while keepalive pings keep the byte-level
 * receive watchdog alive — is invisible to it. findStalledReceivingNodeUrls flags such an entry only when
 * its apply watermark (RECEIVED_TIME, surfaced here via the injected getReceiveStatus) has not advanced for
 * the whole threshold, so a healthy slow-but-progressing copy (which keeps bumping RECEIVED_TIME) is never
 * torn down. See harper-pro#420/#424/#289 (connected:false family) and #460.
 */

import { expect } from 'chai';
import { findStalledReceivingNodeUrls, isReceiveStalled } from '#src/replication/subscriptionManager';

// RECEIVING_STATUS_RECEIVING from replicationConnection.ts; pinned here so the test fails loudly if the
// shared-buffer encoding ever changes out from under the reconcile.
const RECEIVING = 1;
const WAITING = 0;

const THRESHOLD = 15 * 60_000;
const NOW = 1_000_000_000;

const isDesired = (node) => node?.replicates === true || (node?.subscriptions?.length ?? 0) > 0;

function makeWorker(name = 'http') {
	return { name };
}

// entry defaults to a desired, connected:true, live-worker entry; override fields per test.
function entry(worker, overrides = {}) {
	return {
		worker,
		connected: true,
		nodes: [{ name: 'peer', url: 'wss://peer:9933', replicates: true }],
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

// Build a getReceiveStatus reader from a {`${db}|${node}`: status} table. A stalled copy is Receiving with
// a frozen RECEIVED_TIME; a progressing copy keeps a recent RECEIVED_TIME; an absent entry returns undefined
// (no audit store / never connected), which must never be treated as stalled.
function reader(table) {
	return (database, nodeName) => table[`${database}|${nodeName}`];
}

const stalled = { status: RECEIVING, lastReceivedTime: NOW - THRESHOLD, version: 0 };
const progressing = { status: RECEIVING, lastReceivedTime: NOW - 1_000, version: 0 };
const waiting = { status: WAITING, lastReceivedTime: NOW - THRESHOLD, version: 0 };

describe('isReceiveStalled', () => {
	it('is true for a Receiving status frozen past the threshold', () => {
		expect(isReceiveStalled(stalled, NOW, THRESHOLD)).to.equal(true);
	});
	it('is false for a Receiving status that advanced recently (progressing copy)', () => {
		expect(isReceiveStalled(progressing, NOW, THRESHOLD)).to.equal(false);
	});
	it('is false when not Receiving (Waiting/idle) even if frozen past the threshold', () => {
		expect(isReceiveStalled(waiting, NOW, THRESHOLD)).to.equal(false);
	});
	it('is false when lastReceivedTime is 0 (never received anything)', () => {
		expect(isReceiveStalled({ status: RECEIVING, lastReceivedTime: 0, version: 0 }, NOW, THRESHOLD)).to.equal(false);
	});
	it('is false for a missing status entry', () => {
		expect(isReceiveStalled(undefined, NOW, THRESHOLD)).to.equal(false);
	});
});

describe('findStalledReceivingNodeUrls', () => {
	it('flags a connected:true Receiving entry frozen past the threshold', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['wss://peer:9933', [['data', entry(w)]]]]);
		const result = findStalledReceivingNodeUrls(map, [w], NOW, THRESHOLD, isDesired, reader({ 'data|peer': stalled }));
		expect(result).to.deep.equal(new Map([['wss://peer:9933', new Set(['data'])]]));
	});

	it('does not flag a copy that is still progressing (RECEIVED_TIME advancing)', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['wss://peer:9933', [['data', entry(w)]]]]);
		const result = findStalledReceivingNodeUrls(
			map,
			[w],
			NOW,
			THRESHOLD,
			isDesired,
			reader({ 'data|peer': progressing })
		);
		expect(result).to.deep.equal(new Map());
	});

	it('does not flag an idle (Waiting) connection even if its watermark is old', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['wss://peer:9933', [['data', entry(w)]]]]);
		const result = findStalledReceivingNodeUrls(map, [w], NOW, THRESHOLD, isDesired, reader({ 'data|peer': waiting }));
		expect(result).to.deep.equal(new Map());
	});

	it('does not flag a connected:false entry (that is the findWedgedNodeUrls path)', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['wss://peer:9933', [['data', entry(w, { connected: false })]]]]);
		const result = findStalledReceivingNodeUrls(map, [w], NOW, THRESHOLD, isDesired, reader({ 'data|peer': stalled }));
		expect(result).to.deep.equal(new Map());
	});

	it('does not flag an entry whose worker is no longer in the pool (stale path handles that)', () => {
		const live = makeWorker();
		const dead = makeWorker();
		const map = makeConnectionMap([['wss://peer:9933', [['data', entry(dead)]]]]);
		const result = findStalledReceivingNodeUrls(
			map,
			[live],
			NOW,
			THRESHOLD,
			isDesired,
			reader({ 'data|peer': stalled })
		);
		expect(result).to.deep.equal(new Map());
	});

	it('does not flag a non-replicating (undesired) node', () => {
		const w = makeWorker();
		const map = makeConnectionMap([
			['wss://peer:9933', [['data', entry(w, { nodes: [{ name: 'peer', replicates: false }] })]]],
		]);
		const result = findStalledReceivingNodeUrls(map, [w], NOW, THRESHOLD, isDesired, reader({ 'data|peer': stalled }));
		expect(result).to.deep.equal(new Map());
	});

	it('does not flag when no shared status is available (no audit store / never connected)', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['wss://peer:9933', [['data', entry(w)]]]]);
		const result = findStalledReceivingNodeUrls(map, [w], NOW, THRESHOLD, isDesired, reader({}));
		expect(result).to.deep.equal(new Map());
	});

	it('does not re-drive after a kick that produced no apply progress (caught-up/cosmetic Receiving)', () => {
		// Watermark frozen since before the last forced reconnect → the kick changed nothing; re-driving a
		// healthy-but-cosmetically-"Receiving" (or unrecoverable) connection every threshold is just churn.
		const w = makeWorker();
		const deeplyStalled = { status: RECEIVING, lastReceivedTime: NOW - 2 * THRESHOLD, version: 0 };
		const map = makeConnectionMap([
			['wss://peer:9933', [['data', entry(w, { receiveStallReconnectAt: NOW - THRESHOLD })]]],
		]);
		const result = findStalledReceivingNodeUrls(
			map,
			[w],
			NOW,
			THRESHOLD,
			isDesired,
			reader({ 'data|peer': deeplyStalled })
		);
		expect(result).to.deep.equal(new Map());
	});

	it('re-drives again once apply progress resumed after the last kick and then re-stalled', () => {
		// Watermark advanced past the last forced reconnect (the kick resumed the copy) and then froze again
		// for the whole threshold → a fresh, recoverable stall, so it is re-driven.
		const w = makeWorker();
		const map = makeConnectionMap([
			['wss://peer:9933', [['data', entry(w, { receiveStallReconnectAt: NOW - 2 * THRESHOLD })]]],
		]);
		const result = findStalledReceivingNodeUrls(map, [w], NOW, THRESHOLD, isDesired, reader({ 'data|peer': stalled }));
		expect(result).to.deep.equal(new Map([['wss://peer:9933', new Set(['data'])]]));
	});

	it('reports only the stalled databases when a node has a mix of stalled and progressing copies', () => {
		const w = makeWorker();
		const map = makeConnectionMap([
			[
				'wss://peer:9933',
				[
					['data', entry(w)],
					['analytics', entry(w)],
					['system', entry(w)],
				],
			],
		]);
		const result = findStalledReceivingNodeUrls(
			map,
			[w],
			NOW,
			THRESHOLD,
			isDesired,
			reader({
				'data|peer': stalled,
				'analytics|peer': progressing,
				'system|peer': stalled,
			})
		);
		expect(result).to.deep.equal(new Map([['wss://peer:9933', new Set(['data', 'system'])]]));
	});

	it('returns empty when no live workers exist', () => {
		const w = makeWorker();
		const map = makeConnectionMap([['wss://peer:9933', [['data', entry(w)]]]]);
		const result = findStalledReceivingNodeUrls(map, [], NOW, THRESHOLD, isDesired, reader({ 'data|peer': stalled }));
		expect(result).to.deep.equal(new Map());
	});
});
