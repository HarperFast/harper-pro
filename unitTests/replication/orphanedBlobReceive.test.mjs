/**
 * A fully received blob that no record claims is released once two record frames have settled after it
 * (harper-pro#659), rather than held for `blobTimeout` (900s). Drives the real inbound handlers of
 * `replicateOverWS` over a fake socket against a real audited table.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { table } from '#src/core/resources/databases';
import { createAuditEntry } from '#src/core/resources/auditStore';
import { isBlobReceiveInFlight } from '#src/core/resources/blob';
import { FrameWriter } from '#src/replication/frameWriter';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';

const NODE_NAME = 140;
const NODE_NAME_TO_ID_MAP = 141;
const TABLE_FIXED_STRUCTURE = 132;
const GET_RECORD = 133;
const GET_RECORD_RESPONSE = 134;
const BLOB_CHUNK = 146;
const REMOTE_SEQUENCE_UPDATE = 11;
const PEER = 'orphan-blob-peer';

class FakeSocket extends EventEmitter {
	readyState = 1;
	sent = [];
	closes = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		this.sent.push(data[0] > 127 ? decode(Buffer.from(data)) : Buffer.from(data));
	}
	close(code = 1000) {
		if (this.readyState === 3) return;
		this.closes.push(code);
		this.readyState = 3;
		this.emit('close', code, Buffer.from(''));
	}
	terminate() {
		this.close(1006);
	}
	ping() {}
	pause() {}
	resume() {}
}

async function until(predicate, what) {
	const end = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < end, `timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function recordFrame(Table, recordId, version) {
	const frame = new FrameWriter();
	frame.writeFloat64(version);
	const entry = Buffer.from(
		createAuditEntry({
			type: 'put',
			tableId: Table.tableId,
			recordId,
			version,
			previousVersion: null,
			nodeId: 0,
			encodedRecord: Buffer.from(Table.primaryStore.encoder.encode({ id: recordId, body: 'row' })),
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

describe('orphaned blob receive streams (harper-pro#659)', function () {
	this.timeout(15_000);
	const sockets = [];
	before(() => setHdbBasePath(process.env.STORAGE_PATH));
	afterEach(() => {
		while (sockets.length) sockets.pop().close();
	});

	it('releases a completed blob no record claimed after two record frames settle', async () => {
		const database = 'orphan_blob_receive';
		const Rows = table({
			database,
			table: 'Rows',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
		});
		setReplicator(database, Rows, {});
		await until(() => databaseSubscriptions.get(database)?.auditStore, 'the subscription');

		const socket = new FakeSocket();
		sockets.push(socket);
		replicateOverWS(socket, {}, { name: PEER, replicates: true });
		socket.emit('message', encode([NODE_NAME, PEER, database, [], buildLocalCapabilities(90_000, true, true)]));
		await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME) || socket.closes.length, 'the handshake');
		assert.deepEqual(socket.closes, []);
		socket.emit('message', encode([NODE_NAME_TO_ID_MAP, { [PEER]: 0 }, [PEER]]));
		const encoder = Rows.primaryStore.encoder;
		socket.emit(
			'message',
			encode([
				TABLE_FIXED_STRUCTURE,
				{
					structures: encoder.structures,
					typedStructs: encoder.typedStructs,
					attributes: Rows.attributes,
					schemaDefined: true,
				},
				Rows.tableId,
				Rows.tableName,
			])
		);

		const orphan = 'orphan-659-file';
		socket.emit('message', encode([BLOB_CHUNK, { fileId: orphan, size: 4, finished: true }, Buffer.from('lost')]));
		await until(() => isBlobReceiveInFlight(orphan), 'the orphan to be received');

		// Inbound frames are handled one at a time, so the answer to a record request proves every frame
		// before it has settled.
		const barrier = async (requestId) => {
			socket.emit('message', encode([GET_RECORD, requestId, Rows.tableId, 'absent', Rows.tableName]));
			await until(
				() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === requestId),
				`the ${requestId} barrier`
			);
		};
		const version = Date.now();
		socket.emit('message', recordFrame(Rows, 'first', version));
		await barrier('after-first');
		// Its record could still be in the frame after the one that arrived next, so it is kept.
		assert.equal(isBlobReceiveInFlight(orphan), true, 'one settled frame does not release it');

		socket.emit('message', recordFrame(Rows, 'second', version + 1));
		await barrier('after-second');
		assert.equal(isBlobReceiveInFlight(orphan), false, 'the second settled frame releases it');
		assert.deepEqual(socket.closes, []);
	});
});
