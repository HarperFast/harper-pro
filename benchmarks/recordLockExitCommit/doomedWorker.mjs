/**
 * The departed off-owner worker of harper-pro#865 ledger item 5: it staged writes under a relayed
 * admission, unlocked, handed the commits to the engine, and is about to be terminated. Nothing is
 * awaited — the state under test is a commit whose calling thread abandons it.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { RocksDatabase } from '@harperfast/rocksdb-js';

const db = new RocksDatabase(workerData.path);
db.open();

const value = 'x'.repeat(workerData.valueBytes);
for (let i = 0; i < workerData.count; i++) {
	if (workerData.mode === 'transaction') db.transaction(() => db.put(`contested-${i}`, { writer: 'doomed', i, value }));
	else db.put(`contested-${i}`, { writer: 'doomed', i, value });
}

parentPort.postMessage({ handedOff: workerData.count, stalledAtHandoff: db.isWriteStalled?.() ?? null });
