/**
 * The storage-engine contract the W1 connection truth (harper-pro#431) rests on. RocksDB frees a user
 * shared buffer once the last view of it is collected and re-mints it zeroed on the next resolution; LMDB
 * keeps it on the env for the env's lifetime. subscriptionManager therefore anchors the (database, peer)
 * status buffer on its subscription entry, and only the RocksDB arm can show why that is load-bearing.
 */

import { expect } from 'chai';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/knownNodes';
import { LAST_ERROR_CODE_POSITION, WORKER_EXIT_ERROR_CODE } from '#src/replication/replicationConnection';

// Required, not imported: the ESM entry evaluates a second copy of the package that knownNodes has already
// loaded through CJS, and the two copies collide redefining the transaction-log reader's properties.
const { RocksDatabase } = createRequire(import.meta.url)('@harperfast/rocksdb-js');

setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc');

// V8 promises no collection on demand — a residual stack or register reference can keep a temporary view
// alive — so the drop below is observed over several rounds rather than asserted after one.
const COLLECTION_ROUNDS = 20;

describe('replication shared-status buffer retention', () => {
	let directory;
	let db;

	before(() => {
		directory = mkdtempSync(join(tmpdir(), 'shared-status-retention-'));
		db = new RocksDatabase(join(directory, 'retention.db'));
		db.open();
	});

	after(() => {
		db?.close();
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	// Mirrors getReplicationSharedStatus: same key shape, same slot count, same per-call view.
	const resolve = (databaseName, nodeName) =>
		new Float64Array(
			db.getUserSharedBuffer(
				['replicated', databaseName, nodeName],
				new ArrayBuffer(REPLICATION_SHARED_STATUS_SLOTS * 8)
			)
		);

	const settle = async () => {
		collect();
		await new Promise((done) => setImmediate(done));
		collect();
	};

	it('drops a stamp written into a buffer nothing holds', async function () {
		resolve('data', 'unanchored')[LAST_ERROR_CODE_POSITION] = WORKER_EXIT_ERROR_CODE;
		expect(resolve('data', 'unanchored')[LAST_ERROR_CODE_POSITION]).to.equal(WORKER_EXIT_ERROR_CODE);

		for (let round = 0; round < COLLECTION_ROUNDS; round++) {
			await settle();
			if (resolve('data', 'unanchored')[LAST_ERROR_CODE_POSITION] === 0) return;
		}
		// Nothing was collected, so this run proves nothing either way; failing here would report a GC
		// scheduling detail as a defect. The anchored case below is the assertion that must always hold.
		this.skip();
	});

	it('keeps the stamp while an anchor holds the buffer', async () => {
		const anchor = resolve('data', 'anchored');
		anchor[LAST_ERROR_CODE_POSITION] = WORKER_EXIT_ERROR_CODE;

		for (let round = 0; round < COLLECTION_ROUNDS; round++) await settle();

		expect(resolve('data', 'anchored')[LAST_ERROR_CODE_POSITION]).to.equal(WORKER_EXIT_ERROR_CODE);
		expect(anchor[LAST_ERROR_CODE_POSITION]).to.equal(WORKER_EXIT_ERROR_CODE);
	});

	it('keeps each (database, peer) buffer separate', () => {
		const anchors = [
			resolve('data', 'peer-one'),
			resolve('data', 'peer-two'),
			resolve('other', 'peer-one'),
			resolve('other', 'peer-two'),
		];
		anchors[0][LAST_ERROR_CODE_POSITION] = WORKER_EXIT_ERROR_CODE;

		expect(anchors.map((anchor) => anchor[LAST_ERROR_CODE_POSITION])).to.deep.equal([WORKER_EXIT_ERROR_CODE, 0, 0, 0]);
	});
});
