/**
 * The sender keeps a `replicate: false` table on its node, asserted on the wire: these drive the real
 * inbound handlers of `replicateOverWS` over a fake socket, against a real `@table(replicate: false)`
 * table beside a replicated control table. A peer that declared no table excludes nothing in its
 * subscription request, which is the case the sender alone has to enforce.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { decode, encode, Packr } from 'msgpackr';
import { createStructon } from 'structon';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { loadGQLSchema } from '#src/core/resources/graphql';
import { tables } from '#src/core/resources/databases';
import { HAS_BLOBS, createAuditEntry } from '#src/core/resources/auditStore';
import { FrameWriter } from '#src/replication/frameWriter';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { databaseSubscriptions, encodeCopyRecordValue, replicateOverWS } from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';

const SUBSCRIPTION_REQUEST = 129;
const TABLE_FIXED_STRUCTURE = 132;
const GET_RECORD = 133;
const GET_RECORD_RESPONSE = 134;
const NODE_NAME = 140;
const NODE_NAME_TO_ID_MAP = 141;
const BLOB_CHUNK = 146;
const REMOTE_SEQUENCE_UPDATE = 11;
const COPY_START = 148;
const COPY_COMPLETE = 149;
// Above FILE_STORAGE_THRESHOLD (8 KiB): the value is stored as a blob file, so a copy of the row would
// have to stream it.
const BLOB_PAYLOAD = 'stays here '.repeat(2048);

const SCHEMA = () => `
	type ReplicateFalseLocal @table(replicate: false) {
		id: ID @primaryKey
		payload: Blob
	}
	type ReplicateFalseShared @table {
		id: ID @primaryKey
		payload: String
	}
`;
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
	let socket, session;

	before(async () => {
		setHdbBasePath(process.env.STORAGE_PATH);
		await loadGQLSchema(SCHEMA());
		await tables.ReplicateFalseLocal.put({ id: 'local', payload: BLOB_PAYLOAD });
		await tables.ReplicateFalseShared.put({ id: 'shared', payload: 'travels' });
	});

	beforeEach(async () => {
		socket = new FakeSocket();
		session = replicateOverWS(socket, {}, { name: 'peer-a', replicates: true });
		socket.emit('message', encode([NODE_NAME, 'peer-a', 'data', [], buildLocalCapabilities(90_000, false, true)]));
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

	it('refuses cleanly, not with an internal fault, when the connection resolved no database', async () => {
		const orphan = new FakeSocket();
		replicateOverWS(orphan, {}, { replicates: true });
		orphan.emit('message', encode([NODE_NAME, 'peer-a', 'database_that_does_not_exist', [], {}]));
		await settle(orphan, 1);
		orphan.emit('message', encode([GET_RECORD, 11, 99, 'k', 'SomeTable']));
		for (let turn = 0; turn < 60 && !orphan.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE); turn++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		const response = orphan.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE);
		orphan.close(1000);
		assert.ok(response, 'the peer must be answered rather than left waiting');
		assert.equal(response[1], 11);
		assert.match(response[2].error, /is not available for replication/);
		assert.doesNotMatch(response[2].error, /Cannot read properties|undefined/);
	});

	it('serves GET_RECORD on a retrieval socket using the requested table id', async () => {
		const shared = tables.ReplicateFalseShared;
		const requestedId = shared.tableId + 50;
		socket.emit('message', encode([GET_RECORD, 8, requestedId, 'shared', 'ReplicateFalseShared']));
		await settle(socket, 3);
		assert.equal(socket.sent.find((frame) => frame[0] === TABLE_FIXED_STRUCTURE)?.[2], requestedId);
		const response = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE);
		assert.ok(response, 'the control table must be served');
		assert.equal(response[1], 8);
		assert.equal(response[2].error, undefined);
		assert.ok(response[2].value, 'a record value must be returned');
	});

	it('resolves repeated name-less GET_RECORD requests against the live table', async () => {
		const shared = tables.ReplicateFalseShared;
		socket.emit('message', encode([GET_RECORD, 20, shared.tableId, 'shared', shared.tableName]));
		await settle(socket, 2);
		const start = socket.sent.length;
		socket.emit('message', encode([GET_RECORD, 21, shared.tableId, 'shared']));
		await settle(socket, start + 1);
		const response = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 21);
		assert.ok(response);
		assert.equal(response[2].error, undefined);
		assert.ok(response[2].value);

		const replicated = shared.replicate;
		try {
			shared.replicate = false;
			const start = socket.sent.length;
			socket.emit('message', encode([GET_RECORD, 22, shared.tableId, 'shared']));
			await settle(socket, start + 1);
			const refused = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 22);
			assert.match(refused?.[2].error, /is not available for replication/);
		} finally {
			shared.replicate = replicated;
		}
	});

	it('announces a usable decoder for every requested table, including an empty dictionary', async () => {
		await loadGQLSchema(`
			type GetRecordOther @table { id: ID @primaryKey payload: String }
			type GetRecordEmpty @table { id: ID @primaryKey }
		`);
		await tables.GetRecordOther.put({ id: 'other', payload: 'another table' });
		const StructonPackr = createStructon(Packr);
		for (const [i, [table, id]] of [
			[tables.ReplicateFalseShared, 'shared'],
			[tables.GetRecordOther, 'other'],
			[tables.GetRecordEmpty, 'missing'],
		].entries()) {
			const start = socket.sent.length;
			socket.emit('message', encode([GET_RECORD, 30 + i, table.tableId, id, table.tableName]));
			await settle(socket, start + 2);
			const frames = socket.sent.slice(start);
			const structure = frames.find((frame) => frame[0] === TABLE_FIXED_STRUCTURE);
			assert.ok(structure, `no decoder for ${table.tableName}`);
			assert.equal(structure[2], table.tableId);
			assert.equal(structure[3], table.tableName);
			const entry = frames.find((frame) => frame[0] === GET_RECORD_RESPONSE)?.[2];
			if (id === 'missing') assert.equal(entry, undefined);
			else {
				assert.equal(entry?.error, undefined);
				if (!table.primaryStore.encoder.isRocksDB) {
					assert.equal(entry.version, table.primaryStore.getEntry(id).version);
				}
				const decoder = new StructonPackr({
					typedStructs: structure[1].typedStructs,
					structures: structure[1].structures,
				});
				const decoded = decoder.decode(entry.value);
				assert.equal(decoded.id, id);
				assert.equal(decoded.payload, (await table.get(id)).payload);
			}
		}
	});

	it('does not reuse a cached class after a named table is dropped', async () => {
		await loadGQLSchema('type GetRecordDropped @table { id: ID @primaryKey payload: String }');
		const table = tables.GetRecordDropped;
		await table.put({ id: 'gone', payload: 'old generation' });
		socket.emit('message', encode([GET_RECORD, 40, table.tableId, 'gone', table.tableName]));
		await settle(socket, 2);
		await table.dropTable();
		const start = socket.sent.length;
		socket.emit('message', encode([GET_RECORD, 41, table.tableId, 'gone']));
		await settle(socket, start + 1);
		const refused = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 41);
		assert.match(refused?.[2].error, /is not available for replication/);
	});

	it('re-announces the schema after an in-place attribute change, and only then', async () => {
		await loadGQLSchema('type GetRecordSchema @table { id: ID @primaryKey payload: String }');
		const table = tables.GetRecordSchema;
		const attributes = table.attributes;
		await table.put({ id: 'row', payload: 'value' });
		const request = async (requestId) => {
			const start = socket.sent.length;
			socket.emit('message', encode([GET_RECORD, requestId, table.tableId, 'row', table.tableName]));
			for (let turn = 0; turn < 100 && !socket.sent.some((frame) => frame[1] === requestId); turn++)
				await new Promise((resolve) => setImmediate(resolve));
			const frames = socket.sent.slice(start);
			assert.ok(frames.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === requestId));
			return frames.find((frame) => frame[0] === TABLE_FIXED_STRUCTURE);
		};
		const names = (structure) => structure[1].attributes.map((attribute) => attribute.name);
		assert.deepEqual(names(await request(60)), ['id', 'payload']);
		assert.equal(await request(61), undefined);
		await loadGQLSchema('type GetRecordSchema @table { id: ID @primaryKey payload: String added: String }');
		assert.equal(tables.GetRecordSchema, table);
		assert.equal(table.attributes, attributes);
		assert.deepEqual(names(await request(62)), ['id', 'payload', 'added']);
		assert.equal(await request(63), undefined);
	});

	for (const randomAccessFields of [false, true]) {
		it(`refreshes growing dictionaries and suppresses redundant announcements (typed: ${randomAccessFields})`, async () => {
			const name = `GetRecordGrowing${randomAccessFields}`;
			await loadGQLSchema(`type ${name} @table(randomAccessFields: ${randomAccessFields}) { id: ID @primaryKey }`);
			const table = tables[name];
			const StructonPackr = createStructon(Packr);
			let decoder;
			for (const [i, value] of [
				{ id: 'first', payload: 'simple' },
				{ id: 'second', payload: 'larger', extra: { nested: ['value', 42, false] } },
			].entries()) {
				await table.put(value);
				const start = socket.sent.length;
				socket.emit('message', encode([GET_RECORD, 50 + i, table.tableId, value.id, table.tableName]));
				await settle(socket, start + 2);
				const frames = socket.sent.slice(start);
				const structure = frames.find((frame) => frame[0] === TABLE_FIXED_STRUCTURE);
				assert.ok(structure, `no updated decoder for ${value.id}`);
				decoder = new StructonPackr(structure[1]);
				assert.deepEqual(decoder.decode(frames.find((frame) => frame[0] === GET_RECORD_RESPONSE)[2].value), value);
			}
			for (const [i, id] of ['second', 'missing'].entries()) {
				const start = socket.sent.length;
				socket.emit('message', encode([GET_RECORD, 52 + i, table.tableId, id, table.tableName]));
				await settle(socket, start + 1);
				const frames = socket.sent.slice(start);
				assert.deepEqual(
					frames.map((frame) => frame[0]),
					[GET_RECORD_RESPONSE]
				);
				if (id === 'missing') assert.equal(frames[0][2], undefined);
				else assert.equal(decoder.decode(frames[0][2].value).extra.nested[1], 42);
			}
		});
	}

	it('refuses blob repair before receiving a usable subscription decoder', async () => {
		const table = tables.ReplicateFalseShared;
		const unknown = session.getRecord({ table, id: 'shared', entry: {}, blobRepairOnly: true });
		const earlyRequest = socket.sent.find((frame) => frame[0] === GET_RECORD);
		if (earlyRequest) socket.emit('message', encode([GET_RECORD_RESPONSE, earlyRequest[1], { error: 'test cleanup' }]));
		await assert.rejects(unknown, /No subscription decoder/);
		assert.equal(earlyRequest, undefined);
	});

	it("uses the subscription's remote table id for blob repair and always sends the name", async () => {
		const table = tables.ReplicateFalseShared;
		const remoteId = table.tableId + 100;
		socket.emit('message', structureFrame(table, remoteId));
		for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
		for (let i = 0; i < 2; i++) {
			const pending = session.getRecord({ table, id: 'shared', entry: {}, blobRepairOnly: true });
			const outcome = pending.then(
				(entry) => ({ entry }),
				(error) => ({ error })
			);
			const message = socket.sent.at(-1);
			socket.emit(
				'message',
				encode([
					GET_RECORD_RESPONSE,
					message[1],
					{ value: table.primaryStore.encoder.encode({ id: 'shared', payload: 'travels' }) },
				])
			);
			const result = await outcome;
			assert.equal(message[0], GET_RECORD);
			assert.equal(message[2], remoteId);
			assert.equal(message[4], table.tableName);
			assert.equal(result.error, undefined);
			assert.equal(result.entry.value.payload, 'travels');
		}
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

	it('copies only replicated tables and keeps GET_RECORD in the subscription decoder namespace', async () => {
		socket = new FakeSocket();
		replicateOverWS(socket, {}, { replicates: true });
		// Without a capability bag the sender reads this peer as v4 and waits on a legacy baseline
		// answer no fake socket gives, so the copy never starts.
		socket.emit('message', encode([NODE_NAME, 'peer-a', 'data', [], buildLocalCapabilities(90_000, false, true)]));
		await settle(socket, 1);
		// A peer that declared no table excludes nothing, so the source's own gate is the only filter.
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
		const table = tables.ReplicateFalseShared;
		let start = socket.sent.length;
		socket.emit('message', encode([GET_RECORD, 70, table.tableId + 100, 'shared', table.tableName]));
		await settle(socket, start + 1);
		const refused = socket.sent.slice(start);
		assert.deepEqual(
			refused.map((frame) => frame[0]),
			[GET_RECORD_RESPONSE]
		);
		assert.match(refused[0][2].error, /is not available for replication/);

		start = socket.sent.length;
		socket.emit('message', encode([GET_RECORD, 71, table.tableId, 'shared', table.tableName]));
		await settle(socket, start + 2);
		assert.ok(socket.sent.slice(start).find((frame) => frame[0] === GET_RECORD_RESPONSE)?.[2].value);
	});
});

// One replicated transaction as a pre-#883 sender frames it: the origin log key, one put entry (its
// leading local-time float stripped, as the sender does), and the end-of-transaction sequence update.
function oldSenderFrame(table, tableId, record, options = {}) {
	const frame = new FrameWriter();
	const txnLogKey = Date.now();
	frame.writeFloat64(txnLogKey);
	const entry = Buffer.from(
		createAuditEntry({
			type: 'put',
			tableId,
			recordId: record.id,
			version: txnLogKey,
			previousVersion: null,
			nodeId: 0,
			extendedType: options.extendedType,
			encodedRecord: options.encodedRecord ?? Buffer.from(table.primaryStore.encoder.encode(record)),
		})
	);
	const start = entry[0] === 66 ? 8 : 0;
	frame.writeInt(entry.length - start);
	frame.writeBytes(entry, start);
	frame.writeInt(9);
	frame.writeInt(REMOTE_SEQUENCE_UPDATE);
	frame.writeFloat64(txnLogKey);
	return Buffer.from(frame.encodingBuffer.subarray(frame.encodingStart, frame.position));
}

function structureFrame(table, tableId) {
	const encoder = table.primaryStore.encoder;
	return encode([
		TABLE_FIXED_STRUCTURE,
		{
			typedStructs: encoder.typedStructs,
			structures: encoder.structures,
			attributes: table.attributes,
			schemaDefined: true,
		},
		tableId,
		table.tableName,
	]);
}

async function waitForRecord(table, id) {
	for (let turn = 0; turn < 200; turn++) {
		const record = await table.get(id);
		if (record) return record;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return undefined;
}

describe('replicate: false on the receive path (harper-pro#883)', function () {
	this.timeout(30_000);
	let socket;

	before(async () => {
		setReplicator('data', tables.ReplicateFalseShared, {});
		for (let turn = 0; turn < 100 && databaseSubscriptions.get('data')?.then; turn++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.ok(databaseSubscriptions.get('data')?.auditStore, 'the data subscription must resolve in-process');
	});

	afterEach(() => {
		socket?.close(1000);
	});

	it("drops a pre-fix sender's row for a table this node declares replicate: false, and applies the replicated one", async () => {
		const local = tables.ReplicateFalseLocal;
		const shared = tables.ReplicateFalseShared;
		socket = new FakeSocket();
		replicateOverWS(socket, {}, { replicates: true });
		socket.emit('message', encode([NODE_NAME, 'peer-a', 'data', [], buildLocalCapabilities(90_000, false, true)]));
		await settle(socket, 1);
		socket.emit('message', encode([NODE_NAME_TO_ID_MAP, { 'peer-a': 0 }, ['peer-a']]));
		socket.emit('message', structureFrame(local, 21));
		socket.emit('message', structureFrame(shared, 22));
		socket.emit('message', oldSenderFrame(local, 21, { id: 'from-old-sender', payload: 'must not land' }));
		socket.emit('message', oldSenderFrame(shared, 22, { id: 'from-old-sender', payload: 'lands' }));
		const applied = await waitForRecord(shared, 'from-old-sender');
		assert.equal(applied?.payload, 'lands', 'the replicated table must still apply the same sender frames');
		assert.ok(!(await local.get('from-old-sender')), 'the local table must not apply a peer row');
		assert.deepEqual(socket.closes, [], 'the drop must not close the connection');
	});

	it('drops a blob-carrying row for the local table without leaving its announced stream in flight', async () => {
		const local = tables.ReplicateFalseLocal;
		// Real stored bytes: the blob references inside them are what the drop path enumerates in order
		// to retire the streams a sender announces ahead of the record.
		await local.put({ id: 'blob-donor', payload: BLOB_PAYLOAD });
		const donor = local.primaryStore.getEntry('blob-donor');
		assert.ok(donor.metadataFlags & HAS_BLOBS, 'premise: the donor row is blob-carrying');
		// The sender's own copy-row encode, so the blob references travel exactly as they do in production.
		const announced = [];
		const encodedRecord = Buffer.from(
			encodeCopyRecordValue(local.primaryStore, donor.value, (blob) => announced.push(blob))
		);
		assert.ok(announced.length > 0, 'premise: encoding the donor row surfaces its blob reference');

		socket = new FakeSocket();
		replicateOverWS(socket, {}, { replicates: true });
		socket.emit('message', encode([NODE_NAME, 'peer-a', 'data', [], buildLocalCapabilities(90_000, false, true)]));
		await settle(socket, 1);
		socket.emit('message', encode([NODE_NAME_TO_ID_MAP, { 'peer-a': 0 }, ['peer-a']]));
		socket.emit('message', structureFrame(local, 31));
		socket.emit(
			'message',
			oldSenderFrame(local, 31, { id: 'blob-from-old-sender' }, { encodedRecord, extendedType: HAS_BLOBS })
		);
		for (let turn = 0; turn < 60; turn++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(!(await local.get('blob-from-old-sender')), 'a blob-carrying peer row must not land either');
		assert.deepEqual(socket.closes, [], 'enumerating the dropped record blobs must not close the connection');
	});
});
