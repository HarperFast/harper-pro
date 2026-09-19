import assert from 'node:assert';
import { verifyLegacyCopyBaseline } from '#src/replication/legacyCopy';
import { LOCAL_ONLY } from '../../dist/core/resources/auditStore.js';

let nextPeer = 0;
function fixture(entries, remoteEntries = entries) {
	// Real getRange({ versions: true }) reports a live row's value; only a tombstone omits it.
	// Fill that in by default so a test only has to say `value: null` when it means a tombstone.
	entries = entries.map((entry) => ({ value: 'v', ...entry }));
	const rows = new Map(remoteEntries.map((entry) => [entry.key, entry.version]));
	const requests = [];
	const options = {
		peerName: `legacy-unit-${nextPeer++}`,
		databaseName: 'data',
		tables: {
			test: {
				primaryStore: {
					getRange({ snapshot }) {
						return (snapshot ? entries.slice() : entries).values();
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
	it('accepts a current-build describe_table response, which reports primary_key rather than hash_attribute', async () => {
		const entries = [{ key: 'k', version: 10 }];
		const { options, requests } = fixture(entries);
		const request = options.request;
		options.request = async (operation) => {
			if (operation.operation !== 'describe_table') return request(operation);
			return { primary_key: 'id', attributes: [{ attribute: '__updatedtime__' }] };
		};
		await verifyLegacyCopyBaseline(options);
		assert.strictEqual(requests.filter((operation) => operation.operation === 'search_by_id').length, 1);
	});
	it('pins later tables before a peer request can race concurrent inserts and updates', async () => {
		const entries = [{ key: 'old', version: 10 }];
		const { options, requests } = fixture(entries);
		options.tables.later = options.tables.test;
		const request = options.request;
		options.request = async (operation) => {
			entries[0] = { key: 'old', version: 20 };
			entries.push({ key: 'concurrent', version: 30 });
			return request(operation);
		};
		await verifyLegacyCopyBaseline(options);
		assert.deepStrictEqual(
			requests.filter((request) => request.ids).map((request) => request.ids),
			[['old'], ['old']]
		);
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
	it('does not verify delete tombstones: both sides already agree the row is gone', async () => {
		const { options, requests } = fixture([{ key: 'deleted', version: 10, value: null }], []);
		await verifyLegacyCopyBaseline(options);
		assert.strictEqual(requests.length, 0);
	});
	it('skips a tombstone as the first entry of a table without misreading it as ineligible forever', async () => {
		const entries = [
			{ key: 'deleted', version: 10, value: null },
			{ key: 'live', version: 10 },
		];
		const { options, requests } = fixture(entries);
		await verifyLegacyCopyBaseline(options);
		assert.deepStrictEqual(
			requests.filter((request) => request.ids).flatMap((request) => request.ids),
			['live']
		);
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
