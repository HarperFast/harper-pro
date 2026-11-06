/** Stops a clone before it writes config or joins; the process keeps running, Unavailable, so a restart can correct it. */
export class CloneShardRefusedError extends Error {}

const SHARD_OPTION = '--shard or CLONE_SHARD';

function shardNumber(value: unknown, source: string): number {
	const shard = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (!Number.isInteger(shard) || (shard as number) < 0 || (shard as number) > 65535)
		throw new CloneShardRefusedError(
			`${source} must be an integer from 0 through 65535 or "auto", received ${JSON.stringify(value)}`
		);
	return shard as number;
}

export function parseShardOption(raw: unknown): number | 'auto' | undefined {
	if (raw === undefined || raw === '') return undefined;
	return raw === 'auto' ? 'auto' : shardNumber(raw, SHARD_OPTION);
}

export type ShardMember = { shard: unknown; live: boolean };

/** The leader and its peers with a shard, as the leader sees them; this node is excluded so a retry does not count itself. */
export function leaderShardMembers(leaderShard: unknown, leaderStatus: any, thisNode: string): ShardMember[] {
	const members: ShardMember[] = leaderShard == null ? [] : [{ shard: leaderShard, live: true }];
	for (const peer of leaderStatus?.connections ?? []) {
		if (peer?.shard == null || peer.name === thisNode) continue;
		members.push({ shard: peer.shard, live: Boolean(peer.database_sockets?.some((socket: any) => socket.connected)) });
	}
	return members;
}

/**
 * The listed shard with the fewest live members, lowest number on a tie. A shard whose registered members are all
 * offline is passed over: it has no source for this node's owned slots, so choosing it would stall the clone. A
 * shard with no members at all has nothing to copy.
 */
export function pickAutoShard(shards: readonly number[], members: readonly ShardMember[]): number | undefined {
	const registered = new Map(shards.map((shard) => [shard, 0]));
	const live = new Map(shards.map((shard) => [shard, 0]));
	for (const { shard, live: isLive } of members) {
		if (!registered.has(shard as number)) continue;
		registered.set(shard as number, registered.get(shard as number)! + 1);
		if (isLive) live.set(shard as number, live.get(shard as number)! + 1);
	}
	return shards
		.filter((shard) => !registered.get(shard) || live.get(shard))
		.sort((a, b) => live.get(a)! - live.get(b)! || a - b)[0];
}

function listedShards(value: unknown): number[] | undefined {
	if (value == null) return undefined;
	if (!Array.isArray(value)) throw new CloneShardRefusedError(`The leader's replication.shards is not a list`);
	return value.map((shard) => shardNumber(shard, `The leader's replication.shards entry`));
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
	thisNode,
}: {
	requested: unknown;
	configured?: unknown;
	/** The configured shard came only from a config file an older clone attempt wrote, so it may be the leader's. */
	configuredUnproven?: boolean;
	leaderShard?: unknown;
	leaderShards?: unknown;
	leaderStatus?: any;
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
	} else if (request === 'auto') {
		if (!list) {
			if (leaderShard == null && !Object.keys(leaderStatus?.sharding ?? {}).length)
				return { description: 'no shard: the leader is not sharded, so "auto" has nothing to fill' };
			throw new CloneShardRefusedError(
				`"auto" only fills shards listed in replication.shards, and the leader lists none; pass a shard number with ${SHARD_OPTION}`
			);
		}
		const members = leaderShardMembers(leaderShard, leaderStatus, thisNode);
		const picked = pickAutoShard(list, members);
		if (picked === undefined)
			throw new CloneShardRefusedError(
				`"auto" found no listed shard with a live member to copy from${listing}; pass a shard number with ${SHARD_OPTION}`
			);
		shard = picked;
		const liveCount = (candidate: number) =>
			members.filter((member) => member.shard === candidate && member.live).length;
		description = `shard ${shard} from "auto"; live members: ${list.map((candidate) => `${candidate}=${liveCount(candidate)}`).join(', ')}`;
	} else if (leaderShard != null || list) {
		throw new CloneShardRefusedError(
			`The leader is sharded and a clone does not inherit its shard: choose this node's shard with ${SHARD_OPTION}, ` +
				`as a number or "auto"${listing}`
		);
	} else return { description: 'no shard: the leader is not sharded' };

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
}: {
	durable: number | undefined;
	requested: unknown;
	configured: unknown;
}): void {
	if (durable === undefined) return;
	const request = parseShardOption(requested);
	const local = configured == null ? undefined : shardNumber(configured, 'replication.shard');
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
