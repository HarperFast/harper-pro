import { setTimeout as sleep } from 'node:timers/promises';

export type SyncMonitorLog = (message: string, level?: string) => void;

export type SyncCheckResult = {
	syncComplete: boolean;
	/** Most recent arrival stamp (ms epoch) among databases not yet confirmed synced; 0 if none. */
	latestReceivedMs: number;
	/** `<database>: <why it is not caught up>` for each database still holding the clone back. */
	pending: string[];
};

/**
 * Normalize a leader-reported `last_updated_record` into a comparable version number.
 *
 * `describe_table` fills this field from one of two sources with two different shapes: the audit
 * store's newest key (`key[0]`, a number) or, when that yields nothing, the `__updatedtime__`
 * index's newest key — which is the composite `[timestamp, primaryKey]`. An array silently loses
 * every numeric comparison against it (`[t, k] > 0` coerces to `NaN > 0`), so a target derived from
 * the fallback path reads as "no target at all". Take the leading timestamp component instead.
 * Anything that is not a finite positive number becomes 0, meaning "the leader gave us no usable
 * target" — which callers must treat as unknown, never as satisfied.
 */
export function normalizeTargetVersion(value: unknown): number {
	const raw = Array.isArray(value) ? value[0] : value;
	return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Check whether every database this node subscribed to the leader for has finished receiving the
 * leader's data, and report the freshest arrival stamp among those that have not.
 *
 * The required set is the leader connection's `database_sockets` restricted to the databases the
 * leader reported. `subscribeToNode` populates that map synchronously for every database it sets up
 * replication for, before any socket connects, so it is this node's own subscription intent — not
 * merely the links that happen to be up — and intersecting it with the leader's own database list
 * keeps a local-only database (which the leader will never send anything for) from stalling the clone.
 *
 * Every database must produce POSITIVE evidence of being caught up; anything unknown counts as not
 * caught up. Three independent conditions, all required:
 *
 *  1. No base copy in flight (`baseCopyInProgress`). The bulk copy is the whole reason a clone is not
 *     immediately queryable, and it is the one fact the watermark below cannot express.
 *  2. A positive received-version watermark. It is deliberately frozen for the entire bulk copy and
 *     only advances to `copyStartTime` on the single end_txn the leader sends after the copy — so
 *     `> 0` means "the leader has declared this database's base copy fully delivered", including for
 *     a database with no rows at all.
 *  3. If the leader supplied a usable target timestamp, the watermark has reached it. This covers
 *     writes the leader took while the copy was running; a target of 0 means the leader could not
 *     tell us (see `normalizeTargetVersion`), which weakens this check to (1) + (2) rather than
 *     waiving it.
 *
 * Completion and liveness are deliberately separate signals: the watermark can only answer "is it
 * done?", while `lastReceivedLocalTime` advances on every applied record, copy records included, so
 * it answers "is it still moving?" and is what slides the stall deadline.
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
		return { syncComplete: false, latestReceivedMs: 0, pending: ['cluster status unavailable'] };
	}

	if (!clusterResponse.connections?.length) {
		log('No connections found in cluster status response for clone, will wait and retry');
		return { syncComplete: false, latestReceivedMs: 0, pending: ['no replication connections'] };
	}

	const leaderConnection = clusterResponse.connections.find((conn) => conn.url === leaderReplicationURL);

	if (!leaderConnection) {
		log('No connection found matching leader replication URL, will wait and retry');
		return { syncComplete: false, latestReceivedMs: 0, pending: ['no connection to the leader'] };
	}

	if (!leaderConnection.database_sockets?.length) {
		log(`No database sockets found for connection leader ${leaderConnection.name}`, 'debug');
		return { syncComplete: false, latestReceivedMs: 0, pending: ['no database subscriptions to the leader yet'] };
	}

	const pending: string[] = [];
	let latestReceivedMs = 0;
	// Guards the degenerate "nothing was checked, so everything must be fine" pass: if not one of the
	// leader's databases has a socket yet, there is no evidence of anything, which is not completion.
	let requiredChecked = 0;
	for (const socket of leaderConnection.database_sockets) {
		const dbName = socket.database;
		// Membership, not value, decides whether we wait on a database: `targetTimestamps` has an entry
		// for every database the leader reported, even when its timestamp is unusable (0). A socket for a
		// database the leader does NOT have (local-only on this node) will never receive anything from it,
		// so waiting on it would stall the clone forever — skip it, and don't let it slide the deadline.
		if (!Object.hasOwn(targetTimestamps, dbName)) {
			log(`Database ${dbName}: not present on the leader, skipping sync check`, 'debug');
			continue;
		}
		requiredChecked++;
		const targetTime = normalizeTargetVersion(targetTimestamps[dbName]);
		// Raw version (high-precision float64) preserves the sub-millisecond precision needed for an
		// accurate comparison against the leader's last_updated_record targets.
		const receivedVersion = socket.lastReceivedVersion;
		const haveWatermark =
			typeof receivedVersion === 'number' && Number.isFinite(receivedVersion) && receivedVersion > 0;
		let reason: string | undefined;
		if (socket.baseCopyInProgress) {
			reason = 'base copy still in progress';
		} else if (!haveWatermark) {
			// Includes the pre-copy window (subscription set up, COPY_START not yet received) and the whole
			// duration of the copy itself, since the watermark stays frozen until the post-copy end_txn.
			reason = 'no received-version watermark yet (base copy not confirmed delivered)';
		} else if (targetTime && receivedVersion < targetTime) {
			reason = `received ${receivedVersion} is behind target ${targetTime} (gap: ${targetTime - receivedVersion}ms)`;
		}

		if (!reason) {
			log(
				targetTime
					? `Database ${dbName}: Synchronized (received ${receivedVersion} >= target ${targetTime})`
					: `Database ${dbName}: Base copy delivered (received ${receivedVersion}); leader supplied no catch-up target`,
				'debug'
			);
			continue;
		}

		pending.push(`${dbName}: ${reason}`);
		log(`Database ${dbName}: Not yet synchronized — ${reason}`, 'debug');

		// Only databases that are NOT yet synced slide the stall deadline — arrivals on already-synced
		// sockets must not mask a wedged copy on a pending one. cluster_status formats the arrival stamp
		// as a UTC string (absent until data arrives); second precision is ample for a minutes-scale
		// window, and Number.isFinite drops undefined/unparseable values.
		const receivedAt = socket.lastReceivedLocalTime ? Date.parse(socket.lastReceivedLocalTime) : NaN;
		if (Number.isFinite(receivedAt) && receivedAt > latestReceivedMs) latestReceivedMs = receivedAt;
	}

	if (!requiredChecked) {
		const leaderDatabases = Object.keys(targetTimestamps).join(', ');
		log(`No database sockets to the leader for any of its databases (${leaderDatabases}) yet`, 'debug');
		return { syncComplete: false, latestReceivedMs: 0, pending: ["no subscriptions to the leader's databases yet"] };
	}

	return { syncComplete: pending.length === 0, latestReceivedMs, pending };
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
			const { syncComplete, latestReceivedMs, pending } = result;

			if (syncComplete) return 'synced';

			if (latestReceivedMs > lastProgressAt) lastProgressAt = latestReceivedMs;

			// Log every other iteration to reduce noise. Name what is actually holding the clone back —
			// a clone that sits Unavailable for an hour is otherwise indistinguishable from a wedged one.
			if (loopCount % 2 === 0) {
				const waitingOn = pending.length ? ` waiting on ${pending.join('; ')};` : '';
				options.log(
					latestReceivedMs
						? `Sync incomplete;${waitingOn} last replication data arrived ${Math.max(0, Math.round((now() - latestReceivedMs) / 1000))}s ago; retrying in ${options.checkIntervalMs}ms`
						: `Sync incomplete;${waitingOn} no replication data received yet; retrying in ${options.checkIntervalMs}ms`
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
