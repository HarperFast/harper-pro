import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { table } from '#src/core/resources/databases';
import { transaction } from '#src/core/resources/transaction';
import { Decoder, readAuditEntry } from '#src/core/resources/auditStore';
import { INVALIDATED, REPLICA, FULL_WRITE_HEAD } from '#src/core/resources/Table';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';
import { server } from '#src/core/server/Server';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';

const OPERATION_REQUEST = 136;
const SUBSCRIPTION_REQUEST = 129;
const TABLE_FIXED_STRUCTURE = 132;
const GET_RECORD = 133;
const GET_RECORD_RESPONSE = 134;
const OPERATION_RESPONSE = 137;
const NODE_NAME = 140;
const COPY_START = 148;
const COPY_COMPLETE = 149;
const DATABASE = 'residencyReplicaWire';
const PEER = 'residency-replica-peer';
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const replicaTest = isLMDB ? it.skip : it;

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
			if (entry.tableId === tableId)
				records.set(entry.recordId, { entry, bytes: Buffer.from(frame.subarray(offset, offset + length)) });
		}
	}
	return records;
}

describe('local replicas on the replication wire', function () {
	this.timeout(30_000);
	let Records, KeyOnly, Expiring, Proxy, socket, session, residencyId, stubVersion;

	before(async () => {
		setHdbBasePath(process.env.STORAGE_PATH);
		for (const schema of [
			{ name: 'Records', indexed: true },
			{ name: 'KeyOnly', indexed: false },
			{ name: 'Expiring', indexed: true, expiration: 3600 },
			{ name: 'Proxy', indexed: true, replicaExpiration: 0 },
		]) {
			const { indexed } = schema;
			const RecordTable = table({
				database: DATABASE,
				table: schema.name,
				expiration: schema.expiration,
				replicaExpiration: schema.replicaExpiration,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'name', indexed },
					{ name: 'body' },
					{ name: 'created', assignCreatedTime: true },
				],
				audit: true,
			});
			if (schema.name === 'Records') Records = RecordTable;
			else if (schema.name === 'KeyOnly') KeyOnly = RecordTable;
			else if (schema.name === 'Expiring') Expiring = RecordTable;
			else Proxy = RecordTable;
			RecordTable.setResidency(() => [PEER]);
			await RecordTable.put('full', { id: 'full', name: 'indexed', body: 'complete' });
			residencyId = RecordTable.primaryStore.getEntry('full').residencyId;
			setReplicator(DATABASE, RecordTable, {});
		}
		await until(() => databaseSubscriptions.get(DATABASE)?.auditStore, 'the database subscription');
	});

	async function stub(id, RecordTable = Records) {
		const context = {};
		await transaction(context, async () => {
			const resource = await RecordTable.getResource(id, context, { ensureLoaded: false });
			resource._writeInvalidate(id, { id, name: 'indexed' }, { residencyId });
		});
		const entry = RecordTable.primaryStore.getEntry(id);
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

	async function fullRecordFrame(RecordTable = Records) {
		socket.emit('message', encode([GET_RECORD, 11, RecordTable.tableId, 'full', RecordTable.tableName]));
		await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 11));
		const response = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 11)[2];
		assert.equal(response.error, undefined);
		assert.equal(response.originNode, server.hostname, 'a full row names its writer');
		const structure = socket.sent.find((frame) => frame[0] === TABLE_FIXED_STRUCTURE);
		return { response, structure };
	}

	async function fetchedRecord(id, existing, RecordTable = Records) {
		existing ??= await stub(id, RecordTable);
		stubVersion = existing.version;
		const { response, structure } = await fullRecordFrame(RecordTable);
		socket.emit('message', encode([TABLE_FIXED_STRUCTURE, structure[1], RecordTable.tableId, RecordTable.tableName]));
		await new Promise((resolve) => setImmediate(resolve));
		const pending = session.getRecord({ table: RecordTable, id, entry: existing });
		const request = socket.sent.filter((frame) => frame[0] === GET_RECORD).at(-1);
		const fullWriteHead = stubVersion;
		socket.emit(
			'message',
			encode([GET_RECORD_RESPONSE, request[1], { ...response, version: stubVersion, fullWriteHead }])
		);
		const found = await pending;
		assert.equal(found.value.body, 'complete');
		return found;
	}

	async function keptReplica(id, existing, RecordTable = Records) {
		await fetchedRecord(id, existing, RecordTable);
		return until(() => RecordTable.primaryStore.getEntry(id).metadataFlags & REPLICA, 'the replica write').then(() =>
			RecordTable.primaryStore.getEntry(id)
		);
	}

	replicaTest(
		'keeps a GET_RECORD answer as a replica of the stub, without an audit entry, and keeps the socket open',
		async () => {
			const existing = await stub('fetched');
			const history = (await Records.getHistoryOfRecord('fetched')).map((entry) => entry.type);
			const replica = await keptReplica('fetched', existing);
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
		}
	);

	replicaTest('reports the head log key only while the head is a full write', async () => {
		const answer = async (requestId) => {
			socket.emit('message', encode([GET_RECORD, requestId, Records.tableId, 'head-kind', Records.tableName]));
			await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === requestId));
			return socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === requestId)[2];
		};
		await Records.put('head-kind', { id: 'head-kind', name: 'indexed', body: 'put' });
		const put = Records.primaryStore.getEntry('head-kind');
		assert.equal((await answer(21)).fullWriteHead, put.additionalAuditRefs?.[0]?.version ?? put.version);
		await Records.patch('head-kind', { body: 'patched' });
		assert.ok(!('fullWriteHead' in (await answer(22))), 'a patch head adds no key');
	});

	it('names a row written by another node after that node', async () => {
		const remoteId = getIdOfRemoteNode('other-resident', Records.auditStore);
		Records.dbisDB.putSync([Symbol.for('residency_by_id'), 777], [server.hostname, 'other-resident']);
		const context = { sourceApply: true, timestamp: Date.now() };
		await transaction(context, async () => {
			const resource = await Records.getResource('remote', context, { ensureLoaded: false });
			resource._writeUpdate('remote', { id: 'remote', name: 'indexed', body: 'remote body' }, true, {
				version: context.timestamp,
				nodeId: remoteId,
				residencyId: 777,
			});
			resource.save();
		});
		const entry = Records.primaryStore.getEntry('remote');
		assert.equal(entry.nodeId, remoteId);
		assert.ok(!(entry.metadataFlags & INVALIDATED), 'this node is a resident of the remote write');
		socket.emit('message', encode([GET_RECORD, 13, Records.tableId, 'remote', Records.tableName]));
		await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 13));
		const response = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 13)[2];
		assert.equal(response.originNode, 'other-resident', 'a resident names the writer, not itself');
		assert.equal(response.version, context.timestamp);
	});

	for (const RecordTableName of ['Proxy', ...(isLMDB ? ['Records'] : [])]) {
		it(`proxies GET_RECORD without changing the ${RecordTableName} stub or audit history`, async () => {
			const RecordTable = RecordTableName === 'Proxy' ? Proxy : Records;
			const existing = await stub('proxy', RecordTable);
			const history = (await RecordTable.getHistoryOfRecord('proxy')).map((entry) => entry.type);
			const storeReplica = RecordTable._storeReplica;
			let storeAttempt;
			RecordTable._storeReplica = function (existingEntry, entry) {
				return (storeAttempt = storeReplica.call(this, existingEntry, entry));
			};
			try {
				for (let attempt = 0; attempt < 2; attempt++) {
					storeAttempt = undefined;
					await fetchedRecord('proxy', existing, RecordTable);
					assert.strictEqual(await storeAttempt, false, 'proxy reads must decline replica admission');
					const stored = RecordTable.primaryStore.getEntry('proxy');
					assert.ok(stored.metadataFlags & INVALIDATED);
					assert.ok(!(stored.metadataFlags & REPLICA));
					assert.equal(stored.value.body, undefined);
					assert.equal(stored.version, existing.version);
					assert.equal(stored.residencyId, existing.residencyId);
					assert.deepEqual(
						(await RecordTable.getHistoryOfRecord('proxy')).map((entry) => entry.type),
						history
					);
					assert.equal(socket.readyState, 1);
				}
			} finally {
				RecordTable._storeReplica = storeReplica;
			}
		});
	}

	for (const peer of ['capable', 'missing-key', 'unlearned']) {
		replicaTest(`answers GET_RECORD for a replica as not resident to a ${peer} peer`, async () => {
			await keptReplica('not-held');
			if (peer !== 'capable') {
				socket.close();
				socket = new Socket();
				replicateOverWS(socket, { database: DATABASE }, { name: PEER, replicates: true });
				if (peer === 'missing-key') {
					const bag = { ...buildLocalCapabilities(90_000, false, true) };
					delete bag.residencyNotResident;
					socket.emit('message', encode([NODE_NAME, PEER, DATABASE, [], bag]));
					await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME));
				}
			}
			socket.emit('message', encode([GET_RECORD, 12, Records.tableId, 'not-held', Records.tableName]));
			await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 12));
			assert.strictEqual(
				socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 12)[2],
				peer === 'capable' ? false : undefined
			);
		});
	}

	for (const shape of ['secondary-indexed', 'key-only', 'expiring']) {
		const indexed = shape !== 'key-only';
		for (const peer of ['capable', 'missing-key', 'unlearned']) {
			replicaTest(`copies a ${shape} replica like its demoted stub to a ${peer} resident`, async () => {
				const RecordTable = shape === 'expiring' ? Expiring : indexed ? Records : KeyOnly;
				const id = `copied-${peer}`;
				const replica = await keptReplica(id, undefined, RecordTable);
				assert.ok(replica.value.created != null, 'the fixture must supply a created time');
				if (shape === 'expiring') assert.ok(replica.expiresAt > Date.now(), 'the fixture must supply a record expiry');
				if (peer !== 'capable') {
					socket.close();
					socket = new Socket();
					replicateOverWS(socket, { database: DATABASE }, { name: PEER, replicates: true });
					if (peer === 'missing-key') {
						const bag = { ...buildLocalCapabilities(90_000, false, true) };
						delete bag.residencyStubCopy;
						socket.emit('message', encode([NODE_NAME, PEER, DATABASE, [], bag]));
						await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME));
					}
				}
				const copy = async () => {
					socket.sent.length = 0;
					socket.emit(
						'message',
						encode([SUBSCRIPTION_REQUEST, [{ name: PEER, startTime: 0, tables: [], replicateByDefault: true }], []])
					);
					if (peer === 'unlearned') {
						await until(() => socket.sent.some((frame) => frame[0] === OPERATION_REQUEST));
						const { requestId } = socket.sent.find((frame) => frame[0] === OPERATION_REQUEST)[1];
						socket.emit('message', encode([OPERATION_RESPONSE, { requestId, version: '5.3.0' }]));
					}
					await until(() => socket.sent.some((frame) => frame[0] === COPY_COMPLETE));
					return copiedRecords(socket, RecordTable.tableId);
				};
				const records = await copy();
				const copied = records.get(id).entry;
				assert.ok(replica.metadataFlags & FULL_WRITE_HEAD, 'premise: a certified replica');
				assert.equal(copied.extendedType & FULL_WRITE_HEAD, 0, 'a record-only bit must not reach the audit flags');
				assert.equal(copied.type, peer === 'capable' ? 'invalidate' : 'put');
				assert.equal(copied.residencyId, peer === 'capable' ? residencyId : undefined);
				const value = copied.getValue(RecordTable.primaryStore);
				assert.equal(value.id, id);
				assert.equal(value.body, undefined);
				assert.equal(value.created, replica.value.created);
				assert.equal(value.name, indexed ? 'indexed' : undefined);
				assert.equal(copied.expiresAt, undefined, 'stored stubs also use main’s copy frame without record expiry');
				assert.equal(records.get('full').entry.type, 'put');
				await RecordTable.evict(id, replica.value, replica.version);
				await until(() => RecordTable.primaryStore.getEntry(id).metadataFlags & INVALIDATED, 'replica demotion');
				const demoted = await copy();
				assert.deepEqual(records.get(id).bytes, demoted.get(id).bytes, 'replica copy must match its demoted stub');
			});
		}
	}
});
