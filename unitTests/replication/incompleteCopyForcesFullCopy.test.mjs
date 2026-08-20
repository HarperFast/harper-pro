/**
 * A base copy killed mid-stream can leave `{seq > 1, no copyCursor}` on disk: mid-copy sequence
 * updates persist (and core stores `Math.max(existing, localTime)`, so they cannot be walked back)
 * while the copy cursor is still absent — for the first flush interval/byte budget of a copy, for a
 * whole copy whose `copyFromNodeId` never resolved, or after a malformed one is discarded. Read as
 * an incremental resume, that state permanently skips every un-copied row (harper-pro#658).
 * `incompleteCopyForcesFullCopy` is the read-side guard: a surviving `copyIncomplete` marker means
 * the seq cursor is not a baseline we hold, so the subscription must request a full copy instead.
 */

import { expect } from 'chai';
import { incompleteCopyForcesFullCopy } from '#src/replication/replicationConnection';

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

	it('tolerates a missing dbisDB', () => {
		expect(incompleteCopyForcesFullCopy(undefined, 1785944669174, undefined, 'node-a')).to.equal(false);
	});
});
