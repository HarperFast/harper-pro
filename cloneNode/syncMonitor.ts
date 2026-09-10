import { setTimeout as sleep } from 'node:timers/promises';

export type SyncMonitorLog = (message: string, level?: string) => void;

export type SyncCheckResult = {
	syncComplete: boolean;
	/** Most recent arrival stamp (ms epoch) among databases still below their target; 0 if none. */
	latestReceivedMs: number;
	/** Databases that had a replication socket to the leader in this check. */
	socketDatabases: Set<string>;
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
	log: SyncMonitorLog,
	requiredSocketDatabases: string[] = Object.keys(targetTimestamps)
): Promise<SyncCheckResult> {
	const clusterResponse = await clusterStatus();
	log(`clone sync check cluster status response: ${JSON.stringify(clusterResponse)}`, 'debug');

	if (!clusterResponse) {
		log('No cluster status response received for clone, will wait and retry');
		return { syncComplete: false, latestReceivedMs: 0, socketDatabases: new Set() };
	}

	if (!clusterResponse.connections?.length) {
		log('No connections found in cluster status response for clone, will wait and retry');
		return { syncComplete: false, latestReceivedMs: 0, socketDatabases: new Set() };
	}

	const leaderConnection = clusterResponse.connections.find((conn) => conn.url === leaderReplicationURL);

	if (!leaderConnection) {
		log('No connection found matching leader replication URL, will wait and retry');
		return { syncComplete: false, latestReceivedMs: 0, socketDatabases: new Set() };
	}

	if (!leaderConnection.database_sockets?.length) {
		log(`No database sockets found for connection leader ${leaderConnection.name}`, 'debug');
		return { syncComplete: false, latestReceivedMs: 0, socketDatabases: new Set() };
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

	// A required database with no socket yet (its subscription is still registering with the
	// main thread) is pending, not verified — otherwise a lone early socket (e.g. the system DB,
	// whose small copy finishes in seconds) could complete the check before the data databases'
	// sockets even appear. Only databases the clone actually subscribes to are required: a legacy
	// (v4) leader never replicates the system database, so demanding its socket would wedge the
	// clone; when the socket does exist it is still verified by the loop above.
	for (const dbName of requiredSocketDatabases) {
		if (!socketDatabases.has(dbName)) {
			log(`Database ${dbName}: no replication socket to the leader yet`, 'debug');
			syncComplete = false;
		}
	}

	return { syncComplete, latestReceivedMs, socketDatabases };
}

export type MonitorSyncLoopOptions = {
	targetTimestamps: Record<string, number>;
	clusterStatus: () => Promise<any>;
	leaderReplicationURL: string;
	stallTimeoutMs: number;
	checkIntervalMs: number;
	/** Ceiling on the whole wait: arrivals slide the stall deadline, so a copy that applies records
	 *  without ever converging would otherwise poll forever instead of reaching a verdict. */
	maxDurationMs?: number;
	log: SyncMonitorLog;
	/** Databases whose replication socket must exist before sync can complete (default: every target). */
	requiredSocketDatabases?: string[];
	/** Test hooks: injectable clock and delay. */
	now?: () => number;
	delay?: (ms: number) => Promise<unknown>;
};

/**
 * Poll sync status until every database reaches its target, failing on a stall (no arrivals for
 * `stallTimeoutMs`, so a healthy clone is never timed out for being large) or on exceeding
 * `maxDurationMs`. Errors from the status check do not count as progress, so a wedged status
 * pipeline still stalls out.
 *
 * Always performs at least one check before enforcing either deadline — `maxDurationMs` can arrive
 * already elapsed on a resume — and only reports `unconverged` if that check (or a later one)
 * actually got a definite answer; a check that merely timed out or errored reports `stalled`
 * instead, so a transient blip can't erase resumable state.
 */
export async function monitorSyncLoop(options: MonitorSyncLoopOptions): Promise<'synced' | 'stalled' | 'unconverged'> {
	const now = options.now ?? Date.now;
	const delay = options.delay ?? sleep;
	const maxDurationMs = options.maxDurationMs ?? Number.POSITIVE_INFINITY;
	const startedAt = now();
	let lastProgressAt = startedAt;
	let loopCount = 0;
	let firstCheck = true;
	// Only a check that actually got a response (complete or not) counts as "we looked and it
	// isn't done yet" — a timeout or thrown error is no information, not evidence of non-convergence.
	let gotDefiniteCheck = false;
	const deadlinePassed = () => now() - lastProgressAt >= options.stallTimeoutMs || now() - startedAt >= maxDurationMs;
	const baseRequired = options.requiredSocketDatabases ?? Object.keys(options.targetTimestamps);
	// Ratchet: a target database whose socket has been seen once stays required even if the socket
	// later drops, and a non-required one (e.g. `system`, optional because v4 leaders never
	// replicate it) becomes required as soon as its socket appears — so on a v5 leader a small user
	// database finishing first cannot complete the clone while the system copy is still pending.
	const seenTargetSockets = new Set<string>();

	while (firstCheck || !deadlinePassed()) {
		firstCheck = false;
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
				options.log,
				[...new Set([...baseRequired, ...seenTargetSockets])]
			);
			checkPromise.catch(() => {});
			const result = await Promise.race([
				checkPromise,
				delay(options.checkIntervalMs).then(() => 'timed-out' as const),
			]);
			if (result === 'timed-out') {
				options.log(`Cluster status check did not respond within ${options.checkIntervalMs}ms`);
				if (deadlinePassed()) break;
				await delay(options.checkIntervalMs);
				continue;
			}
			const { syncComplete, latestReceivedMs, socketDatabases } = result;
			for (const dbName of socketDatabases) {
				if (dbName in options.targetTimestamps) seenTargetSockets.add(dbName);
			}

			if (syncComplete) return 'synced';
			gotDefiniteCheck = true;

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
		// Skip the trailing sleep when the loop is about to exit anyway — otherwise the single
		// mandatory check at an already-spent budget pays a full checkIntervalMs of pure latency.
		if (deadlinePassed()) break;
		await delay(options.checkIntervalMs);
	}

	return gotDefiniteCheck && now() - startedAt >= maxDurationMs ? 'unconverged' : 'stalled';
}
