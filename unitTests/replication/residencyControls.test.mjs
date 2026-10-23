import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import * as env from '#src/core/utility/environment/environmentManager';
import { server } from '#src/core/server/Server';
import { table } from '#src/core/resources/databases';
import { createAuditEntry, readAuditEntry, Decoder } from '#src/core/resources/auditStore';
import { writeLockBarrier } from '#src/core/resources/recordLockCoordinator';
import { initializeResidencySlots, getResidencyConfiguration } from '#src/core/resources/residencyMaps';
import { setReplicator } from '#src/replication/replicator';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
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
function recordFrame(Table, type, recordId, value, version) {
	const frame = new FrameWriter();
	frame.writeFloat64(version);
	const entry = Buffer.from(
		createAuditEntry({
			type,
			tableId: Table.tableId,
			recordId,
			version,
			previousVersion: null,
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
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
	});
	afterEach(() => {
		while (sockets.length) sockets.pop().close();
	});
	after(() => {
		server.shards = oldShards;
		env.setProperty('replication_shards', oldList);
		env.setProperty('replication_shard', oldShard);
	});
	async function connect(byAttribute, direction) {
		const database = `slot_control_${direction}_${byAttribute}`;
		await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
		const Records = table({
			database,
			table: 'Records',
			audit: true,
			residency: { slots: 2, byAttribute, slotFrom: byAttribute ? 'region' : 'id.length % 2' },
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'region', indexed: true }, { name: 'body' }],
		});
		setReplicator(database, Records, {});
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
		assert.deepEqual(socket.closes, []);
		return { Records, socket, database };
	}
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
