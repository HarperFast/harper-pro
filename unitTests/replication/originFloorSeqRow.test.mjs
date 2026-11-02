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
import { membersDigest, readCopyBounds } from '#src/core/resources/subscriptionCheckpoint';
import { setOriginCaptureIntervalForTests } from '#src/core/resources/transactionBroadcast';
import { getThisNodeName } from '#src/core/server/nodeName';
import {
	ensureCopyFence,
	persistMergedCopyBounds,
	persistCopyHole,
	readCopyHoles,
	settleCopyBounds,
	HOLE_COPY_BOUND,
} from '#src/replication/replicationConnection';
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

	it('refuses an origin a copy dropped a record of, and once a later complete pass fills it admits only starts after that pass', async function () {
		this.timeout(30_000);
		const T = table({
			table: 'CopyHoleAdmission',
			database: 'copy_hole_admission',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		const route = getIdOfRemoteNode('route-r', T.auditStore);
		const origin = getIdOfRemoteNode('origin-x', T.auditStore);
		const copier = getIdOfRemoteNode('copier-q', T.auditStore);
		const rootStore = T.primaryStore.rootStore;
		const listener = (event) => listener.values.push(event?.value?.value);
		listener.values = [];
		const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
		let releaseSource, sendRecertification;
		const held = new Promise((resolve) => (releaseSource = resolve));
		const recertification = new Promise((resolve) => (sendRecertification = resolve));
		const txnStream = {};
		const routeUpdate = (floor, routeStates) => {
			const event = {
				type: 'end_txn',
				localTime: floor,
				remoteNodeIds: [route],
				txnStream,
				onFailure: () => false,
				originRouteStates: routeStates,
			};
			event.onCommit = () => {
				event.originFloors = [[origin, floor, true, 'origin-generation', true]];
			};
			return event;
		};
		try {
			await T.put('a', { value: 'a' });
			await waitFor(() => listener.values.includes('a'), 'the live write');
			await new Promise((resolve) => setTimeout(resolve, 2));
			const floor = certify(T);
			T.sourcedFrom(
				{
					subscribeOnThisThread: () => true,
					async *subscribe() {
						yield routeUpdate(floor, [[origin, floor - 1000, undefined, undefined, 'origin-generation']]);
						yield await recertification;
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
			const admitted = await T.subscribe({ resume: token, omitCurrent: true, listener: () => {} });
			assert.strictEqual(await admitted.resumeVerified, true, 'admitted before the drop');
			admitted.end();

			// a projection from Q dropped a record of the origin: what any later process reads from the store
			await persistCopyHole(T.dbisDB, copier, rootStore, 'dropping-pass', 1, [origin], floor - 500);
			await assert.rejects(
				T.subscribe({ resume: token, omitCurrent: true }),
				(error) => error.statusCode === 410,
				'no route certifies an origin missing a record'
			);

			// a later pass from Q copies everything again and drops nothing: it fills the hole, but its snapshot carries
			// no audit entry for the dropped record, so a checkpoint from before it still cannot be resumed
			const copyStart = Date.now();
			await settleCopyBounds(T.dbisDB, new Map(), copier, rootStore, 'later-pass', readCopyHoles(T.dbisDB), copyStart);
			assert.deepEqual(readCopyHoles(T.dbisDB), []);
			await assert.rejects(
				T.subscribe({ resume: token, omitCurrent: true }),
				(error) => error.statusCode === 410,
				'a checkpoint from before the filled hole stays refused'
			);

			// the route certifies again from after the pass, as its next fresh socket does: the void start cleared first
			await T.put('b', { value: 'b' });
			await waitFor(() => listener.values.includes('b'), 'a later live write');
			await new Promise((resolve) => setTimeout(resolve, 2));
			const laterFloor = certify(T);
			assert.ok(laterFloor > copyStart + 1);
			sendRecertification(
				routeUpdate(laterFloor, [
					[origin, undefined, true, undefined, 'origin-generation'],
					[origin, copyStart + 1, false, undefined, 'origin-generation'],
				])
			);
			let laterToken;
			await waitFor(
				() => (laterToken = subscription.checkpoint())?.members === members && laterToken.time >= laterFloor,
				'a checkpoint after the recertification'
			);
			const readmitted = await T.subscribe({ resume: laterToken, omitCurrent: true, listener: () => {} });
			assert.strictEqual(await readmitted.resumeVerified, true, 'a start after the filled hole is admitted');
			readmitted.end();
		} finally {
			releaseSource();
			sendRecertification(undefined);
			subscription.end();
		}
	});

	it('never releases a loss a pass recorded after another pass captured its hole', async () => {
		const T = table({
			table: 'CopyHoleRevisions',
			database: 'copy_hole_revisions',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const copier = getIdOfRemoteNode('copier-q', T.auditStore);
		const [x, y] = ['origin-x', 'origin-y'].map((name) => getIdOfRemoteNode(name, T.auditStore));
		const rootStore = T.primaryStore.rootStore;
		await persistCopyHole(T.dbisDB, copier, rootStore, 'pass-a', 1, [x], 100);
		// a clean pass begins, and captures what stands
		const captured = readCopyHoles(T.dbisDB);
		// pass A then drops a record of another origin: a new revision, which releases the one captured
		const [first] = captured;
		await persistCopyHole(T.dbisDB, copier, rootStore, 'pass-a', 2, [x, y], 200, first.slot);
		await settleCopyBounds(T.dbisDB, new Map(), copier, rootStore, 'pass-b', captured, 150);
		const standing = readCopyHoles(T.dbisDB);
		assert.deepEqual(
			standing.map(({ origins, lossKey }) => [origins.sort(), lossKey]),
			[[[x, y].sort(), 200]],
			'the later loss stays'
		);
		assert.strictEqual(readCopyBounds(T.dbisDB).get(y), HOLE_COPY_BOUND);
	});

	it('a fence written once per generation refuses certifications and own boundaries from before it', async function () {
		this.timeout(30_000);
		const T = table({
			table: 'CopyFenceSeqRow',
			database: 'copy_fence_seq_row',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		const route = getIdOfRemoteNode('fence-route', T.auditStore);
		const origin = getIdOfRemoteNode('fence-origin', T.auditStore);
		const listener = (event) => listener.values.push(event?.value?.value);
		listener.values = [];
		const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
		let releaseRoute;
		const routeHeld = new Promise((resolve) => (releaseRoute = resolve));
		try {
			await T.put('a', { value: 'a' });
			await waitFor(() => listener.values.includes('a'), 'the live write');
			await new Promise((resolve) => setTimeout(resolve, 2));
			const floor = certify(T);
			// a route that resumed floor-only below a row an older build copied in: nothing on the row says so
			const certificate = {
				type: 'end_txn',
				localTime: floor,
				remoteNodeIds: [route],
				txnStream: {},
				onFailure: () => false,
				originRouteStates: [[origin, floor - 1000, undefined, undefined, 'fence-origin-generation']],
			};
			certificate.onCommit = () => {
				certificate.originFloors = [[origin, floor, true, 'fence-origin-generation', true]];
			};
			T.sourcedFrom(
				{
					subscribeOnThisThread: () => true,
					async *subscribe() {
						yield certificate;
						await routeHeld;
					},
				},
				{ intermediateSource: true }
			);
			const generation = getDatabaseGeneration(T.auditStore).id;
			const members = membersDigest([
				[getThisNodeName(), generation],
				['fence-origin', 'fence-origin-generation'],
			]);
			let token;
			await waitFor(() => (token = subscription.checkpoint())?.members === members, 'a checkpoint naming the origin');
			const admitted = await T.subscribe({ resume: token, omitCurrent: true, listener: () => {} });
			assert.strictEqual(await admitted.resumeVerified, true, 'admitted before the fence');
			admitted.end();

			const fenceKey = [Symbol.for('copyBound'), 0, 'fence', generation];
			const before = Date.now();
			await ensureCopyFence(T.auditStore, T.dbisDB, true);
			const fence = { ...T.dbisDB.getSync(fenceKey) };
			assert.ok(fence[origin] >= before + 60_000, `the fence reaches past now by the headroom: ${fence[origin]}`);
			assert.strictEqual(fence[route], fence[origin], 'every mapped origin is fenced');
			assert.strictEqual(fence[0], fence[origin], 'the own origin is fenced');
			assert.deepStrictEqual({ ...T.dbisDB.getSync([Symbol.for('copyFence'), generation]) }, { bounded: true });
			await assert.rejects(
				T.subscribe({ resume: token, omitCurrent: true }),
				(error) => error.statusCode === 410,
				'a certification and an own boundary from before the fence are refused'
			);

			await new Promise((resolve) => setTimeout(resolve, 5));
			await ensureCopyFence(T.auditStore, T.dbisDB, true);
			assert.deepStrictEqual({ ...T.dbisDB.getSync(fenceKey) }, fence, 'a fenced generation is not fenced again');
		} finally {
			releaseRoute();
			subscription.end();
		}
	});

	it('a database present at startup with no replication history is marked without a bound', async () => {
		const T = table({
			table: 'CopyFenceClean',
			database: 'copy_fence_clean',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		await T.put('a', { value: 'a' });
		const generation = getDatabaseGeneration(T.auditStore).id;
		await ensureCopyFence(T.auditStore, T.dbisDB, true);
		assert.deepStrictEqual({ ...T.dbisDB.getSync([Symbol.for('copyFence'), generation]) }, { bounded: false });
		assert.strictEqual(T.dbisDB.getSync([Symbol.for('copyBound'), 0, 'fence', generation]), undefined);
	});

	it('a database present at startup that knows a remote origin is fenced though no progress row survived', async () => {
		const T = table({
			table: 'CopyFenceMapped',
			database: 'copy_fence_mapped',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		getIdOfRemoteNode('mapped-peer', T.auditStore);
		const generation = getDatabaseGeneration(T.auditStore).id;
		await ensureCopyFence(T.auditStore, T.dbisDB, true);
		assert.deepStrictEqual({ ...T.dbisDB.getSync([Symbol.for('copyFence'), generation]) }, { bounded: true });
	});

	it('a database seen at startup is still fenced when its first fence fails and a later non-startup call retries', async () => {
		const T = table({
			table: 'CopyFenceRetry',
			database: 'copy_fence_retry',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		await T.dbisDB.put([Symbol.for('seq'), 5], { seqId: 1, nodes: [] });
		const malformed = [Symbol.for('copyBound'), 9];
		await T.dbisDB.put(malformed, { 2: 'x' });
		const generation = getDatabaseGeneration(T.auditStore).id;
		await assert.rejects(ensureCopyFence(T.auditStore, T.dbisDB, true), (error) => error.statusCode === 410);
		assert.strictEqual(
			T.dbisDB.getSync([Symbol.for('copyFence'), generation]),
			undefined,
			'a failed fence marks nothing'
		);
		await T.dbisDB.remove(malformed);
		await ensureCopyFence(T.auditStore, T.dbisDB);
		assert.deepStrictEqual({ ...T.dbisDB.getSync([Symbol.for('copyFence'), generation]) }, { bounded: true });
		assert.ok(
			T.dbisDB.getSync([Symbol.for('copyBound'), 0, 'fence', generation])?.[0] > 0,
			'the retry wrote the fence'
		);
	});

	it("a database created after startup is marked without a bound despite its first copy's rows", async () => {
		const T = table({
			table: 'CopyFenceCreated',
			database: 'copy_fence_created',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		await T.dbisDB.put([Symbol.for('copyCursor'), 5], { copyStartTime: Date.now() });
		const generation = getDatabaseGeneration(T.auditStore).id;
		await ensureCopyFence(T.auditStore, T.dbisDB);
		assert.deepStrictEqual({ ...T.dbisDB.getSync([Symbol.for('copyFence'), generation]) }, { bounded: false });
		assert.strictEqual(T.dbisDB.getSync([Symbol.for('copyBound'), 0, 'fence', generation]), undefined);
	});
});
