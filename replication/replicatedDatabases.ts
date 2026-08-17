export function isReplicatedDatabase(
	databaseReplications: unknown,
	dbName: string,
	shardedReplicates: (entry: any) => boolean = () => true,
	nonArrayFallback: boolean = true
): boolean {
	if (!databaseReplications || databaseReplications === '*') return true;
	if (!Array.isArray(databaseReplications)) return nonArrayFallback;
	return databaseReplications.some((entry: any) =>
		typeof entry === 'string'
			? entry === dbName
			: entry?.name === dbName && (!entry.sharded || shardedReplicates(entry))
	);
}

export function isExplicitDatabaseSubscription(subscriptions: unknown, dbName: string): boolean {
	return (
		Array.isArray(subscriptions) &&
		subscriptions.some(
			(sub) => sub && typeof sub === 'object' && (sub.database || sub.schema) === dbName && sub.subscribe
		)
	);
}
