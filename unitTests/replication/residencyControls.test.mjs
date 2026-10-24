import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import * as env from '#src/core/utility/environment/environmentManager';
import { server } from '#src/core/server/Server';
import { transaction } from '#src/core/resources/transaction';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { INVALIDATED } from '#src/core/resources/Table';
import { table } from '#src/core/resources/databases';
import { createAuditEntry, readAuditEntry, Decoder } from '#src/core/resources/auditStore';
import { writeLockBarrier } from '#src/core/resources/recordLockCoordinator';
import {
	initializeResidencySlots,
	getResidencyConfiguration,
	requireConnectedResidencyOwner,
} from '#src/core/resources/residencyMaps';
import { setReplicator } from '#src/replication/replicator';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { getHDBNodeTable } from '#src/replication/knownNodes';
import { residencyTopologyErrors } from '#src/replication/residencyTopology';
import { FrameWriter } from '#src/replication/frameWriter';

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
			extendedType: residencyId ? 512 : undefined,
			nodeId: 0,
			encodedRecord: type === 'lockBarrier' ? encode(value) : Buffer.from(Table.primaryStore.encoder.encode(value)),
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

describe('Declarative tables keep control and event traffic independent of placement', function () {
	this.timeout(15_000);
	let oldShards, oldList, oldShard;
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
		connection
	) {
		const database = `slot_control_${direction}_${byAttribute}`;
		await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
		const Records = table({
			database,
			table: 'Records',
			audit: true,
			residency: legacy ? undefined : { slots: 2, byAttribute, slotFrom: byAttribute ? 'region' : 'id.length % 2' },
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'region', indexed: true }, { name: 'body' }],
		});
		setReplicator(database, Records, {});
		await until(() => databaseSubscriptions.get(database)?.auditStore);
		beforeConnect?.(database);
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
	for (const byAttribute of [false, true])
		for (const stubCapable of [false, true])
			it(`copies declarative stubs safely (attribute=${byAttribute}, stub capability=${stubCapable})`, async () => {
				const capabilities = { ...buildLocalCapabilities(90_000, false, true), residencyStubCopy: stubCapable ? 1 : 0 };
				const { Records, socket } = await connect(byAttribute, `copy_${stubCapable}`, false, capabilities);
				const context = {};
				await transaction(context, async () => {
					const row = await Records.getResource('stub', context, { ensureLoaded: false });
					row._writeInvalidate('stub', { id: 'stub', region: 0 }, { residencySlot: byAttribute ? 0 : undefined });
				});
				assert.ok(Records.primaryStore.getEntry('stub').metadataFlags & INVALIDATED);
				Records.setTTLExpiration(3600);
				await Records.put('full', { id: 'full', region: 0, body: 'canonical' });
				const prior = server.shards;
				server.shards = new Map([[0, [{ name: server.hostname }, { name: 'slot-control-peer' }]]]);
				try {
					socket.emit(
						'message',
						encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
					);
					await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
					assert.deepEqual(socket.closes, []);
					const copied = entries(socket);
					const stub = copied.find((entry) => entry.recordId === 'stub');
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
				const state = new Uint32Array(
					first.Records.auditStore.getUserSharedBuffer(
						['residency-sending', first.database, 'slot-control-peer'],
						new ArrayBuffer(12)
					)
				);
				Atomics.store(state, 2, Math.floor(Date.now() / 1000) - 3600);
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

	it('sends an extended map before a reference using its new version on an active stream', async () => {
		const { Records, socket, database } = await connect(false, 'extension');
		socket.emit(
			'message',
			encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
		);
		await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
		await Records.put('before', { id: 'before', region: 0, body: 'complete' });
		await until(() => entries(socket).some((entry) => entry.recordId === 'before'));
		const from = socket.sent.length;
		const extended = await initializeResidencySlots({ database, slots: 4, ranges: [{ start: 0, end: 4, shard: 0 }] });
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
});
