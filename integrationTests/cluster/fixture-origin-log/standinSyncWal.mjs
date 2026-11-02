import { createRequire } from 'node:module';

const { RocksDatabase } = createRequire(import.meta.url)('@harperfast/rocksdb-js');

// `@harperfast/rocksdb-js` 2.12.0 has no `syncWal()`; stand in for it in cluster tests until rocksdb-js#949
// publishes a build with the native binding, matching `core/unitTests/resources/subscribeCheckpoint.test.js`.
if (typeof RocksDatabase?.prototype?.syncWal !== 'function') {
	RocksDatabase.prototype.syncWal = () => Promise.resolve();
}
