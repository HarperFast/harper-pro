import { setTimeout as sleep } from 'node:timers/promises';

export type SyncMonitorLog = (message: string, level?: string) => void;

export type SyncCheckResult = {
	syncComplete: boolean;
	/** Most recent arrival stamp (ms epoch) among databases still below their target; 0 if none. */
	latestReceivedMs: number;
};

/**
 * Check whether every database with a target timestamp has caught up, and report the freshest
 * arrival stamp among the databases that have not.
 *
 * Completion and liveness are deliberately separate signals: `lastReceivedVersion` is frozen for the
 * whole bulk copy (it jumps to copyStartTime only on the post-copy end_txn), so it can only answer
 * "is it done?". `lastReceivedLocalTime` advances on every applied record, copy records included,
 * so it answers "is it still moving?".
 */
export async function checkSyncStatus(
	targetTimestamps: Record<string, number>,
	clusterStatus: () => Promise<any>,
	leaderReplicationURL: string,
	log: SyncMonitorLog
): Promise<SyncCheckResult> {
	const clusterResponse = await clusterStatus();
	log(`clone sync check cluster status response: ${clusterResponse}`, 'debug');

	if (!clusterResponse) {
		log('No cluster status response received for clone, will wait and retry');
		return { syncComplete: false, latestReceivedMs: 0 };
	}

	if (!clusterResponse.connections?.length) {
		log('No connections found in cluster status response for clone, will wait and retry');
		return { syncComplete: false, latestReceivedMs: 0 };
	}

	const leaderConnection = clusterResponse.connections.find((conn) => conn.url === leaderReplicationURL);

	if (!leaderConnection) {
		log('No connection found matching leader replication URL, will wait and retry');
		return { syncComplete: false, latestReceivedMs: 0 };
	}

	if (!leaderConnection.database_sockets?.length) {
		log(`No database sockets found for connection leader ${leaderConnection.name}`, 'debug');
		return { syncComplete: false, latestReceivedMs: 0 };
	}

	let syncComplete = true;
	let latestReceivedMs = 0;
	for (const socket of leaderConnection.database_sockets) {
		const dbName = socket.database;
		const targetTime = targetTimestamps[dbName];
		if (!targetTime) {
			log(`Database ${dbName}: No target timestamp, skipping sync check`, 'debug');
			continue;
		}

		// Raw version (high-precision float64) preserves the sub-millisecond precision needed for
		// an accurate comparison against the leader's last_updated_record targets.
		const receivedVersion = socket.lastReceivedVersion;
		if (receivedVersion && receivedVersion >= targetTime) {
			log(`Database ${dbName}: Synchronized`, 'debug');
			continue;
		}

		syncComplete = false;
		if (receivedVersion) {
			log(
				`Database ${dbName}: Not yet synchronized (received: ${receivedVersion}, target: ${targetTime}, gap: ${targetTime - receivedVersion}ms)`
			);
		} else {
			log(`No lastReceivedVersion data received yet for database ${dbName}`, 'debug');
		}

		// Only databases still below target slide the stall deadline — arrivals on synced or
		// untracked sockets must not mask a wedged copy on a pending one. cluster_status formats
		// the arrival stamp as a UTC string (absent until data arrives); second precision is ample
		// for a minutes-scale window, and Number.isFinite drops undefined/unparseable values.
		const receivedAt = socket.lastReceivedLocalTime ? Date.parse(socket.lastReceivedLocalTime) : NaN;
		if (Number.isFinite(receivedAt) && receivedAt > latestReceivedMs) latestReceivedMs = receivedAt;
	}

	return { syncComplete, latestReceivedMs };
}

export type MonitorSyncLoopOptions = {
	targetTimestamps: Record<string, number>;
	clusterStatus: () => Promise<any>;
	leaderReplicationURL: string;
	stallTimeoutMs: number;
	checkIntervalMs: number;
	log: SyncMonitorLog;
	/** Test hooks: injectable clock and delay. */
	now?: () => number;
	delay?: (ms: number) => Promise<unknown>;
};

/**
 * Poll sync status until every database reaches its target, failing only on a stall: the deadline
 * slides forward whenever replication data arrives, so a healthy clone is never timed out for being
 * large. Errors from the status check do not count as progress, so a wedged status pipeline still
 * stalls out.
 */
export async function monitorSyncLoop(options: MonitorSyncLoopOptions): Promise<'synced' | 'stalled'> {
	const now = options.now ?? Date.now;
	const delay = options.delay ?? sleep;
	let lastProgressAt = now();
	let loopCount = 0;

	while (now() - lastProgressAt < options.stallTimeoutMs) {
		try {
			const { syncComplete, latestReceivedMs } = await checkSyncStatus(
				options.targetTimestamps,
				options.clusterStatus,
				options.leaderReplicationURL,
				options.log
			);

			if (syncComplete) return 'synced';

			if (latestReceivedMs > lastProgressAt) lastProgressAt = latestReceivedMs;

			// Log every other iteration to reduce noise
			if (loopCount % 2 === 0) {
				options.log(
					latestReceivedMs
						? `Sync incomplete; last replication data arrived ${Math.max(0, Math.round((now() - latestReceivedMs) / 1000))}s ago; retrying in ${options.checkIntervalMs}ms`
						: `Sync incomplete; no replication data received yet; retrying in ${options.checkIntervalMs}ms`
				);
			}
			loopCount++;
		} catch (err) {
			options.log(`Error checking sync status: ${err}`, 'error');
		}
		await delay(options.checkIntervalMs);
	}

	return 'stalled';
}
