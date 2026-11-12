/**
 * Region × column replication topology (harper-pro#1343). Pure functions over `hdb_nodes` rows: whether the grid is
 * active, each node's column, which origins a node receives directly, and who may supply an origin it does not.
 * Callers own the rows, liveness and timing.
 */

export interface TopologyMember {
	name: string;
	region?: unknown;
	shard?: unknown;
	replicates?: unknown;
}

export interface RegionTopology {
	active: boolean;
	/** Why the topology is off, naming the member that turned it off. */
	inactiveReason?: string;
	regionOf: Map<string, string>;
	/** Each node's column number. Columns are numbered across the cluster in (shard, lane) order. */
	columnOf: Map<string, number>;
	/** Each region's members in column order. */
	membersByRegion: Map<string, string[]>;
}

const MAX_REGION_LENGTH = 256;

/** A region label, trimmed, so a stray space cannot make two regions of one. */
export function validRegion(value: unknown): string | undefined {
	if (typeof value !== 'string') return;
	const region = value.trim();
	return region !== '' && region.length <= MAX_REGION_LENGTH ? region : undefined;
}

// Code-unit order, never locale order: every node must rank the same names the same way.
function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

type Shard = number | string | undefined;

function shardOf(value: unknown): Shard {
	return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

/** No shard first, then numbers in numeric order, then strings. */
function compareShards(a: Shard, b: Shard): number {
	const rank = (shard: Shard) => (shard === undefined ? 0 : typeof shard === 'number' ? 1 : 2);
	if (rank(a) !== rank(b)) return rank(a) - rank(b);
	if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
	return a === undefined || b === undefined ? 0 : compareNames(String(a), String(b));
}

/**
 * Active only when every member carries a valid region and replicates fully (`replicates: true`), across at least two
 * regions: a directional record can filter tables per route, and an unlabeled member is an older version or an
 * unconfigured node, either of which keeps the cluster on today's full mesh.
 *
 * A node's column is (shard, lane). The lane is derived, not stored: the node's rank by name among the members of its
 * region with the same shard, so a join or a leave can move the lanes of the names after it.
 */
export function deriveRegionTopology(members: Iterable<TopologyMember>): RegionTopology {
	const regionOf = new Map<string, string>();
	const columnOf = new Map<string, number>();
	const membersByRegion = new Map<string, string[]>();
	const inactive = (inactiveReason: string): RegionTopology => ({
		active: false,
		inactiveReason,
		regionOf,
		columnOf,
		membersByRegion,
	});
	const shards = new Map<string, Shard>();
	for (const member of members) {
		if (!member?.name) continue;
		const region = validRegion(member.region);
		if (region === undefined) return inactive(`node ${member.name} has no region`);
		if (member.replicates !== true)
			return inactive(
				member.replicates
					? `node ${member.name} uses directional replication`
					: `node ${member.name} does not replicate`
			);
		if (regionOf.has(member.name)) continue;
		regionOf.set(member.name, region);
		shards.set(member.name, shardOf(member.shard));
		let regionMembers = membersByRegion.get(region);
		if (!regionMembers) membersByRegion.set(region, (regionMembers = []));
		regionMembers.push(member.name);
	}
	if (membersByRegion.size < 2) return inactive('fewer than two regions');
	const columnKeys = new Map<string, { shard: Shard; lane: number }>();
	for (const regionMembers of membersByRegion.values()) {
		regionMembers.sort((a, b) => compareShards(shards.get(a), shards.get(b)) || compareNames(a, b));
		let lane = 0;
		regionMembers.forEach((name, index) => {
			lane = index > 0 && compareShards(shards.get(regionMembers[index - 1]), shards.get(name)) === 0 ? lane + 1 : 0;
			columnKeys.set(name, { shard: shards.get(name), lane });
		});
	}
	const columns = [...columnKeys.values()].sort((a, b) => compareShards(a.shard, b.shard) || a.lane - b.lane);
	const numbered: { shard: Shard; lane: number }[] = [];
	for (const column of columns) {
		const last = numbered.at(-1);
		if (!last || compareShards(last.shard, column.shard) !== 0 || last.lane !== column.lane) numbered.push(column);
	}
	for (const [name, key] of columnKeys) {
		columnOf.set(
			name,
			numbered.findIndex((column) => compareShards(column.shard, key.shard) === 0 && column.lane === key.lane)
		);
	}
	return { active: true, regionOf, columnOf, membersByRegion };
}

/**
 * The member of `region` that receives `column`'s origins from other regions: the member in that column, else, by
 * folding, member `column mod m` of the region's `m` members in column order. So every region has exactly one carrier
 * for every column, and a region smaller than the widest one carries several columns per node.
 */
export function columnCarrier(topology: RegionTopology, region: string, column: number): string | undefined {
	const members = topology.membersByRegion.get(region);
	if (!members?.length) return;
	return members.find((name) => topology.columnOf.get(name) === column) ?? members[column % members.length];
}

/**
 * Whether `selfName` subscribes to `originName` itself: its region-mates, and the origins whose column it carries
 * for its region. A peer that is not a member (no row yet) keeps a direct link: unknown is never pruned.
 */
export function receivesDirect(topology: RegionTopology, selfName: string, originName: string): boolean {
	if (!topology.active) return true;
	const selfRegion = topology.regionOf.get(selfName);
	const originRegion = topology.regionOf.get(originName);
	if (selfRegion === undefined || originRegion === undefined || selfRegion === originRegion) return true;
	return columnCarrier(topology, selfRegion, topology.columnOf.get(originName)!) === selfName;
}

/**
 * Whether two nodes hold a connection in either direction. Between regions of different sizes a folded link is one
 * subscription, not two: the smaller region's node receives every column it carries, and of those columns' nodes only
 * the one in its own column receives it back.
 */
export function gridLinks(topology: RegionTopology, a: string, b: string): boolean {
	return a !== b && (receivesDirect(topology, a, b) || receivesDirect(topology, b, a));
}

export function topologySignature(topology: RegionTopology): string {
	if (!topology.active) return 'inactive';
	return JSON.stringify([[...topology.regionOf].sort(), [...topology.columnOf].sort()]);
}

/**
 * Failover candidates for the origin at `originIndex` in `sortedNames` when this node's own link to it drops: the
 * shared ring order after the origin, with peers in the origin's region first when regions are set, so a broken link
 * prefers a peer that holds everything the origin's region does. Under an active topology only peers that receive
 * the origin directly qualify: a peer that takes the origin through this node, or through another relay, could
 * otherwise be asked to supply it back.
 */
export function orderFailoverCandidates(
	sortedNames: string[],
	originIndex: number,
	topology?: RegionTopology,
	selfName?: string
): string[] {
	const origin = sortedNames[originIndex];
	const ring: string[] = [];
	for (let offset = 1; offset < sortedNames.length; offset++) {
		ring.push(sortedNames[(originIndex + offset) % sortedNames.length]);
	}
	const originRegion = topology?.active ? topology.regionOf.get(origin) : undefined;
	if (originRegion === undefined) return ring;
	const eligible = ring.filter((name) => name !== selfName && receivesDirect(topology!, name, origin));
	const inRegion = eligible.filter((name) => topology!.regionOf.get(name) === originRegion);
	return [...inRegion, ...eligible.filter((name) => !inRegion.includes(name))];
}

/**
 * Who may supply `originName`'s writes to `selfName` when it does not receive that origin directly, best first, or
 * undefined when the origin is not topology-managed. First the carrier of the origin's column in this node's region,
 * which receives the origin directly; then this node's lower-named region-mates, one of which takes the origin by a
 * temporary direct link when the carrier is lost. When none qualifies this node links to the origin itself, so the
 * lowest-named live node of a region is the one that takes a lost carrier's column.
 *
 * Every edge goes to the carrier or to a strictly lower name in the same region, and the carrier takes its own
 * column from no region-mate, so no cycle forms.
 */
export function supplierCandidates(
	topology: RegionTopology,
	selfName: string,
	originName: string
): string[] | undefined {
	if (!topology.active || originName === selfName || receivesDirect(topology, selfName, originName)) return;
	const selfRegion = topology.regionOf.get(selfName)!;
	const carrier = columnCarrier(topology, selfRegion, topology.columnOf.get(originName)!)!;
	const lowerMates = topology.membersByRegion
		.get(selfRegion)!
		.filter((name) => name !== carrier && name < selfName)
		.sort(compareNames);
	return [carrier, ...lowerMates];
}

export interface SupplierState {
	/** The peer's link to this node can supply relayed origins now. */
	qualifies(name: string): boolean;
	qualifiedSince(name: string): number;
}

export interface SupplierAssignment {
	/** The origin's own name when this node links to the origin itself; undefined while no supplier is settled. */
	supplier?: string;
	/** When the assigned supplier stopped qualifying, or when this node began waiting for a first one. */
	ineligibleSince?: number;
	/** When to settle again because a hold or a stability wait ends. */
	recheckAt?: number;
}

/**
 * Settles one origin's supplier with hysteresis, so a brief disconnect or a peer that just came back does not move
 * the origin back and forth: the current supplier keeps the assignment for `holdMs` after it stops qualifying, and
 * yields to a better-ranked candidate only once that candidate has qualified for `stableMs`. The origin's own name
 * is the last resort and always qualifies: the caller then subscribes to the origin directly.
 *
 * With no supplier yet (startup, or a topology that just turned on) this node waits `stableMs` for a candidate before
 * taking the direct link, so a restart does not open a link to every remote origin while its region's links come up.
 * Until then the supplier is undefined, and the caller excludes the origin nowhere.
 */
export function settleSupplier(
	candidates: string[],
	originName: string,
	state: SupplierState,
	previous: SupplierAssignment | undefined,
	now: number,
	holdMs: number,
	stableMs: number
): SupplierAssignment {
	const rankOf = (name: string): number => {
		if (name === originName) return candidates.length;
		const index = candidates.indexOf(name);
		return index !== -1 && state.qualifies(name) ? index : Infinity;
	};
	let best = originName;
	let bestRank = candidates.length;
	for (const name of candidates) {
		const rank = rankOf(name);
		if (rank < bestRank) {
			best = name;
			bestRank = rank;
		}
	}
	const current = previous?.supplier;
	if (current === undefined) {
		if (best !== originName) return { supplier: best };
		const waitingSince = previous?.ineligibleSince ?? now;
		if (now - waitingSince < stableMs) return { ineligibleSince: waitingSince, recheckAt: waitingSince + stableMs };
		return { supplier: originName };
	}
	const currentRank = rankOf(current);
	if (currentRank === Infinity) {
		const ineligibleSince = previous!.ineligibleSince ?? now;
		if (now - ineligibleSince < holdMs)
			return { supplier: current, ineligibleSince, recheckAt: ineligibleSince + holdMs };
		return { supplier: best };
	}
	if (best === current || bestRank >= currentRank) return { supplier: current };
	const stableAt = state.qualifiedSince(best) + stableMs;
	if (now >= stableAt) return { supplier: best };
	return { supplier: current, recheckAt: stableAt };
}
