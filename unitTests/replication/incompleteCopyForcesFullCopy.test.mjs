/**
 * An interrupted base copy can leave `{seq > 1, no copyCursor}` on disk, which read as an incremental
 * resume permanently skips every un-copied row (harper-pro#658). `incompleteCopyForcesFullCopy` is
 * the read-side guard on that state, and the marker helpers are the write side: both must fail
 * closed, and both must reach for the store's synchronous mutator (see their docblocks).
 */

import { expect } from 'chai';
import {
	incompleteCopyForcesFullCopy,
	writeCopyIncompleteMarker,
	clearCopyIncompleteMarker,
} from '#src/replication/replicationConnection';

const COPY_INCOMPLETE_SYMBOL = Symbol.for('copyIncomplete');

function makeDb(entries = []) {
	const reads = [];
	return {
		reads,
		getSync(key) {
			reads.push(key);
			const [symbol, id] = key;
			const found = entries.find((entry) => entry.symbol === symbol && entry.id === id);
			return found?.value;
		},
	};
}

function markerFor(nodeName, copyStartTime = 1785944669000) {
	return { symbol: COPY_INCOMPLETE_SYMBOL, id: nodeName, value: { copyStartTime } };
}

describe('incompleteCopyForcesFullCopy', () => {
	it('forces a full copy when a marker survives an interrupted copy with no cursor', () => {
		const db = makeDb([markerFor('node-a')]);
		expect(incompleteCopyForcesFullCopy(undefined, 1785944669174, db, 'node-a')).to.equal(true);
		expect(db.reads).to.deep.equal([[COPY_INCOMPLETE_SYMBOL, 'node-a']]);
	});

	it('does not force a full copy when no marker is on disk (a copy that finished, or never ran)', () => {
		const db = makeDb();
		expect(incompleteCopyForcesFullCopy(undefined, 1785944669174, db, 'node-a')).to.equal(false);
	});

	it('is keyed by node name, so another node’s interrupted copy does not force this one to re-copy', () => {
		const db = makeDb([markerFor('node-b')]);
		expect(incompleteCopyForcesFullCopy(undefined, 1785944669174, db, 'node-a')).to.equal(false);
	});

	it('prefers a usable copy cursor: a resumable copy is not restarted from scratch', () => {
		const db = makeDb([markerFor('node-a')]);
		const copyCursor = { copyStartTime: 1785944669000, currentTable: 'dog', afterKey: 'k-42' };
		expect(incompleteCopyForcesFullCopy(copyCursor, 1785944669174, db, 'node-a')).to.equal(false);
		expect(db.reads).to.deep.equal([]);
	});

	it('skips the store read when the subscription is already requesting a full copy', () => {
		const db = makeDb([markerFor('node-a')]);
		expect(incompleteCopyForcesFullCopy(undefined, 0, db, 'node-a')).to.equal(false);
		expect(incompleteCopyForcesFullCopy(undefined, 1, db, 'node-a')).to.equal(false);
		expect(db.reads).to.deep.equal([]);
	});

	it('skips the store read when there is no node name to key by', () => {
		const db = makeDb([markerFor('node-a')]);
		expect(incompleteCopyForcesFullCopy(undefined, 1785944669174, db, undefined)).to.equal(false);
		expect(incompleteCopyForcesFullCopy(undefined, 1785944669174, db, '')).to.equal(false);
		expect(db.reads).to.deep.equal([]);
	});

	it('fails closed when there is no store to rule the marker out', () => {
		expect(incompleteCopyForcesFullCopy(undefined, 1785944669174, undefined, 'node-a')).to.equal(true);
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
		const written = writeCopyIncompleteMarker(store, 'node-a', { copyStartTime: 1 });
		const cleared = clearCopyIncompleteMarker(store, 'node-a');
		expect(typeof written.then).to.equal('function');
		expect(typeof cleared.then).to.equal('function');
		expect(store.calls.map(([op]) => op)).to.deep.equal(['put', 'remove']);
	});

	it('clears nothing when there is no store or no node name to key by', () => {
		const store = makeStore({ sync: true });
		expect(clearCopyIncompleteMarker(undefined, 'node-a')).to.equal(undefined);
		expect(clearCopyIncompleteMarker(store, undefined)).to.equal(undefined);
		expect(store.calls).to.deep.equal([]);
	});
});
