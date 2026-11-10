import assert from 'node:assert';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import * as env from '#src/core/utility/environment/environmentManager';
import { server } from '#src/core/server/Server';
import { transaction } from '#src/core/resources/transaction';
import { REPLICATION_APPLY } from '#src/core/resources/databaseLiveGuard';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { INVALIDATED, REPLICA } from '#src/core/resources/Table';
import { table } from '#src/core/resources/databases';
import { createAuditEntry, readAuditEntry, Decoder } from '#src/core/resources/auditStore';
import { initializeResidencySlots, getResidencyConfiguration } from '#src/core/resources/residencyMaps';
import { setReplicator } from '#src/replication/replicator';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { FrameWriter } from '#src/replication/frameWriter';
import { advanceShardingHistory } from '#src/replication/shardingBootstrapState';
import { shardingLayout } from '#src/replication/shardingRecovery';
const { RocksDatabase } = createRequire(import.meta.url)('@harperfast/rocksdb-js');

const PEER = 'stub-reach-peer';
const WRITER = 'stub-reach-writer';
const SUBSCRIPTION_REQUEST = 129;
const RESIDENCY_LIST = 130;
const TABLE_FIXED_STRUCTURE = 132;
const NODE_NAME = 140;
const NODE_NAME_TO_ID_MAP = 141;
const COPY_START = 148;
const COPY_COMPLETE = 149;
const COPY_ORDER_VERSION = 1;
const isRocksDB = (process.env.HARPER_STORAGE_ENGINE || env.get('storage_engine')) !== 'lmdb';

class Socket extends EventEmitter {
	readyState = 1;
	sent = [];
	closes = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		this.sent.push(data[0] > 127 ? decode(Buffer.from(data)) : Buffer.from(data));
	}
	close(code = 1000, reason = '') {
		if (this.readyState === 3) return;
		this.closes.push({ code, reason });
		this.readyState = 3;
		this.emit('close', code, Buffer.from(reason));
	}
	terminate() {
		this.close(1006);
	}
	ping() {}
	pause() {}
	resume() {}
}
async function until(predicate) {
	const end = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < end, 'replication did not make progress');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
function sentEntries(socket, tableId) {
	const records = [];
	for (const frame of socket.sent) {
		if (!Buffer.isBuffer(frame)) continue;
		const decoder = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
		decoder.position = 8;
		while (decoder.position < frame.length) {
			const length = decoder.readInt();
			const start = decoder.position;
			decoder.position += length;
			if (length === 9 && frame[start] === 11) continue;
			const entry = readAuditEntry(frame, start, start + length);
			if (entry.tableId === tableId) records.push(entry);
		}
	}
	return records;
}
function recordFrame(Table, type, recordId, value, version, residencyId) {
	const frame = new FrameWriter();
	frame.writeFloat64(version);
	const entry = Buffer.from(
		createAuditEntry({
			type,
			tableId: Table.tableId,
			recordId,
			version,
			previousVersion: null,
			residencyId,
			extendedType: 512,
			nodeId: 0,
			encodedRecord: Buffer.from(Table.primaryStore.encoder.encode(value)),
		})
	);
	const start = entry[0] === 66 ? 8 : 0;
	frame.writeInt(entry.length - start);
	frame.writeBytes(entry, start);
	frame.writeInt(9);
	frame.writeInt(11);
	frame.writeFloat64(version);
	return Buffer.from(frame.encodingBuffer.subarray(frame.encodingStart, frame.position));
}
function keyInSlot(Table, slot, prefix) {
	for (let i = 0; i < 1000; i++) if (Table.getResidencySlot(prefix + i) === slot) return prefix + i;
	throw new Error(`no key with prefix ${prefix} hashes to slot ${slot}`);
}
function lastLogKey(Table) {
	const last = Array.from(Table.auditStore.getRange({ start: 1 })).at(-1);
	return last.txnLogKey ?? last.version;
}

describe('A base copy never leaves a designated resident holding only a stub of a body its sender replays', function () {
	this.timeout(20_000);
	const sockets = [];
	let priorShards, priorNodes, priorList, priorShard, priorSyncWal;
	before(() => {
		priorSyncWal = Object.getOwnPropertyDescriptor(RocksDatabase.prototype, 'syncWal');
		Object.defineProperty(RocksDatabase.prototype, 'syncWal', { value: undefined, configurable: true, writable: true });
		env.setHdbBasePath(process.env.STORAGE_PATH);
		priorShards = server.shards;
		priorNodes = server.nodes;
		priorList = env.get('replication_shards');
		priorShard = env.get('replication_shard');
		env.setProperty('replication_shards', [0, 1]);
		env.setProperty('replication_shard', 0);
		server.nodes = [
			{ name: PEER, replicates: true },
			{ name: 'stub-reach-third', replicates: true },
		];
	});
	afterEach(() => {
		while (sockets.length) sockets.pop().close();
	});
	after(() => {
		if (priorSyncWal) Object.defineProperty(RocksDatabase.prototype, 'syncWal', priorSyncWal);
		else delete RocksDatabase.prototype.syncWal;
		server.shards = priorShards;
		server.nodes = priorNodes;
		env.setProperty('replication_shards', priorList);
		env.setProperty('replication_shard', priorShard);
	});

	async function keyHashTable(name, shards) {
		server.shards = shards;
		const database = `stub_reach_${name}`;
		const ranges = [
			{ start: 0, end: 1, shard: 0 },
			{ start: 1, end: 2, shard: 1 },
		];
		await initializeResidencySlots({ database, slots: 2, ranges });
		const Records = table({
			database,
			table: 'Records',
			audit: true,
			replicaExpiration: 3600,
			residency: { slots: 2, byAttribute: false },
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'region', indexed: true }, { name: 'body' }],
		});
		for (const shard of [0, 1])
			advanceShardingHistory(Records.dbisDB, shardingLayout(database, shard), {
				initializer: server.hostname,
				agreement: 'fixture',
				run: 'fixture',
				phase: 'began',
				localFloor: 1,
				localOrigin: server.hostname,
			});
		setReplicator(database, Records, {});
		await until(() => databaseSubscriptions.get(database)?.auditStore);
		return { Records, database };
	}
	async function legacyTable(name) {
		const database = `stub_reach_${name}`;
		const Records = table({
			database,
			table: 'Records',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'region', indexed: true }, { name: 'body' }],
		});
		setReplicator(database, Records, {});
		await until(() => databaseSubscriptions.get(database)?.auditStore);
		return { Records, database };
	}
	async function connectPeer(database) {
		const socket = new Socket();
		sockets.push(socket);
		replicateOverWS(socket, {}, { name: PEER, replicates: true });
		socket.emit(
			'message',
			encode([
				NODE_NAME,
				PEER,
				database,
				[],
				buildLocalCapabilities(90_000, true, true),
				{ shardsDigest: getResidencyConfiguration().digest },
			])
		);
		await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME) || socket.closes.length);
		assert.deepEqual(socket.closes, []);
		return socket;
	}
	async function copyFrom(database, copyResume) {
		const socket = await connectPeer(database);
		socket.emit(
			'message',
			encode([
				SUBSCRIPTION_REQUEST,
				[{ name: PEER, startTime: 0, tables: [], replicateByDefault: true, copyResume }],
				[],
			])
		);
		await until(() => socket.sent.some((frame) => frame[0] === COPY_COMPLETE) || socket.closes.length);
		return socket;
	}
	const resumeAt = (copyStartTime) => ({
		copyStartTime,
		currentTable: 'Records',
		afterKey: '',
		copyOrder: COPY_ORDER_VERSION,
	});

	describe('primary-key placement', function () {
		before(function () {
			if (!isRocksDB) this.skip();
		});

		it('refuses to copy a writer replica to its slot owner, below, at and without a resumed copyStartTime', async () => {
			const { Records, database } = await keyHashTable(
				'writer_replica',
				new Map([
					[0, [{ name: server.hostname }]],
					[1, [{ name: PEER }]],
				])
			);
			const owned = keyInSlot(Records, 0, 'owned');
			const foreign = keyInSlot(Records, 1, 'foreign');
			await Records.put(owned, { id: owned, region: 'r', body: 'owned' });
			const below = lastLogKey(Records);
			await Records.put(foreign, { id: foreign, region: 'r', body: 'canonical' });
			const replica = Records.primaryStore.getEntry(foreign);
			assert.ok(replica.metadataFlags & REPLICA, 'a non-owner writer keeps a replica');
			assert.ok(replica.version > below);
			for (const copyResume of [undefined, resumeAt(below), resumeAt(replica.version)]) {
				const socket = await copyFrom(database, copyResume);
				assert.equal(
					socket.sent.find((frame) => frame[0] === COPY_START)?.[1],
					copyResume?.copyStartTime ?? replica.version
				);
				assert.match(socket.closes[0]?.reason ?? '', /A projection cannot fill owned sharding slots/);
				assert.equal(
					sentEntries(socket, Records.tableId).some((entry) => entry.recordId === foreign),
					false
				);
				assert.equal(
					socket.sent.some((frame) => frame[0] === COPY_COMPLETE),
					false
				);
			}
		});

		it('refuses to copy a stub held in an owned slot to a co-owner', async () => {
			const { Records, database } = await keyHashTable(
				'owned_stub',
				new Map([
					[0, [{ name: server.hostname }, { name: PEER }]],
					[1, [{ name: 'stub-reach-third' }]],
				])
			);
			const owned = keyInSlot(Records, 0, 'owned');
			const stubbed = keyInSlot(Records, 0, 'stubbed');
			await Records.put(owned, { id: owned, region: 'r', body: 'owned' });
			const below = lastLogKey(Records);
			const context = { sourceApply: true, [REPLICATION_APPLY]: true };
			await transaction(context, async () => {
				const row = await Records.getResource(stubbed, context, { ensureLoaded: false });
				row._writeInvalidate(stubbed, { id: stubbed, region: 'r' }, {});
			});
			assert.ok(Records.primaryStore.getEntry(stubbed).metadataFlags & INVALIDATED);
			for (const copyResume of [undefined, resumeAt(below)]) {
				const socket = await copyFrom(database, copyResume);
				assert.match(socket.closes[0]?.reason ?? '', /A projection cannot fill owned sharding slots/);
				assert.equal(
					sentEntries(socket, Records.tableId).some((entry) => entry.recordId === stubbed),
					false
				);
			}
		});
	});

	describe('legacy residency lists', function () {
		it("copies a received stub to a listed resident, and the stub holder's replay carries no body for it", async () => {
			const { Records, database } = await legacyTable('legacy_sender');
			Records.setResidency(() => [PEER, WRITER]);
			await Records.put('before', { id: 'before', region: 'r', body: 'kept' });
			const below = lastLogKey(Records);
			const residencyId = Records.primaryStore.getEntry('before').residencyId;
			const origin = getIdOfRemoteNode(WRITER, Records.auditStore);
			const version = Date.now() + 50;
			const context = { source: {}, sourceApply: true, timestamp: version };
			await transaction(context, async () => {
				const row = await Records.getResource('stub', context);
				return row._writeInvalidate('stub', { id: 'stub', region: 'r' }, { nodeId: origin, version, residencyId });
			});
			assert.ok(Records.primaryStore.getEntry('stub').metadataFlags & INVALIDATED);
			assert.deepEqual(
				Array.from(Records.auditStore.getRange({ start: 1 }))
					.filter((entry) => entry.recordId === 'stub')
					.map((entry) => [entry.type, entry.version, entry.nodeId]),
				[['invalidate', version, origin]]
			);
			for (const copyResume of [resumeAt(below), resumeAt(version)]) {
				const socket = await copyFrom(database, copyResume);
				assert.deepEqual(socket.closes, []);
				await new Promise((resolve) => setTimeout(resolve, 200));
				const stubEntries = sentEntries(socket, Records.tableId).filter((entry) => entry.recordId === 'stub');
				assert.ok(stubEntries.length > 0);
				for (const entry of stubEntries) {
					assert.equal(entry.type, 'invalidate');
					assert.equal(entry.version, version);
					assert.equal(entry.getValue(Records.primaryStore).body, undefined);
				}
			}
		});

		it('keeps the body of a same-identity put that follows a copied stub at or above copyStartTime', async function () {
			if (!isRocksDB) this.skip();
			const { Records, database } = await legacyTable('legacy_receiver');
			const socket = await connectPeer(database);
			const base = Date.now() + 1000;
			const cases = [0, 100].map((aboveStart) => {
				const id = `resident-${aboveStart}`;
				const version = base + aboveStart;
				return {
					id,
					copyStartTime: version - aboveStart,
					stub: recordFrame(Records, 'invalidate', id, { id, region: 'r' }, version, 42),
					put: recordFrame(Records, 'put', id, { id, region: 'r', body: 'canonical' }, version, 42),
				};
			});
			const encoder = Records.primaryStore.encoder;
			socket.emit('message', encode([NODE_NAME_TO_ID_MAP, { [PEER]: 0 }, [PEER]]));
			socket.emit(
				'message',
				encode([
					TABLE_FIXED_STRUCTURE,
					{
						structures: encoder.structures,
						typedStructs: encoder.typedStructs,
						attributes: Records.attributes,
						schemaDefined: true,
					},
					Records.tableId,
					Records.tableName,
				])
			);
			socket.emit('message', encode([RESIDENCY_LIST, [server.hostname, 'stub-reach-third'], 42]));
			for (const { id, copyStartTime, stub, put } of cases) {
				socket.emit('message', encode([COPY_START, copyStartTime, COPY_ORDER_VERSION]));
				socket.emit('message', stub);
				socket.emit('message', encode([COPY_COMPLETE]));
				await until(() => Records.primaryStore.getEntry(id)?.metadataFlags & INVALIDATED);
				socket.emit('message', put);
				await until(() => !(Records.primaryStore.getEntry(id)?.metadataFlags & INVALIDATED));
				assert.equal(Records.primaryStore.getEntry(id).value.body, 'canonical');
			}
			assert.deepEqual(socket.closes, []);
		});
	});
});
