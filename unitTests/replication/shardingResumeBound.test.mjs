import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { table } from '#src/core/resources/databases';
import * as env from '#src/core/utility/environment/environmentManager';
import { server } from '#src/core/server/Server';
import {
	initializeResidencySlots,
	getResidencyMapTable,
	getResidencyConfiguration,
} from '#src/core/resources/residencyMaps';
import { reserveLocalKey, releaseLocalKey } from '#src/core/resources/originClosedFloor';
import { readOriginClosedFloor } from '#src/core/resources/auditStore';
import {
	startShardingBootstrap,
	assertShardingStartupReady,
	noteShardingResumeBound,
} from '#src/replication/shardingBootstrap';
import { originReadyWord, ORIGIN_READY, recoveryBoundKey } from '#src/replication/shardingOriginAdmission';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import { setReplicator } from '#src/replication/replicator';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { getHDBNodeTable } from '#src/replication/knownNodes';

const child = process.env.HARPER_TEST_RESUME_BOUND_CHILD === '1';

describe('Sharding reconnect closed-prefix admission', function () {
	this.timeout(30_000);
	if (!child) {
		it('isolates the bootstrap coordinator from other suites', async function () {
			const result = await promisify(execFile)(
				process.execPath,
				['node_modules/mocha/bin/mocha.js', '--require', 'unitTests/unitTestSetup.cjs', fileURLToPath(import.meta.url)],
				{ env: { ...process.env, HARPER_TEST_RESUME_BOUND_CHILD: '1' }, timeout: 25_000 }
			).catch((error) => {
				throw new Error(`${error.stdout}\n${error.stderr}`, { cause: error });
			});
			assert.match(result.stdout, /7 passing/);
		});
		return;
	}
	let Rows, root, catalog, origin, shard;
	const database = 'resumeBound';
	const { Transaction } = createRequire(import.meta.url)('@harperfast/rocksdb-js');
	before(async () => {
		env.setHdbBasePath(process.env.STORAGE_PATH);
		env.setProperty('replication_shards', [0]);
		env.setProperty('replication_shard', 0);
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		Rows = table({ database, table: 'Rows', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
		root = Rows.primaryStore.rootStore;
		catalog = Rows.dbisDB;
		await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
		startShardingBootstrap();
		origin = originReadyWord(root, database);
		shard = new Int32Array(
			getResidencyMapTable().auditStore.getUserSharedBuffer(['sharding-ready', database, 0], new ArrayBuffer(4))
		);
		try {
			assertShardingStartupReady(database, 0, root);
		} catch {}
	});
	beforeEach(() => {
		Atomics.store(origin, 0, ORIGIN_READY);
		Atomics.store(shard, 0, 1);
	});
	function reserve() {
		const handle = new Transaction(Rows.primaryStore.store);
		return { handle, key: reserveLocalKey(root, handle) };
	}
	function release(reservation) {
		releaseLocalKey(reservation.handle);
		reservation.handle.abort();
	}
	function assertReady() {
		assert.ok(Atomics.load(origin, 0) & ORIGIN_READY, 'a below-clock reconnect must not clear origin readiness');
		assert.equal(Atomics.load(shard, 0), 1, 'a below-clock reconnect must not clear shard readiness');
		assert.equal(catalog.getSync([recoveryBoundKey, database]), undefined);
	}
	it('refuses only the link while an older native reservation remains open', async () => {
		const older = reserve();
		const requested = root.getMonotonicTimestamp();
		assert.ok(requested > older.key);
		try {
			await assert.rejects(noteShardingResumeBound(database, requested, 'peer'), (error) => error.statusCode === 503);
			assertReady();
			assert.ok(readOriginClosedFloor(Rows.auditStore) < requested);
			await Rows.put('independent', { id: 'independent' });
			assert.equal(Rows.primaryStore.getSync('independent').id, 'independent');
		} finally {
			release(older);
		}
		await noteShardingResumeBound(database, requested, 'peer');
		assertReady();
		assert.ok(readOriginClosedFloor(Rows.auditStore) >= requested);
	});
	it('yields to an older reservation release while a newer reservation stays open', async () => {
		const older = reserve();
		const requested = root.getMonotonicTimestamp();
		const newer = reserve();
		let released = false;
		const timer = setTimeout(() => {
			release(older);
			released = true;
		}, 0);
		try {
			await noteShardingResumeBound(database, requested, 'peer');
			assert.equal(released, true, 'certification must yield to the release');
			assertReady();
			assert.ok(readOriginClosedFloor(Rows.auditStore) >= requested);
			assert.ok(newer.key > requested);
		} finally {
			clearTimeout(timer);
			if (!released) release(older);
			release(newer);
		}
	});
	it('yields while a native reservation publishes its transient zero bound', async () => {
		const older = reserve();
		const requested = root.getMonotonicTimestamp();
		const words = new BigInt64Array(
			root.getUserSharedBuffer('origin-closed-floor', new ArrayBuffer((4 + 1024 + 1024 * 8) * 8))
		);
		const slot = words.subarray(4, 1028).findIndex((owner) => owner === BigInt(threadId + 1));
		assert.ok(slot >= 0);
		const index = 1028 + slot * 8;
		const bound = Atomics.exchange(words, index, 0n);
		let released = false;
		const timer = setTimeout(() => {
			release(older);
			released = true;
		}, 0);
		try {
			await noteShardingResumeBound(database, requested, 'sentinel-peer');
			assert.equal(released, true);
			assertReady();
			assert.ok(readOriginClosedFloor(Rows.auditStore) >= requested);
		} finally {
			clearTimeout(timer);
			if (!released) {
				Atomics.store(words, index, bound);
				release(older);
			}
		}
	});
	it('issues subsequent native reservations above the published floor', async () => {
		await noteShardingResumeBound(database, root.getMonotonicTimestamp(), 'peer');
		const floor = readOriginClosedFloor(Rows.auditStore);
		const next = reserve();
		try {
			assert.ok(next.key >= floor);
		} finally {
			release(next);
		}
	});
	for (const denial of ['route', 'hdb_nodes'])
		it(`leaves no recovery state for a subscriber its ${denial} does not send to`, async () => {
			setReplicator(database, Rows, {});
			const socket = Object.assign(new EventEmitter(), {
				readyState: 1,
				sent: [],
				closes: [],
				_socket: { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} },
				send(data) {
					this.sent.push(data[0] > 127 ? decode(Buffer.from(data)) : data);
				},
				close(code = 1000, reason = '') {
					if (this.readyState === 3) return;
					this.readyState = 3;
					this.closes.push({ code, reason });
					this.emit('close', code, Buffer.from(reason));
				},
				terminate() {
					this.close(1006);
				},
				ping() {},
				pause() {},
				resume() {},
			});
			const peer = `denied-${denial}-peer`;
			const deadline = Date.now() + 10_000;
			const until = async (predicate) => {
				while (!predicate()) {
					assert.ok(Date.now() < deadline, 'replication did not make progress');
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			};
			await until(() => databaseSubscriptions.get(database)?.auditStore);
			const routes = [{ name: peer, hostname: peer, replicates: { sendsTo: [], receivesFrom: [{ source: peer }] } }];
			if (denial === 'hdb_nodes')
				await getHDBNodeTable().put(peer, { name: peer, url: `wss://${peer}:9933`, replicates: false });
			replicateOverWS(socket, denial === 'route' ? { routes } : {}, { name: peer, replicates: true });
			socket.emit(
				'message',
				encode([
					140,
					peer,
					database,
					[],
					buildLocalCapabilities(90_000, true, true),
					{ shardsDigest: getResidencyConfiguration().digest },
				])
			);
			await until(() => socket.sent.some((frame) => frame[0] === 140) || socket.closes.length);
			const future = root.getMonotonicTimestamp() + 60_000;
			socket.emit(
				'message',
				encode([129, [{ name: server.hostname, startTime: future, tables: [], replicateByDefault: true }], []])
			);
			await until(() => socket.closes.length);
			assert.equal(socket.closes[0].code, 1008, socket.closes[0].reason);
			assertReady();
		});
	it('retains the durable hold for a genuinely future recovery bound', async () => {
		const future = root.getMonotonicTimestamp() + 60_000;
		await assert.rejects(noteShardingResumeBound(database, future, 'future-peer'), (error) => error.statusCode === 503);
		assert.equal(Atomics.load(origin, 0) & ORIGIN_READY, 0);
		assert.equal(Atomics.load(shard, 0), 0);
		assert.equal(catalog.getSync([recoveryBoundKey, database]), future);
	});
});
