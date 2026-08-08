/**
 * Coverage for `isDurableIdentityTie`, the shared predicate behind both receive-side duplicate skips:
 * the leading-duplicate fast-skip on a resumed stream, and the copy-mode skip that keeps a base copy
 * from re-minting blob files for records the receiver already holds.
 *
 * The copy-mode caller is the load-bearing one. Copy frames are applied as snapshots with no CRDT
 * resequencing, so without this gate a full copy re-writes every record and re-mints its blobs — and on
 * the reverse leg of a bidirectional join that means a node copies its OWN records back from a peer,
 * trading durable local blob bytes for a re-transfer. Interrupted mid-blob, the record is left on a
 * PENDING stub the peer can never fill (it never held the bytes either), losing the blob on both nodes.
 *
 * So a false positive here is data loss, not a slow path: the predicate must be true ONLY for a true
 * identity tie (same version AND same origin node) whose blob files are all present on disk.
 */

import { expect } from 'chai';
import { isDurableIdentityTie } from '#src/replication/replicationConnection';

const VERSION = 1700000000000;
const NODE_ID = 3;
const entry = (overrides = {}) => ({ version: VERSION, nodeId: NODE_ID, value: { id: 1 }, ...overrides });
const noBlobs = () => [];
const present = () => Promise.resolve();
const missing = () => Promise.reject(new Error('ENOENT'));

describe('isDurableIdentityTie — provably-already-applied record detection', () => {
	it('is a tie for the same version and node when the record carries no blobs', async () => {
		expect(await isDurableIdentityTie(entry(), VERSION, NODE_ID, false)).to.equal(true);
	});

	it('treats a stored entry with no nodeId as node 0 (locally originated)', async () => {
		expect(await isDurableIdentityTie(entry({ nodeId: undefined }), VERSION, 0, false)).to.equal(true);
		expect(await isDurableIdentityTie(entry({ nodeId: undefined }), VERSION, 1, false)).to.equal(false);
	});

	it('is not a tie when nothing is stored locally', async () => {
		expect(await isDurableIdentityTie(undefined, VERSION, NODE_ID, false)).to.equal(false);
	});

	it('is not a tie for a different version or a different origin node', async () => {
		expect(await isDurableIdentityTie(entry(), VERSION + 1, NODE_ID, false)).to.equal(false);
		expect(await isDurableIdentityTie(entry(), VERSION - 1, NODE_ID, false)).to.equal(false);
		expect(await isDurableIdentityTie(entry(), VERSION, NODE_ID + 1, false)).to.equal(false);
	});

	it('is not a tie when the origin node could not be mapped', async () => {
		expect(await isDurableIdentityTie(entry(), VERSION, undefined, false)).to.equal(false);
	});

	it('is a tie for a blob record whose every blob file is on disk', async () => {
		expect(
			await isDurableIdentityTie(entry(), VERSION, NODE_ID, true, () => ['/blobs/a', '/blobs/b'], present)
		).to.equal(true);
	});

	it('is not a tie when a blob file is missing, so the record can reach the repair path', async () => {
		expect(await isDurableIdentityTie(entry(), VERSION, NODE_ID, true, () => ['/blobs/a'], missing)).to.equal(false);
	});

	it('is not a tie when a single blob of several is missing', async () => {
		const access = (path) => (path === '/blobs/b' ? Promise.reject(new Error('ENOENT')) : Promise.resolve());
		expect(
			await isDurableIdentityTie(entry(), VERSION, NODE_ID, true, () => ['/blobs/a', '/blobs/b'], access)
		).to.equal(false);
	});

	it('is not a tie when the blobs cannot be fully accounted for', async () => {
		// null = the header claimed blobs but none was found, or one had no resolvable path.
		expect(await isDurableIdentityTie(entry(), VERSION, NODE_ID, true, () => null, present)).to.equal(false);
	});

	it('is not a tie when blob inspection throws', async () => {
		const throwing = () => {
			throw new Error('unreadable value');
		};
		expect(await isDurableIdentityTie(entry(), VERSION, NODE_ID, true, throwing, present)).to.equal(false);
	});

	it('does not touch the filesystem for a blob-less record', async () => {
		let inspected = 0;
		const counting = () => {
			inspected++;
			return noBlobs();
		};
		expect(await isDurableIdentityTie(entry(), VERSION, NODE_ID, false, counting, missing)).to.equal(true);
		expect(inspected).to.equal(0);
	});
});
