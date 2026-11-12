/**
 * Fresh setup refuses before it writes config or joins, and the process keeps running, Unavailable, so a restart can
 * correct it. A resumed clone refuses before Harper starts, which exits, since it would come up as the wrong shard.
 */
export class CloneShardRefusedError extends Error {}

const SHARD_OPTION = '--shard or CLONE_SHARD';

function shardNumber(value: unknown, source: string): number {
	const shard = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (!Number.isInteger(shard) || (shard as number) < 0 || (shard as number) > 65535)
		throw new CloneShardRefusedError(
			`${source} must be an integer from 0 through 65535, "auto" or "replica", received ${JSON.stringify(value)}`
		);
	return shard as number;
}

export function parseShardOption(raw: unknown): number | 'auto' | 'replica' | undefined {
	if (raw === undefined || raw === '') return undefined;
	return raw === 'auto' || raw === 'replica' ? raw : shardNumber(raw, SHARD_OPTION);
}

export function slotOwningShards(maps: readonly any[] | undefined): Set<number> | undefined {
	if (!maps?.length) return undefined;
	const owning = new Set<number>();
	for (const map of maps) {
		if (!Array.isArray(map?.ranges))
			throw new Error(`The leader's shard map for '${map?.database}' has no slot ranges`);
		for (const range of map.ranges) {
			if (!Number.isInteger(range?.shard))
				throw new Error(`The leader's shard map for '${map.database}' has a range with no shard`);
			if (range.end > range.start) owning.add(range.shard);
		}
	}
	return owning;
}

export type ShardMember = { shard: unknown; live: boolean };

/** Excludes this node, so a retry does not count itself. */
export function leaderShardMembers(leaderShard: unknown, leaderStatus: any, thisNode: string): ShardMember[] {
	const members: ShardMember[] = leaderShard == null ? [] : [{ shard: leaderShard, live: true }];
	for (const peer of leaderStatus?.connections ?? []) {
		if (peer?.shard == null || peer.name === thisNode) continue;
		members.push({ shard: peer.shard, live: Boolean(peer.database_sockets?.some((socket: any) => socket.connected)) });
	}
	return members;
}

function memberCounts(shards: readonly number[], members: readonly ShardMember[]) {
	const registered = new Map(shards.map((shard) => [shard, 0]));
	const live = new Map(shards.map((shard) => [shard, 0]));
	for (const { shard, live: isLive } of members) {
		if (!registered.has(shard as number)) continue;
		registered.set(shard as number, registered.get(shard as number)! + 1);
		if (isLive) live.set(shard as number, live.get(shard as number)! + 1);
	}
	return { registered, live };
}

/**
 * The listed shard owning slots with the fewest live members, lowest number on a tie: a backbone node placed in a shard
 * owning nothing would hold nothing. A shard whose registered members are all offline is passed over: it has no source
 * for this node's owned slots, so choosing it would stall the clone. A shard with no members at all has nothing to copy.
 */
export function pickAutoShard(
	shards: readonly number[],
	members: readonly ShardMember[],
	owning?: ReadonlySet<number>
): number | undefined {
	const { registered, live } = memberCounts(shards, members);
	return shards
		.filter((shard) => (!owning || owning.has(shard)) && (!registered.get(shard) || live.get(shard)))
		.sort((a, b) => live.get(a)! - live.get(b)! || a - b)[0];
}

/**
 * The listed shard owning no slots with the most live members, lowest number on a tie, so replica nodes group into
 * one shard unless told otherwise. With spares listed, only a spare qualifies: a non-spare owning nothing today gets
 * slots from the next default map. A node owning no slots bootstraps from any peer, so liveness does not filter.
 */
export function pickReplicaShard(
	shards: readonly number[],
	members: readonly ShardMember[],
	owning: ReadonlySet<number>,
	spares?: ReadonlySet<number>
): number | undefined {
	const { live } = memberCounts(shards, members);
	return shards
		.filter((shard) => !owning.has(shard) && (!spares || spares.has(shard)))
		.sort((a, b) => live.get(b)! - live.get(a)! || a - b)[0];
}

function listedShards(value: unknown, setting = 'replication.shards'): number[] | undefined {
	if (value == null) return undefined;
	if (!Array.isArray(value)) throw new CloneShardRefusedError(`The leader's ${setting} is not a list`);
	return value.map((shard) => shardNumber(shard, `The leader's ${setting} entry`));
}

/**
 * A shard is node identity: owned slots, origin history and membership bind to it, and changing it takes a fresh
 * root and a new node name. So a clone chooses one and never copies the leader's, and an explicit choice that
 * disagrees with this node's configuration refuses rather than being silently overridden at the next start.
 */
export function chooseCloneShard({
	requested,
	configured,
	configuredUnproven = false,
	leaderShard,
	leaderShards,
	leaderStatus,
	leaderMaps,
	leaderSpareShards,
	thisNode,
}: {
	requested: unknown;
	configured?: unknown;
	/** The configured shard came only from a config file an older clone attempt wrote, so it may be the leader's. */
	configuredUnproven?: boolean;
	leaderShard?: unknown;
	leaderShards?: unknown;
	leaderStatus?: any;
	leaderMaps?: readonly any[];
	leaderSpareShards?: unknown;
	thisNode: string;
}): { shard?: number; description: string } {
	const request = parseShardOption(requested);
	const local = configured == null ? undefined : shardNumber(configured, 'replication.shard');
	const list = listedShards(leaderShards);
	const listing = list ? ` (the leader's replication.shards is [${list.join(', ')}])` : '';
	let shard: number;
	let description: string;

	if (local !== undefined && configuredUnproven && local !== request)
		throw new CloneShardRefusedError(
			`replication.shard ${local} on this node was left by an earlier clone attempt and may be the leader's own shard; ` +
				`pass the shard this node should hold with ${SHARD_OPTION}, as a number${listing}`
		);
	if (typeof request === 'number') {
		if (local !== undefined && local !== request)
			throw new CloneShardRefusedError(
				`${SHARD_OPTION} asks for shard ${request} but this node is configured for shard ${local}; ` +
					'correct the option or the configuration, or clone onto a fresh root to change it'
			);
		shard = request;
		description = `shard ${shard} from ${SHARD_OPTION}`;
	} else if (local !== undefined) {
		shard = local;
		description = `shard ${shard} from this node's configuration`;
	} else if (request === 'auto' || request === 'replica') {
		if (!list) {
			if (request === 'auto' && leaderShard == null && !Object.keys(leaderStatus?.sharding ?? {}).length)
				return { description: 'no shard: the leader is not sharded, so "auto" has nothing to fill' };
			throw new CloneShardRefusedError(
				`"${request}" only fills shards listed in replication.shards, and the leader lists none; pass a shard number with ${SHARD_OPTION}`
			);
		}
		const members = leaderShardMembers(leaderShard, leaderStatus, thisNode);
		const spareList =
			leaderSpareShards == null ? undefined : listedShards(leaderSpareShards, 'replication.spareShards');
		const spares = spareList?.length ? new Set(spareList) : undefined;
		const owning = slotOwningShards(leaderMaps) ?? (spares ? new Set(list.filter((id) => !spares.has(id))) : undefined);
		const owners = owning ? `; shards owning slots: [${[...owning].sort((a, b) => a - b).join(', ')}]` : '';
		const spareListing = spares ? `; replication.spareShards is [${spareList.join(', ')}]` : '';
		let picked: number | undefined;
		if (request === 'auto') {
			picked = pickAutoShard(list, members, owning);
			if (picked === undefined)
				throw new CloneShardRefusedError(
					`"auto" found no listed shard with a live member to copy from${listing}${owners}; pass a shard number with ${SHARD_OPTION}`
				);
		} else {
			if (!owning)
				throw new CloneShardRefusedError(
					`"replica" needs a listed shard owning no slots, but the leader has no shard map and lists no spare shards, so the default map will give every listed shard slots${listing}`
				);
			picked = pickReplicaShard(list, members, owning, spares);
			if (picked === undefined)
				throw new CloneShardRefusedError(
					`"replica" found no ${spares ? 'spare' : 'listed'} shard owning no slots${listing}${owners}${spareListing}; list a spare shard ID first`
				);
		}
		shard = picked;
		const liveCount = (candidate: number) =>
			members.filter((member) => member.shard === candidate && member.live).length;
		description = `shard ${shard} from "${request}"; live members: ${list.map((candidate) => `${candidate}=${liveCount(candidate)}`).join(', ')}${owners}`;
	} else if (leaderShard != null || list) {
		throw new CloneShardRefusedError(
			`The leader is sharded and a clone does not inherit its shard: choose this node's shard with ${SHARD_OPTION}, ` +
				`as a number, "auto" or "replica"${listing}`
		);
	} else {
		// A leader with neither holds no slots, and a clone of it may do the same: the documented fast clone.
		return {
			description: Object.keys(leaderStatus?.sharding ?? {}).length
				? 'no shard: the leader owns no slots, so this node will own none'
				: 'no shard: the leader is not sharded',
		};
	}

	if (list && !list.includes(shard))
		throw new CloneShardRefusedError(`Shard ${shard} is not in the leader's replication.shards [${list.join(', ')}]`);
	return { shard, description };
}

/**
 * A clone that has picked a shard keeps it: its owned copy and its membership row may already be bound to it. A
 * restart whose option or configuration now says otherwise would start the node as a different shard.
 */
export function assertResumedShard({
	durable,
	requested,
	configured,
	joined,
}: {
	durable: number | undefined;
	requested: unknown;
	configured: unknown;
	/** It has joined, so setup will not run again to write the shard back. */
	joined: boolean;
}): void {
	if (durable === undefined) return;
	const request = parseShardOption(requested);
	const local = configured == null ? undefined : shardNumber(configured, 'replication.shard');
	if (joined && local === undefined)
		throw new CloneShardRefusedError(
			`replication.shard is missing but this clone is in progress as shard ${durable}; restore it`
		);
	for (const [source, shard] of [
		[SHARD_OPTION, request],
		['replication.shard', local],
	] as const) {
		if (typeof shard === 'number' && shard !== durable)
			throw new CloneShardRefusedError(
				`${source} says shard ${shard} but this clone is in progress as shard ${durable}; ` +
					'correct it, or clone onto a fresh root to change shards'
			);
	}
}

/** `search_by_id` omits a missing row, so an array alone does not show every requested map was read. */
export function requireLeaderMaps(databases: readonly string[], answer: unknown): any[] {
	if (!Array.isArray(answer)) throw new Error(`The leader answered its shard map read with ${typeof answer}`);
	const missing = databases.filter((database) => !answer.some((map) => map?.database === database));
	if (missing.length)
		throw new Error(`The leader reports ${missing.join(', ')} as sharded but has no shard map for it`);
	return answer;
}
