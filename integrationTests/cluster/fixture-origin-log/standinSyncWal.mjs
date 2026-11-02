import { createRequire } from 'node:module';

const { RocksDatabase } = createRequire(import.meta.url)('@harperfast/rocksdb-js');

if (process.env.HARPER_TEST_WITHOUT_SYNC_WAL === '1') {
	// an engine before rocksdb-js 2.13.0: no floor record can be made durable, so this node neither certifies at
	// level 2 nor records copy bounds (preLevel2CopyFence.test.mjs)
	delete RocksDatabase.prototype.syncWal;
} else if (typeof RocksDatabase?.prototype?.syncWal !== 'function') {
	// `@harperfast/rocksdb-js` 2.12.0 has no `syncWal()`; stand in for it in cluster tests until rocksdb-js#949
	// publishes a build with the native binding, matching `core/unitTests/resources/subscribeCheckpoint.test.js`.
	RocksDatabase.prototype.syncWal = () => Promise.resolve();
}
