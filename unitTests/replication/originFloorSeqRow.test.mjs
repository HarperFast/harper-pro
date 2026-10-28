/**
 * The seam between this receiver and core: `seqUpdateEndTxn` (replicationConnection.ts) attaches
 * certified floors to its `end_txn` from `onCommit`, and core's apply loop (`updateRecordedSequenceId`
 * in core `resources/Table.ts`) stores them in the `[seq, peer]` row that resume reads — including
 * merging 4-field (`relayable: true`) and 3-field (`relayable` omitted) `[seq, peer]` structures across
 * RocksDB `__dbis__` handles. The halves land through the `core` pointer, so a core regression on
 * `originFloors` or `__dbis__` structure saves must fail here, not after 90 s per case in
 * integrationTests/cluster/idleOriginFloorResume.test.mjs.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { table } from '#src/core/resources/databases';
import { getDatabaseGeneration, persistOriginClosedFloor } from '#src/core/resources/auditStore';
import { certifyOriginFloor, publishOriginFloor, getOriginClosedFloor } from '#src/core/resources/originClosedFloor';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { membersDigest } from '#src/core/resources/subscriptionCheckpoint';
import { setOriginCaptureIntervalForTests } from '#src/core/resources/transactionBroadcast';
import { getThisNodeName } from '#src/core/server/nodeName';
import { persistMergedCopyBounds } from '#src/replication/replicationConnection';
import { PrimaryRocksDatabase } from '#src/core/resources/PrimaryRocksDatabase';
import { OpenDBIObject } from '#src/core/utility/lmdb/OpenDBIObject';
import { setMainIsWorker } from '#js/core/server/threads/manageThreads';
import '#src/core/server/serverHelpers/serverUtilities';

const { setupTestDBPath } = createRequire(import.meta.url)('../testUtils.js');

const PEER = 46;
const ORIGIN = 7;
const SEQ = Symbol.for('seq');

async function waitForRow(Table, predicate, what) {
	const deadline = Date.now() + 5000;
	for (;;) {
		const row = Table.dbisDB.getSync([SEQ, PEER]);
		if (predicate(row)) return row;
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}; row: ${JSON.stringify(row)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('a certified origin floor reaches the seq row through core', () => {
	let release;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	after(() => {
		release?.();
		setMainIsWorker(false);
	});

	it('stores closedFloor and relayable beside the applied cursor, on a floor-only sequence update', async function () {
		this.timeout(20_000);
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const txnStream = {};
		const floorUpdate = (localTime, originFloors) => {
			const event = { type: 'end_txn', localTime, remoteNodeIds: [PEER], txnStream };
			event.onFailure = () => false;
			event.onCommit = () => {
				event.originFloors = originFloors;
			};
			return event;
		};
		const events = [
			{ type: 'put', id: 1, value: { id: 1, name: 'seed' }, timestamp: now },
			{
				type: 'end_txn',
				localTime: now,
				remoteNodeIds: [PEER],
				txnStream,
				onFailure: () => false,
				originCursors: [[ORIGIN, now - 5]],
			},
			floorUpdate(now, [[ORIGIN, now - 20, false]]),
			floorUpdate(now, [[ORIGIN, now - 10, true]]),
		];
		const Receiving = table({
			table: 'OriginFloorSeqRow',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		Receiving.sourcedFrom(
			{
				subscribeOnThisThread: () => true,
				async *subscribe() {
					for (const event of events) yield event;
					await held;
				},
			},
			{ intermediateSource: true }
		);

		const row = await waitForRow(
			Receiving,
			(current) => current?.nodes?.some((node) => node.id === ORIGIN && node.closedFloor === now - 10),
			"the origin's floor to rise to the second certificate"
		);
		assert.equal(row.seqId, now, 'a floor-only update does not move the applied position');
		assert.deepEqual(
			row.nodes.map((node) => ({ ...node })),
			[{ id: ORIGIN, originLogKey: now - 5, closedFloor: now - 10, relayable: true }],
			'the floor is kept by max apart from the applied cursor, and relayable follows the latest floor'
		);
	});

	it('merges concurrent 4-field and 3-field [seq, peer] structure saves across RocksDB worker __dbis__ handles', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-seq-row-'));
		const openWorkerDbis = () => {
			const db = new PrimaryRocksDatabase(tempDir, {
				...new OpenDBIObject(false),
				name: '__dbis__',
			}).open();
			db.encoder.useVersions = false;
			return db;
		};

		let db1;
		let db2;
		let readerDb;
		try {
			db1 = openWorkerDbis();
			db2 = openWorkerDbis();
			const rowWithRelayable = {
				seqId: 1000,
				nodes: [{ id: ORIGIN, originLogKey: 900, closedFloor: 850, relayable: true }],
			};
			const rowWithoutRelayable = {
				seqId: 2000,
				nodes: [{ id: ORIGIN + 1, originLogKey: 1900, closedFloor: 1850 }],
			};

			const origTxn2 = db2.transactionSync;
			let injected = false;
			db2.transactionSync = function (callback, options) {
				return origTxn2.call(
					this,
					(txn, attempt) =>
						callback(
							new Proxy(txn, {
								get(target, prop) {
									if (prop === 'putSync' && !injected) {
										return (...args) => {
											injected = true;
											db1.putSync([SEQ, PEER + 1], rowWithRelayable);
											return target.putSync(...args);
										};
									}
									const value = target[prop];
									return typeof value === 'function' ? value.bind(target) : value;
								},
							}),
							attempt
						),
					options
				);
			};

			db2.putSync([SEQ, PEER + 2], rowWithoutRelayable);
			assert.ok(injected, 'expected db1 structure save to interleave inside db2 saveStructures read-to-put window');

			db2.close();
			db2 = undefined;
			db1.close();
			db1 = undefined;

			readerDb = openWorkerDbis();
			assert.deepEqual(readerDb.getSync([SEQ, PEER + 1]), rowWithRelayable);
			assert.deepEqual(readerDb.getSync([SEQ, PEER + 2]), rowWithoutRelayable);
		} finally {
			for (const handle of [readerDb, db2, db1]) {
				try {
					handle?.close();
				} catch {
					// Ensure remaining handles and tempDir are still cleaned up.
				}
			}
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("one writer per [seq, peer] row: another route's copy never rewrites it", () => {
	let release;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		setOriginCaptureIntervalForTests(100);
	});

	after(() => {
		release?.();
		setMainIsWorker(false);
	});

	async function waitFor(predicate, what) {
		const deadline = Date.now() + 10_000;
		while (!predicate()) {
			if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	function certify(T) {
		const rootStore = T.primaryStore.rootStore;
		if (typeof rootStore.syncWal !== 'function') rootStore.syncWal = () => Promise.resolve();
		let floor = certifyOriginFloor(rootStore);
		for (let retry = 0; floor === null && retry < 100; retry++) floor = certifyOriginFloor(rootStore);
		if (floor) {
			persistOriginClosedFloor(T.auditStore, floor);
			publishOriginFloor(rootStore, floor);
		}
		return getOriginClosedFloor(rootStore)?.floor ?? 0;
	}

	it("refuses a disconnected route's certification once a copy on another route covers it, whatever the route's in-flight commit wrote", async function () {
		this.timeout(30_000);
		const T = table({
			table: 'SingleWriterSeqRow',
			database: 'single_writer_seq_row',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		const route = getIdOfRemoteNode('route-r', T.auditStore);
		const origin = getIdOfRemoteNode('origin-x', T.auditStore);
		const copier = getIdOfRemoteNode('copier-q', T.auditStore);
		const listener = (event) => listener.values.push(event?.value?.value);
		listener.values = [];
		const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
		await T.put('a', { value: 'a' });
		await waitFor(() => listener.values.includes('a'), 'the live write');
		await new Promise((resolve) => setTimeout(resolve, 2));
		const floor = certify(T);
		const certifiedFrom = floor - 1000;

		// route R's own apply loop: a level-2 certificate with the start it certified from, then (after R has
		// disconnected) one last frame whose commit was already in flight
		const held = new Promise((resolve) => (release = resolve));
		let sendLastFrame;
		const lastFrameReady = new Promise((resolve) => (sendLastFrame = resolve));
		const txnStream = {};
		const certificate = {
			type: 'end_txn',
			localTime: floor,
			remoteNodeIds: [route],
			txnStream,
			onFailure: () => false,
			originRouteStates: [[origin, certifiedFrom, undefined, undefined, 'origin-generation']],
		};
		certificate.onCommit = () => {
			certificate.originFloors = [[origin, floor, true, 'origin-generation', true]];
		};
		const lastFrame = {
			type: 'end_txn',
			localTime: floor + 1,
			remoteNodeIds: [route],
			txnStream,
			onFailure: () => false,
			originCursors: [[origin, floor + 1]],
		};
		T.sourcedFrom(
			{
				subscribeOnThisThread: () => true,
				async *subscribe() {
					yield certificate;
					await lastFrameReady;
					yield lastFrame;
					await held;
				},
			},
			{ intermediateSource: true }
		);
		const members = membersDigest([
			[getThisNodeName(), getDatabaseGeneration(T.auditStore).id],
			['origin-x', 'origin-generation'],
		]);
		let token;
		await waitFor(() => (token = subscription.checkpoint())?.members === members, "a checkpoint naming R's origin");
		const resumed = await T.subscribe({ resume: token, omitCurrent: true, listener: () => {} });
		assert.strictEqual(await resumed.resumeVerified, true, 'admitted before any copy');
		resumed.end();

		// the copy on Q lands between the in-flight commit's read of R's row and its write
		const dbisDB = T.dbisDB;
		const getSync = dbisDB.getSync;
		let copyRan = false;
		let copyPersist;
		dbisDB.getSync = function (key, ...rest) {
			if (!copyRan && Array.isArray(key) && key[0] === SEQ && key[1] === route) {
				copyRan = true;
				const row = getSync.call(this, key, ...rest);
				copyPersist = persistMergedCopyBounds(
					dbisDB,
					new Map([[origin, certifiedFrom]]),
					copier,
					T.primaryStore.rootStore
				);
				return row;
			}
			return getSync.call(this, key, ...rest);
		};
		try {
			sendLastFrame();
			await waitFor(
				() =>
					getSync
						.call(dbisDB, [SEQ, route])
						?.nodes?.some((node) => node.id === origin && node.originLogKey === floor + 1),
				"R's last frame to commit"
			);
		} finally {
			dbisDB.getSync = getSync;
		}
		assert.ok(copyRan, "the copy ran between the commit's read and its write");
		await copyPersist;
		await assert.rejects(
			T.subscribe({ resume: token, omitCurrent: true }),
			(error) => error.statusCode === 410,
			'the stale certification is refused'
		);
		subscription.end();
	});
});
