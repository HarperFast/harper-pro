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

	it('awaits a Promise-returning getEntry instead of treating a block-cache miss as absence (#699)', async () => {
		// A cold entry is the NORM in the repair window: the re-delivered span was applied by a
		// PREVIOUS connection, so getEntry routinely returns a Promise there. Treating a thenable as
		// absence made the repair silently never fire on a resumed copy (and latched the caller's
		// probe window off). A resolved entry must repair; only a RESOLVED null is absence.
		const entry = { version: 5, nodeId: 2, value: { x: blobA } };
		expect(await collectBlobRepairTargets(decoderFor(Promise.resolve(entry)), 'k', 5, 2, async () => true)).to.deep.equal(
			[blobA]
		);
		expect(await collectBlobRepairTargets(decoderFor(Promise.resolve(null)), 'k', 5, 2, async () => true)).to.equal(
			null
		);
	});

	it('counts each decline class so a field non-fire is attributable (#699)', async () => {
		const entry = { version: 5, nodeId: 2, value: { x: blobA } };
		const declines = {};
		await collectBlobRepairTargets(decoderFor(entry), 'k', 6, 2, async () => true, declines);
		await collectBlobRepairTargets(decoderFor(entry), 'k', 5, 3, async () => true, declines);
		await collectBlobRepairTargets(decoderFor(entry), 'k', 5, 2, async () => false, declines);
		await collectBlobRepairTargets(decoderFor(Promise.resolve(null)), 'k', 5, 2, async () => true, declines);
		expect(declines).to.deep.equal({
			'version-mismatch': 1,
			'node-mismatch': 1,
			healthy: 1,
			'no-stored-entry': 1,
		});
	});

	it('returns null with no stored entry, an unmapped source node, or a throwing read', async () => {
		expect(await collectBlobRepairTargets(decoderFor(undefined), 'k', 5, 2, async () => true)).to.equal(null);
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
