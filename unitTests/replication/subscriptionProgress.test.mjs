import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import { table } from '#src/core/resources/databases';
import { server } from '#src/core/server/Server';
import { transaction } from '#src/core/resources/transaction';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { Decoder, readAuditEntry } from '#src/core/resources/auditStore';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';

const SUBSCRIPTION_REQUEST = 129;
const NODE_NAME = 140;
const SEQUENCE_ID_UPDATE = 143;
const database = 'subscriptionProgress';

class Socket extends EventEmitter {
	readyState = 1;
	sent = [];
	_socket = Object.assign(new EventEmitter(), { bytesRead: 0, bytesWritten: 0, writableNeedDrain: false });
	send(data) {
		this.sent.push(data[0] > 127 ? decode(Buffer.from(data)) : Buffer.from(data));
	}
	close(code = 1000, reason = '') {
		if (this.readyState === 3) return;
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

async function until(predicate, description) {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, description);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function rows(socket) {
	const ids = [];
	for (const frame of socket.sent) {
		if (!Buffer.isBuffer(frame)) continue;
		const decoder = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
		decoder.position = 8;
		while (decoder.position < frame.length) {
			const length = decoder.readInt();
			const offset = decoder.position;
			decoder.position += length;
			if (length === 9 && frame[offset] === 11) continue;
			ids.push(readAuditEntry(frame, offset, offset + length).recordId);
		}
	}
	return ids;
}

describe('subscription replay progress', function () {
	this.timeout(20_000);
	let Records, Skipped, socket, start;
	before(async () => {
		Records = table({ database, table: 'Records', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
		Skipped = table({ database, table: 'Skipped', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
		await Records.put('seed', { id: 'seed' });
		setReplicator(database, Records, {});
		setReplicator(database, Skipped, {});
		await until(() => databaseSubscriptions.get(database)?.auditStore, 'database subscription');
		for (const entry of Records.auditStore.getRange({ start: 1, log: 'local' }))
			if (entry.recordId === 'seed') start = entry.txnLogKey;
		assert.ok(start > 0, 'seed must have a native audit key');
		await Skipped.put('skip', { id: 'skip' });
		await transaction({}, async () => {
			await Records.put('buffered', { id: 'buffered' });
			await Records.put('same-transaction', { id: 'same-transaction' });
		});
	});
	afterEach(() => socket?.close());

	it('never advances past a buffered row when a subscription is replaced', async () => {
		socket = new Socket();
		replicateOverWS(socket, {}, { name: 'progress-peer', replicates: true });
		socket.emit(
			'message',
			encode([NODE_NAME, 'progress-peer', database, [], buildLocalCapabilities(90_000, false, true)])
		);
		await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME), 'handshake');
		const subscribe = () =>
			socket.emit(
				'message',
				encode([
					SUBSCRIPTION_REQUEST,
					[{ name: server.hostname, startTime: start, tables: ['Records'], replicateByDefault: false }],
					[],
				])
			);
		socket._socket.writableNeedDrain = true;
		subscribe();
		await until(() => socket._socket.listenerCount('drain') > 0, 'a real row encoded before socket drain');
		assert.ok(!rows(socket).includes('buffered'));
		socket.emit('message', encode([SUBSCRIPTION_REQUEST, [], []]));
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(
			socket.sent.filter((frame) => frame[0] === SEQUENCE_ID_UPDATE && frame[1] > start).length,
			0,
			'an obsolete subscription must not certify the undelivered row'
		);
		socket._socket.writableNeedDrain = false;
		socket._socket.emit('drain');
		subscribe();
		await until(
			() => ['buffered', 'same-transaction'].every((id) => rows(socket).includes(id)),
			'replacement replays both rows of the transaction'
		);
	});
	it('does not complete an obsolete copy after its final row drains', async () => {
		const copyDatabase = 'subscriptionFinalCopy';
		const One = table({
			database: copyDatabase,
			table: 'One',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await One.put('only-row', { id: 'only-row' });
		setReplicator(copyDatabase, One, {});
		await until(() => databaseSubscriptions.get(copyDatabase)?.auditStore, 'copy subscription');
		socket = new Socket();
		replicateOverWS(socket, {}, { name: 'progress-peer', replicates: true });
		socket.emit(
			'message',
			encode([NODE_NAME, 'progress-peer', copyDatabase, [], buildLocalCapabilities(90_000, false, true)])
		);
		await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME), 'copy handshake');
		const subscribe = () =>
			socket.emit(
				'message',
				encode([
					SUBSCRIPTION_REQUEST,
					[{ name: server.hostname, startTime: 0, tables: [], replicateByDefault: true }],
					[],
				])
			);
		socket._socket.writableNeedDrain = true;
		subscribe();
		await until(() => socket._socket.listenerCount('drain') > 0, 'last copy row encoded before drain');
		assert.ok(
			socket.sent.some((frame) => frame[0] === 148),
			'copy started'
		);
		assert.ok(!rows(socket).includes('only-row'), 'last copy row remains buffered');
		socket.emit('message', encode([SUBSCRIPTION_REQUEST, [], []]));
		await new Promise((resolve) => setTimeout(resolve, 20));
		socket._socket.writableNeedDrain = false;
		socket._socket.emit('drain');
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.ok(!socket.sent.some((frame) => frame[0] === 149), 'cancelled copy cannot publish COPY_COMPLETE');
		assert.ok(!socket.sent.some((frame) => frame[0] === SEQUENCE_ID_UPDATE), 'cancelled copy cannot publish progress');
		subscribe();
		await until(() => socket.sent.some((frame) => frame[0] === 149), 'replacement copy completes');
		assert.ok(rows(socket).includes('only-row'));
	});

	it('routes include updates to the replacement subscription iterator', async () => {
		const origin = 'update-origin';
		const nodeId = getIdOfRemoteNode(origin, Records.auditStore);
		const version = start + 1;
		const context = { source: {}, sourceApply: true, timestamp: version };
		await transaction(context, async () => {
			const row = await Records.getResource('included-row', context);
			return row._writeUpdate('included-row', { id: 'included-row' }, true, { isNotification: true, nodeId, version });
		});
		socket = new Socket();
		replicateOverWS(socket, {}, { name: 'progress-peer', replicates: true });
		socket.emit(
			'message',
			encode([NODE_NAME, 'progress-peer', database, [], buildLocalCapabilities(90_000, false, true)])
		);
		await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME), 'update handshake');
		for (let request = 0; request < 2; request++) {
			socket.emit(
				'message',
				encode([
					SUBSCRIPTION_REQUEST,
					[{ name: server.hostname, startTime: start, tables: ['Records'], replicateByDefault: false }],
					[origin],
				])
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(!rows(socket).includes('included-row'), 'the remote origin begins excluded');
		socket.emit('message', encode([147, { includeNodes: [origin] }]));
		await until(() => rows(socket).includes('included-row'), 'included origin reaches the current iterator');
	});
});
