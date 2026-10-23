import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import sinon from 'sinon';
import { decode, encode, Packr } from 'msgpackr';
import { createStructon } from 'structon';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { table } from '#src/core/resources/databases';
import { transaction } from '#src/core/resources/transaction';
import { ACTION_32_BIT, createAuditEntry, Decoder, readAuditEntry } from '#src/core/resources/auditStore';
import { INVALIDATED } from '#src/core/resources/Table';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import {
	databaseSubscriptions,
	encodeCopyRecordValue,
	NodeReplicationConnection,
	replicateOverWS,
} from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';
import { getHDBNodeTable, getReplicationSharedStatus } from '#src/replication/knownNodes';
import { LATENCY_POSITION } from '#src/replication/sharedStatusSlots';

const SUBSCRIPTION_REQUEST = 129;
const TABLE_FIXED_STRUCTURE = 132;
const GET_RECORD = 133;
const GET_RECORD_RESPONSE = 134;
const NODE_NAME = 140;
const OPERATION_REQUEST = 136;
const OPERATION_RESPONSE = 137;
const COPY_START = 148;
const COPY_COMPLETE = 149;
const DATABASE = 'residencyWire';
const PEER = 'residency-wire-peer';

class Socket extends EventEmitter {
	readyState = 1;
	sent = [];
	rawSent = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		this.rawSent.push(Buffer.from(data));
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

async function until(predicate) {
	const deadline = Date.now() + 15_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, 'replication response timed out');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('residency stubs on the replication wire', function () {
	this.timeout(30_000);
	let Records, ReplicationSource, socket, session, residencyId;

	before(async () => {
		setHdbBasePath(process.env.STORAGE_PATH);
		Records = table({
			database: DATABASE,
			table: 'Records',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
			audit: true,
		});
		Records.setResidency(() => [PEER]);
		await Records.put('stub', { id: 'stub', name: 'indexed', body: 'complete' });
		await Records.put('full', { id: 'full', name: 'indexed', body: 'complete' });
		await Records.put('deleted', { id: 'deleted', name: 'indexed', body: 'complete' });
		await Records.delete('deleted');
		residencyId = Records.primaryStore.getEntry('stub').residencyId;
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('stub', context, { ensureLoaded: false });
			resource._writeInvalidate('stub', { id: 'stub', name: 'indexed' }, { residencyId });
		});
		assert.ok(Records.primaryStore.getEntry('stub').metadataFlags & INVALIDATED);
		assert.ok(Records.getResidencyRecord(residencyId).includes(PEER));
		const sourcedFrom = sinon.spy(Records, 'sourcedFrom');
		try {
			setReplicator(DATABASE, Records, {});
			ReplicationSource = sourcedFrom.firstCall.args[0];
		} finally {
			sourcedFrom.restore();
		}
		await until(() => databaseSubscriptions.get(DATABASE)?.auditStore);
	});

	beforeEach(async () => {
		socket = new Socket();
		session = replicateOverWS(socket, {}, { name: PEER, replicates: true });
		socket.emit('message', encode([NODE_NAME, PEER, DATABASE, [], buildLocalCapabilities(90_000, false, true)]));
		await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME));
	});

	afterEach(() => socket?.close());

	for (const [mode, answers, expected] of [
		['retry', [false, 'full'], 'full'],
		['absent', [false, undefined], undefined],
		['absent-first', [undefined, false], undefined],
		['absent-then-full', [undefined, 'full'], 'full'],
		['not-resident', [false, false], 'error'],
		['unreachable', [false, 'offline'], 'error'],
		['absent-unreachable', [undefined, 'offline'], 'error'],
		['not-resident-disconnect', [false, 'disconnect'], 'error'],
		['disconnect-not-resident', ['disconnect', false], 'error'],
		['absent-disconnect', [undefined, 'disconnect'], 'error'],
		['id-derived', [false, 'full'], 'full'],
		['id-derived-absent-first', [undefined, 'full'], 'full'],
		['id-derived-absent-unreachable', [undefined, 'offline'], 'error'],
		['id-derived-absent', [undefined, false], undefined],
		['id-derived-not-resident', [false, false], 'error'],
	]) {
		it(`handles ${mode} across listed residents`, async () => {
			const peers = [`residency-${mode}-first`, `residency-${mode}-second`];
			const contacted = [];
			const connections = [];
			const sandbox = sinon.createSandbox();
			const complete = { key: mode, value: { id: mode, body: 'complete' } };
			try {
				sandbox.stub(getHDBNodeTable().primaryStore, 'getSync').callsFake((name) => ({
					name,
					url: `wss://${name}:9933`,
				}));
				sandbox.stub(NodeReplicationConnection.prototype, 'connect').callsFake(function () {
					connections.push(this);
					this.isConnected = answers[peers.indexOf(this.nodeName)] !== 'offline';
				});
				sandbox.stub(NodeReplicationConnection.prototype, 'getRecord').callsFake(async function () {
					contacted.push(this.nodeName);
					const answer = answers[peers.indexOf(this.nodeName)];
					if (answer === 'disconnect') {
						this.isConnected = false;
						throw new Error('test peer disconnected');
					}
					return answer === 'full' ? complete : answer;
				});
				for (const [index, name] of peers.entries())
					getReplicationSharedStatus(Records.auditStore, DATABASE, name)[LATENCY_POSITION] = index;
				Records.dbisDB.putSync([Symbol.for('residency_by_id'), 789], peers);
				const pending = ReplicationSource.load({
					key: mode,
					residencyId: 789,
					...(mode.startsWith('id-derived') ? { residency: peers } : {}),
				});
				if (expected === 'error')
					await assert.rejects(pending, (error) => {
						assert.equal(error.statusCode, 502);
						assert.match(
							error.message,
							answers.includes('offline') || answers.includes('disconnect') ? /No connection/ : /not resident/i
						);
						return true;
					});
				else assert.equal(await pending, expected === 'full' ? complete : undefined);
				assert.deepEqual(
					contacted,
					peers.filter((_, index) => answers[index] !== 'offline')
				);
			} finally {
				for (const connection of connections) {
					connection.isFinished = true;
					connection.emit('finished');
				}
				sandbox.restore();
			}
		});
	}

	it('receives not-resident without a decoder or relocation and keeps absence distinct', async () => {
		const relocate = sinon.spy(Records, '_recordRelocate');
		try {
			for (const answer of [false, undefined, 0, null]) {
				const pending = session.getRecord({ table: Records, id: 'stub' });
				const request = socket.sent.filter((frame) => frame[0] === GET_RECORD).at(-1);
				socket.emit(
					'message',
					encode(answer === undefined ? [GET_RECORD_RESPONSE, request[1]] : [GET_RECORD_RESPONSE, request[1], answer])
				);
				assert.strictEqual(await pending, answer === false ? false : undefined);
			}
			assert.equal(relocate.callCount, 0);
		} finally {
			relocate.restore();
		}
	});

	for (const peer of ['pre-key', 'unlearned']) {
		it(`sends byte-identical legacy empty responses to a ${peer} requester`, async () => {
			socket.close();
			socket = new Socket();
			session = replicateOverWS(socket, { database: DATABASE }, { name: PEER, replicates: true });
			if (peer === 'pre-key') {
				const bag = { ...buildLocalCapabilities(90_000, false, true) };
				delete bag.residencyNotResident;
				socket.emit('message', encode([NODE_NAME, PEER, DATABASE, [], bag]));
				await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME));
			}
			for (const [index, id] of ['stub', 'missing'].entries()) {
				socket.emit('message', encode([GET_RECORD, index, Records.tableId, id, Records.tableName]));
				await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === index));
				const bytes = socket.rawSent.find((frame) => {
					const decoded = decode(frame);
					return decoded[0] === GET_RECORD_RESPONSE && decoded[1] === index;
				});
				assert.ok(bytes.equals(encode([GET_RECORD_RESPONSE, index])));
			}
			socket.emit('message', encode([GET_RECORD, 8, Records.tableId, 'deleted', Records.tableName]));
			await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 8));
			const tombstone = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 8)[2];
			assert.equal(tombstone?.version, Records.primaryStore.getEntry('deleted').version);
			assert.strictEqual(decode(tombstone.value), null);
			const pending = session.getRecord({ table: Records, id: 'missing' });
			const request = socket.sent.filter((frame) => frame[0] === GET_RECORD).at(-1);
			socket.emit('message', encode([GET_RECORD_RESPONSE, request[1]]));
			assert.equal(await pending, undefined, 'an older responder still reports absence');
		});
	}

	it('names the table on repeated requests so each can resolve the live table', async () => {
		for (let index = 0; index < 2; index++) {
			const pending = session.getRecord({ table: Records, id: 'missing' });
			const request = socket.sent.filter((frame) => frame[0] === GET_RECORD).at(-1);
			socket.emit('message', encode([GET_RECORD_RESPONSE, request[1]]));
			await pending;
			assert.equal(request[4], Records.tableName);
		}
	});

	it('uses the subscription peer table id for blob repair requests and response decoding', async () => {
		socket.emit('message', encode([GET_RECORD, 93, Records.tableId, 'full', Records.tableName]));
		await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 93));
		const fullEntry = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 93)[2];
		assert.equal(fullEntry.error, undefined);
		const structure = socket.sent.find((frame) => frame[0] === TABLE_FIXED_STRUCTURE)[1];
		const peerTableId = Records.tableId + 1000;
		socket.emit('message', encode([TABLE_FIXED_STRUCTURE, structure, peerTableId, Records.tableName]));
		await new Promise((resolve) => setImmediate(resolve));
		const pending = session.getRecord({ table: Records, id: 'full', blobRepairOnly: true });
		const request = socket.sent.filter((frame) => frame[0] === GET_RECORD).at(-1);
		socket.emit('message', encode([GET_RECORD_RESPONSE, request[1], fullEntry]));
		assert.equal((await pending).value.body, 'complete');
		assert.equal(request[2], peerTableId);
	});

	it('refuses blob repair before the subscription has a usable table decoder', async () => {
		const pending = session.getRecord({ table: Records, id: 'missing', blobRepairOnly: true });
		const request = socket.sent.find((frame) => frame[0] === GET_RECORD);
		if (request) socket.emit('message', encode([GET_RECORD_RESPONSE, request[1]]));
		await assert.rejects(pending, /No subscription decoder for blob repair/);
		assert.equal(request, undefined);
	});

	it('rejects mismatched table ids on subscription sockets before announcing a decoder', async () => {
		socket.emit(
			'message',
			encode([SUBSCRIPTION_REQUEST, [{ name: PEER, startTime: 0, tables: [], replicateByDefault: true }], []])
		);
		await until(() => socket.sent.some((frame) => frame[0] === COPY_COMPLETE));
		const sentBeforeRequest = socket.sent.length;
		socket.emit('message', encode([GET_RECORD, 91, Records.tableId + 1000, 'missing', Records.tableName]));
		await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 91));
		const frames = socket.sent.slice(sentBeforeRequest);
		const response = frames.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 91);
		assert.match(response[2]?.error ?? '', /not available for replication/);
		assert.ok(!frames.some((frame) => frame[0] === TABLE_FIXED_STRUCTURE));
		socket.emit('message', encode([GET_RECORD, 92, Records.tableId, 'missing', Records.tableName]));
		await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 92));
		assert.equal(socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 92)[2], undefined);
	});

	for (const id of ['stub', 'missing', 'deleted', 'full']) {
		it(`answers GET_RECORD for ${id} without promoting partial data`, async () => {
			socket.emit('message', encode([GET_RECORD, 7, Records.tableId, id, Records.tableName]));
			await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE));
			const response = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE);
			if (id === 'full') {
				assert.equal(response[2].error, undefined);
				const [, structure] = socket.sent.find((frame) => frame[0] === TABLE_FIXED_STRUCTURE);
				const StructonPackr = createStructon(Packr);
				const decoder = new StructonPackr({ typedStructs: structure.typedStructs, structures: structure.structures });
				assert.equal(decoder.decode(response[2].value).body, 'complete');
			} else if (id === 'deleted') {
				assert.equal(response[2]?.version, Records.primaryStore.getEntry('deleted').version);
				assert.strictEqual(decode(response[2].value), null);
			} else assert.strictEqual(response[2], id === 'stub' ? false : undefined);
		});
	}

	for (const list of ['stored', 'id-derived']) {
		for (const second of ['older-live', 'offline']) {
			it(`a versioned deletion settles a ${list} read before an ${second} holder`, async () => {
				socket.emit('message', encode([GET_RECORD, 950, Records.tableId, 'deleted', Records.tableName]));
				await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 950));
				const wireAnswer = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === 950)[2];
				const structure = socket.sent.find((frame) => frame[0] === TABLE_FIXED_STRUCTURE);
				socket.emit('message', encode(structure));
				await new Promise((resolve) => setImmediate(resolve));
				const deletionVersion = Records.primaryStore.getEntry('deleted').version;
				const older = Records.primaryStore.getEntry('full');
				assert.ok(older.version < deletionVersion);
				const peers = [`deletion-${list}-${second}-first`, `deletion-${list}-${second}-second`];
				const contacted = [];
				const connections = [];
				const sandbox = sinon.createSandbox();
				try {
					const relocate = sandbox.stub(Records, '_recordRelocate').returns(true);
					sandbox.stub(getHDBNodeTable().primaryStore, 'getSync').callsFake((name) => ({
						name,
						url: `wss://${name}:9933`,
					}));
					sandbox.stub(NodeReplicationConnection.prototype, 'connect').callsFake(function () {
						connections.push(this);
						this.isConnected = this.nodeName === peers[0] || second !== 'offline';
					});
					sandbox.stub(NodeReplicationConnection.prototype, 'getRecord').callsFake(async function (request) {
						contacted.push(this.nodeName);
						if (this.nodeName === peers[1])
							return { key: 'deleted', value: { ...older.value, id: 'deleted' }, version: older.version };
						const pending = session.getRecord(request);
						const sent = socket.sent.filter((frame) => frame[0] === GET_RECORD).at(-1);
						socket.emit('message', encode([GET_RECORD_RESPONSE, sent[1], wireAnswer]));
						return pending;
					});
					for (const [index, name] of peers.entries())
						getReplicationSharedStatus(Records.auditStore, DATABASE, name)[LATENCY_POSITION] = index;
					Records.dbisDB.putSync([Symbol.for('residency_by_id'), 790], peers);
					const found = await ReplicationSource.load({
						key: 'deleted',
						residencyId: 790,
						...(list === 'id-derived' ? { residency: peers } : {}),
					});
					assert.strictEqual(found.value, null);
					assert.equal(found.version, deletionVersion);
					assert.deepEqual(contacted, [peers[0]]);
					assert.equal(relocate.callCount, 1);
					assert.strictEqual(relocate.firstCall.args[1], found);
				} finally {
					for (const connection of connections) {
						connection.isFinished = true;
						connection.emit('finished');
					}
					sandbox.restore();
				}
			});
		}
	}

	async function copiedRecords(copySocket = socket) {
		copySocket.emit(
			'message',
			encode([SUBSCRIPTION_REQUEST, [{ name: PEER, startTime: 0, tables: [], replicateByDefault: true }], []])
		);
		await until(() => copySocket.sent.some((frame) => frame[0] === COPY_COMPLETE));
		const start = copySocket.sent.findIndex((frame) => frame[0] === COPY_START);
		const end = copySocket.sent.findIndex((frame) => frame[0] === COPY_COMPLETE);
		assert.ok(start >= 0 && end > start, 'must exercise the base-copy row walk');
		const records = new Map();
		for (const frame of copySocket.sent.slice(start + 1, end)) {
			if (!Buffer.isBuffer(frame)) continue;
			const decoder = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
			decoder.position = 8;
			while (decoder.position < frame.length) {
				const length = decoder.readInt();
				const offset = decoder.position;
				decoder.position += length;
				if (length === 9 && frame[offset] === 11) continue;
				const entry = readAuditEntry(frame, offset, offset + length);
				if (entry.tableId === Records.tableId)
					records.set(entry.recordId, { entry, bytes: Buffer.from(frame.subarray(offset, offset + length)) });
			}
		}
		return records;
	}

	function preGateCopyEncoding(key, nodeId) {
		const stored = [...Records.primaryStore.getRange({ versions: true, snapshot: false })].find(
			(entry) => entry.key === key
		);
		return Buffer.from(
			createAuditEntry({
				version: stored.version,
				tableId: Records.tableId,
				recordId: key,
				previousVersion: null,
				nodeId,
				type: 'put',
				encodedRecord: encodeCopyRecordValue(Records.primaryStore, stored.value, () => {}),
				extendedType: stored.metadataFlags & ~0xff & ~(ACTION_32_BIT << 24),
				residencyId: stored.residencyId,
				previousResidencyId: null,
				expiresAt: stored.expiresAt,
			})
		);
	}

	it('copies a resident-targeted stub as an invalidation with its residency id to a guarded peer', async () => {
		const records = await copiedRecords();
		assert.equal(records.get('stub')?.entry.type, 'invalidate', 'base copy promoted a stub to put');
		assert.equal(records.get('stub').entry.residencyId, residencyId);
		assert.equal(records.get('stub').entry.getValue(Records.primaryStore).body, undefined);
		assert.equal(records.get('full')?.entry.type, 'put');
		assert.equal(records.get('full').entry.residencyId, residencyId);
		assert.equal(records.get('full').entry.getValue(Records.primaryStore).body, 'complete');
	});

	for (const peer of ['a pre-key capability bag', 'unlearned capabilities']) {
		it(`copies a stub exactly as before the gate to a peer with ${peer}`, async () => {
			socket.close();
			socket = new Socket();
			// A peer's NODE_NAME names the database; with none, this side must already know it.
			const unlearned = peer === 'unlearned capabilities';
			replicateOverWS(socket, unlearned ? { database: DATABASE } : {}, { name: PEER, replicates: true });
			if (!unlearned) {
				const olderBag = { ...buildLocalCapabilities(90_000, false, true) };
				delete olderBag.residencyStubCopy;
				socket.emit('message', encode([NODE_NAME, PEER, DATABASE, [], olderBag]));
				await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME));
			}
			const copied = copiedRecords();
			if (unlearned) {
				// No safeCopyAudit either, so the copy first asks for the peer's version.
				await until(() => socket.sent.some((frame) => frame[0] === OPERATION_REQUEST));
				const { requestId } = socket.sent.find((frame) => frame[0] === OPERATION_REQUEST)[1];
				socket.emit('message', encode([OPERATION_RESPONSE, { requestId, version: '5.3.0' }]));
			}
			const records = await copied;
			const stub = records.get('stub');
			assert.equal(stub?.entry.type, 'put');
			assert.deepEqual(stub.bytes, preGateCopyEncoding('stub', stub.entry.nodeId));
			assert.equal(records.get('full')?.entry.residencyId, residencyId);
		});
	}
});
