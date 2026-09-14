/**
 * Pins the storage-engine contract the W1 connection truth (harper-pro#431) rests on: a user shared buffer
 * lives only as long as a JS view of it does. The per-(database, peer) replication status buffer is read
 * transiently almost everywhere, so if nothing durable holds it the next resolution silently returns a
 * ZEROED buffer — losing the worker-exit close code, the receive watermark, the back-pressure ratio, the
 * blob-failure counts and the recovery-fire counters for that link.
 *
 * subscriptionManager anchors it on the subscription entry so the allocation's lifetime is the membership's.
 * These assertions are what make that anchor necessary rather than decorative: if an engine ever starts
 * retaining these buffers itself, this test is where that shows up.
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

// mocha runs without --expose-gc, and this suite needs a real collection rather than a heuristic wait.
setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc');

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
	const resolve = (nodeName) =>
		new Float64Array(
			db.getUserSharedBuffer(['replicated', 'data', nodeName], new ArrayBuffer(REPLICATION_SHARED_STATUS_SLOTS * 8))
		);

	it('drops a stamp written into a buffer nothing holds', async () => {
		resolve('unanchored')[LAST_ERROR_CODE_POSITION] = WORKER_EXIT_ERROR_CODE;
		expect(resolve('unanchored')[LAST_ERROR_CODE_POSITION]).to.equal(WORKER_EXIT_ERROR_CODE);

		gc();
		await new Promise((resolve) => setImmediate(resolve));
		gc();

		expect(resolve('unanchored')[LAST_ERROR_CODE_POSITION]).to.equal(0);
	});

	it('keeps the stamp while an anchor holds the buffer', async () => {
		const anchor = resolve('anchored');
		anchor[LAST_ERROR_CODE_POSITION] = WORKER_EXIT_ERROR_CODE;

		gc();
		await new Promise((resolve) => setImmediate(resolve));
		gc();

		expect(resolve('anchored')[LAST_ERROR_CODE_POSITION]).to.equal(WORKER_EXIT_ERROR_CODE);
		expect(anchor[LAST_ERROR_CODE_POSITION]).to.equal(WORKER_EXIT_ERROR_CODE);
	});

	it('keeps each (database, peer) buffer separate', () => {
		const first = resolve('peer-one');
		const second = resolve('peer-two');
		first[LAST_ERROR_CODE_POSITION] = WORKER_EXIT_ERROR_CODE;

		expect(second[LAST_ERROR_CODE_POSITION]).to.equal(0);
		expect(resolve('peer-one')[LAST_ERROR_CODE_POSITION]).to.equal(WORKER_EXIT_ERROR_CODE);
	});
});
