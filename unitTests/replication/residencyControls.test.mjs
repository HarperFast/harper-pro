import assert from 'node:assert';
import { createRequire } from 'node:module';
const logger = createRequire(import.meta.url)('#src/core/utility/logging/harper_logger').forComponent(
	'replication'
).conditional;
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { decode, encode } from 'msgpackr';
import * as env from '#src/core/utility/environment/environmentManager';
import { server } from '#src/core/server/Server';
import { DatabaseTransaction } from '#src/core/resources/DatabaseTransaction';
const { Transaction: NativeTransaction, RocksDatabase } = createRequire(import.meta.url)('@harperfast/rocksdb-js');
import { transaction } from '#src/core/resources/transaction';
import { REPLICATION_APPLY } from '#src/core/resources/databaseLiveGuard';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { INVALIDATED, FULL_WRITE_HEAD } from '#src/core/resources/Table';
import { table, isDroppedPeerGeneration } from '#src/core/resources/databases';
import { createAuditEntry, readAuditEntry, Decoder, HAS_BLOBS } from '#src/core/resources/auditStore';
import {
	createBlob,
	getFileId,
	getFilePathForBlob,
	blobFileMissingOrIncomplete,
	blobFileMissingOrIncompleteAsync,
	repairBlobFile,
	isBlobReceiveInFlight,
} from '#src/core/resources/blob';
import { writeLockBarrier } from '#src/core/resources/recordLockCoordinator';
import {
	initializeResidencySlots,
	installResidencyMap,
	getResidencyMapTable,
	acquireResidencyMapFence,
	getResidencyConfiguration,
	requireConnectedResidencyOwner,
} from '#src/core/resources/residencyMaps';
import { createResidencyMap } from '#src/core/resources/residencyPolicy';
import { setReplicator } from '#src/replication/replicator';
import {
	databaseSubscriptions,
	encodeCopyRecordValue,
	replicateOverWS,
	PING_TIMEOUT,
} from '#src/replication/replicationConnection';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { getHDBNodeTable } from '#src/replication/knownNodes';
import { residencyTopologyErrors, registerResidencySender } from '#src/replication/residencyTopology';
import { FrameWriter } from '#src/replication/frameWriter';
import { advanceShardingHistory } from '#src/replication/shardingBootstrapState';
import {
	shardingLayout,
	shardingSourceAgreement,
	shardingCertificate,
	certifyShardingCopy,
} from '#src/replication/shardingRecovery';
import { hasActiveBlobSends } from '#src/replication/blobSendDrain';

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
	pause() {
		this.paused = true;
	}
	resume() {}
}
async function until(predicate) {
	const end = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < end, 'replication did not make progress');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
function entries(socket) {
	const records = [];
	for (const frame of socket.sent) {
		if (!Buffer.isBuffer(frame)) continue;
		const decoder = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
		decoder.position = 8;
		while (decoder.position < frame.length) {
			const length = decoder.readInt(),
				start = decoder.position;
			decoder.position += length;
			if (length === 9 && frame[start] === 11) continue;
			records.push(readAuditEntry(frame, start, start + length));
		}
	}
	return records;
}
function recordFrame(Table, type, recordId, value, version, residencyId, overrides = {}, includeSequence = true) {
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
			extendedType: residencyId ? 512 : undefined,
			nodeId: 0,
			encodedRecord: type === 'lockBarrier' ? encode(value) : Buffer.from(Table.primaryStore.encoder.encode(value)),
			...overrides,
		})
	);
	const start = entry[0] === 66 ? 8 : 0;
	frame.writeInt(entry.length - start);
	frame.writeBytes(entry, start);
	if (includeSequence) {
		frame.writeInt(9);
		frame.writeInt(11);
		frame.writeFloat64(version);
	}
	return Buffer.from(frame.encodingBuffer.subarray(frame.encodingStart, frame.position));
}

describe('Declarative tables keep control and event traffic independent of placement', function () {
	let priorExperimental, priorMarkers, priorSyncWal;
	before(() => {
		// These tests count the end_txn events of sharding traffic; an engine that syncs its WAL also sends the
		// route-state updates of checkpoint certification, which originFloors.test.mjs covers.
		priorSyncWal = Object.getOwnPropertyDescriptor(RocksDatabase.prototype, 'syncWal');
		Object.defineProperty(RocksDatabase.prototype, 'syncWal', { value: undefined, configurable: true, writable: true });
		priorExperimental = env.get('replication_experimentalAttributeSlots');
		priorMarkers = env.get('storage_rocks_transactionLogAbortMarkers');
		env.setProperty('replication_experimentalAttributeSlots', true);
		env.setProperty('storage_rocks_transactionLogAbortMarkers', true);
	});
	after(() => {
		if (priorSyncWal) Object.defineProperty(RocksDatabase.prototype, 'syncWal', priorSyncWal);
		else delete RocksDatabase.prototype.syncWal;
		env.setProperty('replication_experimentalAttributeSlots', priorExperimental);
		env.setProperty('storage_rocks_transactionLogAbortMarkers', priorMarkers);
	});
	this.timeout(15_000);
	let oldShards, oldList, oldShard;
	let testContext;
	beforeEach(function () {
		testContext = this;
	});
	const sockets = [];
	before(() => {
		env.setHdbBasePath(process.env.STORAGE_PATH);
		oldShards = server.shards;
		oldList = env.get('replication_shards');
		oldShard = env.get('replication_shard');
		env.setProperty('replication_shards', [0]);
		env.setProperty('replication_shard', 0);
		server.shards = new Map([
			[0, [{ name: server.hostname }]],
			[1, [{ name: 'slot-control-peer' }]],
		]);
	});
	afterEach(() => {
		while (sockets.length) sockets.pop().close();
	});
	after(() => {
		server.shards = oldShards;
		env.setProperty('replication_shards', oldList);
		env.setProperty('replication_shard', oldShard);
	});
	async function connect(
		byAttribute,
		direction,
		legacy = false,
		capabilities = buildLocalCapabilities(90_000, true, true),
		beforeConnect,
		connection,
		ranges = [{ start: 0, end: 2, shard: 0 }],
		keyHash = false
	) {
		if (byAttribute && typeof NativeTransaction.prototype.usesAbortMarkers !== 'function') testContext.skip();
		const database = `slot_control_${direction}_${byAttribute}`;
		await initializeResidencySlots({ database, slots: 2, ranges });
		const Records = table({
			database,
			table: 'Records',
			audit: true,
			residency: legacy
				? undefined
				: keyHash
					? { slots: 2, byAttribute: false }
					: { slots: 2, byAttribute, slotFrom: byAttribute ? 'region' : 'id.length % 2' },
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'region', indexed: true }, { name: 'body' }],
		});
		if (!legacy)
			for (const shard of new Set(ranges.map((range) => range.shard))) {
				advanceShardingHistory(Records.dbisDB, shardingLayout(database, shard), {
					initializer: server.hostname,
					agreement: 'fixture',
					run: 'fixture',
					phase: 'began',
					localFloor: 1,
					localOrigin: server.hostname,
				});
			}
		setReplicator(database, Records, {});
		await until(() => databaseSubscriptions.get(database)?.auditStore);
		beforeConnect?.(database, Records);
		const socket = new Socket();
		sockets.push(socket);
		if (connection) connection.socket = socket;
		replicateOverWS(socket, { connection }, { name: 'slot-control-peer', replicates: true });
		socket.emit(
			'message',
			encode([
				140,
				'slot-control-peer',
				database,
				[],
				capabilities,
				{ shardsDigest: getResidencyConfiguration().digest },
			])
		);
		await until(() => socket.sent.some((frame) => frame[0] === 140) || socket.closes.length);
		assert.deepEqual(socket.closes, []);
		return { Records, socket, database };
	}
	it('persists the frozen origin start from an inbound initial handshake', async () => {
		const { Records, socket: initial, database } = await connect(false, 'inbound_origin_start');
		initial.close();
		const socket = new Socket();
		sockets.push(socket);
		replicateOverWS(socket, {}, { name: 'slot-control-peer', replicates: true });
		socket.emit(
			'message',
			encode([
				140,
				'slot-control-peer',
				database,
				[],
				buildLocalCapabilities(90_000, true, true),
				{
					shardsDigest: getResidencyConfiguration().digest,
					shardingStarts: { 0: { agreement: shardingSourceAgreement(database), floor: 123 } },
				},
			])
		);
		socket.emit('message', encode([133, 'inbound-start-barrier', 0, 'absent', 'MissingTable']));
		await until(
			() =>
				socket.sent.some((frame) => frame[0] === 134 && frame[1] === 'inbound-start-barrier') || socket.closes.length
		);
		assert.deepEqual(socket.closes, []);
		assert.equal(
			Records.dbisDB.getSync([Symbol.for('sharding-origin-start'), shardingLayout(database), 'slot-control-peer']),
			123
		);
	});

	it('refuses owned record-source authority after losing its frozen origin start', async () => {
		const { Records, socket, database } = await connect(false, 'lost_record_source');
		await Records.put('owned', { id: 'owned', region: 0, body: 'complete copied body' });
		Records.dbisDB.removeSync([Symbol.for('sharding-bootstrap-history'), shardingLayout(database)]);
		socket.emit('message', encode([133, 'lost-origin-read', Records.tableId, 'owned', Records.tableName]));
		await until(() => socket.sent.some((frame) => frame[0] === 134 && frame[1] === 'lost-origin-read'));
		assert.equal(socket.sent.find((frame) => frame[0] === 134 && frame[1] === 'lost-origin-read')[2], false);
	});

	it('refuses repeated subscriptions from a lost origin before any forced copy', async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const { socket } = await connect(
				false,
				'missing_start_' + attempt,
				false,
				buildLocalCapabilities(90_000, true, true),
				(database, Records) => {
					Records.dbisDB.removeSync([Symbol.for('sharding-bootstrap-history'), shardingLayout(database)]);
				}
			);
			socket.emit(
				'message',
				encode([129, [{ name: server.hostname, startTime: 1, tables: [], replicateByDefault: true }], []])
			);
			await until(() => socket.closes.length);
			assert.match(socket.closes[0].reason, /frozen origin start/);
			assert.ok(!socket.sent.some((frame) => frame[0] === 148 || frame[0] === 149), 'no copy cursor is sent');
		}
	});
	for (const destinationOwner of [true, false])
		it(`relays foreign projections only to non-owners (destinationOwner=${destinationOwner})`, async () => {
			const priorNodes = server.nodes;
			server.nodes = [{ name: 'slot-control-peer', replicates: true }];
			try {
				const { Records, socket } = await connect(
					false,
					`foreign_projection_${destinationOwner}`,
					false,
					buildLocalCapabilities(90_000, true, true),
					undefined,
					undefined,
					[{ start: 0, end: 2, shard: destinationOwner ? 1 : 0 }]
				);
				const origin = 'foreign-projection-origin';
				const nodeId = getIdOfRemoteNode(origin, Records.auditStore);
				socket.emit(
					'message',
					encode([129, [{ name: origin, startTime: 0, tables: [], replicateByDefault: true }], []])
				);
				await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
				assert.deepEqual(socket.closes, []);
				socket.sent.length = 0;
				const version = Date.now() + 100;
				const context = { source: {}, sourceApply: true, timestamp: version };
				await transaction(context, async () => {
					const row = await Records.getResource('relay', context);
					return row._writeInvalidate('relay', { id: 'relay', region: 1 }, { nodeId, version });
				});
				const invalidation = Array.from(Records.auditStore.getRange({ start: 1 })).find(
					(entry) => entry.tableId === Records.tableId && entry.recordId === 'relay'
				);
				assert.equal(invalidation.type, 'invalidate');
				assert.equal(invalidation.nodeId, nodeId);
				await until(() => socket.closes.length || entries(socket).some((entry) => entry.recordId === 'relay'));
				if (destinationOwner) {
					assert.ok(socket.closes.length, 'a projection cannot certify a canonical body to an owner');
					assert.equal(
						entries(socket).some((entry) => entry.recordId === 'relay'),
						false
					);
					assert.equal(
						socket.sent.some((frame) => Buffer.isBuffer(frame)),
						false,
						'no progress frame passes the refused record'
					);
				} else {
					assert.deepEqual(socket.closes, []);
					assert.equal(entries(socket).find((entry) => entry.recordId === 'relay').type, 'invalidate');
				}
			} finally {
				server.nodes = priorNodes;
			}
		});
	for (const owned of [true, false]) {
		for (const kind of [
			'foreign-origin',
			'foreign-after-prefix',
			'direct-projection',
			'projection-after-prefix',
			'copy',
			'foreign-floor',
		])
			it(`enforces the complete-source boundary before cursor mutation (${kind}, owned=${owned})`, async () => {
				const connection = new EventEmitter();
				connection.nodeSubscriptions = [{ name: 'slot-control-peer', replicateByDefault: true }];
				const { Records, socket } = await connect(
					false,
					`inbound_${kind}_${owned}`,
					false,
					undefined,
					undefined,
					connection,
					[{ start: 0, end: 2, shard: owned ? 0 : 1 }]
				);
				const peerId = getIdOfRemoteNode('slot-control-peer', Records.auditStore);
				getIdOfRemoteNode('foreign-source', Records.auditStore);
				const seqKey = [Symbol.for('seq'), peerId];
				const copyKey = [Symbol.for('copyCursor'), peerId];
				const beforeSeq = Records.dbisDB.getSync(seqKey);
				const beforeCopy = Records.dbisDB.getSync(copyKey);
				const version = Date.now() + 100;
				let incoming = recordFrame(Records, 'invalidate', 'incoming', { id: 'incoming', region: 0 }, version, 42, {
					nodeId: kind.startsWith('foreign-') ? 1 : 0,
				});
				if (kind.endsWith('after-prefix')) {
					const prefix = recordFrame(
						Records,
						'put',
						'prefix',
						{ id: 'prefix', region: 0, body: 'complete' },
						version,
						undefined
					);
					incoming = Buffer.concat([prefix.subarray(0, -10), incoming.subarray(8)]);
				}
				socket.emit(
					'message',
					encode([141, { 'slot-control-peer': 0, 'foreign-source': 1 }, ['slot-control-peer', 'foreign-source']])
				);
				const encoder = Records.primaryStore.encoder;
				socket.emit(
					'message',
					encode([
						132,
						{
							structures: encoder.structures,
							typedStructs: encoder.typedStructs,
							attributes: Records.attributes,
							residency: Records.residency,
							schemaDefined: true,
						},
						Records.tableId,
						Records.tableName,
					])
				);
				socket.emit('message', encode([130, [server.hostname], 42]));
				if (kind === 'copy') socket.emit('message', encode([148, version - 1000, 1]));
				if (kind === 'foreign-floor') socket.emit('message', encode([143, version, { 'foreign-source': version - 1 }]));
				else socket.emit('message', incoming);
				if (kind === 'copy') socket.emit('message', encode([149]));
				socket.emit('message', encode([143, version + 1]));
				await until(() => socket.closes.length || Records.dbisDB.getSync(seqKey)?.seqId >= version);
				if (owned) {
					assert.ok(socket.closes.length, 'the owner refuses the stream');
					assert.deepEqual(Records.dbisDB.getSync(seqKey), beforeSeq, 'durable origin and floor cursors do not move');
					assert.deepEqual(Records.dbisDB.getSync(copyKey), beforeCopy, 'copy cursor does not move');
					assert.equal(Records.primaryStore.getEntry('incoming'), undefined);
				} else {
					assert.deepEqual(socket.closes, []);
					if (kind !== 'foreign-floor')
						assert.ok(Records.primaryStore.getEntry('incoming').metadataFlags & INVALIDATED);
				}
			});
	}
	it('does not split an open live frame when a prior commit completes the copy', async () => {
		const { Records, socket, database } = await connect(false, 'copy_frame_boundary');
		const Nodes = getHDBNodeTable();
		const peer = 'slot-control-peer';
		const previous = Nodes.primaryStore.getSync(peer);
		const subscription = databaseSubscriptions.get(database);
		const send = subscription.send;
		const waitForDrain = subscription.waitForDrain;
		const queue = subscription.queue;
		const events = [];
		let release, paused;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const reached = new Promise((resolve) => {
			paused = resolve;
		});
		try {
			await Nodes.primaryStore.put(peer, { name: peer, shard: 0, replicates: true });
			socket.emit(
				'message',
				encode([
					140,
					peer,
					database,
					[],
					buildLocalCapabilities(90_000, true, true),
					{
						shardsDigest: getResidencyConfiguration().digest,
						shard: 0,
						shardingCertificate: shardingSourceAgreement(database),
					},
				])
			);
			const anchor = Date.now() + 100;
			const first = recordFrame(Records, 'put', 'first', { id: 'first', region: 0 }, anchor - 1, 42, {}, false);
			const live = recordFrame(Records, 'put', 'live', { id: 'live', region: 0 }, anchor + 1, 42, {}, false);
			const encoder = Records.primaryStore.encoder;
			socket.emit('message', encode([141, { [peer]: 0 }, [peer]]));
			socket.emit(
				'message',
				encode([
					132,
					{
						structures: encoder.structures,
						typedStructs: encoder.typedStructs,
						attributes: Records.attributes,
						residency: Records.residency,
						schemaDefined: true,
					},
					Records.tableId,
					Records.tableName,
				])
			);
			socket.emit('message', encode([130, [server.hostname], 42]));
			socket.emit('message', encode([133, 'frame-setup-barrier', 0, 'absent', 'MissingTable']));
			await until(
				() =>
					socket.sent.some((frame) => frame[0] === 134 && frame[1] === 'frame-setup-barrier') || socket.closes.length
			);
			assert.deepEqual(socket.closes, []);
			subscription.send = (event) => {
				events.push(event);
			};
			socket.emit('message', first);
			await until(() => events.some((event) => event.type === 'end_txn') || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			const firstCommit = events.find((event) => event.type === 'end_txn');
			socket.emit('message', encode([148, anchor, 1]));
			socket.emit('message', encode([149]));
			subscription.queue = { length: 100000 };
			subscription.waitForDrain = () => {
				paused();
				return gate;
			};
			socket.emit('message', live);
			await Promise.race([
				reached,
				new Promise((_, reject) => setTimeout(() => reject(new Error('live frame did not pause')), 5000).unref()),
			]);
			await firstCommit.onCommit();
			assert.equal(
				events.filter((event) => event.type === 'end_txn').length,
				1,
				'copy certification cannot terminate a live frame prefix'
			);
			release();
			await until(() => events.filter((event) => event.type === 'end_txn').length === 2 || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			await events.filter((event) => event.type === 'end_txn')[1].onCommit();
			await until(() => events.filter((event) => event.type === 'end_txn').length === 3);
			assert.deepEqual(events.filter((event) => event.type === 'end_txn')[2].remoteNodeIds, []);
		} finally {
			release();
			subscription.send = send;
			subscription.waitForDrain = waitForDrain;
			subscription.queue = queue;
			if (previous) await Nodes.primaryStore.put(peer, previous);
			else await Nodes.primaryStore.remove(peer);
		}
	});

	for (const clone of [false, true])
		it(`does not certify a replacement copy from the prior pass flush (clone=${clone})`, async () => {
			const { Records, socket, database } = await connect(false, 'replacement_copy_certificate_' + clone);
			const Nodes = getHDBNodeTable();
			const peer = 'slot-control-peer';
			const previous = Nodes.primaryStore.getSync(peer);
			const subscription = databaseSubscriptions.get(database);
			const send = subscription.send;
			const root = Records.auditStore.rootStore;
			const flush = root.flush;
			const commits = [];
			let releaseFlush, flushStarted;
			const gate = new Promise((resolve) => {
				releaseFlush = resolve;
			});
			const reached = new Promise((resolve) => {
				flushStarted = resolve;
			});
			let completion;
			const previousCloneAttempt = process.env.HARPER_CLONE_ATTEMPT;
			const remove = Records.dbisDB.remove;
			let releaseRevoke, revoking;
			const revokeGate = new Promise((resolve) => {
				releaseRevoke = resolve;
			});
			const revokeReached = new Promise((resolve) => {
				revoking = resolve;
			});
			try {
				await Nodes.primaryStore.put(peer, { name: peer, shard: 0, replicates: true });
				socket.emit(
					'message',
					encode([
						140,
						peer,
						database,
						[],
						buildLocalCapabilities(90_000, true, true),
						{
							shardsDigest: getResidencyConfiguration().digest,
							shard: 0,
							shardingCertificate: shardingSourceAgreement(database),
						},
					])
				);
				subscription.send = function (event) {
					if (event.type === 'end_txn' && event.remoteNodeIds?.length === 0 && event.onCommit) commits.push(event);
					else return send.call(this, event);
				};
				if (clone) process.env.HARPER_CLONE_ATTEMPT = 'copy-pass-test';
				const anchor = Date.now();
				socket.emit('message', encode([148, anchor, 1]));
				socket.emit('message', encode([149]));
				await until(() => commits.length === 1 || socket.closes.length);
				assert.deepEqual(socket.closes, []);
				assert.equal(shardingCertificate(database), undefined);
				root.flush = async function (...args) {
					flushStarted();
					await gate;
					return flush.apply(this, args);
				};
				completion = commits[0].onCommit();
				await Promise.race([
					reached,
					new Promise((_, reject) => setTimeout(() => reject(new Error('copy flush not reached')), 5000).unref()),
				]);
				if (clone)
					Records.dbisDB.remove = async function (...args) {
						revoking();
						await revokeGate;
						return remove.apply(this, args);
					};
				socket.emit('message', encode([148, anchor + 1, 1]));
				if (clone) {
					await Promise.race([
						revokeReached,
						new Promise((_, reject) => setTimeout(() => reject(new Error('revocation not reached')), 5000).unref()),
					]);
					releaseFlush();
					await completion;
					assert.equal(
						shardingCertificate(database),
						undefined,
						'revocation invalidates the old pass before awaiting storage'
					);
					releaseRevoke();
				}

				socket.emit('message', encode([133, 'copy-restart-barrier', 0, 'absent', 'MissingTable']));
				await until(
					() =>
						socket.sent.some((frame) => frame[0] === 134 && frame[1] === 'copy-restart-barrier') || socket.closes.length
				);
				assert.deepEqual(socket.closes, []);
				releaseFlush();
				await completion;
				assert.equal(shardingCertificate(database), undefined, 'an earlier pass cannot certify the replacement');
				socket.emit('message', encode([149]));
				await until(() => commits.length === 2 || socket.closes.length);
				assert.deepEqual(socket.closes, []);
				assert.equal(commits.length, 2, 'the replacement owns a fresh certification attempt');
				await commits[1].onCommit();
				await until(() => shardingCertificate(database) === shardingLayout(database));
			} finally {
				releaseRevoke();
				Records.dbisDB.remove = remove;
				if (previousCloneAttempt === undefined) delete process.env.HARPER_CLONE_ATTEMPT;
				else process.env.HARPER_CLONE_ATTEMPT = previousCloneAttempt;
				releaseFlush();
				await completion;
				root.flush = flush;
				subscription.send = send;
				if (previous) await Nodes.primaryStore.put(peer, previous);
				else await Nodes.primaryStore.remove(peer);
			}
		});

	for (const [traffic, closeBeforeFlush] of [
		['sequence', false],
		['frame', false],
		['frame', true],
	])
		it(`flushes projection ${traffic} traffic only when publishing durable completion (close=${closeBeforeFlush})`, async () => {
			env.setProperty('replication_shards', [0, 1]);
			const connection = new EventEmitter();
			connection.nodeSubscriptions = [{ name: 'slot-control-peer', replicateByDefault: true }];
			const { Records, socket, database } = await connect(
				false,
				'projection_flush_' + traffic + '_' + closeBeforeFlush,
				false,
				undefined,
				undefined,
				connection,
				[
					{ start: 0, end: 1, shard: 0 },
					{ start: 1, end: 2, shard: 1 },
				]
			);
			await until(() => socket.sent.some((frame) => frame[0] === 129));
			assert.equal(socket.sent.find((frame) => frame[0] === 129)[1][0].shardingProjection, true);
			const subscription = databaseSubscriptions.get(database);
			const send = subscription.send;
			const root = Records.auditStore.rootStore;
			const flush = root.flush;
			const peerId = getIdOfRemoteNode('slot-control-peer', Records.auditStore);
			const marker = () => Records.dbisDB.getSync([Symbol.for('shardingProjectionComplete'), peerId]);
			const sequence = Records.dbisDB.getSync([Symbol.for('seq'), peerId]);
			const anchor = Date.now() + 100;
			const ownedCursor = { copyStartTime: anchor - 100, currentTable: Records.tableName, afterKey: 'owned' };
			await Records.dbisDB.put([Symbol.for('copyCursor'), peerId], ownedCursor);
			const projectionCursorWrites = [];
			const put = Records.dbisDB.put;
			Records.dbisDB.put = function (key, ...args) {
				if (Array.isArray(key) && key[0] === Symbol.for('shardingProjectionCursor')) projectionCursorWrites.push(key);
				return put.call(this, key, ...args);
			};
			let flushes = 0,
				committed = 0;
			const commits = [];
			const gate = Promise.withResolvers();
			let blockFlush = false,
				blockFinalFlush = false,
				blockedFlush = false,
				finalCommitted = false;
			root.flush = async function (...args) {
				flushes++;
				if (blockFlush) {
					blockedFlush = true;
					await gate.promise;
				}
				return flush.apply(this, args);
			};
			subscription.send = function (event) {
				if (event.type === 'end_txn') {
					const final = blockFinalFlush && event.localTime === undefined;
					if (final) blockFlush = true;
					commits.push(event);
					const onCommit = event.onCommit;
					event.onCommit = async function (...args) {
						await onCommit?.apply(this, args);
						committed++;
						if (final) finalCommitted = true;
					};
				}
				return send.call(this, event);
			};
			try {
				const frames = Array.from({ length: 3 }, (_, n) =>
					recordFrame(Records, 'invalidate', `projection-x${n}`, { id: `projection-x${n}`, region: 0 }, anchor + n, 42)
				);
				const encoder = Records.primaryStore.encoder;
				socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
				socket.emit(
					'message',
					encode([
						132,
						{
							structures: encoder.structures,
							typedStructs: encoder.typedStructs,
							attributes: Records.attributes,
							residency: Records.residency,
							schemaDefined: true,
						},
						Records.tableId,
						Records.tableName,
					])
				);
				socket.emit('message', encode([130, [server.hostname], 42]));
				socket.emit('message', encode([148, anchor, 1, undefined, { shardingProjection: true }]));
				socket.emit('message', encode([133, 'projection-started', 0, 'absent', 'MissingTable']));
				await until(
					() =>
						socket.sent.some((frame) => frame[0] === 134 && frame[1] === 'projection-started') || socket.closes.length
				);
				assert.deepEqual(socket.closes, []);
				const before = flushes;
				for (let n = 0; n < 3; n++) {
					if (traffic === 'sequence') socket.emit('message', encode([143, anchor + n]));
					else socket.emit('message', frames[n]);
					await until(() => committed >= n + 1 || socket.closes.length);
					assert.deepEqual(socket.closes, []);
				}
				assert.equal(flushes, before, 'projection events publish no cursor requiring a per-event flush');
				for (const event of commits) {
					assert.deepEqual(event.remoteNodeIds, []);
					assert.equal(event.originCursors, undefined);
				}
				assert.deepEqual(Records.dbisDB.getSync([Symbol.for('seq'), peerId]), sequence);
				assert.equal(marker(), undefined);
				if (traffic === 'frame')
					for (let n = 0; n < 3; n++)
						assert.ok(Records.primaryStore.getEntry(`projection-x${n}`)?.metadataFlags & INVALIDATED);
				blockFinalFlush = true;
				socket.emit('message', encode([149]));
				await until(() => blockedFlush || socket.closes.length);
				assert.deepEqual(socket.closes, []);
				assert.equal(marker(), undefined, 'completion cannot precede row durability');
				if (closeBeforeFlush) socket.close();
				gate.resolve();
				if (closeBeforeFlush) {
					await until(() => finalCommitted);
					assert.equal(marker(), undefined, 'a closed projection cannot publish its completion after the flush');
					assert.deepEqual(Records.dbisDB.getSync([Symbol.for('seq'), peerId]), sequence);
				} else {
					await until(() => marker() || socket.closes.length);
					assert.equal(marker()?.anchor, anchor);
					await until(() => socket.closes.length);
					assert.match(socket.closes[0].reason, /projection complete/);
				}
			} finally {
				Records.dbisDB.put = put;
				assert.deepEqual(projectionCursorWrites, []);
				assert.deepEqual(Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]), ownedCursor);
				gate.resolve();
				root.flush = flush;
				subscription.send = send;
				env.setProperty('replication_shards', [0]);
			}
		});

	it('flushes newer copy projections without appending their snapshot identity to the origin log', async () => {
		const connection = new EventEmitter();
		connection.nodeSubscriptions = [{ name: 'slot-control-peer', replicateByDefault: true }];
		const { Records, socket } = await connect(false, 'newer_copy_projection', false, undefined, undefined, connection, [
			{ start: 0, end: 2, shard: 1 },
		]);
		const peerId = getIdOfRemoteNode('slot-control-peer', Records.auditStore);
		const version = Date.now() + 100;
		const incoming = recordFrame(Records, 'invalidate', 'newer-copy', { id: 'newer-copy', region: 0 }, version, 42);
		const encoder = Records.primaryStore.encoder;
		let reloads = 0;
		const originalReload = Records.writeReloadMarker;
		Records.writeReloadMarker = function (...args) {
			reloads++;
			return originalReload.apply(this, args);
		};
		try {
			socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
			socket.emit(
				'message',
				encode([
					132,
					{
						structures: encoder.structures,
						typedStructs: encoder.typedStructs,
						attributes: Records.attributes,
						residency: Records.residency,
						schemaDefined: true,
					},
					Records.tableId,
					Records.tableName,
				])
			);
			socket.emit('message', encode([130, [server.hostname], 42]));
			socket.emit('message', encode([148, version - 1000, 1]));
			socket.emit('message', incoming);
			socket.emit('message', encode([149]));
			await until(() => reloads > 0 || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			assert.ok(Records.primaryStore.getEntry('newer-copy').metadataFlags & INVALIDATED);
			assert.equal(Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]), undefined);
			assert.equal(
				Array.from(Records.auditStore.getRange({ start: 1 })).filter((entry) => entry.recordId === 'newer-copy').length,
				0
			);
			assert.equal(reloads, 1, 'audit-free projections participate in durable copy completion');
		} finally {
			Records.writeReloadMarker = originalReload;
		}
	});
	it('unwraps an owner record after residency resolution decodes another native entry', async () => {
		const { Records, socket } = await connect(false, 'metadata_decode');
		await Records.put('requested', { id: 'requested', region: 0, body: 'canonical' });
		await Records.put('other', { id: 'other', region: 0, body: 'unrelated' });
		const resolveOwners = Records.getRecordResidency;
		Records.getRecordResidency = function (entry) {
			const owners = resolveOwners.call(this, entry);
			const bytes = Records.primaryStore.getBinary('other');
			Records.primaryStore.decoder.decode(bytes, { valueAsBuffer: true });
			return owners;
		};
		try {
			socket.emit('message', encode([133, 'metadata-decode', Records.tableId, 'requested', Records.tableName]));
			await until(() => socket.sent.some((frame) => frame[0] === 134 && frame[1] === 'metadata-decode'));
			const answer = socket.sent.find((frame) => frame[0] === 134 && frame[1] === 'metadata-decode')[2];
			assert.equal(answer.error, undefined);
			assert.ok(Buffer.isBuffer(answer.value), 'the response carries encoded value bytes, not native metadata');
			assert.equal(Records.primaryStore.decoder.decode(answer.value, { valueOnly: true }).body, 'canonical');
		} finally {
			Records.getRecordResidency = resolveOwners;
		}
	});
	it('holds a canonical frame through repeated owner changes and commits after membership stabilizes', async () => {
		const { Records, socket: initial, database } = await connect(false, 'churn');
		initial.close();
		const version = Date.now() + 1;
		const frame = recordFrame(Records, 'put', 'held', { id: 'held', region: 0, body: 'canonical' }, version, 42);
		const original = DatabaseTransaction.prototype.refuseUnconfirmable;
		let refusals = 0;
		DatabaseTransaction.prototype.refuseUnconfirmable = function (...args) {
			if (!this.sourceApply || !this.writes.some((write) => write?.store?.rootStore.databaseName === database))
				return original.apply(this, args);
			const prior = server.shards;
			server.shards = new Map(prior);
			server.shards.set(0, [...prior.get(0), { name: 'new-owner-during-submit' }]);
			try {
				refusals++;
				return original.apply(this, args);
			} finally {
				server.shards = prior;
			}
		};
		async function deliver() {
			const connection = new EventEmitter();
			connection.nodeSubscriptions = [{ name: 'slot-control-peer', replicateByDefault: true }];
			const { socket } = await connect(false, 'churn', false, undefined, undefined, connection);
			const encoder = Records.primaryStore.encoder;
			socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
			socket.emit(
				'message',
				encode([
					132,
					{
						structures: encoder.structures,
						typedStructs: encoder.typedStructs,
						attributes: Records.attributes,
						residency: Records.residency,
						schemaDefined: true,
					},
					Records.tableId,
					Records.tableName,
				])
			);
			socket.emit('message', encode([130, [server.hostname], 42]));
			socket.emit('message', frame);
			return socket;
		}
		const remoteId = getIdOfRemoteNode('slot-control-peer', Records.auditStore);
		const cursor = () => Records.dbisDB.getSync([Symbol.for('seq'), remoteId])?.seqId;
		const before = cursor();
		try {
			for (let attempt = 0; attempt < 7; attempt++) {
				const socket = await deliver();
				await until(
					() => socket.closes.length || socket.sent.some((message) => message[0] === 144 && message[1] >= version)
				);
				assert.ok(socket.closes.length, `delivery ${attempt + 1} must hold, not skip`);
				assert.equal(cursor(), before, 'a refused canonical frame cannot advance its durable cursor');
				assert.equal(Records.primaryStore.getEntry('held'), undefined);
			}
			assert.ok(refusals >= 7, 'every delivery reaches the native pre-submit owner fence');
		} finally {
			DatabaseTransaction.prototype.refuseUnconfirmable = original;
		}
		const repaired = await deliver();
		await until(() => Records.primaryStore.getEntry('held')?.value?.body === 'canonical');
		await until(() => cursor() === version);
		assert.deepEqual(repaired.closes, []);
	});
	for (const failure of ['busy', 'fork'])
		it(`holds the cursor for ${failure} maps despite subsequent system frames, beyond the poison budget`, async () => {
			const database = `sharded_system_hold_${failure}`;
			await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
			const Maps = getResidencyMapTable();
			const Probe = table({
				database: 'system',
				table: `sharded_hold_probe_${failure}`,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
			});
			setReplicator('system', Maps, {});
			setReplicator('system', Probe, {});
			await until(() => databaseSubscriptions.get('system')?.auditStore);
			const peer = `sharded-map-peer-${failure}`;
			const remoteId = getIdOfRemoteNode(peer, Maps.auditStore);
			const cursor = () => Maps.dbisDB.getSync([Symbol.for('seq'), remoteId])?.seqId;
			const before = cursor();
			const candidate = createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], failure === 'fork' ? 1 : 2);
			const version = Date.now() + 1000;
			const mapFrame = recordFrame(Maps, 'put', database, candidate, version);
			const laterFrame = recordFrame(Probe, 'put', 'later', { id: 'later', body: 'system update' }, version + 1);
			let release = failure === 'busy' ? acquireResidencyMapFence(database, {}) : undefined;
			async function deliver() {
				const connection = new EventEmitter();
				connection.nodeSubscriptions = [{ name: peer, replicateByDefault: true }];
				const socket = new Socket();
				sockets.push(socket);
				connection.socket = socket;
				replicateOverWS(socket, { connection }, { name: peer, replicates: true });
				socket.emit(
					'message',
					encode([
						140,
						peer,
						'system',
						[],
						buildLocalCapabilities(90000, false, false),
						{ shardsDigest: getResidencyConfiguration().digest },
					])
				);
				await until(() => socket.sent.some((frame) => frame[0] === 140) || socket.closes.length);
				assert.deepEqual(socket.closes, [], 'handshake reaches the actual map apply');
				socket.emit('message', encode([141, { [peer]: 0 }, [peer]]));
				for (const Rows of [Maps, Probe])
					socket.emit(
						'message',
						encode([
							132,
							{
								structures: Rows.primaryStore.encoder.structures,
								typedStructs: Rows.primaryStore.encoder.typedStructs,
								attributes: Rows.attributes,
							},
							Rows.tableId,
							Rows.tableName,
						])
					);
				socket.emit('message', mapFrame);
				socket.emit('message', laterFrame);
				return socket;
			}
			try {
				for (let attempt = 0; attempt < 7; attempt++) {
					const socket = await deliver();
					await until(() => socket.closes.length);
					assert.ok(socket.closes.length, `attempt ${attempt + 1} must hold the map`);
					assert.equal(cursor(), before);
				}
			} finally {
				release?.();
				release = undefined;
			}
			if (failure === 'fork')
				await initializeResidencySlots({
					database,
					slots: 2,
					ranges: candidate.ranges,
				});
			const repaired = await deliver();
			await until(() => Probe.primaryStore.getEntry('later')?.value?.body === 'system update');
			await until(() => cursor() === version + 1);
			assert.deepEqual(repaired.closes, []);
			assert.deepEqual(Maps.primaryStore.getSync(database).ranges, candidate.ranges);
		});
	it('preserves an explicitly missing legacy residency list', async () => {
		const { Records, socket } = await connect(false, 'legacy_missing_list', true);
		const frame = recordFrame(Records, 'put', 'legacy-row', { id: 'legacy-row', body: 'complete' }, Date.now(), 42);
		const encoder = Records.primaryStore.encoder;
		socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
		socket.emit(
			'message',
			encode([
				132,
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
		socket.emit('message', encode([130, undefined, 42]));
		socket.emit('message', frame);
		await until(() => Records.primaryStore.getEntry('legacy-row')?.value || socket.closes.length);
		assert.deepEqual(socket.closes, []);
		assert.equal(Records.primaryStore.getEntry('legacy-row').value.body, 'complete');
	});
	for (const [legacy, multiple, cold = false] of [
		[true, false],
		[false, false],
		[false, true],
		[false, false, true],
	])
		it(`repairs cursorless copy damage or withholds certification (F-1020, legacy=${legacy}, multiple=${multiple}, cold=${cold})`, async () => {
			const direction = `cursorless_blob_${legacy}_${multiple}_${cold}`;
			const peer = 'slot-control-peer';
			const Nodes = getHDBNodeTable();
			const previous = Nodes.primaryStore.getSync(peer);
			const { Records, socket: first, database } = await connect(false, direction, legacy);
			const originalGetEntry = Records.primaryStore.getEntry;
			let coldRead = false;
			const warnings = [];
			const originalWarn = logger.warn;
			logger.warn = (...args) => warnings.push(args.join(' '));
			try {
				await Nodes.primaryStore.put(peer, { name: peer, shard: 0, replicates: true });
				const payload = Buffer.alloc(65_536, 79);
				await Records.put('donor', {
					id: 'donor',
					region: 0,
					body: createBlob(payload),
					...(multiple ? { extra: createBlob(Buffer.alloc(65_536, 83)) } : {}),
				});
				const donor = Records.primaryStore.getEntry('donor');
				const announced = [];
				const encodedRecord = Buffer.from(
					encodeCopyRecordValue(Records.primaryStore, donor.value, (blob) => announced.push(blob))
				);
				const leadingRows = [];
				if (!multiple)
					for (let i = 0; i < 9; i++) {
						const id = 'leading-' + i;
						await Records.put('donor-' + i, { id, region: 0, body: createBlob(payload) });
						leadingRows.push({
							id,
							encodedRecord: Buffer.from(
								encodeCopyRecordValue(Records.primaryStore, Records.primaryStore.getEntry('donor-' + i).value, (blob) =>
									announced.push(blob)
								)
							),
						});
					}
				const version = Date.now() + 100;
				const encoder = Records.primaryStore.encoder;
				const sendRow = (socket, leading = false) => {
					if (!legacy)
						socket.emit(
							'message',
							encode([
								140,
								peer,
								database,
								[],
								buildLocalCapabilities(90_000, true, true),
								{
									shardsDigest: getResidencyConfiguration().digest,
									shard: 0,
									shardingCertificate: shardingSourceAgreement(database),
								},
							])
						);
					socket.emit('message', encode([141, { [peer]: 0 }, [peer]]));
					socket.emit(
						'message',
						encode([
							132,
							{
								structures: encoder.structures,
								typedStructs: encoder.typedStructs,
								attributes: Records.attributes,
								schemaDefined: true,
								residency: Records.residency,
							},
							Records.tableId,
							Records.tableName,
						])
					);
					socket.emit('message', encode([130, [server.hostname], 42]));
					socket.emit('message', encode([148, version + 1000, 1]));
					if (leading)
						for (const { id, encodedRecord } of leadingRows)
							socket.emit(
								'message',
								recordFrame(Records, 'put', id, undefined, version, 42, {
									encodedRecord,
									extendedType: HAS_BLOBS | 512,
								})
							);
					socket.emit(
						'message',
						recordFrame(Records, 'put', 'interrupted', undefined, version, 42, {
							encodedRecord,
							extendedType: HAS_BLOBS | 512,
						})
					);
				};
				sendRow(first);
				await until(() => first.closes.length || Records.primaryStore.getEntry('interrupted')?.version === version);
				assert.deepEqual(first.closes, []);
				const original = Records.primaryStore.getEntry('interrupted').value.body;
				const originalFile = getFileId(original);
				const peerId = getIdOfRemoteNode(peer, Records.auditStore);
				assert.equal(Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]), undefined);
				first.close(1011, 'interrupt first copy before blob bytes');
				await until(() => blobFileMissingOrIncomplete(original) === true);
				const { socket: second } = await connect(false, direction, legacy);
				if (cold)
					Records.primaryStore.getEntry = function (id, ...args) {
						const entry = originalGetEntry.call(this, id, ...args);
						if (id !== 'interrupted' || coldRead) return entry;
						coldRead = true;
						return Promise.resolve(entry);
					};
				sendRow(second, !multiple);
				for (const [index, blob] of announced.entries())
					second.emit(
						'message',
						encode([
							146,
							{ fileId: getFileId(blob), size: payload.length, finished: true },
							Buffer.alloc(payload.length, multiple && index ? 83 : 79),
						])
					);
				second.emit('message', encode([149]));
				if (multiple) {
					await until(
						() =>
							second.closes.length ||
							shardingCertificate(database) ||
							warnings.some((w) => w.includes('Sharding recovery required'))
					);
					assert.deepEqual(second.closes, [], 'unrepairable pairing holds certification without reconnect churn');
					assert.equal(shardingCertificate(database), undefined, 'pending owned bytes must not certify readiness');
					assert.ok(
						Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]),
						'retain the copy route while owned bytes are pending'
					);
					assert.equal(blobFileMissingOrIncomplete(original), true);
				} else {
					await until(() => second.closes.length || blobFileMissingOrIncomplete(original) === false);
					assert.deepEqual(second.closes, []);
					assert.equal(getFileId(Records.primaryStore.getEntry('interrupted').value.body), originalFile);
					assert.deepEqual(Buffer.from(await original.arrayBuffer()), payload);
					if (cold) assert.equal(coldRead, true);
					if (!legacy) {
						await until(() => shardingCertificate(database));
						assert.equal(shardingCertificate(database), shardingLayout(database));
					}
				}
			} finally {
				logger.warn = originalWarn;
				Records.primaryStore.getEntry = originalGetEntry;
				if (previous) await Nodes.primaryStore.put(peer, previous);
				else await Nodes.primaryStore.remove(peer);
			}
		});

	for (const [probe, legacy, multiple, cold] of [
		['source-failed', false, false, false],
		['resumed', false, true, false],
		['held-cursor', false, true, false],
	])
		it(`holds owned-copy readiness through ${probe}`, async () => {
			const direction = `copy_hold_${probe}_${multiple}`;
			const peer = 'slot-control-peer';
			const Nodes = getHDBNodeTable();
			const previous = Nodes.primaryStore.getSync(peer);
			const connectCopy = () => {
				const connection = new EventEmitter();
				connection.nodeSubscriptions = [{ name: peer, replicateByDefault: true }];
				connection.forceReconnect = () => connection.socket.close(1011, 'reconnect');
				return connect(false, direction, legacy, undefined, undefined, connection);
			};
			const { Records, socket: first, database } = await connectCopy();
			const originalGetEntry = Records.primaryStore.getEntry;
			let coldRead = false;
			const warnings = [];
			const originalWarn = logger.warn;
			logger.warn = (...args) => warnings.push(args.join(' '));
			try {
				await Nodes.primaryStore.put(peer, { name: peer, shard: 0, replicates: true });
				env.setProperty('replication_copyCursorFlushBytes', 1);
				const payload = Buffer.alloc(65_536, 79);
				await Records.put('donor', {
					id: 'donor',
					region: 0,
					body: createBlob(payload),
					...(multiple ? { extra: createBlob(Buffer.alloc(65_536, 83)) } : {}),
				});
				const donor = Records.primaryStore.getEntry('donor');
				const announced = [];
				const encodedRecord = Buffer.from(
					encodeCopyRecordValue(Records.primaryStore, donor.value, (blob) => announced.push(blob))
				);
				const leadingRows = [];
				if (!multiple)
					for (let i = 0; i < 9; i++) {
						const id = 'leading-' + i;
						await Records.put('donor-' + i, { id, region: 0, body: createBlob(payload) });
						leadingRows.push({
							id,
							encodedRecord: Buffer.from(
								encodeCopyRecordValue(Records.primaryStore, Records.primaryStore.getEntry('donor-' + i).value, (blob) =>
									announced.push(blob)
								)
							),
						});
					}
				const version = Date.now() + 100;
				const encoder = Records.primaryStore.encoder;
				const sendRow = (socket, leading = false, skipTarget = false) => {
					if (!legacy)
						socket.emit(
							'message',
							encode([
								140,
								peer,
								database,
								[],
								buildLocalCapabilities(90_000, true, true),
								{
									shardsDigest: getResidencyConfiguration().digest,
									shard: 0,
									shardingCertificate: shardingSourceAgreement(database),
								},
							])
						);
					socket.emit('message', encode([141, { [peer]: 0 }, [peer]]));
					socket.emit(
						'message',
						encode([
							132,
							{
								structures: encoder.structures,
								typedStructs: encoder.typedStructs,
								attributes: Records.attributes,
								schemaDefined: true,
								residency: Records.residency,
							},
							Records.tableId,
							Records.tableName,
						])
					);
					socket.emit('message', encode([130, [server.hostname], 42]));
					socket.emit('message', encode([148, version + 1000, 1]));
					if (leading)
						for (const { id, encodedRecord } of leadingRows)
							socket.emit(
								'message',
								recordFrame(Records, 'put', id, undefined, version, 42, {
									encodedRecord,
									extendedType: HAS_BLOBS | 512,
								})
							);
					if (skipTarget) return;
					socket.emit(
						'message',
						recordFrame(Records, 'put', 'interrupted', undefined, version, 42, {
							encodedRecord,
							extendedType: HAS_BLOBS | 512,
						})
					);
				};
				sendRow(first);
				await until(() => first.closes.length || Records.primaryStore.getEntry('interrupted')?.version === version);
				assert.deepEqual(first.closes, []);
				const original = Records.primaryStore.getEntry('interrupted').value.body;
				const originalFile = getFileId(original);
				const peerId = getIdOfRemoteNode(peer, Records.auditStore);
				assert.equal(Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]), undefined);
				first.close(1011, 'interrupt first copy before blob bytes');
				await until(() => blobFileMissingOrIncomplete(original) === true);
				const { socket: second } = await connectCopy();
				if (cold)
					Records.primaryStore.getEntry = function (id, ...args) {
						const entry = originalGetEntry.call(this, id, ...args);
						if (id !== 'interrupted' || coldRead) return entry;
						coldRead = true;
						return Promise.resolve(entry);
					};
				sendRow(second, !multiple);
				for (const [index, blob] of announced.entries())
					second.emit(
						'message',
						encode([
							146,
							{
								fileId: getFileId(blob),
								size: payload.length,
								finished: true,
								...(probe === 'source-failed'
									? { error: 'source file missing', errorCode: 'ENOENT', errorStatus: 404 }
									: {}),
							},
							Buffer.alloc(payload.length, multiple && index ? 83 : 79),
						])
					);
				const finish = (socket) => {
					const frame = new FrameWriter();
					frame.writeFloat64(version + 1000);
					frame.writeInt(9);
					frame.writeInt(11);
					frame.writeFloat64(version + 1000);
					socket.emit('message', Buffer.from(frame.encodingBuffer.subarray(frame.encodingStart, frame.position)));
					socket.emit('message', encode([149]));
				};
				if (probe === 'resumed') {
					await until(() => Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId])?.afterKey === 'interrupted');
					const checkpoint = Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]);
					assert.equal(blobFileMissingOrIncomplete(original), true);
					second.close(1011, 'interrupt after damaged row checkpoint');
					const { socket: third } = await connectCopy();
					await certifyShardingCopy(database, shardingLayout(database));
					assert.equal(shardingCertificate(database), shardingLayout(database));
					sendRow(third, false, true);
					finish(third);
					await until(() => third.closes.length || warnings.some((w) => w.includes('Sharding recovery required')));
					console.log(
						'COPY_CERTIFICATION',
						JSON.stringify({
							probe,
							checkpoint,
							certificate: shardingCertificate(database),
							pending: blobFileMissingOrIncomplete(original),
							closes: third.closes,
						})
					);
					assert.deepEqual(third.closes, []);
					assert.equal(
						shardingCertificate(database),
						undefined,
						'a resumed copy must retain the pending-owned-blob hold'
					);
				} else {
					if (probe === 'held-cursor')
						await until(() => Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId])?.afterKey === 'interrupted');
					finish(second);
					await until(
						() =>
							second.closes.length ||
							shardingCertificate(database) ||
							warnings.some((w) => w.includes('Sharding recovery required'))
					);
					const cursor = Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]);
					const seq = Records.dbisDB.getSync([Symbol.for('seq'), peerId]);
					console.log(
						'COPY_CERTIFICATION',
						JSON.stringify({
							probe,
							cursor,
							seq,
							certificate: shardingCertificate(database),
							pending: blobFileMissingOrIncomplete(original),
							closes: second.closes,
						})
					);
					assert.deepEqual(second.closes, []);
					assert.equal(
						shardingCertificate(database),
						undefined,
						'source failure must not certify a pending owned blob'
					);
					if (probe === 'held-cursor') {
						await until(() => Records.dbisDB.getSync([Symbol.for('seq'), peerId])?.seqId === version + 1000);
						assert.equal(Records.dbisDB.getSync([Symbol.for('seq'), peerId]).seqId, version + 1000);
						assert.ok(cursor, 'keep a copy-resume path when the final sequence is banked');
						assert.equal(cursor.copyStartTime, version + 1000);
						assert.equal(cursor.currentTable, Records.tableName);
						const row = Records.primaryStore.getEntry('interrupted');
						for (const [field, byte] of [
							['body', 79],
							['extra', 83],
						]) {
							assert.equal(await blobFileMissingOrIncompleteAsync(row.value[field]), true);
							const repaired = repairBlobFile(
								row.value[field],
								Readable.from(Buffer.alloc(payload.length, byte)),
								payload.length
							);
							assert.ok(repaired, 'repair starts against the original pending file');
							await repaired;
							assert.deepEqual(Buffer.from(await row.value[field].arrayBuffer()), Buffer.alloc(payload.length, byte));
						}
						await until(
							() =>
								shardingCertificate(database) === shardingLayout(database) &&
								!Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId])
						);
						assert.equal(Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]), undefined);
						assert.equal(getFileId(Records.primaryStore.getEntry('interrupted').value.body), originalFile);
					}
				}
			} finally {
				logger.warn = originalWarn;
				Records.primaryStore.getEntry = originalGetEntry;
				if (previous) await Nodes.primaryStore.put(peer, previous);
				else await Nodes.primaryStore.remove(peer);
			}
		});

	it('refuses a policy-less slot reference before creating unreferenced blob files', async () => {
		const { Records, socket } = await connect(false, 'missing_blob_policy', true);
		const payload = Buffer.alloc(65_536, 73);
		await Records.put('blob-donor', { id: 'blob-donor', body: createBlob(payload) });
		const donor = Records.primaryStore.getEntry('blob-donor');
		assert.ok(donor.metadataFlags & HAS_BLOBS);
		const announced = [];
		const encodedRecord = Buffer.from(
			encodeCopyRecordValue(Records.primaryStore, donor.value, (blob) => announced.push(blob))
		);
		assert.equal(announced.length, 1);
		const blobRoot = dirname(dirname(dirname(getFilePathForBlob(donor.value.body))));
		const files = () =>
			readdirSync(blobRoot, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => `${entry.parentPath}/${entry.name}`)
				.sort();
		const before = files();
		const encoder = Records.primaryStore.encoder;
		socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
		socket.emit(
			'message',
			encode([
				132,
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
		socket.emit('message', encode([130, { slot: 0, mapVersion: 1, mapDigest: 'untrusted' }, 42]));
		socket.emit(
			'message',
			encode([146, { fileId: getFileId(announced[0]), size: payload.length, finished: true }, payload])
		);
		socket.emit(
			'message',
			recordFrame(Records, 'put', 'refused-blob', undefined, Date.now(), 42, {
				encodedRecord,
				extendedType: HAS_BLOBS | 512,
			})
		);
		await until(() => socket.closes.length);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(Records.primaryStore.getEntry('refused-blob'), undefined);
		assert.deepEqual(files(), before, 'refusal must not mint a blob with no committed record');
		assert.deepEqual(Buffer.from(await donor.value.body.arrayBuffer()), payload);
	});
	for (const fails of [false, true])
		it(`refreshes a delayed blob confirmation only after a successful save (failure=${fails})`, async () => {
			const { Records, socket } = await connect(false, `delayed_blob_ack_${fails}`, true);
			const id = 'delayed-blob';
			const payload = Buffer.alloc(65_536, 83);
			await Records.put(id, { id, body: createBlob(payload) });
			const donor = Records.primaryStore.getEntry(id);
			const announced = [];
			const encodedRecord = Buffer.from(
				encodeCopyRecordValue(Records.primaryStore, donor.value, (blob) => announced.push(blob))
			);
			assert.equal(announced.length, 1);
			const version = Date.now() + 1;
			const encoder = Records.primaryStore.encoder;
			socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
			socket.emit(
				'message',
				encode([
					132,
					{ structures: encoder.structures, typedStructs: encoder.typedStructs, attributes: Records.attributes },
					Records.tableId,
					Records.tableName,
				])
			);
			socket.emit(
				'message',
				recordFrame(Records, 'put', id, undefined, version, undefined, { encodedRecord, extendedType: HAS_BLOBS })
			);
			await until(() => socket.sent.some((frame) => frame[0] === 144));
			assert.equal(Records.primaryStore.getEntry(id)?.version, version, 'the record commits before its blob finishes');
			const confirmations = () => socket.sent.filter((frame) => frame[0] === 144).map((frame) => frame[1]);
			assert.ok(
				confirmations().every((confirmed) => confirmed < version),
				'unfinished bytes cannot be confirmed'
			);
			socket.emit(
				'message',
				encode([
					146,
					{
						fileId: getFileId(announced[0]),
						size: payload.length,
						finished: true,
						...(fails ? { error: 'temporarily unavailable', errorStatus: 503 } : {}),
					},
					fails ? Buffer.alloc(0) : payload,
				])
			);
			if (fails) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.ok(
					confirmations().every((confirmed) => confirmed < version),
					'a failed blob still holds confirmation'
				);
			} else {
				const record = Records.primaryStore.getEntry(id).value;
				assert.deepEqual(Buffer.from(await record.body.arrayBuffer()), payload);
				await until(() => confirmations().includes(version));
			}
			assert.deepEqual(socket.closes, []);
		});
	for (const byAttribute of [false, true])
		for (const stubCapable of [false, true])
			it(`copies declarative stubs safely (attribute=${byAttribute}, stub capability=${stubCapable})`, async () => {
				const capabilities = { ...buildLocalCapabilities(90_000, false, true), residencyStubCopy: stubCapable ? 1 : 0 };
				const priorList = env.get('replication_shards');
				const prior = server.shards;
				try {
					env.setProperty('replication_shards', [0, 1]);
					const { Records, socket } = await connect(
						byAttribute,
						`copy_${stubCapable}`,
						false,
						capabilities,
						undefined,
						undefined,
						[
							{ start: 0, end: 1, shard: 0 },
							{ start: 1, end: 2, shard: 1 },
						]
					);
					const context = { sourceApply: true, [REPLICATION_APPLY]: true };
					await transaction(context, async () => {
						const row = await Records.getResource('stubx', context, { ensureLoaded: false });
						row._writeInvalidate('stubx', { id: 'stubx', region: 1 }, { residencySlot: byAttribute ? 1 : undefined });
					});
					assert.ok(Records.primaryStore.getEntry('stubx').metadataFlags & INVALIDATED);
					Records.setTTLExpiration(3600);
					await Records.put('full', { id: 'full', region: 0, body: 'canonical' });
					server.shards = new Map([
						[0, [{ name: server.hostname }, { name: 'slot-control-peer' }]],
						[1, [{ name: 'third-slot-owner' }]],
					]);
					socket.emit(
						'message',
						encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
					);
					await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
					assert.deepEqual(socket.closes, []);
					const copied = entries(socket);
					const stub = copied.find((entry) => entry.recordId === 'stubx');
					if (stubCapable) assert.equal(stub?.type, 'invalidate');
					else
						assert.notEqual(
							stub?.type,
							'put',
							'a peer without safe invalidations must not receive a partial canonical put'
						);
					const full = copied.find((entry) => entry.recordId === 'full');
					assert.equal(full?.type, 'put');
					assert.equal(full.getValue(Records.primaryStore).body, 'canonical');
					assert.equal(
						full.extendedType & 0x0e000000,
						0,
						'primary metadata action bits must not enter the audit header'
					);
				} finally {
					server.shards = prior;
					env.setProperty('replication_shards', priorList);
				}
			});

	for (const liveMode of ['blobless', 'blob-success', 'blob-source-failure', 'blob-classification-failure'])
		it(`retains a completed owned-blob walk while a live commit drains (${liveMode})`, async () => {
			const peer = 'slot-control-peer';
			const previousFlushBytes = env.get('replication_copyCursorFlushBytes');
			env.setProperty('replication_copyCursorFlushBytes', 1);
			const Nodes = getHDBNodeTable();
			const previous = Nodes.primaryStore.getSync(peer);
			await Nodes.primaryStore.put(peer, { name: peer, shard: 0, replicates: true });
			const connection = new EventEmitter();
			connection.nodeSubscriptions = [{ name: peer, replicateByDefault: true }];
			const { Records, socket, database } = await connect(
				false,
				`busy_owned_copy_${liveMode}`,
				false,
				undefined,
				undefined,
				connection,
				undefined,
				true
			);
			let releaseLive;
			const liveGate = new Promise((resolve) => (releaseLive = resolve));
			const originalCommit = NativeTransaction.prototype.commit;
			let holdNextCommit = false;
			const originalRange = Records.primaryStore.getRange;
			let held = false;
			let scans = 0;
			let walkFinished = false;
			const warnings = [];
			const originalWarn = logger.warn;
			logger.warn = (...args) => warnings.push(args.join(' '));
			const originalSlot = Records.getResidencySlot;
			const sourceFailed = liveMode === 'blob-source-failure' || liveMode === 'blob-classification-failure';
			try {
				await Records.put('owned-blob', { id: 'owned-blob', region: 0, body: createBlob(Buffer.alloc(65_536, 91)) });
				const version = Date.now() + 100;
				const blobs = [];
				const liveValue = { ...Records.primaryStore.getEntry('owned-blob').value, id: 'aaa-live' };
				const encodedLive = Buffer.from(
					encodeCopyRecordValue(Records.primaryStore, liveValue, (blob) => blobs.push(blob))
				);
				socket.emit(
					'message',
					encode([
						140,
						peer,
						database,
						[],
						buildLocalCapabilities(90_000, true, true),
						{
							shardsDigest: getResidencyConfiguration().digest,
							shard: 0,
							shardingCertificate: shardingSourceAgreement(database),
						},
					])
				);
				socket.emit('message', encode([141, { [peer]: 0 }, [peer]]));
				const encoder = Records.primaryStore.encoder;
				socket.emit(
					'message',
					encode([
						132,
						{
							structures: encoder.structures,
							typedStructs: encoder.typedStructs,
							attributes: Records.attributes,
							schemaDefined: true,
							residency: Records.residency,
						},
						Records.tableId,
						Records.tableName,
					])
				);
				socket.emit('message', encode([130, [server.hostname], 42]));
				socket.emit('message', encode([148, version + 1000, 1]));
				socket.emit(
					'message',
					recordFrame(Records, 'put', 'base', { id: 'base', region: 0, body: 'copied' }, version, 42)
				);
				const peerId = getIdOfRemoteNode(peer, Records.auditStore);
				await until(() => Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId])?.afterKey === 'base');
				NativeTransaction.prototype.commit = function (...args) {
					const shouldHold = holdNextCommit && this.store?.db === Records.primaryStore.store.db;
					if (shouldHold) holdNextCommit = false;
					const committed = originalCommit.apply(this, args);
					if (!shouldHold) return committed;
					return Promise.resolve(committed).then(async (result) => {
						held = true;
						await liveGate;
						return result;
					});
				};
				Records.primaryStore.getRange = function (options) {
					const entries = originalRange.call(this, options);
					if (!options?.versions || !options.lazy || options.snapshot !== false) return entries;
					const scan = ++scans;
					return {
						*[Symbol.iterator]() {
							let injected = false;
							for (const entry of entries) {
								yield entry;
								if (scan !== 1 || injected) continue;
								injected = true;
								holdNextCommit = true;
								socket.emit(
									'message',
									liveMode === 'blobless'
										? recordFrame(
												Records,
												'put',
												'aaa-live',
												{ id: 'aaa-live', region: 0, body: 'live' },
												version + 2000,
												42
											)
										: recordFrame(Records, 'put', 'aaa-live', undefined, version + 2000, 42, {
												encodedRecord: encodedLive,
												extendedType: HAS_BLOBS | 512,
											})
								);
							}
							if (scan === 1) walkFinished = true;
						},
					};
				};
				const frame = new FrameWriter();
				frame.writeFloat64(version + 1000);
				frame.writeInt(9);
				frame.writeInt(11);
				frame.writeFloat64(version + 1000);
				socket.emit('message', Buffer.from(frame.encodingBuffer.subarray(frame.encodingStart, frame.position)));
				socket.emit('message', encode([149]));
				await until(() => held || socket.closes.length);
				assert.deepEqual(socket.closes, []);
				assert.equal(scans, 1);
				if (liveMode !== 'blobless') {
					await until(() => walkFinished);
					if (liveMode === 'blob-classification-failure')
						Records.getResidencySlot = () => {
							Records.getResidencySlot = originalSlot;
							throw new Error('placement unavailable during blob settlement');
						};
					assert.equal(shardingCertificate(database), undefined, 'wait for the captured in-flight blob');
					for (const blob of blobs)
						socket.emit(
							'message',
							encode([
								146,
								{
									fileId: getFileId(blob),
									size: 65_536,
									finished: true,
									...(sourceFailed ? { error: 'source file missing', errorCode: 'ENOENT', errorStatus: 404 } : {}),
								},
								Buffer.alloc(65_536, 91),
							])
						);
					if (sourceFailed) {
						releaseLive();
						await until(() => warnings.some((warning) => warning.includes('Sharding recovery required')));
						assert.ok(scans > 1);
						for (const blob of blobs)
							assert.equal(isBlobReceiveInFlight(getFileId(blob), Records.auditStore.rootStore), false);
						assert.equal(
							shardingCertificate(database),
							undefined,
							'a failed owned save behind the iterator invalidates its proof'
						);
						assert.equal(blobFileMissingOrIncomplete(Records.primaryStore.getEntry('aaa-live').value.body), true);
						assert.ok(Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]));
						return;
					}
				}

				await until(() => shardingCertificate(database) === shardingLayout(database));
				assert.ok(Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]), 'live work still gates cursor removal');
				releaseLive();
				assert.equal(
					scans,
					1,
					'do not discard the completed validation walk because a blob-less live frame was in flight'
				);
				await until(() => !Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]));
				if (liveMode === 'blobless') assert.equal(Records.primaryStore.getEntry('aaa-live').value.body, 'live');
				else
					assert.equal(
						await blobFileMissingOrIncompleteAsync(Records.primaryStore.getEntry('aaa-live').value.body),
						false
					);
			} finally {
				releaseLive();
				NativeTransaction.prototype.commit = originalCommit;
				Records.getResidencySlot = originalSlot;
				logger.warn = originalWarn;
				Records.primaryStore.getRange = originalRange;
				env.setProperty('replication_copyCursorFlushBytes', previousFlushBytes);
				if (previous) await Nodes.primaryStore.put(peer, previous);
				else await Nodes.primaryStore.remove(peer);
			}
		});

	it('copies an owner blob and a non-owner replica projection in the same walk', async () => {
		const priorShards = server.shards;
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'third-slot-owner', replicates: true }];
		const priorList = env.get('replication_shards');
		env.setProperty('replication_shards', [0, 1]);
		server.shards = new Map([
			[0, [{ name: server.hostname }, { name: 'slot-control-peer' }]],
			[1, [{ name: 'third-slot-owner' }]],
		]);
		try {
			let Blobs;
			const { socket } = await connect(
				false,
				'mixed_blob_copy',
				false,
				undefined,
				(database) => {
					Blobs = table({
						database,
						table: 'Blobs',
						audit: true,
						replicaExpiration: 3600,
						residency: { slots: 2, slotFrom: 'id.length % 2' },
						attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag', indexed: true }, { name: 'body' }],
					});
					setReplicator(database, Blobs, {});
				},
				undefined,
				[
					{ start: 0, end: 1, shard: 0 },
					{ start: 1, end: 2, shard: 1 },
				]
			);
			await Blobs.put('a', { id: 'a', tag: 'projected', body: createBlob(Buffer.alloc(32768, 11)) });
			const ownerPayload = Buffer.alloc(32768, 29);
			await Blobs.put('bb', { id: 'bb', tag: 'owned', body: createBlob(ownerPayload), extra: { shape: 'new' } });
			socket.emit(
				'message',
				encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
			);
			await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			await until(() => !hasActiveBlobSends());
			const copied = entries(socket);
			const projection = copied.find((entry) => entry.recordId === 'a');
			assert.equal(projection?.type, 'invalidate');
			assert.equal(projection.getValue(Blobs.primaryStore).tag, 'projected');
			assert.equal(projection.getValue(Blobs.primaryStore).body, undefined);
			const owner = copied.find((entry) => entry.recordId === 'bb');
			assert.ok(Blobs.primaryStore.getEntry('bb').metadataFlags & FULL_WRITE_HEAD);
			assert.equal(owner.extendedType & FULL_WRITE_HEAD, 0, 'primary full-write metadata is not a copied audit flag');
			assert.equal(owner?.type, 'put');
			const value = owner.getValue(Blobs.primaryStore);
			assert.deepEqual(value.extra, { shape: 'new' });
			const chunks = socket.sent.filter((frame) => frame[0] === 146);
			assert.ok(chunks.length > 0);
			assert.ok(
				chunks.every((frame) => frame[1].fileId === getFileId(value.body)),
				'only the owner body starts a transfer, including audit catch-up'
			);
			const transfer = chunks.filter((frame) => frame[1].transferId === value.body.replicationTransferId);
			assert.ok(transfer.some((frame) => frame[1].finished));
			const bytes = Buffer.concat(transfer.map((frame) => frame[2]));
			assert.deepEqual(transfer[0][1].codec === 'deflate' ? inflateSync(bytes) : bytes, ownerPayload);
		} finally {
			server.shards = priorShards;
			server.nodes = priorNodes;
			env.setProperty('replication_shards', priorList);
		}
	});

	for (const indexed of [false, true])
		for (const owner of [false, true])
			for (const slotsCapable of [false, true])
				it(`copies blob bytes only to owners (indexed=${indexed}, owner=${owner}, slots=${slotsCapable})`, async () => {
					let Blobs;
					const { socket } = await connect(
						false,
						`blob_copy_${indexed}_${owner}_${slotsCapable}`,
						false,
						{
							...buildLocalCapabilities(90_000, false, true),
							residencySlots: slotsCapable ? 1 : 0,
						},
						(database) => {
							Blobs = table({
								database,
								table: 'Blobs',
								audit: true,
								residency: { slots: 2, slotFrom: '0' },
								attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag', indexed }, { name: 'body' }],
							});
							setReplicator(database, Blobs, {});
						}
					);
					const payload = Buffer.alloc(32768, 73);
					await Blobs.put('blob', { id: 'blob', tag: 'projected', body: createBlob(payload) });
					const prior = server.shards;
					if (owner) server.shards = new Map([[0, [{ name: server.hostname }, { name: 'slot-control-peer' }]]]);
					try {
						socket.emit(
							'message',
							encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
						);
						await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
						assert.deepEqual(socket.closes, []);
						await until(() => !hasActiveBlobSends());
						const chunks = socket.sent.filter((frame) => frame[0] === 146);
						const copied = entries(socket).find((entry) => entry.recordId === 'blob');
						if (owner) {
							assert.equal(copied?.type, 'put');
							const transferId = copied.getValue(Blobs.primaryStore).body.replicationTransferId;
							const transfer = chunks.filter((frame) => frame[1].transferId === transferId);
							assert.ok(transfer.some((frame) => frame[1].finished));
							const bytes = Buffer.concat(transfer.map((frame) => frame[2]));
							assert.deepEqual(transfer[0][1].codec === 'deflate' ? inflateSync(bytes) : bytes, payload);
						} else {
							assert.equal(chunks.length, 0, 'a projection or omitted row must not leave an unclaimed blob transfer');
							if (indexed) {
								assert.equal(copied?.type, 'invalidate');
								assert.equal(copied.getValue(Blobs.primaryStore).tag, 'projected');
								assert.equal(copied.getValue(Blobs.primaryStore).body, undefined);
							} else assert.equal(copied, undefined);
						}
					} finally {
						server.shards = prior;
					}
				});

	for (const closeNewest of [false, true])
		it(`keeps an eligible sending route when overlapping sockets close (newest=${closeNewest})`, async () => {
			const priorNodes = server.nodes;
			server.nodes = [{ name: 'slot-control-peer', replicates: true }];
			try {
				const first = await connect(false, `sender_liveness_${closeNewest}`);
				for (const socket of [first.socket]) {
					socket.emit(
						'message',
						encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
					);
					await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
					assert.deepEqual(socket.closes, []);
				}
				assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
				const state = new BigUint64Array(
					first.Records.auditStore.getUserSharedBuffer(
						['residency-sending', first.database, 'slot-control-peer'],
						new ArrayBuffer(16)
					)
				);
				Atomics.store(
					state,
					1,
					(Atomics.load(state, 1) & 0xffffffff00000000n) | BigInt((Date.now() - PING_TIMEOUT - 1) >>> 0)
				);
				assert.throws(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']), /connected/);
				first.socket.emit('pong');
				assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
				const second = await connect(false, `sender_liveness_${closeNewest}`);
				second.socket.emit(
					'message',
					encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
				);
				await until(() => second.socket.sent.some((frame) => frame[0] === 149) || second.socket.closes.length);
				assert.deepEqual(second.socket.closes, []);
				if (closeNewest) {
					second.socket.close();
					first.socket.emit('pong');
					assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
					first.socket.close();
				} else {
					first.socket.close();
					assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
					second.socket.close();
				}
				assert.throws(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']), /connected/);
			} finally {
				server.nodes = priorNodes;
			}
		});

	it('publishes a replacement sender heartbeat atomically with its generation', async () => {
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-control-peer', replicates: true }];
		let first, replacement;
		const store = Atomics.store;
		try {
			const { Records, database } = await connect(false, 'atomic_sender');
			first = registerResidencySender(Records.auditStore, database, 'slot-control-peer');
			assert.doesNotThrow(() => requireConnectedResidencyOwner(database, ['slot-control-peer']));
			let observed = false;
			Atomics.store = (state, index, value) => {
				const result = store(state, index, value);
				if (index === 1 && !observed) {
					observed = true;
					assert.throws(() => requireConnectedResidencyOwner(database, ['slot-control-peer']), /connected/);
				}
				return result;
			};
			replacement = registerResidencySender(
				Records.auditStore,
				database,
				'slot-control-peer',
				Date.now() - PING_TIMEOUT - 1
			);
			assert.equal(observed, true, 'observed the replacement publication');
		} finally {
			Atomics.store = store;
			replacement?.close();
			first?.close();
			server.nodes = priorNodes;
		}
	});

	it('does not replace sender liveness when a superseded setup wait resumes', async () => {
		let resume, subscription;
		const gate = new Promise((resolve) => {
			resume = resolve;
		});
		const connection = new EventEmitter();
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-control-peer', replicates: true }];
		const first = await connect(
			false,
			'superseded_sender',
			false,
			undefined,
			(database) => {
				subscription = databaseSubscriptions.get(database);
				databaseSubscriptions.set(database, gate);
			},
			connection
		);
		try {
			const subscribe = (socket) =>
				socket.emit(
					'message',
					encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
				);
			subscribe(first.socket);
			for (let n = 0; n < 30; n++) await new Promise(setImmediate);
			databaseSubscriptions.set(first.database, subscription);
			const second = await connect(false, 'superseded_sender', false, undefined, undefined, connection);
			subscribe(second.socket);
			await until(() => second.socket.sent.some((frame) => frame[0] === 149) || second.socket.closes.length);
			assert.deepEqual(second.socket.closes, []);
			assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
			resume(subscription);
			for (let n = 0; n < 30; n++) await new Promise(setImmediate);
			first.socket.close();
			assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
			second.socket.close();
			assert.throws(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']), /connected/);
		} finally {
			resume(subscription);
			databaseSubscriptions.set(first.database, subscription);
			server.nodes = priorNodes;
		}
	});

	it('does not publish a placement failure after a closed subscription wait resumes', async () => {
		let resume, subscription;
		const gate = new Promise((resolve) => {
			resume = resolve;
		});
		const { Records, socket, database } = await connect(true, 'closed_receive', false, undefined, (database) => {
			subscription = databaseSubscriptions.get(database);
			databaseSubscriptions.set(database, gate);
		});
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-control-peer' }];
		try {
			const encoder = Records.primaryStore.encoder;
			socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
			socket.emit(
				'message',
				encode([
					132,
					{
						structures: encoder.structures,
						typedStructs: encoder.typedStructs,
						attributes: Records.attributes,
						schemaDefined: true,
						residency: Records.residency,
					},
					Records.tableId,
					Records.tableName,
				])
			);
			socket.emit(
				'message',
				recordFrame(Records, 'put', 'late', { id: 'late', region: 99, body: 'invalid' }, Date.now())
			);
			await until(() => socket.paused || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			socket.close();
			resume(subscription);
			for (let n = 0; n < 30; n++) await new Promise(setImmediate);
			assert.deepEqual(residencyTopologyErrors(database), [], 'a closed socket cannot block its replacement');
		} finally {
			resume(subscription);
			databaseSubscriptions.set(database, subscription);
			server.nodes = priorNodes;
		}
	});

	it('sends index invalidations to a known peer without a shard', async () => {
		const { Records, socket, database } = await connect(false, 'unsharded');
		socket.emit(
			'message',
			encode([
				140,
				'slot-control-peer',
				database,
				[],
				buildLocalCapabilities(90_000, true, true),
				{ shardsDigest: getResidencyConfiguration().digest, shard: null },
			])
		);
		const Nodes = getHDBNodeTable();
		const name = 'slot-control-peer';
		const previous = Nodes.primaryStore.getSync(name);
		const known = server.shards;
		await Nodes.primaryStore.put(name, { name, url: 'http://127.0.0.1:19001', replicates: true });
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		try {
			socket.emit('message', encode([129, [{ name, startTime: 0, tables: [], replicateByDefault: true }], []]));
			await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
			await Records.put('unsharded-reader', { id: 'unsharded-reader', region: 0, body: 'complete' });
			await until(() => socket.closes.length || entries(socket).some((entry) => entry.recordId === 'unsharded-reader'));
			assert.deepEqual(socket.closes, []);
			assert.equal(entries(socket).find((entry) => entry.recordId === 'unsharded-reader')?.type, 'invalidate');
		} finally {
			if (previous) await Nodes.primaryStore.put(name, previous);
			else await Nodes.primaryStore.remove(name);
			server.shards = known;
		}
	});

	it('uses a legacy unsharded peer self-announcement without trusting tentative rows', async () => {
		const { Records, socket } = await connect(false, 'legacy_unsharded', false, {
			...buildLocalCapabilities(90_000, true, true),
			residencySlots: undefined,
		});
		const Nodes = getHDBNodeTable();
		const name = 'slot-control-peer';
		const previous = Nodes.primaryStore.getSync(name);
		const known = server.shards;
		const context = {};
		await transaction(context, async () => {
			const resource = await Nodes.getResource(name, context);
			resource._writeUpdate(name, { name, url: 'http://127.0.0.1:19001', replicates: true }, true, {
				isNotification: true,
				nodeId: getIdOfRemoteNode(name, Nodes.auditStore),
			});
			await resource.save();
		});
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		try {
			socket.emit('message', encode([129, [{ name, startTime: 0, tables: [], replicateByDefault: true }], []]));
			await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
			await Records.put('unsharded-reader', { id: 'unsharded-reader', region: 0, body: 'complete' });
			await until(() => socket.closes.length || entries(socket).some((entry) => entry.recordId === 'unsharded-reader'));
			assert.deepEqual(socket.closes, []);
			assert.equal(entries(socket).find((entry) => entry.recordId === 'unsharded-reader')?.type, 'invalidate');
		} finally {
			if (previous) await Nodes.primaryStore.put(name, previous);
			else await Nodes.primaryStore.remove(name);
			server.shards = known;
		}
	});

	it('does not treat a tentative url-only peer row as an unsharded reader', async () => {
		const { Records, socket } = await connect(false, 'tentative');
		const Nodes = getHDBNodeTable();
		const name = 'slot-control-peer';
		const previous = Nodes.primaryStore.getSync(name);
		const known = server.shards;
		await Nodes.primaryStore.put(name, { name, url: 'http://127.0.0.1:19001', replicates: true });
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		try {
			socket.emit('message', encode([129, [{ name, startTime: 0, tables: [], replicateByDefault: true }], []]));
			await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
			await Records.put('tentative-owner', { id: 'tentative-owner', region: 0, body: 'complete' });
			await until(() => socket.closes.length || entries(socket).some((entry) => entry.recordId === 'tentative-owner'));
			assert.ok(socket.closes.length, 'a tentative row does not prove non-ownership');
			assert.ok(!entries(socket).some((entry) => entry.recordId === 'tentative-owner'));
		} finally {
			if (previous) await Nodes.primaryStore.put(name, previous);
			else await Nodes.primaryStore.remove(name);
			server.shards = known;
		}
	});

	it('holds record delivery when the receiver shard is not known', async () => {
		const { Records, socket } = await connect(false, 'unknown');
		socket.emit(
			'message',
			encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
		);
		await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
		const known = server.shards;
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		try {
			await Records.put('unknown-owner', { id: 'unknown-owner', region: 0, body: 'complete' });
			await until(() => socket.closes.length || entries(socket).some((entry) => entry.recordId === 'unknown-owner'));
			assert.ok(socket.closes.length, 'unknown membership must hold the stream');
			assert.ok(!entries(socket).some((entry) => entry.recordId === 'unknown-owner'));
		} finally {
			server.shards = known;
		}
	});

	it('sends a newer map before a reference using its version on an active stream', async () => {
		const { Records, socket, database } = await connect(false, 'extension');
		socket.emit(
			'message',
			encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
		);
		await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
		await Records.put('before', { id: 'before', region: 0, body: 'complete' });
		await until(() => entries(socket).some((entry) => entry.recordId === 'before'));
		const from = socket.sent.length;
		const extended = createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 0 }], 2);
		await installResidencyMap(extended);
		await Records.put('after', { id: 'after', region: 0, body: 'complete' });
		await until(() => entries(socket).some((entry) => entry.recordId === 'after') || socket.closes.length);
		assert.deepEqual(socket.closes, []);
		const frames = socket.sent.slice(from);
		const snapshot = frames.findIndex((frame) => frame[0] === 145 && frame[5]?.snapshot?.digest === extended.digest);
		const reference = frames.findIndex((frame) => frame[0] === 130 && frame[1]?.mapDigest === extended.digest);
		assert.ok(snapshot >= 0 && snapshot < reference, 'new snapshot must precede its reference');
	});

	for (const byAttribute of [false, true]) {
		it(`sends control and root-topic events without a record slot (byAttribute=${byAttribute})`, async () => {
			const { Records, socket, database } = await connect(byAttribute, 'send');
			socket.emit(
				'message',
				encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
			);
			await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			await writeLockBarrier(database, Records.tableName, 17);
			await until(() => entries(socket).some((entry) => entry.type === 'lockBarrier') || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			const barrier = entries(socket).find((entry) => entry.type === 'lockBarrier');
			assert.equal(barrier.recordId, null);
			assert.equal(barrier.residencyId, undefined);
			assert.equal(barrier.residencySlot, undefined);
			await Records.publish(null, { event: 'notice' });
			await until(() => entries(socket).some((entry) => entry.type === 'message') || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			const event = entries(socket).find((entry) => entry.type === 'message');
			assert.equal(event.recordId, null);
			assert.equal(event.residencyId, undefined);
			await Records.put('published', { id: 'published', region: 0, body: 'complete' });
			await Records.publish('published', { event: 'record-notice' });
			await until(() => entries(socket).some((entry) => entry.type === 'message' && entry.recordId === 'published'));
			const recordEvent = entries(socket).find((entry) => entry.type === 'message' && entry.recordId === 'published');
			assert.equal(recordEvent.residencySlot, undefined);
			assert.equal(recordEvent.previousResidencySlot, undefined);
			assert.equal(recordEvent.residencyId, undefined);
		});
		it(`receives control traffic before the next record (byAttribute=${byAttribute})`, async () => {
			const { Records, socket } = await connect(byAttribute, 'receive');
			const version = Date.now();
			const frames = [
				recordFrame(Records, 'lockBarrier', null, [1, 18], version),
				recordFrame(Records, 'message', 'notice', { event: 'notice' }, version + 1),
				recordFrame(Records, 'put', 'after-control', { id: 'after-control', region: 0, body: 'complete' }, version + 2),
			];
			const encoder = Records.primaryStore.encoder;
			socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
			socket.emit(
				'message',
				encode([
					132,
					{
						structures: encoder.structures,
						typedStructs: encoder.typedStructs,
						attributes: Records.attributes,
						schemaDefined: true,
						residency: Records.residency,
					},
					Records.tableId,
					Records.tableName,
				])
			);
			for (const frame of frames) socket.emit('message', frame);
			await until(() => Records.primaryStore.getEntry('after-control')?.value || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			assert.equal(Records.primaryStore.getEntry('after-control').value.body, 'complete');
		});
	}

	it('reads no shard map per received frame for a database without sharded tables', async () => {
		const database = 'slot_control_unsharded';
		const Plain = table({
			database,
			table: 'Plain',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
		});
		const Idle = table({ database, table: 'Idle', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
		setReplicator(database, Plain, {});
		await until(() => databaseSubscriptions.get(database)?.auditStore);
		const socket = new Socket();
		sockets.push(socket);
		replicateOverWS(socket, {}, { name: 'slot-control-peer', replicates: true });
		socket.emit(
			'message',
			encode([
				140,
				'slot-control-peer',
				database,
				[],
				buildLocalCapabilities(90_000, true, true),
				{ shardsDigest: getResidencyConfiguration().digest },
			])
		);
		await until(() => socket.sent.some((frame) => frame[0] === 140) || socket.closes.length);
		const version = Date.now();
		const frames = Array.from({ length: 20 }, (_, n) =>
			recordFrame(Plain, 'put', 'row-' + n, { id: 'row-' + n, body: 'x' }, version + n)
		);
		const encoder = Plain.primaryStore.encoder;
		socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
		socket.emit(
			'message',
			encode([
				132,
				{ structures: encoder.structures, typedStructs: encoder.typedStructs, attributes: Plain.attributes },
				Plain.tableId,
				Plain.tableName,
			])
		);
		const store = getResidencyMapTable().primaryStore;
		const getSync = store.getSync;
		let mapReads = 0;
		store.getSync = function (key, ...rest) {
			if (key === database) mapReads++;
			return getSync.call(this, key, ...rest);
		};
		// After setup, only a per-frame declaration scan would read a table that receives no records.
		let idleScans = 0;
		Object.defineProperty(Idle, 'residency', {
			configurable: true,
			get() {
				idleScans++;
				return undefined;
			},
		});
		try {
			socket.emit('message', frames[0]);
			await until(() => Plain.primaryStore.getEntry('row-0')?.value || socket.closes.length);
			idleScans = 0;
			for (const frame of frames.slice(1)) socket.emit('message', frame);
			await until(() => Plain.primaryStore.getEntry('row-19')?.value || socket.closes.length);
		} finally {
			store.getSync = getSync;
			delete Idle.residency;
		}
		assert.deepEqual(socket.closes, []);
		assert.equal(mapReads, 0);
		assert.equal(idleScans, 0, 'the declaration verdict is cached across frames');
	});

	it('skips an invalidation of a refused table generation without holding the stream', async () => {
		const { Records, socket, database } = await connect(false, 'refused_generation_invalidate');
		const Gone = table({ database, table: 'Gone', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const createdTime = Date.now() - 60_000;
		await Gone.dropTable();
		assert.ok(isDroppedPeerGeneration(database, 'Gone', createdTime), 'premise: the peer generation is dead');
		const version = Date.now() + 100;
		const refused = recordFrame(Records, 'invalidate', 'gone', { id: 'gone' }, version, undefined, { tableId: 777 });
		const after = recordFrame(
			Records,
			'put',
			'after-refused',
			{ id: 'after-refused', region: 0, body: 'complete' },
			version + 1
		);
		const encoder = Records.primaryStore.encoder;
		socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
		socket.emit(
			'message',
			encode([
				132,
				{
					structures: encoder.structures,
					typedStructs: encoder.typedStructs,
					attributes: Records.attributes,
					residency: Records.residency,
					schemaDefined: true,
				},
				Records.tableId,
				Records.tableName,
			])
		);
		socket.emit(
			'message',
			encode([132, { structures: [], attributes: [{ name: 'id', isPrimaryKey: true }], createdTime }, 777, 'Gone'])
		);
		socket.emit('message', refused);
		socket.emit('message', after);
		await until(() => Records.primaryStore.getEntry('after-refused')?.value || socket.closes.length);
		assert.deepEqual(socket.closes, []);
	});

	it('copies again after an empty owned copy is interrupted before certification', async () => {
		const peer = 'slot-control-peer';
		const Nodes = getHDBNodeTable();
		const previous = Nodes.primaryStore.getSync(peer);
		const connection = new EventEmitter();
		connection.nodeSubscriptions = [{ name: peer, replicateByDefault: true }];
		const { Records, socket, database } = await connect(
			false,
			'empty_owned_copy_restart',
			false,
			undefined,
			undefined,
			connection
		);
		const announce = (target) =>
			target.emit(
				'message',
				encode([
					140,
					peer,
					database,
					[],
					buildLocalCapabilities(90_000, true, true),
					{
						shardsDigest: getResidencyConfiguration().digest,
						shard: 0,
						shardingCertificate: shardingSourceAgreement(database),
					},
				])
			);
		const subscription = databaseSubscriptions.get(database);
		const send = subscription.send;
		const root = Records.auditStore.rootStore;
		const flush = root.flush;
		const commits = [];
		let releaseFlush, flushStarted, completion;
		const gate = new Promise((resolve) => {
			releaseFlush = resolve;
		});
		const reached = new Promise((resolve) => {
			flushStarted = resolve;
		});
		try {
			await Nodes.primaryStore.put(peer, { name: peer, shard: 0, replicates: true });
			announce(socket);
			subscription.send = function (event) {
				if (event.type === 'end_txn' && event.remoteNodeIds?.length === 0 && event.onCommit) commits.push(event);
				else return send.call(this, event);
			};
			const anchor = Date.now();
			socket.emit('message', encode([148, anchor, 1]));
			socket.emit('message', encode([149]));
			await until(() => commits.length === 1 || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			// The empty copy's sequence anchor is committed; no copied key staged a copy cursor.
			const peerId = getIdOfRemoteNode(peer, Records.auditStore);
			await Records.dbisDB.put([Symbol.for('seq'), peerId], { seqId: anchor, nodes: [] });
			assert.equal(Records.dbisDB.getSync([Symbol.for('copyCursor'), peerId]), undefined);
			root.flush = async function (...args) {
				flushStarted();
				await gate;
				return flush.apply(this, args);
			};
			completion = commits[0].onCommit();
			await Promise.race([
				reached,
				new Promise((_, reject) => setTimeout(() => reject(new Error('copy flush not reached')), 5000).unref()),
			]);
			socket.close(1006);
			releaseFlush();
			await completion;
			root.flush = flush;
			assert.equal(shardingCertificate(database), undefined, 'premise: the interrupted copy is uncertified');

			subscription.send = send;
			const retry = new Socket();
			sockets.push(retry);
			const reconnection = new EventEmitter();
			reconnection.nodeSubscriptions = [{ name: peer, replicateByDefault: true }];
			reconnection.socket = retry;
			replicateOverWS(retry, { connection: reconnection }, { name: peer, replicates: true });
			announce(retry);
			await until(() => retry.sent.some((frame) => frame[0] === 129) || retry.closes.length);
			assert.deepEqual(retry.closes, []);
			assert.equal(
				retry.sent.findLast((frame) => frame[0] === 129)[1][0].startTime,
				0,
				'the uncertified owned copy is requested again'
			);
		} finally {
			releaseFlush();
			await completion;
			root.flush = flush;
			subscription.send = send;
			if (previous) await Nodes.primaryStore.put(peer, previous);
			else await Nodes.primaryStore.remove(peer);
		}
	});
});
