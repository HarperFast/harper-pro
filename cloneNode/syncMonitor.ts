import { setTimeout as sleep } from 'node:timers/promises';

export type SyncMonitorLog = (message: string, level?: string) => void;

export type SyncCheckResult = {
	syncComplete: boolean;
	/** Most recent arrival stamp (ms epoch) among databases still below their target; 0 if none. */
	latestReceivedMs: number;
};

/**
 * Check whether every database has caught up with the leader, and report the freshest arrival
 * stamp among the databases that have not.
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
	log(`clone sync check cluster status response: ${JSON.stringify(clusterResponse)}`, 'debug');

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
	const socketDatabases = new Set<string>();
	for (const socket of leaderConnection.database_sockets) {
		const dbName = socket.database;
		socketDatabases.add(dbName);
		// A missing target — an empty database, or a leader whose describe cannot report
		// last_updated_record (RocksDB, harper#2091) — must not skip verification, or the check
		// passes vacuously when every target is absent (#655). The received-version watermark is
		// held at 0 for the whole bulk copy and only becomes positive via the final end_txn the
		// sender emits at copyStartTime, so a positive watermark is the copy's own completion
		// signal, independent of the leader's describe support.
		const targetTime = targetTimestamps[dbName] || 1;

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

	// A database with a target but no socket yet (its subscription is still registering with the
	// main thread) is pending, not verified — otherwise a lone early socket (e.g. the system DB,
	// whose small copy finishes in seconds) could complete the check before the data databases'
	// sockets even appear.
	for (const dbName in targetTimestamps) {
		if (!socketDatabases.has(dbName)) {
			log(`Database ${dbName}: no replication socket to the leader yet`, 'debug');
			syncComplete = false;
		}
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
			// Bound each status check by the poll interval: clusterStatus's worker path resolves only
			// when a cluster-status reply message arrives, so an unbounded await would hang this loop
			// past its own deadline (e.g. a wedged main thread). A timed-out check counts as no
			// progress and any late reply is ignored; the no-op catch keeps a late rejection of the
			// discarded promise away from the process-level unhandledRejection handler.
			const checkPromise = checkSyncStatus(
				options.targetTimestamps,
				options.clusterStatus,
				options.leaderReplicationURL,
				options.log
			);
			checkPromise.catch(() => {});
			const result = await Promise.race([
				checkPromise,
				delay(options.checkIntervalMs).then(() => 'timed-out' as const),
			]);
			if (result === 'timed-out') {
				options.log(`Cluster status check did not respond within ${options.checkIntervalMs}ms`);
				await delay(options.checkIntervalMs);
				continue;
			}
			const { syncComplete, latestReceivedMs } = result;

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
