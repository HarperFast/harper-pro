import assert from 'node:assert';
import {
	columnCarrier,
	deriveRegionTopology,
	gridLinks,
	orderFailoverCandidates,
	originFallbackMates,
	receivesDirect,
	RELIEVED_SUPPLIER_LIMIT,
	relievedSuppliers,
	settleSupplier,
	supplierCandidates,
	topologySignature,
	validRegion,
} from '#src/replication/regionTopology';

const HOLD_MS = 3_000;
const STABLE_MS = 10_000;

function member(name, region, extra = {}) {
	return { name, region, replicates: true, ...extra };
}

/** One region per size, named r0, r1, …; nodes r0-n0, r0-n1, … */
function layout(sizes) {
	return sizes.flatMap((size, region) =>
		Array.from({ length: size }, (_, index) => member(`r${region}-n${index}`, `r${region}`))
	);
}

const names = (members) => members.map((node) => node.name);

function linkCounts(topology, nodes) {
	let total = 0;
	let crossRegion = 0;
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			if (!gridLinks(topology, nodes[i], nodes[j])) continue;
			total++;
			if (topology.regionOf.get(nodes[i]) !== topology.regionOf.get(nodes[j])) crossRegion++;
		}
	}
	return { total, crossRegion };
}

/**
 * Settles every live node's supplier for every origin under one shared liveness view, from `previous` (a map of
 * `node/origin` to assignment), and returns the new assignments.
 */
function settleAll(topology, nodes, live, previous, now, qualifiedSince = () => 0) {
	const next = new Map();
	for (const node of nodes) {
		if (!live.has(node)) continue;
		for (const origin of nodes) {
			const candidates = supplierCandidates(topology, node, origin);
			if (!candidates) continue;
			next.set(
				`${node}/${origin}`,
				settleSupplier(
					candidates,
					origin,
					{ qualifies: (name) => live.has(name), qualifiedSince },
					previous?.get(`${node}/${origin}`),
					now,
					HOLD_MS,
					STABLE_MS
				)
			);
		}
	}
	return next;
}

/**
 * Checks delivery of every live origin: one direct receiver in each other region that has a live node, every other
 * live node one relay hop behind a region-mate that receives the origin directly, and so no supplier cycle.
 */
function assertDelivery(topology, nodes, live, assignments, description) {
	const direct = (node, origin) =>
		receivesDirect(topology, node, origin) || assignments.get(`${node}/${origin}`)?.supplier === origin;
	for (const origin of nodes) {
		if (!live.has(origin)) continue;
		const originRegion = topology.regionOf.get(origin);
		for (const [region, members] of topology.membersByRegion) {
			const liveMembers = members.filter((name) => live.has(name));
			if (region === originRegion || liveMembers.length === 0) continue;
			const receivers = liveMembers.filter((name) => direct(name, origin));
			assert.equal(
				receivers.length,
				1,
				`${description}: ${origin} crosses into ${region} ${receivers.length} times (${receivers})`
			);
			for (const node of liveMembers) {
				if (node === receivers[0]) continue;
				const supplier = assignments.get(`${node}/${origin}`)?.supplier;
				assert.equal(supplier, receivers[0], `${description}: ${node} takes ${origin} from ${supplier}`);
				assert.equal(
					topology.regionOf.get(supplier),
					region,
					`${description}: ${node} leaves its region for ${origin}`
				);
			}
		}
	}
}

describe('regionTopology', () => {
	describe('validRegion', () => {
		it('accepts a non-blank string and rejects everything else', () => {
			assert.equal(validRegion('us-east'), 'us-east');
			assert.equal(validRegion(' us-east '), 'us-east');
			for (const bad of ['', '   ', 5, null, undefined, {}, 'x'.repeat(257)]) assert.equal(validRegion(bad), undefined);
		});
	});

	describe('deriveRegionTopology', () => {
		it('is off while a member has no region, does not replicate fully, or there is one region', () => {
			const withUnlabeled = deriveRegionTopology([...layout([2, 2]), { name: 'old', replicates: true }]);
			assert.equal(withUnlabeled.active, false);
			assert.equal(withUnlabeled.inactiveReason, 'node old has no region');
			const directional = deriveRegionTopology([...layout([2, 2]), member('d', 'r0', { replicates: { sends: true } })]);
			assert.equal(directional.inactiveReason, 'node d uses directional replication');
			const off = deriveRegionTopology([...layout([2, 2]), member('d', 'r0', { replicates: false })]);
			assert.equal(off.inactiveReason, 'node d does not replicate');
			assert.equal(deriveRegionTopology(layout([3])).inactiveReason, 'fewer than two regions');
			assert.equal(deriveRegionTopology(layout([2, 2])).active, true);
		});

		it('ranks lanes by name within a region, in code-unit order', () => {
			const topology = deriveRegionTopology([
				member('us_1', 'east'),
				member('us-2', 'east'),
				member('US-0', 'east'),
				member('w', 'west'),
			]);
			assert.deepEqual(topology.membersByRegion.get('east'), ['US-0', 'us-2', 'us_1']);
			assert.deepEqual(
				['US-0', 'us-2', 'us_1'].map((name) => topology.columnOf.get(name)),
				[0, 1, 2]
			);
		});

		it('makes a column of each (shard, lane), so one node per region and shard lines up by shard', () => {
			const regions = ['east', 'west', 'eu'];
			const members = regions.flatMap((region) =>
				// names sort against the shard order, so the column is the shard's, not the name's
				[2, 0, 1].map((shard, index) => member(`${region}-${index}`, region, { shard }))
			);
			const topology = deriveRegionTopology(members);
			for (const region of regions) {
				assert.deepEqual(
					[0, 1, 2].map((index) => topology.columnOf.get(`${region}-${index}`)),
					[2, 0, 1]
				);
			}
			assert.deepEqual(linkCounts(topology, names(members)), { total: 18, crossRegion: 9 });
			assert.equal(gridLinks(topology, 'east-0', 'west-0'), true);
			assert.equal(gridLinks(topology, 'east-0', 'west-1'), false);
		});

		it('numbers lanes per shard, and keeps unsharded nodes, shard 0 and other shards apart', () => {
			const topology = deriveRegionTopology([
				member('a1', 'east', { shard: 0 }),
				member('a2', 'east', { shard: 0 }),
				member('a3', 'east'),
				member('a4', 'east', { shard: 1 }),
				member('b1', 'west', { shard: 1 }),
			]);
			// columns in order: (none, 0), (0, 0), (0, 1), (1, 0)
			assert.deepEqual(
				['a3', 'a1', 'a2', 'a4', 'b1'].map((name) => topology.columnOf.get(name)),
				[0, 1, 2, 3, 3]
			);
		});

		it('ignores a malformed shard instead of throwing', () => {
			const topology = deriveRegionTopology([
				member('a1', 'east', { shard: { bad: true } }),
				member('a2', 'east', { shard: null }),
				member('b1', 'west', { shard: [1] }),
			]);
			assert.equal(topology.active, true);
			assert.deepEqual([...topology.columnOf.values()].sort(), [0, 0, 1]);
		});

		it('gives a different signature when a lane or a region moves, and the same for the same rows', () => {
			const base = topologySignature(deriveRegionTopology(layout([2, 2])));
			assert.equal(topologySignature(deriveRegionTopology(layout([2, 2]).reverse())), base);
			assert.notEqual(topologySignature(deriveRegionTopology([...layout([2, 2]), member('r0-n00', 'r0')])), base);
			assert.equal(topologySignature(deriveRegionTopology(layout([2]))), 'inactive');
		});
	});

	describe('links', () => {
		// harper-pro#1343's comparison table: region sizes, links, cross-region links
		for (const [sizes, total, crossRegion] of [
			[[3, 3, 3], 18, 9],
			[[4, 4, 4, 4, 4], 70, 40],
			[[4, 4, 2], 25, 12],
			[[6, 6, 2], 49, 18],
		]) {
			it(`${sizes.join(',')} has ${total} links, ${crossRegion} of them across regions`, () => {
				const members = layout(sizes);
				assert.deepEqual(linkCounts(deriveRegionTopology(members), names(members)), { total, crossRegion });
			});
		}

		it('puts at most 6 cross-region links on one node at 6,6,2', () => {
			const members = layout([6, 6, 2]);
			const topology = deriveRegionTopology(members);
			const nodes = names(members);
			const most = Math.max(
				...nodes.map(
					(node) =>
						nodes.filter(
							(peer) => topology.regionOf.get(peer) !== topology.regionOf.get(node) && gridLinks(topology, node, peer)
						).length
				)
			);
			assert.equal(most, 6);
		});

		it('uses a folded link one way: the small region receives every lane it carries, and is received by its own', () => {
			const topology = deriveRegionTopology(layout([6, 2]));
			assert.equal(columnCarrier(topology, 'r1', 3), 'r1-n1');
			assert.equal(receivesDirect(topology, 'r1-n1', 'r0-n3'), true);
			assert.equal(receivesDirect(topology, 'r0-n3', 'r1-n1'), false);
			assert.equal(receivesDirect(topology, 'r0-n1', 'r1-n1'), true);
			assert.equal(gridLinks(topology, 'r0-n3', 'r1-n1'), true);
			assert.deepEqual(supplierCandidates(topology, 'r0-n3', 'r1-n1'), ['r0-n1', 'r0-n0', 'r0-n2']);
		});

		it('never prunes a peer with no row, and links everything while inactive', () => {
			const topology = deriveRegionTopology(layout([2, 2]));
			assert.equal(receivesDirect(topology, 'r0-n0', 'stranger'), true);
			assert.equal(receivesDirect(topology, 'stranger', 'r0-n0'), true);
			assert.equal(supplierCandidates(topology, 'r0-n0', 'stranger'), undefined);
			const inactive = deriveRegionTopology(layout([2]));
			assert.equal(receivesDirect(inactive, 'r0-n0', 'r0-n1'), true);
			assert.equal(supplierCandidates(inactive, 'r0-n0', 'r0-n1'), undefined);
		});
	});

	describe('delivery in every layout', () => {
		const LAYOUTS = [
			[3, 3, 3],
			[4, 4, 4, 4, 4],
			[4, 4, 2],
			[6, 6, 2],
			[1, 1],
			[1, 1, 1],
			[1, 4],
			[3, 1, 2],
			[2, 5, 3],
		];
		for (const sizes of LAYOUTS) {
			describe(sizes.join(','), () => {
				const members = layout(sizes);
				const nodes = names(members);
				const topology = deriveRegionTopology(members);
				const everyone = new Set(nodes);

				it('agrees on every link from both ends', () => {
					for (const a of nodes)
						for (const b of nodes) assert.equal(gridLinks(topology, a, b), gridLinks(topology, b, a), `${a} ${b}`);
				});

				it('sends each write into each other region once, and to every other node through one relay', () => {
					const settled = settleAll(topology, nodes, everyone, undefined, 0);
					assertDelivery(topology, nodes, everyone, settled, 'all live');
					for (const origin of nodes) {
						const copies = nodes.filter(
							(node) =>
								topology.regionOf.get(node) !== topology.regionOf.get(origin) && receivesDirect(topology, node, origin)
						).length;
						assert.equal(copies, sizes.length - 1, `${origin} crosses regions ${copies} times`);
					}
				});

				it('still does after any one node is lost, and again once it is back', () => {
					const steady = settleAll(topology, nodes, everyone, undefined, 0);
					for (const lost of nodes) {
						const live = new Set(nodes.filter((name) => name !== lost));
						const lostAt = 100_000;
						const holding = settleAll(topology, nodes, live, steady, lostAt);
						for (const [key, assignment] of holding) {
							// the hold keeps a lost supplier, and nothing else moves
							assert.equal(assignment.supplier, steady.get(key).supplier, `${key} moved during the hold`);
						}
						const after = settleAll(topology, nodes, live, holding, lostAt + HOLD_MS);
						assertDelivery(topology, nodes, live, after, `without ${lost}`);
						const backAt = lostAt + 60_000;
						const waiting = settleAll(topology, nodes, everyone, after, backAt, () => backAt);
						assertDelivery(topology, nodes, live, waiting, `${lost} back but not yet stable`);
						const back = settleAll(topology, nodes, everyone, waiting, backAt + STABLE_MS, () => backAt);
						for (const [key, assignment] of back) {
							if (!key.startsWith(`${lost}/`))
								assert.equal(assignment.supplier, steady.get(key).supplier, `${key} did not return`);
						}
					}
				});

				it('forms no supplier cycle when nodes disagree about who is live', () => {
					// every node sees a different, arbitrary set of its region-mates as live
					let seed = 7;
					const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
					for (let round = 0; round < 50; round++) {
						const sees = new Map(nodes.map((node) => [node, new Set(nodes.filter(() => random() < 0.6))]));
						const supplierOf = (node, origin) => {
							const candidates = supplierCandidates(topology, node, origin);
							if (!candidates) return undefined;
							return settleSupplier(
								candidates,
								origin,
								{ qualifies: (name) => sees.get(node).has(name), qualifiedSince: () => 0 },
								{ supplier: origin },
								STABLE_MS,
								HOLD_MS,
								STABLE_MS
							).supplier;
						};
						for (const origin of nodes) {
							for (const start of nodes) {
								let node = start;
								for (let hops = 0; ; hops++) {
									assert.ok(hops <= nodes.length, `${start} loops on the way to ${origin}`);
									const supplier = supplierOf(node, origin);
									if (supplier === undefined || supplier === origin) break;
									assert.equal(topology.regionOf.get(supplier), topology.regionOf.get(node));
									node = supplier;
								}
							}
						}
					}
				});
			});
		}
	});

	describe('a lost carrier', () => {
		const members = layout([4, 4]);
		const nodes = names(members);
		const topology = deriveRegionTopology(members);

		it('hands its column to the lowest-named live node of the region, by a direct link', () => {
			const origin = 'r1-n2';
			assert.deepEqual(supplierCandidates(topology, 'r0-n3', origin), ['r0-n2', 'r0-n0', 'r0-n1']);
			const live = new Set(nodes.filter((name) => name !== 'r0-n2'));
			const steady = settleAll(topology, nodes, new Set(nodes), undefined, 0);
			const after = settleAll(topology, nodes, live, settleAll(topology, nodes, live, steady, 1000), 1000 + HOLD_MS);
			assert.equal(after.get(`r0-n0/${origin}`).supplier, origin);
			assert.equal(after.get(`r0-n1/${origin}`).supplier, 'r0-n0');
			assert.equal(after.get(`r0-n3/${origin}`).supplier, 'r0-n0');
		});

		it('passes to the next name when the lowest is lost too', () => {
			const origin = 'r1-n2';
			const live = new Set(nodes.filter((name) => name !== 'r0-n2' && name !== 'r0-n0'));
			const steady = settleAll(topology, nodes, new Set(nodes), undefined, 0);
			const after = settleAll(topology, nodes, live, settleAll(topology, nodes, live, steady, 1000), 1000 + HOLD_MS);
			assert.equal(after.get(`r0-n1/${origin}`).supplier, origin);
			assert.equal(after.get(`r0-n3/${origin}`).supplier, 'r0-n1');
		});
	});

	describe('settleSupplier', () => {
		const candidates = ['carrier', 'lower'];
		const settle = (qualified, previous, now, since = {}) =>
			settleSupplier(
				candidates,
				'origin',
				{ qualifies: (name) => qualified.includes(name), qualifiedSince: (name) => since[name] ?? 0 },
				previous,
				now,
				HOLD_MS,
				STABLE_MS
			);

		it('takes the best qualifying candidate at once when it has no supplier', () => {
			assert.deepEqual(settle(['carrier', 'lower'], undefined, 5), { supplier: 'carrier' });
			assert.deepEqual(settle(['lower'], undefined, 5), { supplier: 'lower' });
		});

		it('waits the stable time for a first candidate before linking to the origin itself', () => {
			const waiting = settle([], undefined, 100);
			assert.deepEqual(waiting, { ineligibleSince: 100, recheckAt: 100 + STABLE_MS });
			assert.deepEqual(settle([], waiting, 100 + STABLE_MS - 1), waiting);
			assert.deepEqual(settle(['carrier'], waiting, 5000), { supplier: 'carrier' });
			assert.deepEqual(settle([], waiting, 100 + STABLE_MS), { supplier: 'origin' });
		});

		it('keeps a supplier that stops qualifying for the hold, then moves to the best', () => {
			const held = settle(['lower'], { supplier: 'carrier' }, 1000);
			assert.deepEqual(held, { supplier: 'carrier', ineligibleSince: 1000, recheckAt: 1000 + HOLD_MS });
			assert.deepEqual(settle(['carrier', 'lower'], held, 2000), { supplier: 'carrier' });
			assert.deepEqual(settle(['lower'], held, 1000 + HOLD_MS), { supplier: 'lower' });
			assert.deepEqual(settle([], held, 1000 + HOLD_MS), { supplier: 'origin' });
		});

		it('yields to a better candidate only once it has qualified for the stable time', () => {
			const since = { carrier: 20_000 };
			assert.deepEqual(settle(['carrier', 'lower'], { supplier: 'lower' }, 21_000, since), {
				supplier: 'lower',
				recheckAt: 20_000 + STABLE_MS,
			});
			assert.deepEqual(settle(['carrier', 'lower'], { supplier: 'lower' }, 30_000, since), { supplier: 'carrier' });
			assert.deepEqual(settle(['lower'], { supplier: 'origin' }, 5000, { lower: 0 }), {
				supplier: 'origin',
				recheckAt: STABLE_MS,
			});
			assert.deepEqual(settle(['lower'], { supplier: 'origin' }, STABLE_MS, { lower: 0 }), { supplier: 'lower' });
		});

		it('never leaves a qualifying supplier for a worse one, and drops one that is no longer a candidate', () => {
			assert.deepEqual(settle(['carrier', 'lower'], { supplier: 'carrier' }, 99_000), { supplier: 'carrier' });
			const held = settle(['carrier'], { supplier: 'gone' }, 1000);
			assert.equal(held.supplier, 'gone');
			assert.deepEqual(settle(['carrier'], held, 1000 + HOLD_MS), { supplier: 'carrier' });
		});
	});

	describe('relievedSuppliers', () => {
		it('puts the supplier being relieved first, before those it relieved', () => {
			assert.deepEqual(relievedSuppliers(undefined), []);
			assert.deepEqual(relievedSuppliers({ supplier: 'east1' }), ['east1']);
			assert.deepEqual(relievedSuppliers({ supplier: 'east1', relieved: ['east2'] }), ['east1', 'east2']);
		});

		it('keeps every earlier supplier, so one relieved before it recorded anything hides none', () => {
			// the quiet join: east2 carried the origin, the joiner east1 took it while its link was copying, then the
			// node took the origin by a direct link
			const joinerAssigned = { supplier: 'east1', relieved: relievedSuppliers({ supplier: 'east2' }) };
			assert.deepEqual(relievedSuppliers(joinerAssigned), ['east1', 'east2']);
		});

		it('names each supplier once, most recent first, and counts a direct link as one', () => {
			assert.deepEqual(relievedSuppliers({ supplier: 'east2', relieved: ['east1', 'east2', 'origin'] }), [
				'east2',
				'east1',
				'origin',
			]);
			assert.deepEqual(relievedSuppliers({ supplier: 'origin', relieved: ['east1'] }), ['origin', 'east1']);
		});

		it('keeps the list unchanged through a time with no supplier', () => {
			assert.deepEqual(relievedSuppliers({ relieved: ['east1', 'east2'] }), ['east1', 'east2']);
		});

		it('keeps only the most recent suppliers once departed members would grow it', () => {
			let assignment;
			for (let i = 0; i < RELIEVED_SUPPLIER_LIMIT + 5; i++)
				assignment = { supplier: `member${i}`, relieved: relievedSuppliers(assignment) };
			const routes = relievedSuppliers(assignment);
			assert.strictEqual(routes.length, RELIEVED_SUPPLIER_LIMIT);
			assert.strictEqual(routes[0], `member${RELIEVED_SUPPLIER_LIMIT + 4}`);
		});
	});

	describe('orderFailoverCandidates', () => {
		it('keeps the shared ring order after the origin when no topology applies', () => {
			const sorted = ['a', 'b', 'c', 'd'];
			assert.deepEqual(orderFailoverCandidates(sorted, 1), ['c', 'd', 'a']);
			assert.deepEqual(orderFailoverCandidates(sorted, 3, deriveRegionTopology(layout([1]))), ['a', 'b', 'c']);
		});

		it('offers only peers that receive the origin directly, its own region first, and never this node', () => {
			const members = layout([3, 3, 3]);
			const topology = deriveRegionTopology(members);
			const sorted = names(members).sort();
			// the carrier of r1-n1's column in r0 lost its link to it
			assert.deepEqual(orderFailoverCandidates(sorted, sorted.indexOf('r1-n1'), topology, 'r0-n1'), [
				'r1-n2',
				'r1-n0',
				'r2-n1',
			]);
			// a region-mate lost its link: every other region-mate, then the column's carriers elsewhere
			assert.deepEqual(orderFailoverCandidates(sorted, sorted.indexOf('r1-n1'), topology, 'r1-n0'), [
				'r1-n2',
				'r2-n1',
				'r0-n1',
			]);
		});

		it("gives a node of another region the origin's region-mates to take a lost origin's log from", () => {
			const members = layout([3, 3, 1]);
			const topology = deriveRegionTopology(members);
			const sorted = names(members).sort();
			const mates = (origin, self) => originFallbackMates(sorted, sorted.indexOf(origin), topology, self);
			assert.deepEqual(mates('r1-n1', 'r0-n1'), ['r1-n2', 'r1-n0']);
			// a follower that took the origin over by a temporary link is covered too
			assert.deepEqual(mates('r1-n1', 'r0-n0'), ['r1-n2', 'r1-n0']);
			// within the origin's region a region-mate is already linked
			assert.deepEqual(mates('r1-n1', 'r1-n0'), []);
			// an origin alone in its region has nobody else holding its last writes
			assert.deepEqual(mates('r2-n0', 'r0-n0'), []);
			assert.deepEqual(originFallbackMates(sorted, 0, deriveRegionTopology([member('a', 'r0')]), 'r0-n0'), []);
		});
	});
});
