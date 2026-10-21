import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { table } from '#src/core/resources/databases';
import { transaction } from '#src/core/resources/transaction';
import { Decoder, readAuditEntry } from '#src/core/resources/auditStore';
import { INVALIDATED, REPLICA } from '#src/core/resources/Table';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';
import { server } from '#src/core/server/Server';

const SUBSCRIPTION_REQUEST = 129;
const TABLE_FIXED_STRUCTURE = 132;
const GET_RECORD = 133;
const GET_RECORD_RESPONSE = 134;
const NODE_NAME = 140;
const COPY_START = 148;
const COPY_COMPLETE = 149;
const DATABASE = 'residencyReplicaWire';
const PEER = 'residency-replica-peer';

class Socket extends EventEmitter {
	readyState = 1;
	sent = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
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

async function until(predicate, description = 'replication response') {
	const deadline = Date.now() + 15_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, `${description} timed out`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function copiedRecords(socket, tableId) {
	const start = socket.sent.findIndex((frame) => frame[0] === COPY_START);
	const end = socket.sent.findIndex((frame) => frame[0] === COPY_COMPLETE);
	assert.ok(start >= 0 && end > start, 'must exercise the base-copy row walk');
	const records = new Map();
	for (const frame of socket.sent.slice(start + 1, end)) {
		if (!Buffer.isBuffer(frame)) continue;
		const decoder = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
		decoder.position = 8;
		while (decoder.position < frame.length) {
			const length = decoder.readInt();
			const offset = decoder.position;
			decoder.position += length;
			if (length === 9 && frame[offset] === 11) continue;
			const entry = readAuditEntry(frame, offset, offset + length);
			if (entry.tableId === tableId) records.set(entry.recordId, entry);
		}
	}
	return records;
}

describe('local replicas on the replication wire', function () {
	this.timeout(30_000);
	let Records, socket, session, residencyId, stubVersion;

	before(async () => {
		setHdbBasePath(process.env.STORAGE_PATH);
		Records = table({
			database: DATABASE,
			table: 'Records',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
			audit: true,
		});
		Records.setResidency(() => [PEER]);
		await Records.put('full', { id: 'full', name: 'indexed', body: 'complete' });
		residencyId = Records.primaryStore.getEntry('full').residencyId;
		setReplicator(DATABASE, Records, {});
		await until(() => databaseSubscriptions.get(DATABASE)?.auditStore, 'the database subscription');
	});

	async function stub(id) {
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource(id, context, { ensureLoaded: false });
			resource._writeInvalidate(id, { id, name: 'indexed' }, { residencyId });
		});
		const entry = Records.primaryStore.getEntry(id);
		assert.ok(entry.metadataFlags & INVALIDATED);
		return entry;
	}

	beforeEach(async () => {
		socket = new Socket();
		session = replicateOverWS(socket, {}, { name: PEER, replicates: true });
		socket.emit('message', encode([NODE_NAME, PEER, DATABASE, [], buildLocalCapabilities(90_000, false, true)]));
		await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME));
	});

	afterEach(() => socket?.close());

	async function fullRecordFrame() {
		socket.emit('message', encode([GET_RECORD, 11, Records.tableId, 'full', Records.tableName]));
		await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 11));
		const response = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 11)[2];
		assert.equal(response.error, undefined);
		assert.equal(response.originNode, server.hostname, 'a full row names its writer');
		const structure = socket.sent.find((frame) => frame[0] === TABLE_FIXED_STRUCTURE);
		return { response, structure };
	}

	it('keeps a GET_RECORD answer as a replica of the stub, without an audit entry, and keeps the socket open', async () => {
		const existing = await stub('fetched');
		stubVersion = existing.version;
		const history = (await Records.getHistoryOfRecord('fetched')).map((entry) => entry.type);
		const { response, structure } = await fullRecordFrame();
		socket.emit('message', encode([TABLE_FIXED_STRUCTURE, structure[1], Records.tableId, Records.tableName]));
		await new Promise((resolve) => setImmediate(resolve));
		const pending = session.getRecord({ table: Records, id: 'fetched', entry: existing });
		const request = socket.sent.filter((frame) => frame[0] === GET_RECORD).at(-1);
		socket.emit('message', encode([GET_RECORD_RESPONSE, request[1], { ...response, version: stubVersion }]));
		assert.equal((await pending).value.body, 'complete');
		const replica = await until(
			() => Records.primaryStore.getEntry('fetched').metadataFlags & REPLICA,
			'the replica write'
		).then(() => Records.primaryStore.getEntry('fetched'));
		assert.equal(socket.readyState, 1, 'storing the replica must not close the retrieval socket');
		assert.equal(replica.value.body, 'complete');
		assert.equal(replica.residencyId, residencyId);
		assert.equal(replica.version, stubVersion);
		assert.ok(!(replica.metadataFlags & INVALIDATED));
		assert.deepEqual(
			(await Records.getHistoryOfRecord('fetched')).map((entry) => entry.type),
			history,
			'a read must not write a relocation or any other audit entry'
		);
	});

	it('answers GET_RECORD for a replica as not held', async () => {
		assert.ok(Records.primaryStore.getEntry('fetched')?.metadataFlags & REPLICA, 'needs the replica kept above');
		socket.emit('message', encode([GET_RECORD, 12, Records.tableId, 'fetched', Records.tableName]));
		await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 12));
		assert.equal(socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 12)[2], undefined);
	});

	it('copies a replica as a bodyless invalidation with its residency id and no lifetime', async () => {
		const replica = Records.primaryStore.getEntry('fetched');
		assert.ok(replica?.metadataFlags & REPLICA, 'needs the replica kept above');
		assert.equal(replica.expiresAt, undefined, 'the row carries no replica deadline');
		socket.emit(
			'message',
			encode([SUBSCRIPTION_REQUEST, [{ name: PEER, startTime: 0, tables: [], replicateByDefault: true }], []])
		);
		await until(() => socket.sent.some((frame) => frame[0] === COPY_COMPLETE));
		const records = copiedRecords(socket, Records.tableId);
		const copied = records.get('fetched');
		assert.equal(copied?.type, 'invalidate', 'base copy promoted a replica to put');
		assert.equal(copied.residencyId, residencyId);
		const value = copied.getValue(Records.primaryStore);
		assert.equal(value.body, undefined);
		assert.equal(value.name, 'indexed');
		assert.equal(copied.expiresAt, undefined, 'a replica lifetime is never sent as the record expiry');
		assert.equal(records.get('full')?.type, 'put');
	});
});
