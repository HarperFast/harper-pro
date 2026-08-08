/**
 * Coverage for the clone sync monitor. Completion requires POSITIVE evidence per database — its socket
 * exists, no base copy is in flight, the received-version watermark has advanced, and (when the leader
 * could supply one) it is past the leader's target. Anything unknown counts as not caught up.
 *
 * Failure is stall-based (the copy freezes the watermark, so a total-time cap would fail any clone
 * larger than the timeout allows): the deadline slides forward only on arrivals for databases still
 * pending, so neither a synced-but-busy database nor a skipped one can mask a wedged copy.
 */
import assert from 'node:assert/strict';
import { checkSyncStatus, monitorSyncLoop, normalizeTargetVersion } from '#src/cloneNode/syncMonitor';
import {
	deriveBaseCopyInProgress,
	BASE_COPY_STATE_POSITION,
	BASE_COPY_IDLE,
	BASE_COPY_IN_PROGRESS,
} from '#src/replication/replicationConnection';

const LEADER_URL = 'wss://leader:9933';
const noopLog = () => {};

// The same shape cluster_status emits: asDate() formats arrival stamps as UTC strings.
const utc = (ms) => new Date(ms).toUTCString();

function statusResponse(sockets) {
	return {
		connections: [{ name: 'leader', url: LEADER_URL, database_sockets: sockets }],
	};
}

/** Assert the completion + liveness signals without pinning the human-readable reason strings. */
function assertResult(result, { syncComplete, latestReceivedMs, pendingCount }) {
	assert.equal(result.syncComplete, syncComplete);
	assert.equal(result.latestReceivedMs, latestReceivedMs);
	assert.equal(result.pending.length, pendingCount ?? (syncComplete ? 0 : result.pending.length));
	if (syncComplete) assert.deepEqual(result.pending, []);
}

describe('normalizeTargetVersion', () => {
	it('accepts a plain version number', () => {
		assert.equal(normalizeTargetVersion(1786207156882.293), 1786207156882.293);
	});

	it('takes the timestamp component of a composite __updatedtime__ key', () => {
		// describe's fallback path assigns the whole index key; comparing that array numerically is NaN,
		// which read as "no target" and silently disabled the catch-up half of the gate.
		assert.equal(normalizeTargetVersion([1786207156882.293, 'a']), 1786207156882.293);
	});

	it('collapses unusable values to 0 (unknown, never satisfied)', () => {
		for (const value of [undefined, null, 0, -1, NaN, Infinity, 'nope', {}, [], ['a']]) {
			assert.equal(normalizeTargetVersion(value), 0, `${JSON.stringify(value)} must be unusable`);
		}
	});
});

describe('checkSyncStatus', () => {
	it('reports complete when every database meets its target', async () => {
		const result = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: 1500, lastReceivedLocalTime: utc(5000) },
					{ database: 'data', lastReceivedVersion: 2500, lastReceivedLocalTime: utc(7000) },
				]),
			LEADER_URL,
			noopLog
		);
		assertResult(result, { syncComplete: true, latestReceivedMs: 0 });
	});

	it('reports incomplete when any database is behind its target', async () => {
		const result = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: 1500, lastReceivedLocalTime: utc(5000) },
					{ database: 'data', lastReceivedVersion: 1999, lastReceivedLocalTime: utc(7000) },
				]),
			LEADER_URL,
			noopLog
		);
		assertResult(result, { syncComplete: false, latestReceivedMs: 7000, pendingCount: 1 });
	});

	it('does not treat a database with no usable target as synced (false-completion regression)', async () => {
		// The failing large-clone shape: describe gave no last_updated_record (RocksDB), so the target is
		// 0, and the copy is still running so the watermark is still frozen at 0. The old gate skipped
		// this database entirely and returned synced on the first poll.
		const result = await checkSyncStatus(
			{ system: 0, data: 0 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: 0, lastReceivedLocalTime: utc(5000) },
					{ database: 'data', lastReceivedVersion: 0, lastReceivedLocalTime: utc(7000) },
				]),
			LEADER_URL,
			noopLog
		);
		assertResult(result, { syncComplete: false, latestReceivedMs: 7000, pendingCount: 2 });
	});

	it('accepts a delivered base copy when the leader supplied no target', async () => {
		// Same missing-target situation, but the post-copy end_txn has advanced the watermark to
		// copyStartTime — the leader has declared the base copy fully delivered, so this is complete.
		const result = await checkSyncStatus(
			{ data: 0 },
			async () =>
				statusResponse([{ database: 'data', lastReceivedVersion: 1786207156882, lastReceivedLocalTime: utc(7000) }]),
			LEADER_URL,
			noopLog
		);
		assertResult(result, { syncComplete: true, latestReceivedMs: 0 });
	});

	it('never reports complete while a base copy is in flight', async () => {
		// Even a watermark past the target cannot override an in-flight copy: a second connection sharing
		// the (db, peer) status buffer can advance the watermark while this one is still copying.
		const result = await checkSyncStatus(
			{ data: 2000 },
			async () =>
				statusResponse([
					{ database: 'data', lastReceivedVersion: 5000, baseCopyInProgress: true, lastReceivedLocalTime: utc(7000) },
				]),
			LEADER_URL,
			noopLog
		);
		assertResult(result, { syncComplete: false, latestReceivedMs: 7000, pendingCount: 1 });
	});

	it('normalizes a composite target key before comparing', async () => {
		const behind = await checkSyncStatus(
			{ data: [2000, 'row-1'] },
			async () => statusResponse([{ database: 'data', lastReceivedVersion: 1999, lastReceivedLocalTime: utc(7000) }]),
			LEADER_URL,
			noopLog
		);
		assertResult(behind, { syncComplete: false, latestReceivedMs: 7000, pendingCount: 1 });

		const caughtUp = await checkSyncStatus(
			{ data: [2000, 'row-1'] },
			async () => statusResponse([{ database: 'data', lastReceivedVersion: 2000, lastReceivedLocalTime: utc(7000) }]),
			LEADER_URL,
			noopLog
		);
		assertResult(caughtUp, { syncComplete: true, latestReceivedMs: 0 });
	});

	it('scans every socket for arrival stamps instead of returning on the first laggard', async () => {
		const result = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: undefined, lastReceivedLocalTime: utc(4000) },
					{ database: 'data', lastReceivedVersion: 1, lastReceivedLocalTime: utc(9000) },
				]),
			LEADER_URL,
			noopLog
		);
		assertResult(result, { syncComplete: false, latestReceivedMs: 9000, pendingCount: 2 });
	});

	it('skips databases the leader does not have, including their arrivals', async () => {
		// A local-only database will never receive anything from the leader, so waiting on it would stall
		// every clone. Membership in the leader's database list — not the timestamp's value — decides.
		const result = await checkSyncStatus(
			{ system: 1000 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: 500, lastReceivedLocalTime: utc(1000) },
					{ database: 'local-only', lastReceivedLocalTime: utc(8000) },
				]),
			LEADER_URL,
			noopLog
		);
		assertResult(result, { syncComplete: false, latestReceivedMs: 1000, pendingCount: 1 });
	});

	it('holds completion while a required database has no socket at all', async () => {
		// The reachable partial-set hole: `system` copies in seconds and meets its target, while `data`
		// was never subscribed (a swallowed schema pre-create, or a database the leader added later). A
		// loop over the sockets that exist cannot see it, so the required set has to carry it.
		const sockets = [{ database: 'system', lastReceivedVersion: 1500, lastReceivedLocalTime: utc(5000) }];
		const withoutRequired = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () => statusResponse(sockets),
			LEADER_URL,
			noopLog
		);
		assertResult(withoutRequired, { syncComplete: true, latestReceivedMs: 0 });

		const withRequired = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () => statusResponse(sockets),
			LEADER_URL,
			noopLog,
			['data']
		);
		assertResult(withRequired, { syncComplete: false, latestReceivedMs: 0, pendingCount: 1 });
	});

	it('completes once the required socket appears and is caught up', async () => {
		const result = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: 1500, lastReceivedLocalTime: utc(5000) },
					{ database: 'data', lastReceivedVersion: 2500, lastReceivedLocalTime: utc(7000) },
				]),
			LEADER_URL,
			noopLog,
			['data']
		);
		assertResult(result, { syncComplete: true, latestReceivedMs: 0 });
	});

	it('does not require a socket for a database outside the required set (legacy leader / system)', async () => {
		// A v4 leader never replicates `system`, so `system` is deliberately not in the required set;
		// requiring it would wedge those clones at Unavailable.
		const result = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () => statusResponse([{ database: 'data', lastReceivedVersion: 2500, lastReceivedLocalTime: utc(7000) }]),
			LEADER_URL,
			noopLog,
			['data']
		);
		assertResult(result, { syncComplete: true, latestReceivedMs: 0 });
	});

	it('reports incomplete when none of the leader databases has a socket yet', async () => {
		const result = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () =>
				statusResponse([{ database: 'local-only', lastReceivedVersion: 9000, lastReceivedLocalTime: utc(8000) }]),
			LEADER_URL,
			noopLog
		);
		assertResult(result, { syncComplete: false, latestReceivedMs: 0, pendingCount: 1 });
	});

	it('ignores arrivals on already-synced databases (wedged-copy regression)', async () => {
		const result = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: undefined },
					{ database: 'data', lastReceivedVersion: 2500, lastReceivedLocalTime: utc(9000) },
				]),
			LEADER_URL,
			noopLog
		);
		assertResult(result, { syncComplete: false, latestReceivedMs: 0, pendingCount: 1 });
	});

	it('ignores non-date sentinel strings in the arrival field', async () => {
		const result = await checkSyncStatus(
			{ system: 1000 },
			async () => statusResponse([{ database: 'system', lastReceivedVersion: 500, lastReceivedLocalTime: 'Copying' }]),
			LEADER_URL,
			noopLog
		);
		assertResult(result, { syncComplete: false, latestReceivedMs: 0, pendingCount: 1 });
	});

	it('reports no progress when the leader connection has not appeared yet', async () => {
		for (const response of [
			null,
			{ connections: [] },
			{ connections: [{ name: 'other', url: 'wss://other:9933', database_sockets: [{ database: 'data' }] }] },
			{ connections: [{ name: 'leader', url: LEADER_URL, database_sockets: [] }] },
		]) {
			const result = await checkSyncStatus({ system: 1000 }, async () => response, LEADER_URL, noopLog);
			assertResult(result, { syncComplete: false, latestReceivedMs: 0, pendingCount: 1 });
		}
	});
});

describe('monitorSyncLoop', () => {
	function fakeClock() {
		let time = 0;
		return {
			now: () => time,
			delay: async (ms) => {
				time += ms;
			},
		};
	}

	it('returns synced when the check reports completion', async () => {
		const clock = fakeClock();
		const outcome = await monitorSyncLoop({
			targetTimestamps: { system: 1000 },
			clusterStatus: async () =>
				statusResponse([{ database: 'system', lastReceivedVersion: 1500, lastReceivedLocalTime: utc(1000) }]),
			leaderReplicationURL: LEADER_URL,
			stallTimeoutMs: 10000,
			checkIntervalMs: 1000,
			log: noopLog,
			...clock,
		});
		assert.equal(outcome, 'synced');
	});

	it('waits out a full base copy before reporting synced (large-clone regression)', async () => {
		const clock = fakeClock();
		// The observed 10 GB shape: no usable target, copy frames keep arriving (so the deadline slides)
		// while baseCopyInProgress holds and the watermark stays frozen, then the post-copy end_txn lands.
		let checks = 0;
		const outcome = await monitorSyncLoop({
			targetTimestamps: { data: 0 },
			clusterStatus: async () => {
				checks++;
				const copying = clock.now() < 30000;
				return statusResponse([
					{
						database: 'data',
						baseCopyInProgress: copying || undefined,
						lastReceivedVersion: copying ? 0 : 1786207156882,
						lastReceivedLocalTime: utc(clock.now()),
					},
				]);
			},
			leaderReplicationURL: LEADER_URL,
			stallTimeoutMs: 10000,
			checkIntervalMs: 3000,
			log: noopLog,
			...clock,
		});
		assert.equal(outcome, 'synced');
		assert.ok(checks > 1, 'must not have completed on the first poll');
		assert.ok(clock.now() >= 30000, 'must have waited for the copy to finish');
	});

	it('stalls out when no replication data ever arrives', async () => {
		const clock = fakeClock();
		let checks = 0;
		const outcome = await monitorSyncLoop({
			targetTimestamps: { system: 1000 },
			clusterStatus: async () => {
				checks++;
				// No lastReceivedLocalTime at all — cluster_status omits the field until data arrives.
				return statusResponse([{ database: 'system', lastReceivedVersion: undefined }]);
			},
			leaderReplicationURL: LEADER_URL,
			stallTimeoutMs: 10000,
			checkIntervalMs: 3000,
			log: noopLog,
			...clock,
		});
		assert.equal(outcome, 'stalled');
		// Exact poll count depends on how the fake clock ticks (the per-check timeout timer also
		// advances it); the invariant is that polling happened and the t=0 baseline never moved.
		assert.ok(checks >= 2, 'must have polled before stalling');
		assert.ok(clock.now() >= 10000, 'must fail via the stall window');
	});

	it('outlives the stall window while data keeps arriving (large-clone regression)', async () => {
		const clock = fakeClock();
		// Data arrives on every poll (arrival stamp tracks the clock) but the version watermark stays
		// frozen — the bulk-copy shape — until well past the stall window, then sync completes.
		const outcome = await monitorSyncLoop({
			targetTimestamps: { system: 1000 },
			clusterStatus: async () =>
				statusResponse([
					clock.now() < 25000
						? { database: 'system', lastReceivedVersion: undefined, lastReceivedLocalTime: utc(clock.now()) }
						: { database: 'system', lastReceivedVersion: 1500, lastReceivedLocalTime: utc(clock.now()) },
				]),
			leaderReplicationURL: LEADER_URL,
			stallTimeoutMs: 10000,
			checkIntervalMs: 3000,
			log: noopLog,
			...clock,
		});
		assert.equal(outcome, 'synced');
		assert.ok(clock.now() >= 25000, 'loop must have run well past the stall window');
	});

	it('fails after the window when data stops arriving mid-copy', async () => {
		const clock = fakeClock();
		const outcome = await monitorSyncLoop({
			targetTimestamps: { system: 1000 },
			clusterStatus: async () =>
				statusResponse([
					{
						database: 'system',
						lastReceivedVersion: undefined,
						// Arrivals track the clock until t=6000, then the link goes silent.
						lastReceivedLocalTime: utc(Math.min(clock.now(), 6000)),
					},
				]),
			leaderReplicationURL: LEADER_URL,
			stallTimeoutMs: 10000,
			checkIntervalMs: 3000,
			log: noopLog,
			...clock,
		});
		assert.equal(outcome, 'stalled');
		assert.ok(clock.now() >= 16000, 'deadline must have slid to last-arrival + window');
	});

	it('stalls out when a pending database is silent while a synced one keeps receiving', async () => {
		const clock = fakeClock();
		const outcome = await monitorSyncLoop({
			targetTimestamps: { system: 1000, data: 2000 },
			clusterStatus: async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: undefined },
					{ database: 'data', lastReceivedVersion: 2500, lastReceivedLocalTime: utc(clock.now()) },
				]),
			leaderReplicationURL: LEADER_URL,
			stallTimeoutMs: 10000,
			checkIntervalMs: 3000,
			log: noopLog,
			...clock,
		});
		assert.equal(outcome, 'stalled');
		assert.equal(clock.now(), 12000);
	});

	it('stalls out when the cluster status check never settles', async () => {
		const clock = fakeClock();
		const outcome = await monitorSyncLoop({
			targetTimestamps: { system: 1000 },
			clusterStatus: () => new Promise(() => {}),
			leaderReplicationURL: LEADER_URL,
			stallTimeoutMs: 10000,
			checkIntervalMs: 3000,
			log: noopLog,
			...clock,
		});
		assert.equal(outcome, 'stalled');
		assert.ok(clock.now() >= 10000, 'must fail via the stall window, not hang');
	});

	it('does not treat status-check errors as progress', async () => {
		const clock = fakeClock();
		const outcome = await monitorSyncLoop({
			targetTimestamps: { system: 1000 },
			clusterStatus: async () => {
				throw new Error('cluster status unavailable');
			},
			leaderReplicationURL: LEADER_URL,
			stallTimeoutMs: 10000,
			checkIntervalMs: 3000,
			log: noopLog,
			...clock,
		});
		assert.equal(outcome, 'stalled');
	});
});

describe('deriveBaseCopyInProgress', () => {
	// The gate's veto is only as good as the slot and constant the reader compares against; every other
	// test here hand-feeds `baseCopyInProgress`, so without this a wrong slot index would go unnoticed.
	it('reads the base-copy slot, not a neighbour', () => {
		const status = new Float64Array(16);
		assert.equal(deriveBaseCopyInProgress(status), false);

		status[BASE_COPY_STATE_POSITION] = BASE_COPY_IN_PROGRESS;
		assert.equal(deriveBaseCopyInProgress(status), true);

		status[BASE_COPY_STATE_POSITION] = BASE_COPY_IDLE;
		assert.equal(deriveBaseCopyInProgress(status), false);
	});

	it('is not confused by the neighbouring slots the same buffer carries', () => {
		const status = new Float64Array(16);
		for (let i = 0; i < status.length; i++) if (i !== BASE_COPY_STATE_POSITION) status[i] = Date.now();
		assert.equal(deriveBaseCopyInProgress(status), false);
	});
});
