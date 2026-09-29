/**
 * harper-pro#883: the source is the party that keeps a `replicate: false` table on the node. These
 * drive the real inbound handlers of `replicateOverWS` with a fake socket and a real table declared
 * `@table(replicate: false)`, next to a replicated control table:
 *  - GET_RECORD for the local table is refused with an error frame before anything is read or sent
 *    (no TABLE_FIXED_STRUCTURE precedes it), while the control table is still served;
 *  - the NODE_NAME handshake omits the local table's definition and keeps the control table's;
 *  - a full copy (SUBSCRIPTION_REQUEST at startTime 0 from a peer that declared no table, so its request
 *    excludes nothing) announces and copies the control table only, and opens no blob — the wire is what
 *    is asserted, not a receiver's outcome.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { loadGQLSchema } from '#src/core/resources/graphql';
import { tables } from '#src/core/resources/databases';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';

const SUBSCRIPTION_REQUEST = 129;
const TABLE_FIXED_STRUCTURE = 132;
const GET_RECORD = 133;
const GET_RECORD_RESPONSE = 134;
const NODE_NAME = 140;
const BLOB_CHUNK = 146;
const COPY_START = 148;
const COPY_COMPLETE = 149;
// Above FILE_STORAGE_THRESHOLD (8 KiB): the value is stored as a blob file, so a copy of the row would
// have to stream it.
const BLOB_PAYLOAD = 'stays here '.repeat(2048);
const OPEN = 1;
const CLOSED = 3;

class FakeSocket extends EventEmitter {
	readyState = OPEN;
	sent = [];
	closes = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		// A command frame is a msgpack array (first byte > 127); a record frame opens with a float64 key.
		this.sent.push(data[0] > 127 ? decode(data) : { recordFrame: data.length });
	}
	close(code, reason) {
		this.closes.push(code);
		if (this.readyState === CLOSED) return;
		this.readyState = CLOSED;
		this.emit('close', code, Buffer.from(reason ?? ''));
	}
	terminate() {
		this.close(1006);
	}
	ping() {}
	pause() {}
	resume() {}
}

async function settle(socket, expectedFrames) {
	for (let turn = 0; turn < 100 && socket.sent.length < expectedFrames && !socket.closes.length; turn++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe('replicate: false on the send paths (harper-pro#883)', function () {
	this.timeout(20_000);
	let socket;

	before(async () => {
		setHdbBasePath(process.env.STORAGE_PATH);
		await loadGQLSchema(`
			type ReplicateFalseLocal @table(replicate: false) {
				id: ID @primaryKey
				payload: Blob
			}
			type ReplicateFalseShared @table {
				id: ID @primaryKey
				payload: String
			}
		`);
		await tables.ReplicateFalseLocal.put({ id: 'local', payload: BLOB_PAYLOAD });
		await tables.ReplicateFalseShared.put({ id: 'shared', payload: 'travels' });
	});

	beforeEach(async () => {
		socket = new FakeSocket();
		replicateOverWS(socket, {}, { name: 'peer-a', replicates: true });
		socket.emit('message', encode([NODE_NAME, 'peer-a', 'data', [], {}]));
		await settle(socket, 1);
	});

	afterEach(() => {
		socket.close(1000);
	});

	it('answers the handshake without the non-replicated table definition', () => {
		const [command, , databaseName, tableDefinitions] = socket.sent[0];
		assert.equal(command, NODE_NAME);
		assert.equal(databaseName, 'data');
		const names = tableDefinitions.map((definition) => definition.table);
		assert.ok(names.includes('ReplicateFalseShared'), `control table missing from ${names}`);
		assert.ok(!names.includes('ReplicateFalseLocal'), `non-replicated table leaked in ${names}`);
	});

	it('refuses GET_RECORD for the non-replicated table with an error frame, before any structure or record', async () => {
		const local = tables.ReplicateFalseLocal;
		socket.emit('message', encode([GET_RECORD, 7, local.tableId, 'local', 'ReplicateFalseLocal']));
		await settle(socket, 2);
		const frames = socket.sent.slice(1);
		assert.deepEqual(
			frames.map((frame) => frame[0]),
			[GET_RECORD_RESPONSE],
			`only the refusal may be sent, got ${JSON.stringify(frames.map((frame) => frame[0]))}`
		);
		const [, requestId, entry] = frames[0];
		assert.equal(requestId, 7);
		assert.equal(typeof entry?.error, 'string', `expected an error frame, got ${JSON.stringify(entry)}`);
		assert.match(entry.error, /ReplicateFalseLocal/);
		assert.equal(entry.value, undefined);
		assert.ok(!frames.some((frame) => frame[0] === TABLE_FIXED_STRUCTURE));
	});

	it('answers GET_RECORD for a table this node does not have with an error frame instead of silence', async () => {
		socket.emit('message', encode([GET_RECORD, 9, 4242, 'x', 'ReplicateFalseMissing']));
		await settle(socket, 2);
		const [command, requestId, entry] = socket.sent[1];
		assert.equal(command, GET_RECORD_RESPONSE);
		assert.equal(requestId, 9);
		assert.equal(typeof entry?.error, 'string', `expected an error frame, got ${JSON.stringify(entry)}`);
	});

	it('still serves GET_RECORD for a replicated table', async () => {
		const shared = tables.ReplicateFalseShared;
		socket.emit('message', encode([GET_RECORD, 8, shared.tableId, 'shared', 'ReplicateFalseShared']));
		await settle(socket, 3);
		const response = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE);
		assert.ok(response, 'the control table must be served');
		assert.equal(response[1], 8);
		assert.equal(response[2].error, undefined);
		assert.ok(response[2].value, 'a record value must be returned');
	});
});

describe('replicate: false on the full copy (harper-pro#883)', function () {
	this.timeout(30_000);
	let socket;

	before(async () => {
		// Registers the database's replication subscription on this thread, as `start()` does per table.
		setReplicator('data', tables.ReplicateFalseShared, {});
		for (let turn = 0; turn < 100 && databaseSubscriptions.get('data')?.then; turn++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.ok(databaseSubscriptions.get('data')?.auditStore, 'the data subscription must resolve in-process');
		assert.equal(tables.ReplicateFalseLocal.replicate, false);
	});

	afterEach(() => {
		socket?.close(1000);
	});

	it('copies the replicated table only, announces no other table, and streams no blob', async () => {
		socket = new FakeSocket();
		replicateOverWS(socket, {}, { replicates: true });
		socket.emit('message', encode([NODE_NAME, 'peer-a', 'data', [], {}]));
		await settle(socket, 1);
		// A peer that declared no table excludes nothing: before the fix this request received every table.
		socket.emit(
			'message',
			encode([SUBSCRIPTION_REQUEST, [{ name: 'peer-a', startTime: 0, tables: [], replicateByDefault: true }], []])
		);
		const deadline = Date.now() + 20_000;
		while (!socket.sent.some((frame) => frame[0] === COPY_COMPLETE) && Date.now() < deadline && !socket.closes.length) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const commands = socket.sent.map((frame) => frame[0]);
		assert.ok(commands.includes(COPY_START), `no COPY_START in ${JSON.stringify(commands)}`);
		assert.ok(commands.includes(COPY_COMPLETE), `no COPY_COMPLETE in ${JSON.stringify(commands)}`);
		const announced = socket.sent.filter((frame) => frame[0] === TABLE_FIXED_STRUCTURE).map((frame) => frame[3]);
		assert.ok(announced.includes('ReplicateFalseShared'), `control table not copied: ${announced}`);
		assert.ok(!announced.includes('ReplicateFalseLocal'), `non-replicated table copied: ${announced}`);
		assert.equal(socket.sent.filter((frame) => frame[0] === BLOB_CHUNK).length, 0, 'no blob may be streamed');
		assert.ok(
			socket.sent.some((frame) => frame.recordFrame > 8),
			'the control table row must be on the wire'
		);
	});
});
