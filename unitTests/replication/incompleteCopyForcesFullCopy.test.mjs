/**
 * An interrupted base copy can leave `{seq > 1, no copyCursor}` on disk, which read as an incremental
 * resume permanently skips every un-copied row (harper-pro#658). These are the pieces that stop that:
 * the marker scan (fail-closed on an unreadable store), the peer-vs-database matching a marker needs
 * once its peer has left the subscription, the resume veto itself, and the write/clear helpers.
 */

import { expect } from 'chai';
import {
	incompleteCopyForcesFullCopy,
	incompleteCopyMarkerApplies,
	readIncompleteCopyMarkers,
	writeCopyIncompleteMarker,
	clearCopyIncompleteMarkers,
} from '#src/replication/replicationConnection';

const COPY_INCOMPLETE_SYMBOL = Symbol.for('copyIncomplete');

function markers(peers, unknown = false) {
	return { peers: new Set(peers), unknown };
}

describe('incompleteCopyForcesFullCopy', () => {
	const cursor = { copyStartTime: 1785944669000, currentTable: 'dog', afterKey: 'k-42' };

	it('forces a full copy for a marked source with no resumable cursor', () => {
		expect(incompleteCopyForcesFullCopy(undefined, 1785944669174, true)).to.equal(true);
	});

	it('does not force one when no marker applies (a copy that finished, or never ran)', () => {
		expect(incompleteCopyForcesFullCopy(undefined, 1785944669174, false)).to.equal(false);
	});

	it('prefers a usable copy cursor: a resumable copy is not restarted from scratch', () => {
		expect(incompleteCopyForcesFullCopy(cursor, 1785944669174, true)).to.equal(false);
	});

	it('leaves a subscription that is already requesting a full copy alone', () => {
		expect(incompleteCopyForcesFullCopy(undefined, 0, true)).to.equal(false);
		expect(incompleteCopyForcesFullCopy(undefined, 1, true)).to.equal(false);
	});
});

describe('readIncompleteCopyMarkers', () => {
	function makeDb(keys, throwing) {
		const ranges = [];
		return {
			ranges,
			getRange(options) {
				ranges.push(options);
				if (throwing) throw throwing;
				return keys.map((key) => ({ key }));
			},
		};
	}

	it('collects the peer names of every marker in one scan of the marker keyspace', () => {
		const db = makeDb([
			[COPY_INCOMPLETE_SYMBOL, 'node-a'],
			[COPY_INCOMPLETE_SYMBOL, 'node-b'],
		]);
		const result = readIncompleteCopyMarkers(db);
		expect([...result.peers]).to.deep.equal(['node-a', 'node-b']);
		expect(result.unknown).to.equal(false);
		expect(db.ranges).to.have.lengthOf(1);
		expect(db.ranges[0].start).to.equal(COPY_INCOMPLETE_SYMBOL);
		expect(db.ranges[0].values).to.equal(false);
	});

	it('reports no markers for an empty keyspace', () => {
		const result = readIncompleteCopyMarkers(makeDb([]));
		expect(result.peers.size).to.equal(0);
		expect(result.unknown).to.equal(false);
	});

	it('reads no store as no markers, so an add_node start_time cutoff is not overridden', () => {
		expect(readIncompleteCopyMarkers(undefined)).to.deep.equal({ peers: new Set(), unknown: false });
	});

	it('fails closed on a store it cannot scan, and reports the error instead of throwing', () => {
		const warned = [];
		const result = readIncompleteCopyMarkers(makeDb([], new Error('poison entry')), (error) => warned.push(error));
		expect(result.unknown).to.equal(true);
		expect(warned).to.have.lengthOf(1);
	});
});

describe('incompleteCopyMarkerApplies', () => {
	const inCluster = (members) => (peer) => members.includes(peer);

	it('applies to the peer the interrupted copy came from', () => {
		expect(incompleteCopyMarkerApplies(markers(['node-a']), 'node-a', inCluster(['node-a', 'node-b']))).to.equal(true);
	});

	it('does not apply to another peer while the marked one is still a cluster member', () => {
		expect(incompleteCopyMarkerApplies(markers(['node-a']), 'node-b', inCluster(['node-a', 'node-b']))).to.equal(false);
	});

	it('falls to the remaining sources once the marked peer has left the cluster', () => {
		expect(incompleteCopyMarkerApplies(markers(['gone-leader']), 'node-b', inCluster(['node-b', 'node-c']))).to.equal(
			true
		);
	});

	it('applies to nothing when there are no markers', () => {
		expect(incompleteCopyMarkerApplies(markers([]), 'node-a', inCluster(['node-a']))).to.equal(false);
	});

	it('applies everywhere when the marker state could not be scanned', () => {
		expect(incompleteCopyMarkerApplies(markers([], true), 'node-a', inCluster(['node-a']))).to.equal(true);
		expect(incompleteCopyMarkerApplies(markers([], true), undefined, inCluster([]))).to.equal(true);
	});
});

describe('copyIncomplete marker write/clear', () => {
	function makeStore({ sync, markers = [] }) {
		const calls = [];
		const store = {
			calls,
			getRange() {
				return markers.map((peer) => ({ key: [COPY_INCOMPLETE_SYMBOL, peer] }));
			},
			put(key, value) {
				calls.push(['put', key, value]);
				return Promise.resolve(true);
			},
			remove(key) {
				calls.push(['remove', key]);
				return Promise.resolve(true);
			},
		};
		if (sync) {
			store.putSync = (key, value) => {
				calls.push(['putSync', key, value]);
				return true;
			};
			store.removeSync = (key) => {
				calls.push(['removeSync', key]);
				return true;
			};
		}
		return store;
	}

	it('prefers the synchronous mutator, so a failure surfaces as a throw the caller can act on', () => {
		const store = makeStore({ sync: true, markers: ['node-a'] });
		writeCopyIncompleteMarker(store, 'node-a', { copyStartTime: 1785944669000 });
		clearCopyIncompleteMarkers(store, 'node-a', () => true);
		expect(store.calls).to.deep.equal([
			['putSync', [COPY_INCOMPLETE_SYMBOL, 'node-a'], { copyStartTime: 1785944669000 }],
			['removeSync', [COPY_INCOMPLETE_SYMBOL, 'node-a']],
		]);
	});

	it('falls back to the queueing mutator on a store without one', () => {
		const store = makeStore({ sync: false, markers: ['node-a'] });
		expect(typeof writeCopyIncompleteMarker(store, 'node-a', { copyStartTime: 1 }).then).to.equal('function');
		clearCopyIncompleteMarkers(store, 'node-a', () => true);
		expect(store.calls.map(([op]) => op)).to.deep.equal(['put', 'remove']);
	});

	it('sweeps markers whose peer has left the cluster, so nothing is left to re-fire the veto', () => {
		const store = makeStore({ sync: true, markers: ['gone-leader', 'node-a', 'node-b'] });
		const retired = clearCopyIncompleteMarkers(store, 'node-a', (peer) => ['node-a', 'node-b'].includes(peer));
		expect(retired.sort()).to.deep.equal(['gone-leader', 'node-a']);
		expect(store.calls).to.deep.equal([
			['removeSync', [COPY_INCOMPLETE_SYMBOL, 'gone-leader']],
			['removeSync', [COPY_INCOMPLETE_SYMBOL, 'node-a']],
		]);
	});

	it('leaves a live peer’s marker alone: its copy is still the one that has to finish', () => {
		const store = makeStore({ sync: true, markers: ['node-c'] });
		expect(clearCopyIncompleteMarkers(store, 'node-b', (peer) => ['node-b', 'node-c'].includes(peer))).to.deep.equal([
			'node-b',
		]);
		expect(store.calls).to.deep.equal([['removeSync', [COPY_INCOMPLETE_SYMBOL, 'node-b']]]);
	});

	it('still clears this peer when its own marker never made it to disk', () => {
		const store = makeStore({ sync: true, markers: [] });
		expect(clearCopyIncompleteMarkers(store, 'node-a', () => true)).to.deep.equal(['node-a']);
	});

	it('keeps sweeping after a store throw, so no marker is left behind', () => {
		const warned = [];
		const store = makeStore({ sync: true, markers: ['gone-1', 'gone-2'] });
		store.removeSync = (key) => {
			store.calls.push(['removeSync', key]);
			if (key[1] === 'gone-1') throw new Error('read-only txn');
			return true;
		};
		const retired = clearCopyIncompleteMarkers(
			store,
			undefined,
			() => false,
			(error) => warned.push(error)
		);
		expect(retired).to.deep.equal(['gone-1', 'gone-2']);
		expect(store.calls.map(([, key]) => key[1])).to.deep.equal(['gone-1', 'gone-2']);
		expect(warned).to.have.lengthOf(1);
	});

	it('clears nothing without a store', () => {
		expect(clearCopyIncompleteMarkers(undefined, 'node-a', () => true)).to.deep.equal([]);
	});
});
