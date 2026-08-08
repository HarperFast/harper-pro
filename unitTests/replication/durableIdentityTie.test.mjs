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
 * identity tie (same version AND same origin node) whose blobs are all durably complete on disk.
 */

import { expect } from 'chai';
import { isDurableIdentityTie } from '#src/replication/replicationConnection';

const VERSION = 1700000000000;
const NODE_ID = 3;
const entry = (overrides = {}) => ({ version: VERSION, nodeId: NODE_ID, value: { id: 1 }, ...overrides });
const complete = () => Promise.resolve(true);
const incomplete = () => Promise.resolve(false);

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

	it('is a tie for a blob record whose blobs are all durably complete', async () => {
		expect(await isDurableIdentityTie(entry(), VERSION, NODE_ID, true, complete)).to.equal(true);
	});

	it('is NOT a tie when a local blob is incomplete, so the copy can repair it', async () => {
		// A PENDING/truncated stub must reach the apply loop: a skipped key is also staged as a durable
		// copy cursor, so tying here would make the damage permanent rather than merely unrepaired.
		expect(await isDurableIdentityTie(entry(), VERSION, NODE_ID, true, incomplete)).to.equal(false);
	});

	it('is not a tie when blob verification throws', async () => {
		const throwing = () => Promise.reject(new Error('unreadable value'));
		expect(await isDurableIdentityTie(entry(), VERSION, NODE_ID, true, throwing)).to.equal(false);
	});

	it('ties a record originated on a THIRD node, not just one we originated ourselves', async () => {
		// A copy hands back records from every origin in the mesh, so the tie must not assume node 0.
		expect(await isDurableIdentityTie(entry({ nodeId: 7 }), VERSION, 7, true, complete)).to.equal(true);
		expect(await isDurableIdentityTie(entry({ nodeId: 7 }), VERSION, 0, true, complete)).to.equal(false);
	});

	it('uses the real blob verifier by default', async () => {
		// The injected verifier above never exercises the default; a value with no reachable blob must
		// not tie through it either.
		expect(
			await isDurableIdentityTie(entry({ value: { id: 1, note: 'no blobs here' } }), VERSION, NODE_ID, true)
		).to.equal(false);
	});

	it('does not touch the blob store for a blob-less record', async () => {
		let inspected = 0;
		const counting = () => {
			inspected++;
			return Promise.resolve(false);
		};
		expect(await isDurableIdentityTie(entry(), VERSION, NODE_ID, false, counting)).to.equal(true);
		expect(inspected).to.equal(0);
	});
});
