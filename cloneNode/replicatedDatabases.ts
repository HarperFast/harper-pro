/**
 * Whether `dbName` is replicated under a `replication.databases` config value, mirroring the
 * name/shard gating of `shouldReplicateFromNode` (`replication/knownNodes.ts`): `undefined` or
 * `'*'` accept everything; an array accepts the names it lists, and a sharded entry only when
 * `shardedReplicates` accepts it (same-shard leader). Callers that cannot evaluate the shard
 * predicate must pass a fail-closed (always-true) predicate: a wrong inclusion stalls the clone
 * visibly, while a wrong exclusion would skip verification of a database that is being copied.
 */
export function isReplicatedDatabase(
	databaseReplications: unknown,
	dbName: string,
	shardedReplicates: (entry: any) => boolean = () => true
): boolean {
	if (!databaseReplications || databaseReplications === '*') return true;
	if (!Array.isArray(databaseReplications)) return true;
	return databaseReplications.some((entry: any) =>
		typeof entry === 'string'
			? entry === dbName
			: entry?.name === dbName && (!entry.sharded || shardedReplicates(entry))
	);
}
