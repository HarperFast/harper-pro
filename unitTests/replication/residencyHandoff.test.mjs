/**
 * The Pro half of a record-based residency transition (HarperFast/harper#2257): which row a base copy
 * or `GET_RECORD` may present as complete, when the origin may release core's retained image, and the
 * durable per-peer receipts that decide it. Core's side is reached only through the optional accessors
 * the fakes below stand in for.
 */
import { expect } from 'chai';
import { toBufferKey } from 'ordered-binary';
import {
	applyHandoffReceipt,
	chunkReceipts,
	clearHandoffReceipts,
	copyRowDisposition,
	decodeHandoffReceipts,
	fetchDisposition,
	handoffReceipts,
	handoffReleasable,
	imageMatchesRow,
	localRowSatisfies,
	MAX_RECEIPT_BATCH,
	RECEIPT_REQUEST_TTL_MS,
	peersOwedImage,
	receiptRequestKey,
	recordHandoffReceipt,
	settleReceiptRequests,
	transitionsOwedToPeer,
} from '#src/replication/residencyHandoff';

const INVALIDATED = 1;
const HAS_BLOBS = 0x2000;
const V1 = 1700000000000;
const V2 = V1 + 1000;

const complete = (version = V1) => ({ version, metadataFlags: 0, value: { id: 'r', name: 'kept' } });
const stub = (version = V1) => ({ version, metadataFlags: INVALIDATED, value: { home: 'B' } });
const residencyOf = (lists) => (id) => lists[id];

/**
 * In-memory stand-in for a database's `dbisDB`: array keys, ordered prefix ranges, encoded through the
 * same ordered-binary `toBufferKey` the real stores use — not JSON, which preserves array nesting and
 * would hide a compound (array) id flattening into its surrounding key (see the compound-id test below).
 */
function fakeDbisDB() {
	const rows = new Map();
	const keyOf = (key) => toBufferKey(key).toString('hex');
	return {
		rows,
		getSync(key) {
			return rows.get(keyOf(key))?.value;
		},
		async put(key, value) {
			rows.set(keyOf(key), { key, value });
		},
		async remove(key) {
			rows.delete(keyOf(key));
		},
		*getRange({ start, end }) {
			const from = toBufferKey(start);
			const to = end === undefined ? undefined : toBufferKey(end);
			for (const row of rows.values()) {
				const key = toBufferKey(row.key);
				if (Buffer.compare(key, from) < 0) continue;
				if (to !== undefined && Buffer.compare(key, to) >= 0) continue;
				yield row;
			}
		},
	};
}

/** A table whose core accessors are the companion contract; `retained` is its pending set. */
function fakeTable({ retained = [], entries = {}, dbisDB = fakeDbisDB() } = {}) {
	const released = [];
	return {
		tableId: 7,
		tableName: 'Homed',
		dbisDB,
		released,
		primaryStore: { getEntry: (id) => entries[id] },
		pendingTransitionEntries: () => retained.filter((entry) => !released.some((r) => r.id === entry.recordId)),
		pendingTransitionEntry: (id) =>
			retained.find((entry) => entry.recordId === id && !released.some((r) => r.id === id)),
		releaseTransitionEntry: (id, version) => {
			released.push({ id, version });
		},
	};
}

describe('residency handoff — row predicates', () => {
	it('a complete row satisfies a version at or below its own; a stub never does', () => {
		expect(localRowSatisfies(complete(V2), V1)).to.equal(true);
		expect(localRowSatisfies(complete(V1), V1)).to.equal(true);
		expect(localRowSatisfies(complete(V1), V2)).to.equal(false);
		expect(localRowSatisfies(stub(V2), V1)).to.equal(false);
		expect(localRowSatisfies(undefined, V1)).to.equal(false);
	});

	it('an image matches a row only at the row’s exact version', () => {
		expect(imageMatchesRow({ version: V1 }, stub(V1))).to.equal(true);
		expect(imageMatchesRow({ version: V1 }, stub(V2))).to.equal(false);
		expect(imageMatchesRow(undefined, stub(V1))).to.equal(false);
		expect(imageMatchesRow({ version: V1 }, undefined)).to.equal(false);
	});
});

describe('residency handoff — what a base copy may send', () => {
	it('sends a complete row as today, to anyone', () => {
		expect(copyRowDisposition(complete(), true, undefined)).to.equal('row');
		expect(copyRowDisposition(complete(), false, undefined)).to.equal('row');
	});

	it('still sends a stub to a non-resident peer (the send path turns it into an invalidate)', () => {
		expect(copyRowDisposition(stub(), false, undefined)).to.equal('row');
	});

	it('sends a resident peer the retained image at the stub’s version, or withholds the row', () => {
		expect(copyRowDisposition(stub(V1), true, { version: V1 })).to.equal('image');
		expect(copyRowDisposition(stub(V2), true, { version: V1 })).to.equal('skip');
		expect(copyRowDisposition(stub(V1), true, undefined)).to.equal('skip');
	});
});

describe('residency handoff — what GET_RECORD may answer', () => {
	const lists = { 3: ['B'], 4: ['C'] };

	it('answers a complete row as today and misses on nothing stored', () => {
		expect(fetchDisposition(complete(), undefined, 'B', residencyOf(lists))).to.equal('row');
		expect(fetchDisposition(undefined, { version: V1, residencyId: 3 }, 'B', residencyOf(lists))).to.equal('miss');
	});

	it('never answers with stub bytes', () => {
		expect(fetchDisposition(stub(), undefined, 'B', residencyOf(lists))).to.equal('miss');
	});

	it('answers a stub with the retained image only to a peer the transition’s residency names', () => {
		const image = { version: V1, residencyId: 3 };
		expect(fetchDisposition(stub(V1), image, 'B', residencyOf(lists))).to.equal('image');
		expect(fetchDisposition(stub(V1), image, 'C', residencyOf(lists))).to.equal('miss');
		expect(fetchDisposition(stub(V1), image, undefined, residencyOf(lists))).to.equal('miss');
		expect(fetchDisposition(stub(V2), image, 'B', residencyOf(lists))).to.equal('miss');
		expect(fetchDisposition(stub(V1), { version: V1, residencyId: 9 }, 'B', residencyOf(lists))).to.equal('miss');
	});
});

describe('residency handoff — release rule', () => {
	it('releases only when every other named resident has a receipt at or above the version', () => {
		const receipts = new Map([
			['B', V1],
			['C', V2],
		]);
		expect(handoffReleasable(['B', 'C'], 'A', receipts, V1)).to.equal(true);
		expect(handoffReleasable(['B', 'C', 'D'], 'A', receipts, V1)).to.equal(false);
		expect(handoffReleasable(['B'], 'A', receipts, V2)).to.equal(false);
	});

	it('ignores the origin itself and never releases when nobody else is named', () => {
		expect(handoffReleasable(['A', 'B'], 'A', new Map([['B', V1]]), V1)).to.equal(true);
		expect(handoffReleasable(['A'], 'A', new Map(), V1)).to.equal(false);
		expect(handoffReleasable([], 'A', new Map(), V1)).to.equal(false);
		expect(handoffReleasable(undefined, 'A', new Map(), V1)).to.equal(false);
	});

	it('lists the residents still owed the image', () => {
		expect(peersOwedImage(['A', 'B', 'C'], 'A', new Map([['B', V1]]), V1)).to.deep.equal(['C']);
		expect(peersOwedImage(['B'], 'A', new Map([['B', V1 - 1]]), V1)).to.deep.equal(['B']);
		expect(peersOwedImage(undefined, 'A', new Map(), V1)).to.deep.equal([]);
	});
});

describe('residency handoff — durable receipts', () => {
	it('records the highest receipt per peer and clears them per record', async () => {
		const dbisDB = fakeDbisDB();
		await recordHandoffReceipt(dbisDB, 7, 'r', 'B', V1);
		await recordHandoffReceipt(dbisDB, 7, 'r', 'B', V1 - 5);
		await recordHandoffReceipt(dbisDB, 7, 'r', 'C', V2);
		await recordHandoffReceipt(dbisDB, 7, 'other', 'B', V2);
		expect([...handoffReceipts(dbisDB, 7, 'r')]).to.deep.equal([
			['B', V1],
			['C', V2],
		]);
		await clearHandoffReceipts(dbisDB, 7, 'r');
		expect(handoffReceipts(dbisDB, 7, 'r').size).to.equal(0);
		expect(handoffReceipts(dbisDB, 7, 'other').get('B')).to.equal(V2);
	});

	it('keeps a compound-id record and a scalar-id record apart, short and long (harper-pro#940)', async () => {
		// A compound (array) id written raw as one element of this module's own
		// [marker, tableId, recordId, peerName] key would flatten into the same bytes as a shorter id
		// followed by a peer name (ordered-binary joins array elements with one separator at every
		// depth). hexIdKey closes this at any id length, including past ordered-binary's 64-character
		// short-string escaping threshold (the long-id case below).
		const dbisDB = fakeDbisDB();
		const long = 'x'.repeat(100);
		for (const [recordId, peerName, version] of [
			[[1, 'B'], 'C', V1],
			[1, 'B', V2],
			[[long, 'B'], 'C', V1],
			[long, 'B', V2],
		]) {
			await recordHandoffReceipt(dbisDB, 7, recordId, peerName, version);
		}
		expect([...handoffReceipts(dbisDB, 7, [1, 'B'])]).to.deep.equal([['C', V1]]);
		expect([...handoffReceipts(dbisDB, 7, 1)]).to.deep.equal([['B', V2]]);
		expect([...handoffReceipts(dbisDB, 7, [long, 'B'])]).to.deep.equal([['C', V1]]);
		expect([...handoffReceipts(dbisDB, 7, long)]).to.deep.equal([['B', V2]]);
		await clearHandoffReceipts(dbisDB, 7, [long, 'B']);
		expect(handoffReceipts(dbisDB, 7, [long, 'B']).size).to.equal(0);
		expect(handoffReceipts(dbisDB, 7, long).get('B')).to.equal(V2);
	});
});

describe('residency handoff — applying a peer’s receipt', () => {
	const lists = { 3: ['B', 'C'], 5: ['B'] };
	const retainedFor = (id, residencyId, version = V1) => ({ recordId: id, tableId: 7, version, residencyId });

	it('ignores a receipt for a record with nothing retained, and one older than the retained version', async () => {
		const table = fakeTable({ retained: [retainedFor('r', 5, V2)] });
		expect(await applyHandoffReceipt(table, 'B', { recordId: 'x', version: V2 }, 'A', residencyOf(lists))).to.equal(
			'ignored'
		);
		expect(await applyHandoffReceipt(table, 'B', { recordId: 'r', version: V1 }, 'A', residencyOf(lists))).to.equal(
			'ignored'
		);
		expect(table.released).to.deep.equal([]);
		expect(table.dbisDB.rows.size).to.equal(0);
	});

	it('records a receipt and releases once every named resident has one', async () => {
		const table = fakeTable({ retained: [retainedFor('r', 3)] });
		expect(await applyHandoffReceipt(table, 'B', { recordId: 'r', version: V1 }, 'A', residencyOf(lists))).to.equal(
			'recorded'
		);
		expect(table.released).to.deep.equal([]);
		expect(await applyHandoffReceipt(table, 'C', { recordId: 'r', version: V2 }, 'A', residencyOf(lists))).to.equal(
			'released'
		);
		expect(table.released).to.deep.equal([{ id: 'r', version: V1 }]);
		expect(table.dbisDB.rows.size).to.equal(0);
	});

	it('does not release on a receipt from a peer the residency does not name', async () => {
		const table = fakeTable({ retained: [retainedFor('r', 5)] });
		expect(await applyHandoffReceipt(table, 'C', { recordId: 'r', version: V1 }, 'A', residencyOf(lists))).to.equal(
			'recorded'
		);
		expect(table.released).to.deep.equal([]);
	});

	it('does nothing when the core lookup throws, so the image stays retained', async () => {
		const table = fakeTable({ retained: [retainedFor('r', 5)] });
		table.pendingTransitionEntry = () => {
			throw new Error('store closed');
		};
		let error;
		await applyHandoffReceipt(table, 'B', { recordId: 'r', version: V1 }, 'A', residencyOf(lists)).catch(
			(e) => (error = e)
		);
		expect(error?.message).to.equal('store closed');
		expect(table.released).to.deep.equal([]);
	});
});

describe('residency handoff — redelivery and local completion', () => {
	const lists = { 3: ['B', 'C'], 5: ['B'] };

	it('releases a retained entry whose row this node again holds complete at that version or newer', async () => {
		const table = fakeTable({
			retained: [{ recordId: 'back', tableId: 7, version: V1, residencyId: 5 }],
			entries: { back: complete(V2) },
		});
		const { owed } = await transitionsOwedToPeer(table, 'B', 'A', residencyOf(lists));
		expect(owed).to.deep.equal([]);
		expect(table.released).to.deep.equal([{ id: 'back', version: V1 }]);
	});

	it('awaits a getEntry that resolves asynchronously (a RocksDB cache miss), and treats a rejection as absent', async () => {
		const rejected = Promise.reject(new Error('closed'));
		rejected.catch(() => {}); // this fake constructs the rejection eagerly; resolveLocalEntry's own catch is under test
		const table = fakeTable({
			retained: [
				{ recordId: 'async', tableId: 7, version: V1, residencyId: 5 },
				{ recordId: 'rejects', tableId: 7, version: V1, residencyId: 5 },
			],
			entries: { async: Promise.resolve(complete(V2)), rejects: rejected },
		});
		const { owed } = await transitionsOwedToPeer(table, 'B', 'A', residencyOf(lists));
		expect(owed.map((entry) => entry.recordId)).to.deep.equal(['rejects']);
		expect(table.released).to.deep.equal([{ id: 'async', version: V1 }]);
	});

	it('keeps a retained entry whose local row is a stub at any version, or complete only at an older version', async () => {
		const table = fakeTable({
			retained: [
				{ recordId: 's', tableId: 7, version: V1, residencyId: 5 },
				{ recordId: 'newerStub', tableId: 7, version: V1, residencyId: 5 },
				{ recordId: 'old', tableId: 7, version: V2, residencyId: 5 },
			],
			entries: { s: stub(V1), newerStub: { ...stub(V2), residencyId: 5 }, old: complete(V1) },
		});
		const { owed } = await transitionsOwedToPeer(table, 'B', 'A', residencyOf(lists));
		expect(owed.map((entry) => entry.recordId)).to.deep.equal(['s', 'newerStub', 'old']);
		expect(table.released).to.deep.equal([]);
	});

	it('owes a peer exactly the retained entries that name it and lack its receipt', async () => {
		const table = fakeTable({
			retained: [
				{ recordId: 'owedB', tableId: 7, version: V1, residencyId: 3 },
				{ recordId: 'ackedB', tableId: 7, version: V1, residencyId: 3 },
				{ recordId: 'notB', tableId: 7, version: V1, residencyId: 9 },
				{ recordId: 'back', tableId: 7, version: V1, residencyId: 5 },
			],
			entries: { owedB: stub(), ackedB: stub(), notB: stub(), back: complete(V2) },
		});
		await recordHandoffReceipt(table.dbisDB, 7, 'ackedB', 'B', V1);
		const { owed, superseded } = await transitionsOwedToPeer(table, 'B', 'A', residencyOf({ ...lists, 9: ['C'] }));
		expect(owed.map((entry) => entry.recordId)).to.deep.equal(['owedB']);
		expect(superseded).to.equal(0);
		expect(table.released).to.deep.equal([{ id: 'back', version: V1 }]);
	});

	it('self-heals a release missed by a crash between the last receipt and applyHandoffReceipt completing', async () => {
		const table = fakeTable({
			retained: [{ recordId: 'crashedBeforeRelease', tableId: 7, version: V1, residencyId: 3 }],
			entries: { crashedBeforeRelease: stub() },
		});
		// both residents (B, C) already receipted -- as if applyHandoffReceipt recorded C's receipt (the
		// last one needed) and then crashed before reaching releaseTransitionEntry
		await recordHandoffReceipt(table.dbisDB, 7, 'crashedBeforeRelease', 'B', V1);
		await recordHandoffReceipt(table.dbisDB, 7, 'crashedBeforeRelease', 'C', V1);
		const { owed } = await transitionsOwedToPeer(table, 'B', 'A', residencyOf(lists));
		expect(owed).to.deep.equal([]);
		expect(table.released).to.deep.equal([{ id: 'crashedBeforeRelease', version: V1 }]);
	});

	it('reports a row-read failure through the callback and still yields an owed/superseded result', async () => {
		const table = fakeTable({
			retained: [{ recordId: 'unreadable', tableId: 7, version: V1, residencyId: 3 }],
			entries: {},
		});
		table.primaryStore.getEntry = () => {
			throw new Error('store closed');
		};
		const errors = [];
		const { owed } = await transitionsOwedToPeer(table, 'B', 'A', residencyOf(lists), (recordId, error) =>
			errors.push({ recordId, message: error.message })
		);
		expect(owed.map((entry) => entry.recordId)).to.deep.equal(['unreadable']);
		expect(errors).to.deep.equal([{ recordId: 'unreadable', message: 'store closed' }]);
	});

	it('keeps but stops owing an entry whose record moved on to a residency that no longer names the peer', async () => {
		const table = fakeTable({
			retained: [
				{ recordId: 'movedOn', tableId: 7, version: V1, residencyId: 5 },
				{ recordId: 'stillMine', tableId: 7, version: V1, residencyId: 5 },
			],
			entries: { movedOn: { ...stub(V2), residencyId: 4 }, stillMine: { ...stub(V2), residencyId: 5 } },
		});
		const { owed, superseded } = await transitionsOwedToPeer(table, 'B', 'A', residencyOf({ ...lists, 4: ['C'] }));
		expect(owed.map((entry) => entry.recordId)).to.deep.equal(['stillMine']);
		expect(superseded).to.equal(1);
		expect(table.released).to.deep.equal([]);
	});

	it('leaves an entry pinned (neither owed nor superseded) when the record moves to a peer the entry never named', async () => {
		// A handed the record to B; before B receipted, a patch moved it on to C, a peer the retained
		// entry never named. The image's content and version are still B's, so redelivering it under a
		// claim of C's residency would hand C stale fields under a false claim of completeness -- worse
		// than pinning. Requires core to reconcile an older image against a newer stub; deferred there.
		const table = fakeTable({
			retained: [{ recordId: 'movedToC', tableId: 7, version: V1, residencyId: 5 }],
			entries: { movedToC: { ...stub(V2), residencyId: 4 } },
		});
		const { owed, superseded } = await transitionsOwedToPeer(table, 'C', 'A', residencyOf({ ...lists, 4: ['C'] }));
		expect(owed).to.deep.equal([]);
		expect(superseded).to.equal(0);
		expect(table.released).to.deep.equal([]);
	});

	it('self-heals a crash-missed release even when the record has since moved to a residency naming neither peer', async () => {
		// both B and C (entry.residencyId 3's residents) already receipted v1, then the process crashed
		// before releasing; the record has since moved on to v2 under a residency (4: ['D']) that names
		// neither B nor C -- the superseded check alone would skip this row and leave it pinned forever
		const table = fakeTable({
			retained: [{ recordId: 'crashedThenMoved', tableId: 7, version: V1, residencyId: 3 }],
			entries: { crashedThenMoved: { ...stub(V2), residencyId: 4 } },
		});
		await recordHandoffReceipt(table.dbisDB, 7, 'crashedThenMoved', 'B', V1);
		await recordHandoffReceipt(table.dbisDB, 7, 'crashedThenMoved', 'C', V1);
		const { owed, superseded } = await transitionsOwedToPeer(table, 'B', 'A', residencyOf({ ...lists, 4: ['D'] }));
		expect(owed).to.deep.equal([]);
		expect(superseded).to.equal(0);
		expect(table.released).to.deep.equal([{ id: 'crashedThenMoved', version: V1 }]);
	});

	it('awaits an async local row when checking whether a record has moved on', async () => {
		const table = fakeTable({
			retained: [{ recordId: 'movedOn', tableId: 7, version: V1, residencyId: 5 }],
			entries: { movedOn: Promise.resolve({ ...stub(V2), residencyId: 4 }) },
		});
		const { owed, superseded } = await transitionsOwedToPeer(table, 'B', 'A', residencyOf({ ...lists, 4: ['C'] }));
		expect(owed).to.deep.equal([]);
		expect(superseded).to.equal(1);
	});

	it('owes nothing on a core without the retained-image index', async () => {
		const table = fakeTable();
		delete table.pendingTransitionEntries;
		expect(await transitionsOwedToPeer(table, 'B', 'A', residencyOf(lists))).to.deep.equal({ owed: [], superseded: 0 });
	});
});

describe('receiptRequestKey', () => {
	it('distinguishes compound ids that String() would collapse to the same string', () => {
		expect(receiptRequestKey(7, [1, 2])).to.not.equal(receiptRequestKey(7, ['1', 2]));
		expect(receiptRequestKey(7, [1, 2])).to.not.equal(receiptRequestKey(7, ['1,2']));
	});

	it('does not throw on a BigInt id, which bare JSON.stringify cannot serialize', () => {
		expect(() => receiptRequestKey(7, 10n)).to.not.throw();
		expect(receiptRequestKey(7, 10n)).to.not.equal(receiptRequestKey(7, 11n));
	});

	it('distinguishes a BigInt id from the identical-looking string, unlike an untagged conversion', () => {
		// String(10n) === '10' === String('10'), and a naive bigint->string tag ('10n') collides with the
		// literal string '10n' too -- writeKeyId (the storage engines' own key identity) does not.
		expect(receiptRequestKey(7, 10n)).to.not.equal(receiptRequestKey(7, '10n'));
		expect(receiptRequestKey(7, [10n])).to.not.equal(receiptRequestKey(7, ['10n']));
	});

	it('does not throw on a deeply nested id', () => {
		let deep = 1;
		for (let i = 0; i < 100; i++) deep = [deep];
		expect(() => receiptRequestKey(7, deep)).to.not.throw();
	});

	it('matches the storage engines’ own key identity, including where that aliases a scalar with its singleton array', () => {
		// writeKeyId is the SAME identity core's stores use (DatabaseTransaction.ts): 'r' and ['r'] are
		// the same stored key there, so treating them as the same receipt-request identity here is
		// correct, not a collision -- a hand-rolled per-type-tagged encoder that told them apart would be
		// answering a receipt for the wrong notion of "the same record".
		expect(receiptRequestKey(7, 'r')).to.equal(receiptRequestKey(7, ['r']));
	});
});

describe('residency handoff — answering receipt requests', () => {
	const NOW = 1_800_000_000_000;
	const request = (recordId, version, getEntry, expiresAt = NOW + RECEIPT_REQUEST_TTL_MS) => ({
		tableId: 7,
		recordId,
		version,
		getEntry,
		expiresAt,
	});
	const blobsOk = async () => true;
	const blobsMissing = async () => false;

	it('answers only requests whose row is complete at the requested version or newer, and keeps the rest', async () => {
		const entries = { done: complete(V2), pendingStub: stub(V1 - 1), older: complete(V1) };
		const getEntry = (id) => entries[id];
		const { receipts, settled, waiting } = await settleReceiptRequests(
			[
				request('done', V1, getEntry),
				request('pendingStub', V1, getEntry),
				request('older', V2, getEntry),
				request('missing', V1, getEntry),
			],
			blobsOk,
			NOW
		);
		expect(receipts).to.deep.equal([[7, 'done', V2]]);
		expect(settled.map((r) => r.recordId)).to.deep.equal(['done']);
		expect(waiting.map((r) => r.recordId)).to.deep.equal(['pendingStub', 'older', 'missing']);
	});

	it('does not answer for a blob-carrying row until every blob file is durably complete', async () => {
		const blobRow = { version: V2, metadataFlags: HAS_BLOBS, value: { id: 'b' } };
		const getEntry = () => blobRow;
		let result = await settleReceiptRequests([request('b', V1, getEntry)], blobsMissing, NOW);
		expect(result.receipts).to.deep.equal([]);
		expect(result.waiting.length).to.equal(1);
		result = await settleReceiptRequests(result.waiting, blobsOk, NOW);
		expect(result.receipts).to.deep.equal([[7, 'b', V2]]);
		result = await settleReceiptRequests(
			[request('b', V1, getEntry)],
			async () => {
				throw new Error('fs');
			},
			NOW
		);
		expect(result.receipts).to.deep.equal([]);
		expect(result.waiting.length).to.equal(1);
	});

	it('keeps waiting over a stub at any version: the image lets core resequence it into a complete row', async () => {
		const newer = await settleReceiptRequests([request('newer', V1, () => stub(V2))], blobsOk, NOW);
		expect(newer.settled).to.deep.equal([]);
		expect(newer.waiting.length).to.equal(1);
		const same = await settleReceiptRequests([request('same', V1, () => stub(V1))], blobsOk, NOW);
		expect(same.settled).to.deep.equal([]);
		expect(same.waiting.length).to.equal(1);
	});

	it('drops a request once it has expired', async () => {
		const pending = request('never', V1, () => undefined, NOW + 1000);
		let result = await settleReceiptRequests([pending], blobsOk, NOW + 999);
		expect(result.waiting.length).to.equal(1);
		result = await settleReceiptRequests([pending], blobsOk, NOW + 1000);
		expect(result.waiting).to.deep.equal([]);
		expect(result.settled).to.deep.equal([pending]);
	});

	it('treats a throwing lookup as not yet provable, and awaits a deferred one', async () => {
		const { receipts, waiting } = await settleReceiptRequests(
			[
				request('throws', V1, () => {
					throw new Error('closed');
				}),
				request('async', V1, () => Promise.resolve(complete(V1))),
				request('rejects', V1, () => Promise.reject(new Error('miss'))),
			],
			blobsOk,
			NOW
		);
		expect(receipts).to.deep.equal([[7, 'async', V1]]);
		expect(waiting.map((r) => r.recordId)).to.deep.equal(['throws', 'rejects']);
	});
});

describe('residency handoff — wire shape', () => {
	it('accepts a batch of [tableId, recordId, version] tuples', () => {
		expect(
			decodeHandoffReceipts([
				[7, 'r', V1],
				[8, 42, V2],
			])
		).to.deep.equal([
			[7, 'r', V1],
			[8, 42, V2],
		]);
		expect(decodeHandoffReceipts([])).to.deep.equal([]);
	});

	it('chunks outbound receipts at the inbound bound', () => {
		const items = Array.from({ length: MAX_RECEIPT_BATCH * 2 + 1 }, (_, i) => i);
		const chunks = chunkReceipts(items);
		expect(chunks.map((chunk) => chunk.length)).to.deep.equal([MAX_RECEIPT_BATCH, MAX_RECEIPT_BATCH, 1]);
		expect(chunks.flat()).to.deep.equal(items);
		expect(chunkReceipts([])).to.deep.equal([]);
	});

	it('drops a batch over the size bound whole', () => {
		const tuples = Array.from({ length: MAX_RECEIPT_BATCH + 1 }, (_, i) => [7, `r${i}`, V1]);
		expect(decodeHandoffReceipts(tuples)).to.equal(undefined);
		expect(decodeHandoffReceipts(tuples.slice(0, MAX_RECEIPT_BATCH)).length).to.equal(MAX_RECEIPT_BATCH);
	});

	it('drops a malformed batch whole', () => {
		expect(decodeHandoffReceipts(undefined)).to.equal(undefined);
		expect(decodeHandoffReceipts('x')).to.equal(undefined);
		expect(decodeHandoffReceipts([[7, 'r']])).to.equal(undefined);
		expect(decodeHandoffReceipts([[-1, 'r', V1]])).to.equal(undefined);
		expect(decodeHandoffReceipts([[7, null, V1]])).to.equal(undefined);
		expect(decodeHandoffReceipts([[7, 'r', 0]])).to.equal(undefined);
		expect(decodeHandoffReceipts([[7, 'r', 'v']])).to.equal(undefined);
	});

	it('accepts a flat compound id (core’s own Id contract) but rejects a nested one', () => {
		expect(decodeHandoffReceipts([[7, [1, 'r', null], V1]])).to.deep.equal([[7, [1, 'r', null], V1]]);
		expect(decodeHandoffReceipts([[7, 10n, V1]])).to.deep.equal([[7, 10n, V1]]);
		expect(decodeHandoffReceipts([[7, [1, [2]], V1]])).to.equal(undefined);
		expect(decodeHandoffReceipts([[7, { a: 1 }, V1]])).to.equal(undefined);
	});

	it('rejects an id whose ordered-binary encoding exceeds LMDB’s real key-size limit (core’s own bound), and a nonfinite numeric part', () => {
		// core's checkValidId (Table.ts) and keyTooLargeForStore (security/user.ts) use the same
		// 1978-byte ordered-binary limit for the size check; this filter is stricter on a few
		// pathological shapes (e.g. a top-level Infinity) than checkValidId's NaN-only number check.
		expect(decodeHandoffReceipts([[7, 'x'.repeat(100), V1]])).to.not.equal(undefined);
		expect(decodeHandoffReceipts([[7, 'x'.repeat(3000), V1]])).to.equal(undefined);
		expect(decodeHandoffReceipts([[7, Array(1000).fill(1), V1]])).to.equal(undefined);
		expect(decodeHandoffReceipts([[7, NaN, V1]])).to.equal(undefined);
		expect(decodeHandoffReceipts([[7, [Infinity], V1]])).to.equal(undefined);
	});
});
