import assert from 'node:assert';
import { isLegacyCopyPeer, verifyLegacyCopyBaseline } from '#src/replication/legacyCopy';
import { LOCAL_ONLY } from '../../dist/core/resources/auditStore.js';

describe('legacy copy peer identification', () => {
	it('uses the latest installation stamp, including an upgraded v4 database', () => {
		assert.strictEqual(isLegacyCopyPeer({ results: [{ info_id: 1, hdb_version_num: '4.7.36' }] }), true);
		assert.strictEqual(
			isLegacyCopyPeer({
				results: [
					{ info_id: 2, hdb_version_num: '5.3.0-alpha.1' },
					{ info_id: 1, hdb_version_num: '4.7.36' },
				],
			}),
			false
		);
	});
	it('does not interpret a failed or malformed probe as a safe v5 peer', () => {
		for (const response of [
			{ error: 'not found' },
			{ results: [] },
			{ results: [{ info_id: 1, hdb_version_num: 5 }] },
			{ results: [{ info_id: 1, hdb_version_num: '3.3.0' }] },
			{ results: [{ info_id: '1', hdb_version_num: '5.3.0' }] },
		])
			assert.throws(() => isLegacyCopyPeer(response));
	});
});

let nextPeer = 0;
function fixture(entries, remoteEntries = entries) {
	const rows = new Map(remoteEntries.map((entry) => [entry.key, entry.version]));
	const requests = [];
	const options = {
		peerName: `legacy-unit-${nextPeer++}`,
		databaseName: 'data',
		tables: {
			test: {
				primaryStore: {
					getRange() {
						return entries.values();
					},
					getEntry(key) {
						return entries.find((entry) => entry.key === key);
					},
				},
			},
		},
		isClosed: () => false,
		async request(operation) {
			requests.push(operation);
			if (operation.operation === 'describe_table')
				return {
					hash_attribute: 'id',
					attributes: [{ attribute: '__updatedtime__' }],
				};
			assert.strictEqual(operation.operation, 'search_by_id');
			assert.deepStrictEqual(operation.get_attributes, ['id', '__updatedtime__']);
			assert.ok(operation.ids.length <= 256);
			return {
				results: operation.ids.filter((key) => rows.has(key)).map((id) => ({ id, __updatedtime__: rows.get(id) })),
			};
		},
	};
	return { options, requests, rows };
}

describe('legacy existing-baseline verification', () => {
	it('verifies every key in bounded projections, accepting newer remote records', async () => {
		const entries = Array.from({ length: 600 }, (_, key) => ({ key, version: key + 10 }));
		const { options, requests } = fixture(
			entries,
			entries.map((entry) => ({ ...entry, version: entry.version + 1 }))
		);
		await verifyLegacyCopyBaseline(options);
		assert.strictEqual(requests.filter((operation) => operation.operation === 'search_by_id').length, 3);
		assert.strictEqual(requests.flatMap((operation) => operation.ids ?? []).length, 600);
	});
	it('rejects missing, older and unverifiable versions instead of acknowledging an incomplete baseline', async () => {
		for (const remote of [[], [{ key: 'k', version: 9 }], [{ key: 'k', version: NaN }]]) {
			await assert.rejects(
				verifyLegacyCopyBaseline(fixture([{ key: 'k', version: 10 }], remote).options),
				/Historical restoration/
			);
		}
	});
	it('checks the previously missing row first on reconnect, then recovers when that row is present', async () => {
		const entries = Array.from({ length: 600 }, (_, key) => ({ key, version: 10 }));
		const { options, requests, rows } = fixture(entries, entries.slice(0, -1));
		await assert.rejects(verifyLegacyCopyBaseline(options), /Historical restoration/);
		requests.length = 0;
		await assert.rejects(verifyLegacyCopyBaseline(options), /Historical restoration/);
		assert.deepStrictEqual(requests[1].ids, [599]);
		rows.set(599, 10);
		await verifyLegacyCopyBaseline(options);
	});
	it('does not verify local-only records or empty tables', async () => {
		const { options, requests } = fixture([{ key: 'private', version: 10, metadataFlags: LOCAL_ONLY }], []);
		await verifyLegacyCopyBaseline(options);
		assert.strictEqual(requests.length, 0);
	});
	it('stops verification when the connection closes during a request', async () => {
		const { options, requests } = fixture([{ key: 'k', version: 10 }]);
		options.isClosed = () => requests.length > 0;
		await assert.rejects(verifyLegacyCopyBaseline(options), /Connection closed/);
		assert.strictEqual(requests.length, 1);
	});
	it('rejects a timestamp projection that cannot prove the stored version', async () => {
		const { options } = fixture([{ key: 'k', version: 10 }]);
		options.request = async () => ({
			hash_attribute: 'id',
			attributes: [{ attribute: 'updatedAt', assigned_updated_time: true, type: 'Date' }],
		});
		await assert.rejects(verifyLegacyCopyBaseline(options), /numeric update timestamps/);
	});
});
