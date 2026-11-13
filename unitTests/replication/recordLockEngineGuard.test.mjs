import assert from 'node:assert';
import { join } from 'node:path';
import { readMetaDb, table } from '#src/core/resources/databases';
import { replicatedLmdbDatabases } from '#src/replication/replicator';
import {
	admitClusterRecordLocks,
	CLUSTER_RECORD_LOCKS_ENABLED,
	RECORD_LOCKS_CONFIGURED,
	RECORD_LOCKS_LMDB_REFUSAL,
	recordLockAdmission,
} from '#src/replication/recordLockConfig';
import { createDisabledRecordLockTransport, RECORD_LOCKS_DISABLED_MESSAGE } from '#src/replication/recordLockTransport';

const configuredEngine = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

describe('record-lock guard on a node with RocksDB and LMDB databases', () => {
	before(() => {
		table({
			database: 'guard_rocks',
			table: 'Current',
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		// Empty `.mdb` roots: no table class exists yet, and a later create_table would land on LMDB. In
		// the storage path, so a catalog rescan finds them again rather than dropping them.
		readMetaDb(join(process.env.STORAGE_PATH, 'guard_legacy.mdb'), null, 'guard_legacy');
		readMetaDb(join(process.env.STORAGE_PATH, 'guard_scratch.mdb'), null, 'guard_scratch');
	});

	const lmdbIn = (options) => replicatedLmdbDatabases(options).filter((name) => name.startsWith('guard_'));

	it('lists the replicated databases opened on LMDB, whatever storage.engine says', () => {
		const expected = configuredEngine === 'lmdb' ? ['guard_legacy', 'guard_rocks'] : ['guard_legacy'];
		assert.deepStrictEqual(lmdbIn({ databases: ['guard_rocks', 'guard_legacy', 'system'] }), expected);
		assert.deepStrictEqual(lmdbIn({ databases: [{ name: 'guard_legacy' }] }), ['guard_legacy']);
	});

	it('leaves out an LMDB database replication does not cover', () => {
		const expected = configuredEngine === 'lmdb' ? ['guard_rocks'] : [];
		assert.deepStrictEqual(lmdbIn({ databases: ['guard_rocks'] }), expected);
	});

	it("counts every opened LMDB database under replication.databases '*' or unset", () => {
		const expected =
			configuredEngine === 'lmdb'
				? ['guard_legacy', 'guard_rocks', 'guard_scratch']
				: ['guard_legacy', 'guard_scratch'];
		assert.deepStrictEqual(lmdbIn({ databases: '*' }), expected);
		assert.deepStrictEqual(lmdbIn({}), expected);
	});

	it('refuses a configured node with any replicated LMDB database, and admits an all-RocksDB one', () => {
		assert.deepStrictEqual(recordLockAdmission(true, ['guard_legacy']), {
			enabled: false,
			refusal: RECORD_LOCKS_LMDB_REFUSAL,
		});
		assert.deepStrictEqual(recordLockAdmission(true, []), { enabled: true });
		assert.deepStrictEqual(recordLockAdmission(false, []), { enabled: false });
	});

	it('does not list databases, or enable, when config leaves record locks off', () => {
		assert.strictEqual(RECORD_LOCKS_CONFIGURED, false);
		let listed = false;
		assert.strictEqual(
			admitClusterRecordLocks(() => {
				listed = true;
				return [];
			}),
			false
		);
		assert.strictEqual(listed, false);
		assert.strictEqual(CLUSTER_RECORD_LOCKS_ENABLED, false);
	});

	it('answers cluster lock() with a 503 naming LMDB, not the switch that is already on', () => {
		const refused = createDisabledRecordLockTransport(RECORD_LOCKS_LMDB_REFUSAL);
		assert.throws(
			() => refused.homeMap('guard_rocks'),
			(error) => error.statusCode === 503 && error.message === RECORD_LOCKS_LMDB_REFUSAL
		);
		assert.match(RECORD_LOCKS_LMDB_REFUSAL, /opened on LMDB/);
		assert.match(RECORD_LOCKS_LMDB_REFUSAL, /storage\.migrateOnStart/);
		assert.doesNotMatch(RECORD_LOCKS_LMDB_REFUSAL, /guard_legacy/);
		assert.throws(
			() => createDisabledRecordLockTransport().homeMap('guard_rocks'),
			(error) => error.message === RECORD_LOCKS_DISABLED_MESSAGE
		);
	});

	it('counts an LMDB database outside replication.databases once one of its tables replicates', () => {
		readMetaDb(join(process.env.STORAGE_PATH, 'guard_tablerep.mdb'), null, 'guard_tablerep');
		assert.ok(!lmdbIn({ databases: ['guard_rocks'] }).includes('guard_tablerep'));
		table({
			database: 'guard_tablerep',
			table: 'Replicated',
			replicate: true,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		assert.ok(lmdbIn({ databases: ['guard_rocks'] }).includes('guard_tablerep'));
	});
});
