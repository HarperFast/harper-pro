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
	clearCopyIncompleteMarker,
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
				return keys.map((key) => ({ key, value: { copyStartTime: 1 } }));
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
	});

	it('reports no markers for an empty keyspace', () => {
		const result = readIncompleteCopyMarkers(makeDb([]));
		expect(result.peers.size).to.equal(0);
		expect(result.unknown).to.equal(false);
	});

	it('fails closed when there is no store to read', () => {
		expect(readIncompleteCopyMarkers(undefined)).to.deep.equal({ peers: new Set(), unknown: true });
	});

	it('fails closed on a closed database rather than reading absence into it', () => {
		const result = readIncompleteCopyMarkers(makeDb([], new Error('Can not read from a closed database')));
		expect(result.unknown).to.equal(true);
	});

	it('propagates an unexpected store error instead of masking it', () => {
		expect(() => readIncompleteCopyMarkers(makeDb([], new Error('disk on fire')))).to.throw('disk on fire');
	});
});

describe('incompleteCopyMarkerApplies', () => {
	it('applies to the peer the interrupted copy came from', () => {
		expect(incompleteCopyMarkerApplies(markers(['node-a']), 'node-a', ['node-a', 'node-b'])).to.equal(true);
	});

	it('does not apply to an unrelated peer while the marked one is still subscribed', () => {
		expect(incompleteCopyMarkerApplies(markers(['node-a']), 'node-b', ['node-a', 'node-b'])).to.equal(false);
	});

	it('falls to the remaining sources once the marked peer has left the subscription', () => {
		expect(incompleteCopyMarkerApplies(markers(['gone-leader']), 'node-b', ['node-b', 'node-c'])).to.equal(true);
	});

	it('applies to nothing when there are no markers', () => {
		expect(incompleteCopyMarkerApplies(markers([]), 'node-a', ['node-a'])).to.equal(false);
	});

	it('applies everywhere when the marker state could not be read', () => {
		expect(incompleteCopyMarkerApplies(markers([], true), 'node-a', ['node-a'])).to.equal(true);
		expect(incompleteCopyMarkerApplies(markers([], true), undefined, [])).to.equal(true);
	});
});

describe('copyIncomplete marker write/clear', () => {
	function makeStore({ sync }) {
		const calls = [];
		const store = {
			calls,
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

	it('prefers the synchronous mutators, so a failure surfaces as a throw the caller can act on', () => {
		const store = makeStore({ sync: true });
		writeCopyIncompleteMarker(store, 'node-a', { copyStartTime: 1785944669000 });
		clearCopyIncompleteMarker(store, 'node-a');
		expect(store.calls).to.deep.equal([
			['putSync', [COPY_INCOMPLETE_SYMBOL, 'node-a'], { copyStartTime: 1785944669000 }],
			['removeSync', [COPY_INCOMPLETE_SYMBOL, 'node-a']],
		]);
	});

	it('falls back to the queueing mutators and hands their promise back for the caller to route', () => {
		const store = makeStore({ sync: false });
		expect(typeof writeCopyIncompleteMarker(store, 'node-a', { copyStartTime: 1 }).then).to.equal('function');
		expect(typeof clearCopyIncompleteMarker(store, 'node-a').then).to.equal('function');
		expect(store.calls.map(([op]) => op)).to.deep.equal(['put', 'remove']);
	});

	it('clears nothing when there is no store or no node name to key by', () => {
		const store = makeStore({ sync: true });
		expect(clearCopyIncompleteMarker(undefined, 'node-a')).to.equal(undefined);
		expect(clearCopyIncompleteMarker(store, undefined)).to.equal(undefined);
		expect(store.calls).to.deep.equal([]);
	});
});
