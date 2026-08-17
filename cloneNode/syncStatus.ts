type CloneTargetResult = {
	targets: Record<string, number>;
	errors: string[];
};

type CloneSyncResult = {
	synced: boolean;
	reason?: string;
};

export const CLONE_SYNC_BASELINE_VERSION = 1;

export function validateCloneSyncBaseline(persisted: any, leaderURL: string): number {
	if (
		persisted?.version !== CLONE_SYNC_BASELINE_VERSION ||
		persisted.leaderURL !== leaderURL ||
		typeof persisted.leaderBaseline !== 'number' ||
		!Number.isFinite(persisted.leaderBaseline) ||
		persisted.leaderBaseline <= 0
	) {
		throw new Error('Persisted clone synchronization baseline does not match this clone attempt');
	}
	return persisted.leaderBaseline;
}

export function isReplicatedDatabase(databaseReplications: unknown, databaseName: string): boolean {
	if (!databaseReplications || databaseReplications === '*') return true;
	if (!Array.isArray(databaseReplications)) return true;
	return databaseReplications.some((entry) =>
		typeof entry === 'string' ? entry === databaseName : entry?.name === databaseName
	);
}

export function deriveCloneTargets(
	databaseDescriptions: Record<string, unknown>,
	databaseReplications: unknown,
	leaderBaseline: unknown
): CloneTargetResult {
	const targets = Object.create(null) as Record<string, number>;
	const errors: string[] = [];
	if (typeof leaderBaseline !== 'number' || !Number.isFinite(leaderBaseline) || leaderBaseline <= 0) {
		return { targets, errors: ['Leader did not return a valid current time'] };
	}

	for (const [databaseName, databaseDescription] of Object.entries(databaseDescriptions)) {
		if (!isReplicatedDatabase(databaseReplications, databaseName)) continue;
		if (!databaseDescription || typeof databaseDescription !== 'object') {
			errors.push(`Leader returned no valid description for database ${databaseName}`);
			continue;
		}
		targets[databaseName] = leaderBaseline;
	}

	if (Array.isArray(databaseReplications)) {
		for (const entry of databaseReplications) {
			const databaseName = typeof entry === 'string' ? entry : entry?.name;
			if (typeof databaseName === 'string' && !(databaseName in databaseDescriptions)) {
				errors.push(`Leader description omitted configured database ${databaseName}`);
			}
		}
	}

	return { targets, errors };
}

export function checkCloneSyncStatus(
	targets: Record<string, number>,
	clusterResponse: any,
	leaderReplicationURL: string
): CloneSyncResult {
	if (!clusterResponse?.connections?.length) return { synced: false, reason: 'No replication connections found' };
	const leaderConnection = clusterResponse.connections.find((connection) => connection?.url === leaderReplicationURL);
	if (!leaderConnection) return { synced: false, reason: 'No connection found for the clone leader' };
	for (const [databaseName, target] of Object.entries(targets)) {
		const socket = leaderConnection.database_sockets?.find((candidate) => candidate?.database === databaseName);
		if (!socket) return { synced: false, reason: `No leader socket found for database ${databaseName}` };
		if (socket.connected !== true) {
			return { synced: false, reason: `Leader socket for database ${databaseName} is not connected` };
		}
		if (socket.copyInProgress === true) {
			return { synced: false, reason: `Database ${databaseName} is still receiving its base copy` };
		}
		const receivedVersion = socket.lastReceivedVersion;
		if (typeof receivedVersion !== 'number' || !Number.isFinite(receivedVersion) || receivedVersion < target) {
			return {
				synced: false,
				reason: `Database ${databaseName} is not synchronized (received: ${receivedVersion ?? 'none'}, target: ${target})`,
			};
		}
	}

	return { synced: true };
}
