import assert from 'node:assert';
import {
	deriveRegionTopology,
	isGateway,
	orderFailoverCandidates,
	settleSupplier,
	supplierCandidates,
	topologyAllowsDirect,
	topologySignature,
	validRegion,
} from '#src/replication/regionTopology';

function member(name, region, extra = {}) {
	return { name, region, replicates: true, ...extra };
}

const NINE = [
	member('a1', 'east'),
	member('a2', 'east'),
	member('a3', 'east'),
	member('b1', 'west'),
	member('b2', 'west'),
	member('b3', 'west'),
	member('c1', 'eu'),
	member('c2', 'eu'),
	member('c3', 'eu'),
];

describe('regionTopology', () => {
	describe('validRegion', () => {
		it('accepts a non-blank string and rejects everything else', () => {
			assert.equal(validRegion('us-east'), 'us-east');
			assert.equal(validRegion(' us-east '), 'us-east');
			for (const bad of ['', '   ', 5, null, undefined, {}, 'x'.repeat(257)]) assert.equal(validRegion(bad), undefined);
		});
	});

	describe('deriveRegionTopology', () => {
		it('picks the two lowest names of each region when no node sets gateway', () => {
			const topology = deriveRegionTopology(NINE);
			assert.equal(topology.active, true);
			assert.deepEqual(topology.gatewaysByRegion.get('east'), ['a1', 'a2']);
			assert.deepEqual(topology.gatewaysByRegion.get('west'), ['b1', 'b2']);
			assert.equal(isGateway(topology, 'a3'), false);
		});

		it('keeps explicit gateways and tops up to two, skipping gateway: false', () => {
			const topology = deriveRegionTopology([
				member('a1', 'east', { gateway: false }),
				member('a2', 'east'),
				member('a3', 'east', { gateway: true }),
				member('b1', 'west', { gateway: true }),
				member('b2', 'west', { gateway: true }),
				member('b3', 'west', { gateway: true }),
			]);
			assert.deepEqual(topology.gatewaysByRegion.get('east'), ['a2', 'a3']);
			assert.deepEqual(topology.gatewaysByRegion.get('west'), ['b1', 'b2', 'b3']);
		});

		it('allows a single gateway when the rest of the region opts out', () => {
			const topology = deriveRegionTopology([
				member('a1', 'east', { gateway: false }),
				member('a2', 'east', { gateway: true }),
				member('a3', 'east', { gateway: false }),
				member('b1', 'west'),
			]);
			assert.deepEqual(topology.gatewaysByRegion.get('east'), ['a2']);
		});

		it('treats a non-boolean gateway as unset', () => {
			const topology = deriveRegionTopology([
				member('a1', 'east'),
				member('a2', 'east'),
				member('a3', 'east', { gateway: 'true' }),
				member('b1', 'west'),
			]);
			assert.deepEqual(topology.gatewaysByRegion.get('east'), ['a1', 'a2']);
		});

		it('sorts by code unit, the order failover uses', () => {
			const topology = deriveRegionTopology([
				member('node-10', 'east'),
				member('node-9', 'east'),
				member('b1', 'west'),
			]);
			assert.deepEqual(topology.gatewaysByRegion.get('east'), ['node-10', 'node-9']);
		});

		it('is inactive with an unlabeled member, a directional member, one region, or a region with no gateway', () => {
			assert.match(
				deriveRegionTopology([...NINE, { name: 'old', replicates: true }]).inactiveReason,
				/node old has no region/
			);
			assert.match(
				deriveRegionTopology([...NINE, member('d1', 'east', { replicates: { sendsTo: ['a1'] } })]).inactiveReason,
				/node d1 uses directional replication/
			);
			assert.match(deriveRegionTopology(NINE.slice(0, 3)).inactiveReason, /fewer than two regions/);
			assert.match(
				deriveRegionTopology([
					member('a1', 'east', { gateway: false }),
					member('a2', 'east', { gateway: false }),
					member('b1', 'west'),
				]).inactiveReason,
				/region east has no gateway/
			);
		});
	});

	describe('topologyAllowsDirect', () => {
		const topology = deriveRegionTopology(NINE);

		it('links every node in a region and gateways across regions', () => {
			assert.equal(topologyAllowsDirect(topology, 'a3', 'a1'), true);
			assert.equal(topologyAllowsDirect(topology, 'a3', 'a2'), true);
			assert.equal(topologyAllowsDirect(topology, 'a1', 'b2'), true);
			assert.equal(topologyAllowsDirect(topology, 'a2', 'c1'), true);
		});

		it('prunes every cross-region link that has a non-gateway end', () => {
			assert.equal(topologyAllowsDirect(topology, 'a3', 'b1'), false);
			assert.equal(topologyAllowsDirect(topology, 'a1', 'b3'), false);
			assert.equal(topologyAllowsDirect(topology, 'a3', 'b3'), false);
		});

		it('keeps links to peers it has no row for, and everything when inactive', () => {
			assert.equal(topologyAllowsDirect(topology, 'a3', 'unknown'), true);
			const inactive = deriveRegionTopology([...NINE, { name: 'old', replicates: true }]);
			assert.equal(topologyAllowsDirect(inactive, 'a3', 'b3'), true);
		});
	});

	describe('failover ordering', () => {
		it('keeps ring order after the origin when no regions are set', () => {
			const names = ['n1', 'n2', 'n3', 'n4', 'n5'];
			assert.deepEqual(orderFailoverCandidates(names, 2), ['n4', 'n5', 'n1', 'n2']);
		});

		it("puts peers in the origin's region first in ring order, then the rest in ring order", () => {
			const names = ['a1', 'b1', 'b2', 'c1', 'a2'];
			const regionOf = new Map([
				['a1', 'east'],
				['a2', 'east'],
				['b1', 'west'],
				['b2', 'west'],
				['c1', 'eu'],
			]);
			assert.deepEqual(orderFailoverCandidates(names, 0, regionOf), ['a2', 'b1', 'b2', 'c1']);
		});
	});

	describe('topologySignature', () => {
		it('ignores row order and collapses every inactive topology', () => {
			assert.equal(
				topologySignature(deriveRegionTopology(NINE)),
				topologySignature(deriveRegionTopology([...NINE].reverse()))
			);
			assert.notEqual(
				topologySignature(deriveRegionTopology(NINE)),
				topologySignature(deriveRegionTopology([...NINE, member('a0', 'east')]))
			);
			assert.equal(topologySignature(deriveRegionTopology(NINE.slice(0, 3))), 'inactive');
		});
	});

	describe('supplierCandidates', () => {
		const topology = deriveRegionTopology(NINE);

		it('sends a leaf to its own gateways for every remote origin', () => {
			assert.deepEqual(supplierCandidates(topology, 'a3', 'b3'), {
				region: 'west',
				reachTier: ['a1', 'a2'],
				liveTier: [],
				preemptLiveTier: true,
			});
			assert.deepEqual(supplierCandidates(topology, 'a3', 'c1').reachTier, ['a1', 'a2']);
		});

		it('sends the lower gateway to the remote gateways and the higher one to the lower first', () => {
			assert.deepEqual(supplierCandidates(topology, 'a1', 'b3'), {
				region: 'west',
				reachTier: [],
				liveTier: ['b1', 'b2'],
				preemptLiveTier: false,
			});
			assert.deepEqual(supplierCandidates(topology, 'a2', 'b3').reachTier, ['a1']);
		});

		it('manages nothing that has a direct link, and nothing when inactive', () => {
			assert.equal(supplierCandidates(topology, 'a3', 'a2'), undefined);
			assert.equal(supplierCandidates(topology, 'a1', 'b2'), undefined);
			assert.equal(supplierCandidates(topology, 'a1', 'a1'), undefined);
			assert.equal(supplierCandidates(deriveRegionTopology(NINE.slice(0, 3)), 'a3', 'b3'), undefined);
		});
	});

	describe('settleSupplier', () => {
		const HOLD = 3000;
		const STABLE = 10000;
		function view(peers) {
			return {
				isLive: (name) => peers[name]?.live === true,
				liveSince: (name) => peers[name]?.liveSince ?? 0,
				reaches: (name, region) => peers[name]?.reach?.includes(region) === true,
				reachSince: (name) => peers[name]?.reachSince ?? 0,
			};
		}
		const leaf = { region: 'west', reachTier: ['a1', 'a2'], liveTier: [], preemptLiveTier: true };
		const gateway = { region: 'west', reachTier: [], liveTier: ['b1', 'b2'], preemptLiveTier: false };
		const standby = { region: 'west', reachTier: ['a1'], liveTier: ['b1', 'b2'], preemptLiveTier: false };

		it('picks the lowest gateway that reaches the region, and none when no live gateway reaches it', () => {
			const both = view({ a1: { live: true, reach: ['west'] }, a2: { live: true, reach: ['west'] } });
			assert.equal(settleSupplier(leaf, both, undefined, 0, HOLD, STABLE).supplier, 'a1');
			const isolated = view({ a1: { live: true, reach: [] }, a2: { live: true, reach: ['west'] } });
			assert.equal(settleSupplier(leaf, isolated, undefined, 0, HOLD, STABLE).supplier, 'a2');
			const noReach = view({ a1: { live: true }, a2: { live: true } });
			assert.equal(settleSupplier(leaf, noReach, undefined, 0, HOLD, STABLE).supplier, undefined);
			assert.equal(settleSupplier(leaf, view({}), undefined, 0, HOLD, STABLE).supplier, undefined);
		});

		it('lets a leaf fail open after the hold when its gateway stops reaching the region and no other does', () => {
			const isolated = view({ a1: { live: true, reach: [] }, a2: { live: true, reach: [] } });
			const held = settleSupplier(leaf, isolated, { supplier: 'a1' }, 0, HOLD, STABLE);
			assert.equal(held.supplier, 'a1');
			assert.equal(settleSupplier(leaf, isolated, held, HOLD, HOLD, STABLE).supplier, undefined);
		});

		it('keeps a supplier through a disconnect shorter than the hold, then moves', () => {
			const down = view({ a1: { live: false }, a2: { live: true, reach: ['west'] } });
			const held = settleSupplier(leaf, down, { supplier: 'a1' }, 1000, HOLD, STABLE);
			assert.deepEqual(held, { supplier: 'a1', ineligibleSince: 1000, recheckAt: 4000 });
			assert.equal(settleSupplier(leaf, down, held, 3999, HOLD, STABLE).supplier, 'a1');
			assert.equal(settleSupplier(leaf, down, held, 4000, HOLD, STABLE).supplier, 'a2');
		});

		it('moves to a gateway that reaches the region once the supplier has lost reach for the hold', () => {
			const lostReach = view({ a1: { live: true, reach: [] }, a2: { live: true, reach: ['west'], reachSince: 0 } });
			const held = settleSupplier(leaf, lostReach, { supplier: 'a1' }, 60000, HOLD, STABLE);
			assert.equal(held.supplier, 'a1');
			assert.equal(settleSupplier(leaf, lostReach, held, 60000 + HOLD, HOLD, STABLE).supplier, 'a2');
		});

		it('returns to the lower gateway only after it has reached the region for the stable time', () => {
			const back = view({
				a1: { live: true, liveSince: 50000, reach: ['west'], reachSince: 52000 },
				a2: { live: true, reach: ['west'] },
			});
			assert.deepEqual(settleSupplier(leaf, back, { supplier: 'a2' }, 55000, HOLD, STABLE), {
				supplier: 'a2',
				recheckAt: 62000,
			});
			assert.equal(settleSupplier(leaf, back, { supplier: 'a2' }, 62000, HOLD, STABLE).supplier, 'a1');
		});

		it('never moves a gateway from a live remote gateway to a lower-named one', () => {
			const both = view({ b1: { live: true }, b2: { live: true } });
			assert.equal(settleSupplier(gateway, both, { supplier: 'b2' }, 999999, HOLD, STABLE).supplier, 'b2');
		});

		it('moves a standby gateway in-region once the lower gateway reaches the region, and back out when it stops', () => {
			const primaryBack = view({
				a1: { live: true, liveSince: 0, reach: ['west'], reachSince: 0 },
				b1: { live: true },
			});
			assert.equal(settleSupplier(standby, primaryBack, { supplier: 'b1' }, 20000, HOLD, STABLE).supplier, 'a1');
			const primaryIsolated = view({ a1: { live: true, reach: [] }, b1: { live: true } });
			const held = settleSupplier(standby, primaryIsolated, { supplier: 'a1' }, 1000, HOLD, STABLE);
			assert.equal(held.supplier, 'a1');
			assert.equal(settleSupplier(standby, primaryIsolated, held, 4000, HOLD, STABLE).supplier, 'b1');
		});
	});
});
