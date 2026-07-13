/**
 * Coverage for computeSelfReplicates (the directional self hdb_nodes record derivation) and
 * mergeReconstructedNode (decode-recovery directional preservation).
 *
 * computeSelfReplicates turns a node's normalized config routes into the `replicates` value written to
 * its own hdb_nodes row. Instead of a blanket `replicates: true` (full mesh), it advertises the node's
 * configured directions so that when `system` is replicated the record propagates and the #498 gates
 * keep discovered non-neighbor peers from opening direct connections. A node with no directional routes
 * still gets `true` (legacy). See replication/subscriptionManager.ts and the systemdb-routing feature.
 */
import { expect } from 'chai';
import { computeSelfReplicates } from '#src/replication/subscriptionManager';
import { mergeReconstructedNode } from '#src/replication/knownNodes';

describe('computeSelfReplicates', () => {
	it('returns true (legacy full-mesh) when there are no routes', () => {
		expect(computeSelfReplicates([])).to.equal(true);
	});

	it('returns true (legacy) when routes are only full-replication (true / undefined replicates)', () => {
		// Opt-in: with no directional route there is no constraint to advertise, so legacy full-mesh is
		// preserved and existing seed-based auto-mesh clusters are unaffected.
		expect(
			computeSelfReplicates([
				{ name: 'A', replicates: true },
				{ name: 'B', replicates: undefined },
			])
		).to.equal(true);
	});

	it('constrains a full-replication neighbor once ANY route on the node is directional', () => {
		// Mixed config: a directional route to M opts the node in; the full-replication route to A still
		// gets both-direction entries (A is fully replicated), while discovered non-neighbors are excluded.
		const result = computeSelfReplicates([
			{ name: 'A', replicates: true },
			{ name: 'M', replicates: { sends: true } },
		]);
		expect(result).to.deep.equal({
			sendsTo: [{ target: 'A' }, { target: 'M' }],
			receivesFrom: [{ source: 'A' }],
		});
	});

	it('maps sends/receives booleans to qualified entries for that peer', () => {
		const result = computeSelfReplicates([
			{ name: 'M', replicates: { sends: true, receives: false } },
			{ name: 'C', replicates: { sends: false, receives: true } },
		]);
		expect(result).to.deep.equal({
			sendsTo: [{ target: 'M' }],
			receivesFrom: [{ source: 'C' }],
		});
	});

	it('defaults sendsTo/receivesFrom entry target/source to the route peer, preserving database scope', () => {
		const result = computeSelfReplicates([
			{ name: 'M', replicates: { sendsTo: [{ database: 'cardata' }], receivesFrom: [{ database: 'config' }] } },
		]);
		expect(result).to.deep.equal({
			sendsTo: [{ target: 'M', database: 'cardata' }],
			receivesFrom: [{ source: 'M', database: 'config' }],
		});
	});

	it('keeps an explicit target/source on an entry (does not overwrite with the route peer)', () => {
		const result = computeSelfReplicates([
			{ name: 'M', replicates: { sendsTo: [{ target: 'other', database: 'd' }], receivesFrom: [] } },
		]);
		expect(result).to.deep.equal({ sendsTo: [{ target: 'other', database: 'd' }], receivesFrom: [] });
	});

	it('accepts string entries, qualifying them to a target/source', () => {
		const result = computeSelfReplicates([{ name: 'M', replicates: { sendsTo: ['X'], receivesFrom: ['Y'] } }]);
		expect(result).to.deep.equal({ sendsTo: [{ target: 'X' }], receivesFrom: [{ source: 'Y' }] });
	});

	it('returns an EMPTY directional record (not true) for an explicit "replicate nothing" route', () => {
		// A directional object that authorizes nothing must not silently re-advertise a full mesh.
		expect(computeSelfReplicates([{ name: 'M', replicates: { sends: false, receives: false } }])).to.deep.equal({
			sendsTo: [],
			receivesFrom: [],
		});
		expect(computeSelfReplicates([{ name: 'M', replicates: { sendsTo: [], receivesFrom: [] } }])).to.deep.equal({
			sendsTo: [],
			receivesFrom: [],
		});
	});

	it('treats a subscriptions-only route (replicates:false) as non-directional → legacy true', () => {
		// iterateRoutes normalizes a subscriptions-only route to replicates:false; it drives the
		// node.subscriptions path, not the directional record, and must not by itself force an empty record.
		expect(computeSelfReplicates([{ name: 'M', replicates: false }])).to.equal(true);
	});

	it('models the Toyota per-database opposite-direction shape', () => {
		// Middle: cardata up to Core, config down to Roadside; receives cardata from Roadside, config from Core.
		const result = computeSelfReplicates([
			{ name: 'C', replicates: { sendsTo: [{ database: 'cardata' }], receivesFrom: [{ database: 'config' }] } },
			{ name: 'R', replicates: { sendsTo: [{ database: 'config' }], receivesFrom: [{ database: 'cardata' }] } },
		]);
		expect(result).to.deep.equal({
			sendsTo: [
				{ target: 'C', database: 'cardata' },
				{ target: 'R', database: 'config' },
			],
			receivesFrom: [
				{ source: 'C', database: 'config' },
				{ source: 'R', database: 'cardata' },
			],
		});
	});
});

describe('mergeReconstructedNode', () => {
	const reconstruct = { name: 'R', replicates: true };

	it('returns the reconstruct unchanged when there is no prior in-memory node', () => {
		expect(mergeReconstructedNode({ ...reconstruct }, undefined)).to.deep.equal({ name: 'R', replicates: true });
	});

	it('enriches from the old node (url/shard) while keeping the reconstruct name', () => {
		const merged = mergeReconstructedNode(
			{ ...reconstruct },
			{
				name: 'R',
				url: 'wss://R:9933',
				shard: 2,
				replicates: true,
			}
		);
		expect(merged).to.include({ name: 'R', url: 'wss://R:9933', shard: 2 });
	});

	it('preserves a directional replicates object instead of clobbering it to true', () => {
		// The whole point: a transient decode miss must not widen a constrained peer back to full mesh.
		const directional = { sendsTo: [{ target: 'M' }], receivesFrom: [] };
		const merged = mergeReconstructedNode(
			{ ...reconstruct },
			{
				name: 'R',
				url: 'wss://R:9933',
				replicates: directional,
			}
		);
		expect(merged.replicates).to.deep.equal(directional);
	});

	it('leaves a legacy boolean replicates as the reconstruct true', () => {
		const merged = mergeReconstructedNode({ ...reconstruct }, { name: 'R', replicates: true });
		expect(merged.replicates).to.equal(true);
	});
});
