/** createOrphanedBlobReclaimer (harper-pro#659); the ordering argument is replication/DESIGN.md item 40. */
import { expect } from 'chai';
import { createOrphanedBlobReclaimer, ORPHANED_BLOB_RECORD_FRAMES } from '#src/replication/replicationConnection';

const makeStream = () => ({ connectedToBlob: false });

function settleFrames(reclaimer, blobsInFlight, count) {
	const released = [];
	for (let frame = 0; frame < count; frame++)
		reclaimer.recordFrameProcessed(blobsInFlight, (streamKey, stream) => released.push([streamKey, stream]));
	return released;
}

describe('createOrphanedBlobReclaimer (harper-pro#659)', () => {
	it('waits two record frames, so the frame carrying the record has fully settled', () => {
		expect(ORPHANED_BLOB_RECORD_FRAMES).to.equal(2);
		const reclaimer = createOrphanedBlobReclaimer();
		const stream = makeStream();
		const blobsInFlight = new Map([['transfer:1', stream]]);
		reclaimer.completedUnconnected('transfer:1', stream);

		expect(settleFrames(reclaimer, blobsInFlight, 1)).to.deep.equal([]);
		expect(blobsInFlight.has('transfer:1')).to.equal(true);

		expect(settleFrames(reclaimer, blobsInFlight, 1)).to.deep.equal([['transfer:1', stream]]);
		expect(blobsInFlight.has('transfer:1')).to.equal(false);
		expect(reclaimer.awaitingRecordCount).to.equal(0);
	});

	it('counts only frames that settle after the final chunk', () => {
		const reclaimer = createOrphanedBlobReclaimer();
		const blobsInFlight = new Map();
		settleFrames(reclaimer, blobsInFlight, 5);
		const stream = makeStream();
		blobsInFlight.set('transfer:2', stream);
		reclaimer.completedUnconnected('transfer:2', stream);
		expect(settleFrames(reclaimer, blobsInFlight, 1)).to.deep.equal([]);
		expect(settleFrames(reclaimer, blobsInFlight, 1)).to.have.length(1);
	});

	it('reclaims in completion order and leaves younger streams alone', () => {
		const reclaimer = createOrphanedBlobReclaimer();
		const older = makeStream();
		const younger = makeStream();
		const blobsInFlight = new Map([
			['transfer:older', older],
			['transfer:younger', younger],
		]);
		reclaimer.completedUnconnected('transfer:older', older);
		settleFrames(reclaimer, blobsInFlight, 1);
		reclaimer.completedUnconnected('transfer:younger', younger);

		expect(settleFrames(reclaimer, blobsInFlight, 1).map(([key]) => key)).to.deep.equal(['transfer:older']);
		expect(blobsInFlight.has('transfer:younger')).to.equal(true);
		expect(settleFrames(reclaimer, blobsInFlight, 1).map(([key]) => key)).to.deep.equal(['transfer:younger']);
	});

	it('never reclaims a stream a record attached to', () => {
		const reclaimer = createOrphanedBlobReclaimer();
		const viaAttach = makeStream();
		const viaFlag = makeStream();
		const blobsInFlight = new Map([
			['transfer:a', viaAttach],
			['transfer:b', viaFlag],
		]);
		reclaimer.completedUnconnected('transfer:a', viaAttach);
		reclaimer.completedUnconnected('transfer:b', viaFlag);
		reclaimer.forget('transfer:a');
		viaFlag.connectedToBlob = true;

		expect(settleFrames(reclaimer, blobsInFlight, 3)).to.deep.equal([]);
		expect([...blobsInFlight.keys()]).to.deep.equal(['transfer:a', 'transfer:b']);
		expect(reclaimer.takeReclaimed('transfer:a')).to.equal(false);
	});

	it('ignores an entry whose stream already left the map or was replaced', () => {
		const reclaimer = createOrphanedBlobReclaimer();
		const gone = makeStream();
		const replaced = makeStream();
		const replacement = makeStream();
		const blobsInFlight = new Map([['transfer:replaced', replaced]]);
		reclaimer.completedUnconnected('transfer:gone', gone);
		reclaimer.completedUnconnected('transfer:replaced', replaced);
		blobsInFlight.set('transfer:replaced', replacement);

		expect(settleFrames(reclaimer, blobsInFlight, 2)).to.deep.equal([]);
		expect(blobsInFlight.get('transfer:replaced')).to.equal(replacement);
		expect(reclaimer.awaitingRecordCount).to.equal(0);
	});

	it('tombstones a reclaimed transfer once, so a late record fails fast', () => {
		const reclaimer = createOrphanedBlobReclaimer();
		const stream = makeStream();
		const blobsInFlight = new Map([['transfer:late', stream]]);
		reclaimer.completedUnconnected('transfer:late', stream);
		settleFrames(reclaimer, blobsInFlight, 2);

		expect(reclaimer.takeReclaimed('transfer:late')).to.equal(true);
		expect(reclaimer.takeReclaimed('transfer:late')).to.equal(false);
		expect(reclaimer.takeReclaimed('transfer:never')).to.equal(false);
	});

	it('caps the tombstones, dropping the oldest first', () => {
		const reclaimer = createOrphanedBlobReclaimer(2);
		const blobsInFlight = new Map();
		for (const key of ['transfer:1', 'transfer:2', 'transfer:3']) {
			const stream = makeStream();
			blobsInFlight.set(key, stream);
			reclaimer.completedUnconnected(key, stream);
		}
		settleFrames(reclaimer, blobsInFlight, 2);

		expect(reclaimer.reclaimedCount).to.equal(2);
		expect(reclaimer.takeReclaimed('transfer:1')).to.equal(false);
		expect(reclaimer.takeReclaimed('transfer:3')).to.equal(true);
	});

	it('expires tombstones reclaimed at or before the cutoff', () => {
		const reclaimer = createOrphanedBlobReclaimer();
		const blobsInFlight = new Map();
		for (const [key, at] of [
			['transfer:early', 1_000],
			['transfer:late', 5_000],
		]) {
			const stream = makeStream();
			blobsInFlight.set(key, stream);
			reclaimer.completedUnconnected(key, stream);
			reclaimer.recordFrameProcessed(blobsInFlight, () => {}, at);
			reclaimer.recordFrameProcessed(blobsInFlight, () => {}, at);
		}
		reclaimer.expireReclaimed(1_000);

		expect(reclaimer.takeReclaimed('transfer:early')).to.equal(false);
		expect(reclaimer.takeReclaimed('transfer:late')).to.equal(true);
	});

	it('re-completing a transfer restarts its wait', () => {
		const reclaimer = createOrphanedBlobReclaimer();
		const first = makeStream();
		const second = makeStream();
		const blobsInFlight = new Map([['transfer:r', first]]);
		reclaimer.completedUnconnected('transfer:r', first);
		settleFrames(reclaimer, blobsInFlight, 1);
		blobsInFlight.set('transfer:r', second);
		reclaimer.completedUnconnected('transfer:r', second);

		expect(settleFrames(reclaimer, blobsInFlight, 1)).to.deep.equal([]);
		expect(settleFrames(reclaimer, blobsInFlight, 1)).to.deep.equal([['transfer:r', second]]);
	});

	it('tombstones only copy transfers: a file key is reused by later sends of the same file', () => {
		const reclaimer = createOrphanedBlobReclaimer();
		const stream = makeStream();
		const blobsInFlight = new Map([['file:reused', stream]]);
		reclaimer.completedUnconnected('file:reused', stream);

		expect(settleFrames(reclaimer, blobsInFlight, 2)).to.have.length(1);
		expect(reclaimer.takeReclaimed('file:reused')).to.equal(false);
	});

	it('counts no frames while nothing waits, and forgets a stream removed elsewhere', () => {
		const reclaimer = createOrphanedBlobReclaimer();
		const stream = makeStream();
		const blobsInFlight = new Map([['transfer:discarded', stream]]);
		reclaimer.completedUnconnected('transfer:discarded', stream);
		blobsInFlight.delete('transfer:discarded');
		reclaimer.forget('transfer:discarded');

		expect(reclaimer.awaitingRecordCount).to.equal(0);
		expect(reclaimer.recordFrameProcessed(blobsInFlight, () => expect.fail('nothing to reclaim'))).to.equal(0);
	});
});
