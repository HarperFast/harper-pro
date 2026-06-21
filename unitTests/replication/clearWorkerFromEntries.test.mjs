/**
 * Coverage for `clearWorkerFromEntries` — the pure helper behind the one-exit-handler-per-worker fix
 * (harper-pro#357). When a worker thread dies, its single 'exit' handler clears that worker from every
 * subscription entry it owned (setting worker → undefined) so `findStaleNodeUrls` re-binds those entries
 * on a live worker. This replaces the old per-(db,node) `worker.on('exit')` registration that accumulated
 * D×P listeners on the shared worker objects and tripped MaxListenersExceededWarning past ~10 databases.
 */

import { expect } from 'chai';
import { clearWorkerFromEntries } from '#src/replication/subscriptionManager';

// Build a connectionReplicationMap: Map<url, Map<database, entry>> with the given worker per (url, db).
function makeMap(spec) {
	const map = new Map();
	for (const [url, dbs] of Object.entries(spec)) {
		const dbMap = new Map();
		for (const [db, worker] of Object.entries(dbs)) {
			dbMap.set(db, { worker, nodes: [{ name: url }] });
		}
		map.set(url, dbMap);
	}
	return map;
}

describe('clearWorkerFromEntries', () => {
	it('clears the dead worker from every entry it owned (across urls/dbs) and returns true', () => {
		const w1 = { id: 1 };
		const w2 = { id: 2 };
		const map = makeMap({ 'wss://a': { data: w1, system: w2 }, 'wss://b': { data: w1 } });

		const owned = clearWorkerFromEntries(map, w1);

		expect(owned).to.equal(true);
		expect(map.get('wss://a').get('data').worker).to.equal(undefined);
		expect(map.get('wss://b').get('data').worker).to.equal(undefined);
		// an entry owned by a different worker is left untouched
		expect(map.get('wss://a').get('system').worker).to.equal(w2);
	});

	it('returns false and changes nothing when the worker owns no entries', () => {
		const w1 = { id: 1 };
		const other = { id: 9 };
		const map = makeMap({ 'wss://a': { data: w1 } });

		expect(clearWorkerFromEntries(map, other)).to.equal(false);
		expect(map.get('wss://a').get('data').worker).to.equal(w1);
	});

	it('handles an empty map', () => {
		expect(clearWorkerFromEntries(new Map(), { id: 1 })).to.equal(false);
	});
});
