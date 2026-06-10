/**
 * On reconnect the follower reads a persisted copy-resume cursor and forwards `currentTable` +
 * `afterKey` to the leader so the bulk copy can resume mid-stream. If `currentTable` is missing or
 * nullish (harper-pro#321), the leader's resume check falls into the warn-and-recopy branch on
 * every reconnect — the cluster never converges because COPY_COMPLETE (which clears the cursor)
 * never arrives while the loop is active. `discardMalformedCopyCursor` is the read-side guard:
 * detect the bad cursor, remove it from disk, and return `undefined` so the next subscription
 * request goes out as a clean full-copy request. Well-formed cursors are returned unchanged.
 */

import { expect } from 'chai';
import { discardMalformedCopyCursor } from '#src/replication/replicationConnection';

const COPY_CURSOR_SYMBOL = Symbol.for('copyCursor');

function makeDb() {
	const calls = [];
	return {
		calls,
		remove(key) {
			calls.push(['remove', key]);
		},
	};
}

describe('discardMalformedCopyCursor', () => {
	it('returns undefined unchanged (no cursor on disk)', () => {
		const db = makeDb();
		let warned = false;
		const out = discardMalformedCopyCursor(undefined, db, 7, () => {
			warned = true;
		});
		expect(out).to.equal(undefined);
		expect(db.calls).to.deep.equal([]);
		expect(warned).to.equal(false);
	});

	it('passes a well-formed cursor through unchanged', () => {
		const db = makeDb();
		const cursor = { copyStartTime: 1000, currentTable: 'hdb_user', afterKey: 'k-42' };
		let warned = false;
		const out = discardMalformedCopyCursor(cursor, db, 7, () => {
			warned = true;
		});
		expect(out).to.equal(cursor);
		expect(db.calls).to.deep.equal([]);
		expect(warned).to.equal(false);
	});

	it('discards a cursor with undefined currentTable: warns, removes by [Symbol, nodeId], returns undefined', () => {
		const db = makeDb();
		const cursor = { copyStartTime: 1000, currentTable: undefined, afterKey: 'k-42' };
		let warned = false;
		const out = discardMalformedCopyCursor(cursor, db, 7, () => {
			warned = true;
		});
		expect(out).to.equal(undefined);
		expect(warned).to.equal(true);
		expect(db.calls).to.have.lengthOf(1);
		const [op, key] = db.calls[0];
		expect(op).to.equal('remove');
		expect(key).to.have.lengthOf(2);
		expect(key[0]).to.equal(COPY_CURSOR_SYMBOL);
		expect(key[1]).to.equal(7);
	});

	it('discards a cursor with empty-string currentTable (falsy check, not strict undefined)', () => {
		const db = makeDb();
		const cursor = { copyStartTime: 1000, currentTable: '', afterKey: 'k-42' };
		const out = discardMalformedCopyCursor(cursor, db, 7, () => {});
		expect(out).to.equal(undefined);
		expect(db.calls).to.deep.equal([['remove', [COPY_CURSOR_SYMBOL, 7]]]);
	});

	it('still warns when nodeId is undefined but skips the remove (cannot key the entry)', () => {
		const db = makeDb();
		const cursor = { copyStartTime: 1000, currentTable: undefined, afterKey: 'k-42' };
		let warned = false;
		const out = discardMalformedCopyCursor(cursor, db, undefined, () => {
			warned = true;
		});
		expect(out).to.equal(undefined);
		expect(warned).to.equal(true);
		expect(db.calls).to.deep.equal([]);
	});

	it('tolerates a missing dbisDB (optional-chained remove is a no-op)', () => {
		const cursor = { copyStartTime: 1000, currentTable: undefined, afterKey: 'k-42' };
		let warned = false;
		const out = discardMalformedCopyCursor(cursor, undefined, 7, () => {
			warned = true;
		});
		expect(out).to.equal(undefined);
		expect(warned).to.equal(true);
	});

	it('tolerates an absent warn callback', () => {
		const db = makeDb();
		const cursor = { copyStartTime: 1000, currentTable: undefined, afterKey: 'k-42' };
		const out = discardMalformedCopyCursor(cursor, db, 7);
		expect(out).to.equal(undefined);
		expect(db.calls).to.deep.equal([['remove', [COPY_CURSOR_SYMBOL, 7]]]);
	});
});
