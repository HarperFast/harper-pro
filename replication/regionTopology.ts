/**
 * Region-aware replication topology (harper-pro#1291). Pure functions over `hdb_nodes` rows: whether the
 * topology is active, each region's gateways, which peers a node subscribes to, and which link supplies an
 * origin it has no direct link to. Callers own the rows, liveness and timing.
 */

export interface TopologyMember {
	name: string;
	region?: unknown;
	gateway?: unknown;
	replicates?: unknown;
}

export interface RegionTopology {
	active: boolean;
	/** Why the topology is off, naming the member or region that turned it off. */
	inactiveReason?: string;
	regionOf: Map<string, string>;
	/** Each region's gateways, lowest name first. */
	gatewaysByRegion: Map<string, string[]>;
}

const MAX_REGION_LENGTH = 256;
const AUTO_GATEWAYS_PER_REGION = 2;

export function validRegion(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_REGION_LENGTH ? value : undefined;
}

function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Active only when every member carries a valid region and replicates fully (`replicates: true`): a directional
 * record can filter tables per route, and an unlabeled member is an older version or an unconfigured node, either of
 * which keeps the cluster on today's full mesh. A region whose members all set `gateway: false` has no path out, so
 * it turns the topology off too.
 */
export function deriveRegionTopology(members: Iterable<TopologyMember>): RegionTopology {
	const regionOf = new Map<string, string>();
	const membersByRegion = new Map<string, TopologyMember[]>();
	const gatewaysByRegion = new Map<string, string[]>();
	const inactive = (inactiveReason: string): RegionTopology => ({
		active: false,
		inactiveReason,
		regionOf,
		gatewaysByRegion,
	});
	for (const member of members) {
		if (!member?.name) continue;
		const region = validRegion(member.region);
		if (region === undefined) return inactive(`node ${member.name} has no region`);
		if (member.replicates !== true) return inactive(`node ${member.name} uses directional replication`);
		regionOf.set(member.name, region);
		let regionMembers = membersByRegion.get(region);
		if (!regionMembers) membersByRegion.set(region, (regionMembers = []));
		regionMembers.push(member);
	}
	if (membersByRegion.size < 2) return inactive('fewer than two regions');
	for (const [region, regionMembers] of membersByRegion) {
		regionMembers.sort((a, b) => compareNames(a.name, b.name));
		const gateways = regionMembers.filter((member) => member.gateway === true).map((member) => member.name);
		for (const member of regionMembers) {
			if (gateways.length >= AUTO_GATEWAYS_PER_REGION) break;
			if (member.gateway !== false && member.gateway !== true) gateways.push(member.name);
		}
		if (gateways.length === 0) return inactive(`region ${region} has no gateway`);
		gatewaysByRegion.set(region, gateways.sort(compareNames));
	}
	return { active: true, regionOf, gatewaysByRegion };
}

export function isGateway(topology: RegionTopology, name: string): boolean {
	const region = topology.regionOf.get(name);
	return region !== undefined && topology.gatewaysByRegion.get(region)!.includes(name);
}

/** A peer that is not a member (no row yet) keeps a direct link: unknown is never pruned. */
export function topologyAllowsDirect(topology: RegionTopology, selfName: string, peerName: string): boolean {
	if (!topology.active) return true;
	const selfRegion = topology.regionOf.get(selfName);
	const peerRegion = topology.regionOf.get(peerName);
	if (selfRegion === undefined || peerRegion === undefined || selfRegion === peerRegion) return true;
	return isGateway(topology, selfName) && isGateway(topology, peerName);
}

/** Equal for two topologies that give every node the same links. */
export function topologySignature(topology: RegionTopology): string {
	if (!topology.active) return 'inactive';
	return JSON.stringify([[...topology.regionOf].sort(), [...topology.gatewaysByRegion].sort()]);
}

const LATENCY_BUCKET_CEILING = 30;

/** Doubling buckets (≤1, ≤2, ≤4 … ms); an unmeasured link sorts last. */
export function latencyBucket(latency: number | undefined): number {
	if (latency === undefined || !(latency > 0) || !Number.isFinite(latency)) return LATENCY_BUCKET_CEILING;
	return Math.min(LATENCY_BUCKET_CEILING - 1, Math.max(0, Math.ceil(Math.log2(latency))));
}

/**
 * Failover candidates for the origin at `originIndex` in `sortedNames`: ring order after the origin, stably sorted
 * by latency bucket, so peers that tie on bucket keep the deterministic ring order failover has always used.
 */
export function orderFailoverCandidates(
	sortedNames: string[],
	originIndex: number,
	latencyOf: (name: string) => number | undefined
): string[] {
	const ring: string[] = [];
	for (let offset = 1; offset < sortedNames.length; offset++) {
		ring.push(sortedNames[(originIndex + offset) % sortedNames.length]);
	}
	const buckets = new Map(ring.map((name) => [name, latencyBucket(latencyOf(name))]));
	return ring.sort((a, b) => buckets.get(a)! - buckets.get(b)!);
}

/**
 * Who may supply `originName`'s writes to `selfName` when the two have no direct link, best first, or undefined
 * when the origin is not topology-managed. `reachTier` candidates qualify only while they report a caught-up link to
 * the origin's region; `liveTier` candidates while their link to this node is live. A leaf takes remote origins from
 * its own region's gateways, and only from one that reports the region: a gateway that lost its WAN must not hold the
 * origin while another has it. A gateway takes them from a lower-named gateway of its own region that reports the
 * region (so one gateway per region imports it), else from the origin region's gateways directly. Every exclusive
 * edge points to a lower-named gateway in the same region or into the origin's region, so no cycle forms.
 */
export function supplierCandidates(
	topology: RegionTopology,
	selfName: string,
	originName: string
): { region: string; reachTier: string[]; liveTier: string[]; preemptLiveTier: boolean } | undefined {
	if (!topology.active || originName === selfName || topologyAllowsDirect(topology, selfName, originName)) return;
	const selfRegion = topology.regionOf.get(selfName)!;
	const region = topology.regionOf.get(originName)!;
	const ownGateways = topology.gatewaysByRegion.get(selfRegion)!.filter((name) => name !== selfName);
	if (!isGateway(topology, selfName)) {
		return { region, reachTier: ownGateways, liveTier: [], preemptLiveTier: true };
	}
	return {
		region,
		reachTier: ownGateways.filter((name) => name < selfName),
		liveTier: topology.gatewaysByRegion.get(region)!,
		preemptLiveTier: false,
	};
}

export interface SupplierState {
	isLive(name: string): boolean;
	liveSince(name: string): number;
	reaches(name: string, region: string): boolean;
	reachSince(name: string, region: string): number;
}

export interface SupplierAssignment {
	supplier?: string;
	/** When the assigned supplier stopped qualifying; it keeps the assignment for `holdMs` after. */
	ineligibleSince?: number;
	/** When to settle again because a hold or a stability wait ends. */
	recheckAt?: number;
}

/**
 * Settles one origin's supplier with hysteresis, so a brief disconnect or a peer that just came back does not move
 * the origin back and forth: the current supplier keeps the assignment for `holdMs` after it stops qualifying, and
 * yields to a better-ranked candidate only once that candidate has qualified for `stableMs`. A better remote gateway
 * never preempts (`preemptLiveTier` false): it may still be catching up on its own region. Undefined means no
 * candidate qualifies, and the caller excludes the origin nowhere.
 */
export function settleSupplier(
	candidates: { region: string; reachTier: string[]; liveTier: string[]; preemptLiveTier: boolean },
	state: SupplierState,
	previous: SupplierAssignment | undefined,
	now: number,
	holdMs: number,
	stableMs: number
): SupplierAssignment {
	const { region, reachTier, liveTier, preemptLiveTier } = candidates;
	const rankOf = (name: string): number => {
		if (!state.isLive(name)) return Infinity;
		const reachIndex = reachTier.indexOf(name);
		if (reachIndex !== -1 && state.reaches(name, region)) return reachIndex;
		const liveIndex = liveTier.indexOf(name);
		return liveIndex === -1 ? Infinity : reachTier.length + liveIndex;
	};
	const qualifiedSince = (name: string, rank: number): number =>
		rank < reachTier.length ? Math.max(state.liveSince(name), state.reachSince(name, region)) : state.liveSince(name);
	let best: string | undefined;
	let bestRank = Infinity;
	for (const name of new Set([...reachTier, ...liveTier])) {
		const rank = rankOf(name);
		if (rank < bestRank) {
			best = name;
			bestRank = rank;
		}
	}
	const current = previous?.supplier;
	if (current === undefined) return { supplier: best };
	const currentRank = rankOf(current);
	if (currentRank === Infinity) {
		const ineligibleSince = previous.ineligibleSince ?? now;
		if (now - ineligibleSince < holdMs)
			return { supplier: current, ineligibleSince, recheckAt: ineligibleSince + holdMs };
		return { supplier: best };
	}
	if (best === undefined || best === current || bestRank >= currentRank) return { supplier: current };
	if (bestRank >= reachTier.length && !preemptLiveTier) return { supplier: current };
	const stableAt = qualifiedSince(best, bestRank) + stableMs;
	if (now >= stableAt) return { supplier: best };
	return { supplier: current, recheckAt: stableAt };
}
