import assert from 'node:assert';
import {
	checkCloneSyncStatus,
	CLONE_SYNC_BASELINE_VERSION,
	deriveCloneTargets,
	isReplicatedDatabase,
	validateCloneSyncBaseline,
} from '#src/cloneNode/syncStatus';

describe('clone sync targets', () => {
	it('reuses the original baseline when an interrupted copy resumes', () => {
		const copyStartTime = 1730000000200;
		const resumedAt = copyStartTime + 60000;
		const persisted = {
			version: CLONE_SYNC_BASELINE_VERSION,
			leaderURL: 'https://leader:9925',
			leaderBaseline: copyStartTime - 1,
		};
		assert.equal(validateCloneSyncBaseline(persisted, 'https://leader:9925'), copyStartTime - 1);
		assert.ok(validateCloneSyncBaseline(persisted, 'https://leader:9925') < resumedAt);
	});

	it('rejects a persisted baseline from another clone attempt', () => {
		assert.throws(
			() =>
				validateCloneSyncBaseline(
					{
						version: CLONE_SYNC_BASELINE_VERSION,
						leaderURL: 'https://old-leader:9925',
						leaderBaseline: 1730000000000,
					},
					'https://leader:9925'
				),
			/does not match this clone attempt/
		);
	});

	it('uses one pre-copy leader baseline for every replicated database', () => {
		const result = deriveCloneTargets({ system: {}, data: { items: {} } }, '*', 1730000000100);
		assert.deepStrictEqual(
			{ ...result, targets: { ...result.targets } },
			{
				targets: { system: 1730000000100, data: 1730000000100 },
				errors: [],
			}
		);
	});

	it('fails closed when the leader clock is unavailable', () => {
		const result = deriveCloneTargets({}, '*', undefined);
		assert.deepStrictEqual(
			{ ...result, targets: { ...result.targets } },
			{ targets: {}, errors: ['Leader did not return a valid current time'] }
		);
	});

	it('omits databases outside replication.databases', () => {
		const result = deriveCloneTargets(
			{
				data: { included: {} },
				staging: { items: {} },
			},
			['data'],
			1000
		);
		assert.deepStrictEqual({ ...result, targets: { ...result.targets } }, { targets: { data: 1000 }, errors: [] });
		assert.equal(isReplicatedDatabase([{ name: 'data' }], 'data'), true);
		assert.equal(isReplicatedDatabase([{ name: 'data' }], 'staging'), false);
	});

	it('fails closed when an explicitly configured database is omitted', () => {
		const result = deriveCloneTargets({ system: {} }, ['system', 'data'], 1000);
		assert.deepStrictEqual(
			{ ...result, targets: { ...result.targets } },
			{
				targets: { system: 1000 },
				errors: ['Leader description omitted configured database data'],
			}
		);
	});
});

describe('checkCloneSyncStatus', () => {
	const leaderURL = 'wss://leader:9933';

	it('does not synchronize when an in-scope target socket is missing', () => {
		const result = checkCloneSyncStatus(
			{ data: 100, system: 50 },
			{
				connections: [
					{
						url: leaderURL,
						database_sockets: [
							{ database: 'system', connected: true, lastReceivedStatus: 'Waiting', lastReceivedVersion: 50 },
						],
					},
				],
			},
			leaderURL
		);
		assert.deepStrictEqual(result, { synced: false, reason: 'No leader socket found for database data' });
	});

	it('ignores leader sockets outside the configured clone targets', () => {
		const result = checkCloneSyncStatus(
			{ system: 50 },
			{
				connections: [
					{
						url: leaderURL,
						database_sockets: [
							{ database: 'system', connected: true, lastReceivedStatus: 'Waiting', lastReceivedVersion: 50 },
							{ database: 'data', connected: true, lastReceivedStatus: 'Waiting', lastReceivedVersion: 100 },
						],
					},
				],
			},
			leaderURL
		);
		assert.deepStrictEqual(result, { synced: true });
	});

	it('does not synchronize against a disconnected socket with a stale watermark', () => {
		const result = checkCloneSyncStatus(
			{ data: 100 },
			{
				connections: [
					{
						url: leaderURL,
						database_sockets: [
							{ database: 'data', connected: false, lastReceivedStatus: 'Waiting', lastReceivedVersion: 100 },
						],
					},
				],
			},
			leaderURL
		);
		assert.deepStrictEqual(result, {
			synced: false,
			reason: 'Leader socket for database data is not connected',
		});
	});

	it('does not synchronize while a base-copy transaction is still open', () => {
		const result = checkCloneSyncStatus(
			{ data: 100 },
			{
				connections: [
					{
						url: leaderURL,
						database_sockets: [
							{ database: 'data', connected: true, lastReceivedStatus: 'Receiving', lastReceivedVersion: 100 },
						],
					},
				],
			},
			leaderURL
		);
		assert.deepStrictEqual(result, { synced: false, reason: 'Database data is still receiving its base copy' });
	});

	it('does not synchronize below a target watermark', () => {
		const result = checkCloneSyncStatus(
			{ data: 100 },
			{
				connections: [
					{
						url: leaderURL,
						database_sockets: [
							{ database: 'data', connected: true, lastReceivedStatus: 'Waiting', lastReceivedVersion: 99 },
						],
					},
				],
			},
			leaderURL
		);
		assert.equal(result.synced, false);
	});

	it('requires every target watermark', () => {
		const result = checkCloneSyncStatus(
			{ data: 100, system: 50 },
			{
				connections: [
					{
						url: leaderURL,
						database_sockets: [
							{ database: 'data', connected: true, lastReceivedStatus: 'Waiting', lastReceivedVersion: 100 },
							{ database: 'system', connected: true, lastReceivedStatus: 'Waiting', lastReceivedVersion: 51 },
						],
					},
				],
			},
			leaderURL
		);
		assert.deepStrictEqual(result, { synced: true });
	});
});
