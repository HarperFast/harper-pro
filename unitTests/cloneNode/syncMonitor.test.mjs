/**
 * Coverage for the clone sync monitor (harper-pro). The monitor decides when a clone is complete
 * (every database's received version reaches the leader's target timestamp) and when it has failed.
 * Failure is stall-based: the bulk copy keeps the version watermark frozen for its whole duration,
 * so a total-elapsed-time cap would fail any clone larger than the timeout allows. The loop's
 * deadline instead slides forward whenever replication data arrives (parsed from the formatted
 * lastReceivedLocalTime field cluster_status already exposes), so a
 * healthy clone of any size completes and only a genuinely silent link times out.
 */
import assert from 'node:assert/strict';
import { checkSyncStatus, monitorSyncLoop } from '#src/cloneNode/syncMonitor';

const LEADER_URL = 'wss://leader:9933';
const noopLog = () => {};

// cluster_status formats arrival stamps via asDate(): a UTC string (1s precision), absent until
// data has arrived. Fixtures use the same shape the real operation emits.
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
		assert.deepEqual(result, { syncComplete: true, latestReceivedMs: 7000 });
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

	it('counts arrivals on sockets without a target timestamp as progress', async () => {
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
		assert.equal(checks, 4); // t=0,3000,6000,9000; deadline never moved past the t=0 baseline
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
