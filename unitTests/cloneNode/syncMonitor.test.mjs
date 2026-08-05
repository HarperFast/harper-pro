/**
 * Coverage for the clone sync monitor. Completion = every database's received version reaches the
 * leader's target — or, when the leader reports no target for a database (empty, or a RocksDB
 * leader whose describe omits last_updated_record, harper#2091), any positive received version,
 * which only the sender's final copy end_txn can produce (#655). Failure is stall-based (the copy
 * freezes the version watermark, so a total-time cap would fail any clone larger than the timeout
 * allows): the deadline slides forward only on arrivals for databases still pending, so a
 * synced-but-busy database cannot mask a wedged copy.
 */
import assert from 'node:assert/strict';
import { checkSyncStatus, monitorSyncLoop } from '#src/cloneNode/syncMonitor';

const LEADER_URL = 'wss://leader:9933';
const noopLog = () => {};

// The same shape cluster_status emits: asDate() formats arrival stamps as UTC strings.
const utc = (ms) => new Date(ms).toUTCString();

function statusResponse(sockets) {
	return {
		connections: [{ name: 'leader', url: LEADER_URL, database_sockets: sockets }],
	};
}

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
		assert.deepEqual(result, { syncComplete: true, latestReceivedMs: 0 });
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
		assert.deepEqual(result, { syncComplete: false, latestReceivedMs: 7000 });
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
		assert.deepEqual(result, { syncComplete: false, latestReceivedMs: 9000 });
	});

	it('treats a socket without a target as pending until its watermark is positive', async () => {
		// A no-target database is a real pending copy, not an ignorable socket: its arrivals slide
		// the stall deadline, and only the final copy end_txn (positive watermark) completes it.
		const result = await checkSyncStatus(
			{ system: 1000 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: 500, lastReceivedLocalTime: utc(1000) },
					{ database: 'untracked', lastReceivedLocalTime: utc(8000) },
				]),
			LEADER_URL,
			noopLog
		);
		assert.deepEqual(result, { syncComplete: false, latestReceivedMs: 8000 });
	});

	it('does not pass vacuously when every target is missing (#655 regression)', async () => {
		// The RocksDB describe path reports last_updated_record for no table (harper#2091), so every
		// clone target is 0. Skipping 0-target databases made the first poll succeed with zero
		// verification, marking the clone Available seconds into a multi-GB copy.
		const result = await checkSyncStatus(
			{ system: 0, data: 0 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: undefined },
					{ database: 'data', lastReceivedVersion: undefined },
				]),
			LEADER_URL,
			noopLog
		);
		assert.equal(result.syncComplete, false);
	});

	it('completes a no-target database once the final copy end_txn advances its watermark', async () => {
		const copyStartTime = 1785939110564;
		const result = await checkSyncStatus(
			{ system: 0, data: 0 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: copyStartTime, lastReceivedLocalTime: utc(copyStartTime) },
					{ database: 'data', lastReceivedVersion: copyStartTime, lastReceivedLocalTime: utc(copyStartTime) },
				]),
			LEADER_URL,
			noopLog
		);
		assert.deepEqual(result, { syncComplete: true, latestReceivedMs: 0 });
	});

	it('holds completion while a target database has no socket yet', async () => {
		// The system DB's small copy can finish before the data databases' subscriptions have even
		// registered with the main thread; a lone early socket must not complete the check.
		const result = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () => statusResponse([{ database: 'system', lastReceivedVersion: 1500, lastReceivedLocalTime: utc(1000) }]),
			LEADER_URL,
			noopLog
		);
		assert.equal(result.syncComplete, false);
	});

	it('completes without a socket for a database outside requiredSocketDatabases (v4 leader)', async () => {
		// A legacy (v4) leader never replicates the system database: system sits in the targets
		// (added unconditionally) but its socket never appears, and must not wedge the clone.
		const result = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () => statusResponse([{ database: 'data', lastReceivedVersion: 2500, lastReceivedLocalTime: utc(3000) }]),
			LEADER_URL,
			noopLog,
			['data']
		);
		assert.deepEqual(result, { syncComplete: true, latestReceivedMs: 0 });
	});

	it('still verifies a non-required database whenever its socket exists', async () => {
		const result = await checkSyncStatus(
			{ system: 1000, data: 2000 },
			async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: undefined },
					{ database: 'data', lastReceivedVersion: 2500, lastReceivedLocalTime: utc(3000) },
				]),
			LEADER_URL,
			noopLog,
			['data']
		);
		assert.equal(result.syncComplete, false);
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
		assert.deepEqual(result, { syncComplete: false, latestReceivedMs: 0 });
	});

	it('ignores non-date sentinel strings in the arrival field', async () => {
		const result = await checkSyncStatus(
			{ system: 1000 },
			async () => statusResponse([{ database: 'system', lastReceivedVersion: 500, lastReceivedLocalTime: 'Copying' }]),
			LEADER_URL,
			noopLog
		);
		assert.deepEqual(result, { syncComplete: false, latestReceivedMs: 0 });
	});

	it('reports no progress when the leader connection has not appeared yet', async () => {
		for (const response of [
			null,
			{ connections: [] },
			{ connections: [{ name: 'other', url: 'wss://other:9933', database_sockets: [{ database: 'data' }] }] },
			{ connections: [{ name: 'leader', url: LEADER_URL, database_sockets: [] }] },
		]) {
			const result = await checkSyncStatus({ system: 1000 }, async () => response, LEADER_URL, noopLog);
			assert.deepEqual(result, { syncComplete: false, latestReceivedMs: 0 });
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

	it('honors requiredSocketDatabases so a socketless system DB cannot wedge a v4-leader clone', async () => {
		const clock = fakeClock();
		const outcome = await monitorSyncLoop({
			targetTimestamps: { system: 1000, data: 2000 },
			clusterStatus: async () =>
				statusResponse([{ database: 'data', lastReceivedVersion: 2500, lastReceivedLocalTime: utc(1000) }]),
			leaderReplicationURL: LEADER_URL,
			stallTimeoutMs: 10000,
			checkIntervalMs: 1000,
			log: noopLog,
			requiredSocketDatabases: ['data'],
			...clock,
		});
		assert.equal(outcome, 'synced');
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

	it('waits through a copy with no targets and completes on the final end_txn (#655)', async () => {
		const clock = fakeClock();
		// All-zero targets (RocksDB leader, harper#2091): the loop must poll through the whole copy —
		// arrivals sliding the deadline past the stall window — and complete only when the watermark
		// turns positive, never on the first poll.
		const outcome = await monitorSyncLoop({
			targetTimestamps: { system: 0, data: 0 },
			clusterStatus: async () =>
				statusResponse([
					{ database: 'system', lastReceivedVersion: 500, lastReceivedLocalTime: utc(clock.now()) },
					clock.now() < 25000
						? { database: 'data', lastReceivedVersion: undefined, lastReceivedLocalTime: utc(clock.now()) }
						: { database: 'data', lastReceivedVersion: 30000, lastReceivedLocalTime: utc(clock.now()) },
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
