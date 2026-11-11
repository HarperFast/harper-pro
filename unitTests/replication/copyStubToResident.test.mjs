import assert from 'node:assert';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import * as env from '#src/core/utility/environment/environmentManager';
import { server } from '#src/core/server/Server';
import { getThisNodeName } from '#src/core/server/nodeName';
import { transaction } from '#src/core/resources/transaction';
import { REPLICATION_APPLY } from '#src/core/resources/databaseLiveGuard';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { INVALIDATED, REPLICA } from '#src/core/resources/Table';
import { table } from '#src/core/resources/databases';
import { createAuditEntry, readAuditEntry, Decoder, LOCAL_ONLY } from '#src/core/resources/auditStore';
import { initializeResidencySlots, getResidencyConfiguration } from '#src/core/resources/residencyMaps';
import { setReplicator } from '#src/replication/replicator';
import { databaseSubscriptions, replayedStubPut, replicateOverWS } from '#src/replication/replicationConnection';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { FrameWriter } from '#src/replication/frameWriter';
import { advanceShardingHistory } from '#src/replication/shardingBootstrapState';
import { shardingLayout } from '#src/replication/shardingRecovery';
const { RocksDatabase } = createRequire(import.meta.url)('@harperfast/rocksdb-js');

const PEER = 'stub-resident-peer';
const OTHER = 'stub-resident-other';
const WRITER = 'stub-resident-writer';
const SUBSCRIPTION_REQUEST = 129;
const RESIDENCY_LIST = 130;
const TABLE_FIXED_STRUCTURE = 132;
const NODE_NAME = 140;
const NODE_NAME_TO_ID_MAP = 141;
const COPY_START = 148;
const COPY_COMPLETE = 149;
const REMOTE_SEQUENCE_UPDATE = 11;
const COPY_ORDER_VERSION = 1;
const isRocksDB = (process.env.HARPER_STORAGE_ENGINE || env.get('storage_engine')) !== 'lmdb';

class Socket extends EventEmitter {
	readyState = 1;
	sent = [];
	rawSent = [];
	closes = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		this.rawSent.push(Buffer.from(data));
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
async function until(predicate, message = 'replication did not make progress') {
	const end = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < end, message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
function dataFrames(socket) {
	const frames = [];
	let phase = 'before-copy';
	for (const frame of socket.sent) {
		if (!Buffer.isBuffer(frame)) {
			if (frame[0] === COPY_START) phase = 'copy';
			else if (frame[0] === COPY_COMPLETE) phase = 'replay';
			continue;
		}
		const parsed = { phase, key: frame.readDoubleBE(0), entries: [], sequenceUpdate: undefined };
		const decoder = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
		decoder.position = 8;
		while (decoder.position < frame.length) {
			const length = decoder.readInt();
			const start = decoder.position;
			decoder.position += length;
			if (length === 9 && frame[start] === REMOTE_SEQUENCE_UPDATE)
				parsed.sequenceUpdate = frame.readDoubleBE(start + 1);
			else parsed.entries.push(readAuditEntry(frame, start, start + length));
		}
		frames.push(parsed);
	}
	return frames;
}
function sentFor(socket, Table, id, phase) {
	return dataFrames(socket)
		.filter((frame) => frame.phase === phase)
		.flatMap((frame) =>
			frame.entries
				.filter((entry) => entry.tableId === Table.tableId && entry.recordId === id)
				.map((entry) => ({
					type: entry.type,
					version: entry.version,
					key: frame.key,
					body: entry.getValue(Table.primaryStore)?.body,
				}))
		);
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
	frame.writeInt(REMOTE_SEQUENCE_UPDATE);
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
function loggedFor(Table, id) {
	return Array.from(Table.auditStore.getRange({ start: 1 })).filter(
		(entry) => entry.tableId === Table.tableId && entry.recordId === id
	);
}

describe('A base copy never leaves a designated resident with only the stub of a body its replay re-sends', function () {
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
			{ name: OTHER, replicates: true },
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

	const capabilities = buildLocalCapabilities(90_000, true, true);
	const withoutStubCopy = () => {
		const older = { ...buildLocalCapabilities(90_000, true, true) };
		delete older.residencyStubCopy;
		return older;
	};
	async function replicatedTable(database, options = {}) {
		const Records = table({
			database,
			table: 'Records',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'region', indexed: true }, { name: 'body' }],
			...options,
		});
		setReplicator(database, Records, {});
		await until(() => databaseSubscriptions.get(database)?.auditStore);
		return Records;
	}
	async function connectPeer(database, peerCapabilities = capabilities) {
		const socket = new Socket();
		sockets.push(socket);
		replicateOverWS(socket, {}, { name: PEER, replicates: true });
		socket.emit(
			'message',
			encode([NODE_NAME, PEER, database, [], peerCapabilities, { shardsDigest: getResidencyConfiguration().digest }])
		);
		await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME) || socket.closes.length);
		assert.deepEqual(socket.closes, []);
		return socket;
	}
	async function copyFrom(database, copyResume, peerCapabilities) {
		const socket = await connectPeer(database, peerCapabilities);
		socket.emit(
			'message',
			encode([
				SUBSCRIPTION_REQUEST,
				[{ name: getThisNodeName(), startTime: 0, tables: [], replicateByDefault: true, copyResume }],
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

	describe('a legacy-residency source fill on a node outside its residency', function () {
		let fixtures = 0;
		async function fill(residents = [PEER]) {
			const database = `stub_resident_fill_${++fixtures}`;
			const Records = await replicatedTable(database);
			Records.sourcedFrom({
				get(id) {
					return { id, region: 'r', body: `complete ${id}` };
				},
			});
			Records.setResidency(() => residents);
			await Records.put('before', { id: 'before', region: 'r', body: 'kept' });
			const below = lastLogKey(Records);
			await Records.get('filled');
			await until(() => Records.primaryStore.getEntry('filled')?.metadataFlags & INVALIDATED);
			const stub = Records.primaryStore.getEntry('filled');
			assert.equal(stub.value.body, undefined);
			const [head] = loggedFor(Records, 'filled');
			assert.equal(head.type, 'put');
			assert.equal(head.version, stub.version);
			assert.equal(head.getValue(Records.primaryStore).body, 'complete filled');
			const logKey = head.txnLogKey ?? head.version;
			assert.ok(logKey > below);
			return { Records, database, below, version: stub.version, logKey };
		}
		async function replayReaches(socket, Records) {
			await Records.put('sentinel', { id: 'sentinel', region: 'r', body: 'last' });
			await until(
				() => sentFor(socket, Records, 'sentinel', 'replay').length > 0,
				'the post-copy replay did not reach a later write'
			);
		}

		it('copies the complete put in place of the stub when its audit key is above the resumed copyStartTime', async () => {
			const { Records, database, below, version, logKey } = await fill();
			const starts = [below];
			if (version < logKey) starts.push(version);
			for (const copyStartTime of starts) {
				const socket = await copyFrom(database, resumeAt(copyStartTime));
				assert.deepEqual(socket.closes, []);
				assert.equal(socket.sent.find((frame) => frame[0] === COPY_START)?.[1], copyStartTime);
				assert.deepEqual(sentFor(socket, Records, 'filled', 'copy'), [
					{ type: 'put', version, key: isRocksDB ? logKey : version, body: 'complete filled' },
				]);
				const lastCopyFrame = dataFrames(socket)
					.filter((frame) => frame.phase === 'copy')
					.at(-1);
				assert.equal(lastCopyFrame.sequenceUpdate, copyStartTime, 'the copy checkpoint is copyStartTime');
				await until(() => sentFor(socket, Records, 'filled', 'replay').length > 0);
				assert.deepEqual(sentFor(socket, Records, 'filled', 'replay'), [
					{ type: 'put', version, key: isRocksDB ? logKey : version, body: 'complete filled' },
				]);
				socket.close();
			}
		});

		it('keeps copying the stub when its audit key is at or below copyStartTime, which the replay does not re-send', async () => {
			const { Records, database, version, logKey } = await fill();
			for (const copyStartTime of [logKey, logKey + 1]) {
				const socket = await copyFrom(database, resumeAt(copyStartTime));
				assert.deepEqual(socket.closes, []);
				assert.deepEqual(sentFor(socket, Records, 'filled', 'copy'), [
					{ type: 'invalidate', version, key: isRocksDB ? logKey : version, body: undefined },
				]);
				await replayReaches(socket, Records);
				assert.deepEqual(sentFor(socket, Records, 'filled', 'replay'), []);
				socket.close();
			}
		});

		it('copies the complete put to a resident without residencyStubCopy instead of the stub projection as a put', async () => {
			const { Records, database, below, version } = await fill();
			const socket = await copyFrom(database, resumeAt(below), withoutStubCopy());
			assert.deepEqual(socket.closes, []);
			assert.deepEqual(
				sentFor(socket, Records, 'filled', 'copy').map(({ type, version, body }) => ({ type, version, body })),
				[{ type: 'put', version, body: 'complete filled' }]
			);
		});

		it('keeps copying the stub to a peer the row is not resident on', async () => {
			const { Records, database, below, version } = await fill([OTHER]);
			const socket = await copyFrom(database, resumeAt(below));
			assert.deepEqual(socket.closes, []);
			assert.deepEqual(
				sentFor(socket, Records, 'filled', 'copy').map(({ type, version, body }) => ({ type, version, body })),
				[{ type: 'invalidate', version, body: undefined }]
			);
		});

		it('leaves a resident fed the real frames with the body once the copy completes, before any replay', async () => {
			const { Records, database, below, logKey } = await fill();
			for (const [label, copyStartTime] of [
				['above', below],
				['equal', logKey],
			]) {
				const sender = await copyFrom(database, resumeAt(copyStartTime));
				assert.deepEqual(sender.closes, []);
				await replayReaches(sender, Records);
				const receiverDatabase = `${database}_resident_${label}`;
				const Resident = await replicatedTable(receiverDatabase);
				const receiver = new Socket();
				sockets.push(receiver);
				replicateOverWS(receiver, {}, { name: PEER, replicates: true });
				receiver.emit('message', encode([NODE_NAME, PEER, receiverDatabase, [], capabilities, {}]));
				await until(() => receiver.sent.some((frame) => frame[0] === NODE_NAME));
				const forward = (index) => {
					const message = sender.sent[index];
					const raw = sender.rawSent[index];
					if (Buffer.isBuffer(message)) receiver.emit('message', raw);
					else if (message[0] === NODE_NAME_TO_ID_MAP) {
						const swap = { [getThisNodeName()]: PEER, [PEER]: getThisNodeName() };
						const ids = Object.fromEntries(Object.entries(message[1]).map(([name, id]) => [swap[name] ?? name, id]));
						receiver.emit('message', encode([NODE_NAME_TO_ID_MAP, ids, [PEER]]));
					} else if (message[0] === RESIDENCY_LIST)
						receiver.emit('message', encode([RESIDENCY_LIST, [server.hostname, OTHER], message[2]]));
					else if ([TABLE_FIXED_STRUCTURE, COPY_START, COPY_COMPLETE].includes(message[0]))
						receiver.emit('message', raw);
				};
				const copyComplete = sender.sent.findIndex((message) => message[0] === COPY_COMPLETE);
				for (let index = 0; index <= copyComplete; index++) forward(index);
				await until(() => Resident.primaryStore.getEntry('filled') && Resident.primaryStore.getEntry('before'));
				const copied = Resident.primaryStore.getEntry('filled');
				if (label === 'above') {
					assert.equal(copied.metadataFlags & INVALIDATED, 0, 'the copy left the resident a stub');
					assert.equal(copied.value.body, 'complete filled');
				} else assert.ok(copied.metadataFlags & INVALIDATED);
				for (let index = copyComplete + 1; index < sender.sent.length; index++) forward(index);
				await until(() => Resident.primaryStore.getEntry('sentinel'));
				assert.deepEqual(receiver.closes, []);
				const resident = Resident.primaryStore.getEntry('filled');
				if (label === 'above') {
					assert.equal(resident.metadataFlags & INVALIDATED, 0, 'the replay left the resident a stub');
					assert.equal(resident.value.body, 'complete filled');
					assert.deepEqual(
						loggedFor(Resident, 'filled').map((entry) => entry.type),
						['put'],
						'the replayed duplicate was applied again'
					);
				} else assert.ok(resident.metadataFlags & INVALIDATED);
				assert.equal(Resident.primaryStore.getEntry('before').value.body, 'kept');
				sender.close();
				receiver.close();
			}
		});
	});

	describe('a received legacy-residency stub', function () {
		it('is still copied to a listed resident, and its holder replays only the invalidation', async () => {
			const database = 'stub_resident_received';
			const Records = await replicatedTable(database);
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
				loggedFor(Records, 'stub').map((entry) => [entry.type, entry.version, entry.nodeId]),
				[['invalidate', version, origin]]
			);
			for (const copyStartTime of [below, version]) {
				const socket = await copyFrom(database, resumeAt(copyStartTime));
				assert.deepEqual(socket.closes, []);
				assert.deepEqual(
					sentFor(socket, Records, 'stub', 'copy').map(({ type, version, body }) => ({ type, version, body })),
					[{ type: 'invalidate', version, body: undefined }]
				);
				const sentinel = `sentinel-${copyStartTime}`;
				await Records.put(sentinel, { id: sentinel, region: 'r' });
				await until(() => sentFor(socket, Records, sentinel, 'replay').length > 0);
				for (const replayed of sentFor(socket, Records, 'stub', 'replay')) {
					assert.equal(replayed.type, 'invalidate');
					assert.equal(replayed.body, undefined);
				}
				socket.close();
			}
		});

		it('followed by the same-identity put keeps the body on a RocksDB resident', async function () {
			if (!isRocksDB) this.skip();
			const database = 'stub_resident_receiver';
			const Records = await replicatedTable(database);
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
			socket.emit('message', encode([RESIDENCY_LIST, [server.hostname, OTHER], 42]));
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

	describe('primary-key placement', function () {
		before(function () {
			if (!isRocksDB) this.skip();
		});
		async function keyHashTable(name, shards) {
			server.shards = shards;
			const database = `stub_resident_${name}`;
			await initializeResidencySlots({
				database,
				slots: 2,
				ranges: [
					{ start: 0, end: 1, shard: 0 },
					{ start: 1, end: 2, shard: 1 },
				],
			});
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
				assert.deepEqual(sentFor(socket, Records, foreign, 'copy'), []);
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
					[1, [{ name: OTHER }]],
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
				assert.deepEqual(sentFor(socket, Records, stubbed, 'copy'), []);
			}
		});
	});
});

describe('replayedStubPut', function () {
	const tableId = 7;
	const copyStartTime = 1500;
	const head = { type: 'put', tableId, recordId: ['region', 3], version: 1000, nodeId: 0, extendedType: 0 };
	const row = (fields) => ({ key: ['region', 3], version: 1000, localTime: 1000, ...fields });
	function store(entries) {
		const reads = [];
		return {
			reads,
			get(logKey, ...rest) {
				reads.push([logKey, ...rest]);
				const answer = entries[logKey];
				if (answer instanceof Error) throw answer;
				return answer;
			},
		};
	}

	it("answers the row's own local put at its head reference, reading it as committed state", () => {
		const audit = store({ 2000: head });
		assert.deepEqual(
			replayedStubPut(audit, tableId, row({ additionalAuditRefs: [{ version: 2000, nodeId: 0 }] }), copyStartTime, 4),
			{ head, logKey: 2000 }
		);
		assert.deepEqual(audit.reads, [[2000, tableId, ['region', 3], 0, true]]);
	});

	it('answers the put at the row log key when the row has no head reference', () => {
		const local = { ...head, nodeId: 4 };
		assert.deepEqual(replayedStubPut(store({ 2000: local }), tableId, row({ localTime: 2000 }), copyStartTime, 4), {
			head: local,
			logKey: 2000,
		});
	});

	it('tries the row log key after a head reference that does not hold its put', () => {
		const audit = store({ 2000: { ...head, type: 'invalidate' }, 3000: head });
		const entry = row({ localTime: 3000, additionalAuditRefs: [{ version: 2000, nodeId: 0 }] });
		assert.deepEqual(replayedStubPut(audit, tableId, entry, copyStartTime, 4), { head, logKey: 3000 });
		assert.deepEqual(
			audit.reads.map(([logKey]) => logKey),
			[2000, 3000]
		);
	});

	it('reads a key once when a head reference is the row log key, in the log the reference names', () => {
		const audit = store({ 2000: { ...head, type: 'invalidate' } });
		const entry = row({ localTime: 2000, additionalAuditRefs: [{ version: 2000, nodeId: 4 }] });
		assert.equal(replayedStubPut(audit, tableId, entry, copyStartTime, 4), undefined);
		assert.deepEqual(audit.reads, [[2000, tableId, ['region', 3], 4, true]]);
	});

	it('lets a failed head read fail the copy, which then resumes, rather than sending the stub', () => {
		const audit = store({ 2000: new Error('unreadable log') });
		assert.throws(() => replayedStubPut(audit, tableId, row({ localTime: 2000 }), copyStartTime, 4), /unreadable log/);
	});

	it('answers the put another key holds even when an earlier key cannot be read', () => {
		const audit = store({ 2000: new Error('unreadable log'), 3000: head });
		const entry = row({ localTime: 3000, additionalAuditRefs: [{ version: 2000, nodeId: 0 }] });
		assert.deepEqual(replayedStubPut(audit, tableId, entry, copyStartTime, 4), { head, logKey: 3000 });
	});

	it('reads nothing for a row whose log keys are all at or below copyStartTime, or come from another origin', () => {
		const audit = store({ 1500: head, 2000: head });
		const entry = row({
			localTime: copyStartTime,
			additionalAuditRefs: [
				{ version: 1400, nodeId: 0 },
				{ version: 2000, nodeId: 9 },
			],
		});
		assert.equal(replayedStubPut(audit, tableId, entry, copyStartTime, 4), undefined);
		assert.deepEqual(audit.reads, []);
	});

	for (const [label, answer] of [
		['no entry', undefined],
		['an invalidation', { ...head, type: 'invalidate' }],
		['a patch', { ...head, type: 'patch' }],
		['a local-only put', { ...head, extendedType: LOCAL_ONLY }],
		["another origin's put", { ...head, nodeId: 9 }],
		['another version', { ...head, version: 999 }],
		['another table', { ...head, tableId: tableId + 1 }],
		['another record at the same key', { ...head, recordId: ['region', 4] }],
	])
		it(`answers nothing for ${label}, which keeps the stub`, () => {
			assert.equal(
				replayedStubPut(store({ 2000: answer }), tableId, row({ localTime: 2000 }), copyStartTime, 4),
				undefined
			);
		});
});
