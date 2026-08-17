/**
 * Regression coverage for the hdb_nodes decode-failure recovery path (harper-pro#460).
 *
 * When an hdb_nodes row's value fails to decode (missing msgpackr shared structure, harper#1163),
 * RecordEncoder.decode returns null rather than throwing. Before the fix a range-visible-but-null row
 * was misread as a deletion, so the subscription scan dropped the live peer (total replication loss),
 * and the self-row read gated off all outbound replication. These assertions pin the fixed behavior:
 * a range-visible null is a decode failure (reconstruct the peer), not a tombstone.
 */

import assert from 'node:assert/strict';
import { probeNodeRow, resolveScannedNode, selfNodeReplicates } from '#src/replication/knownNodes';

// getSync returns `record` (null models a decode failure); getKeys models range visibility, keyed off start.
function fakeStore({ rangeVisible, record = null }) {
	return {
		getSync: () => record,
		getKeys: (options) => (rangeVisible ? [options?.start] : []),
	};
}

describe('hdb_nodes decode-failure recovery (harper-pro#460)', () => {
	describe('probeNodeRow', () => {
		it('classifies a range-visible row that decodes to null as a decode failure, not a tombstone', () => {
			assert.equal(probeNodeRow(fakeStore({ rangeVisible: true }), 'peer').outcome, 'decode-failure');
		});

		it('classifies a null row whose key is gone from the range as a genuine deletion', () => {
			assert.equal(probeNodeRow(fakeStore({ rangeVisible: false }), 'peer').outcome, 'deleted');
		});
	});

	describe('resolveScannedNode (boot scan)', () => {
		it('reconstructs a range-visible decode-miss peer instead of dropping it', () => {
			const store = fakeStore({ rangeVisible: true });
			assert.deepEqual(
				resolveScannedNode(null, 'peer', (key) => probeNodeRow(store, key)),
				{
					name: 'peer',
					replicates: true,
				}
			);
		});

		it('does not revive a genuinely deleted peer', () => {
			const store = fakeStore({ rangeVisible: false });
			assert.equal(
				resolveScannedNode(null, 'peer', (key) => probeNodeRow(store, key)),
				undefined
			);
		});
	});

	describe('selfNodeReplicates', () => {
		it('returns the decoded self-row replicates value (a genuine replicates:false is preserved)', () => {
			assert.equal(selfNodeReplicates(fakeStore({ rangeVisible: true, record: { replicates: false } }), 'self'), false);
		});

		it('defaults to replicating when a range-visible self-row fails to decode and nothing is cached', () => {
			assert.equal(selfNodeReplicates(fakeStore({ rangeVisible: true }), 'self-decode-miss'), true);
		});

		it('stays off for a genuinely absent self-row', () => {
			assert.equal(selfNodeReplicates(fakeStore({ rangeVisible: false }), 'self'), undefined);
		});
	});
});
