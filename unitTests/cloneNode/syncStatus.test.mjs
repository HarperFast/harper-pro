import { expect } from 'chai';
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
		expect(validateCloneSyncBaseline(persisted, 'https://leader:9925')).to.equal(copyStartTime - 1);
		expect(validateCloneSyncBaseline(persisted, 'https://leader:9925')).to.be.lessThan(resumedAt);
	});

	it('rejects a persisted baseline from another clone attempt', () => {
		expect(() =>
			validateCloneSyncBaseline(
				{
					version: CLONE_SYNC_BASELINE_VERSION,
					leaderURL: 'https://old-leader:9925',
					leaderBaseline: 1730000000000,
				},
				'https://leader:9925'
			)
		).to.throw('does not match this clone attempt');
	});

	it('uses one pre-copy leader baseline for every replicated database', () => {
		const result = deriveCloneTargets({ system: {}, data: { items: {} } }, '*', 1730000000100);
		expect(result).to.deep.equal({
			targets: { system: 1730000000100, data: 1730000000100 },
			errors: [],
		});
	});

	it('fails closed when the leader clock is unavailable', () => {
		const result = deriveCloneTargets({}, '*', undefined);
		expect(result).to.deep.equal({ targets: {}, errors: ['Leader did not return a valid current time'] });
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
		expect(result).to.deep.equal({ targets: { data: 1000 }, errors: [] });
		expect(isReplicatedDatabase([{ name: 'data' }], 'data')).to.equal(true);
		expect(isReplicatedDatabase([{ name: 'data' }], 'staging')).to.equal(false);
	});

	it('fails closed when an explicitly configured database is omitted', () => {
		const result = deriveCloneTargets({ system: {} }, ['system', 'data'], 1000);
		expect(result).to.deep.equal({
			targets: { system: 1000 },
			errors: ['Leader description omitted configured database data'],
		});
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
						database_sockets: [{ database: 'system', lastReceivedStatus: 'Waiting', lastReceivedVersion: 50 }],
					},
				],
			},
			leaderURL
		);
		expect(result).to.deep.equal({ synced: false, reason: 'No leader socket found for database data' });
	});

	it('does not synchronize when the leader exposes a socket without a target', () => {
		const result = checkCloneSyncStatus(
			{ system: 50 },
			{
				connections: [
					{
						url: leaderURL,
						database_sockets: [
							{ database: 'system', lastReceivedStatus: 'Waiting', lastReceivedVersion: 50 },
							{ database: 'data', lastReceivedStatus: 'Waiting', lastReceivedVersion: 100 },
						],
					},
				],
			},
			leaderURL
		);
		expect(result).to.deep.equal({ synced: false, reason: 'No clone target found for leader database data' });
	});

	it('does not synchronize while a base-copy transaction is still open', () => {
		const result = checkCloneSyncStatus(
			{ data: 100 },
			{
				connections: [
					{
						url: leaderURL,
						database_sockets: [{ database: 'data', lastReceivedStatus: 'Receiving', lastReceivedVersion: 100 }],
					},
				],
			},
			leaderURL
		);
		expect(result).to.deep.equal({ synced: false, reason: 'Database data is still receiving its base copy' });
	});

	it('does not synchronize below a target watermark', () => {
		const result = checkCloneSyncStatus(
			{ data: 100 },
			{
				connections: [
					{
						url: leaderURL,
						database_sockets: [{ database: 'data', lastReceivedStatus: 'Waiting', lastReceivedVersion: 99 }],
					},
				],
			},
			leaderURL
		);
		expect(result.synced).to.equal(false);
	});

	it('requires every target watermark', () => {
		const result = checkCloneSyncStatus(
			{ data: 100, system: 50 },
			{
				connections: [
					{
						url: leaderURL,
						database_sockets: [
							{ database: 'data', lastReceivedStatus: 'Waiting', lastReceivedVersion: 100 },
							{ database: 'system', lastReceivedStatus: 'Waiting', lastReceivedVersion: 51 },
						],
					},
				],
			},
			leaderURL
		);
		expect(result).to.deep.equal({ synced: true });
	});
});
