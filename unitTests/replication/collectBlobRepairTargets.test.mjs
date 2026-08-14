/**
 * Coverage for `collectBlobRepairTargets` (harper-pro#699) — the identity-tie gate that decides
 * whether an incoming duplicate's blob should be streamed INTO the stored record's damaged fileId
 * (core `repairBlobFile`) instead of freshly saved. The tie semantics must exactly match core's
 * apply-loop duplicate drop (same version AND same source node): anything looser would overwrite
 * blob files of records whose content is not provably identical. Repair is restricted to rows
 * with exactly ONE stored file-backed blob, because pairing multiple stored blobs to incoming
 * decode callbacks positionally is an unverified cross-traversal ordering assumption. The damage
 * probe is injected, so these tests pin the gating without touching disk.
 */

import { expect } from 'chai';
import { collectBlobRepairTargets } from '#src/replication/replicationConnection';

const blobA = new Blob(['a']);
const blobB = new Blob(['b']);

function decoderFor(entry) {
	return { getEntry: () => entry };
}

describe('collectBlobRepairTargets (#699)', () => {
	it('returns the single damaged stored blob on an exact identity tie', async () => {
		const entry = { version: 5, nodeId: 2, value: { x: blobA } };
		expect(await collectBlobRepairTargets(decoderFor(entry), 'k', 5, 2, async () => true)).to.deep.equal([blobA]);
	});

	it('returns null when the single blob is healthy or unverifiable', async () => {
		const entry = { version: 5, nodeId: 2, value: { x: blobA } };
		expect(await collectBlobRepairTargets(decoderFor(entry), 'k', 5, 2, async () => false)).to.equal(null);
		expect(await collectBlobRepairTargets(decoderFor(entry), 'k', 5, 2, async () => undefined)).to.equal(null);
	});

	it('returns null for multi-blob rows regardless of damage (positional pairing is unverified)', async () => {
		const entry = { version: 5, nodeId: 2, value: { x: blobA, nested: [{ y: blobB }] } };
		expect(await collectBlobRepairTargets(decoderFor(entry), 'k', 5, 2, async () => true)).to.equal(null);
	});

	it('returns null on any non-tie: version mismatch, node mismatch; default-node tie only for node 0', async () => {
		const entry = { version: 5, nodeId: 2, value: { x: blobA } };
		expect(await collectBlobRepairTargets(decoderFor(entry), 'k', 6, 2, async () => true)).to.equal(null);
		expect(await collectBlobRepairTargets(decoderFor(entry), 'k', 5, 3, async () => true)).to.equal(null);
		const localEntry = { version: 5, value: { x: blobA } }; // stored nodeId undefined -> local node 0
		expect(await collectBlobRepairTargets(decoderFor(localEntry), 'k', 5, 0, async () => true)).to.deep.equal([blobA]);
		expect(await collectBlobRepairTargets(decoderFor(localEntry), 'k', 5, 1, async () => true)).to.equal(null);
	});

	it('returns null with no stored entry, an async entry, an unmapped source node, or a throwing read', async () => {
		expect(await collectBlobRepairTargets(decoderFor(undefined), 'k', 5, 2, async () => true)).to.equal(null);
		expect(await collectBlobRepairTargets(decoderFor({ then: () => {} }), 'k', 5, 2, async () => true)).to.equal(null);
		expect(
			await collectBlobRepairTargets(decoderFor({ version: 5, nodeId: 2 }), 'k', 5, undefined, async () => true)
		).to.equal(null);
		expect(
			await collectBlobRepairTargets(
				{
					getEntry: () => {
						throw new Error('decode surprise');
					},
				},
				'k',
				5,
				2,
				async () => true
			)
		).to.equal(null);
	});

	it('returns null when the damage probe rejects', async () => {
		const entry = { version: 5, nodeId: 2, value: { x: blobA } };
		expect(
			await collectBlobRepairTargets(decoderFor(entry), 'k', 5, 2, () => Promise.reject(new Error('probe fault')))
		).to.equal(null);
	});
});
