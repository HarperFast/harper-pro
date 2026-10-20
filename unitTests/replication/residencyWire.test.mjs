import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import sinon from 'sinon';
import { decode, encode, Packr } from 'msgpackr';
import { createStructon } from 'structon';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { table } from '#src/core/resources/databases';
import { transaction } from '#src/core/resources/transaction';
import { Decoder, readAuditEntry } from '#src/core/resources/auditStore';
import { INVALIDATED } from '#src/core/resources/Table';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import {
	databaseSubscriptions,
	NodeReplicationConnection,
	replicateOverWS,
} from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';
import { getHDBNodeTable, getReplicationSharedStatus } from '#src/replication/knownNodes';
import { LATENCY_POSITION } from '#src/replication/sharedStatusSlots';

const SUBSCRIPTION_REQUEST = 129;
const GET_RECORD = 133;
const GET_RECORD_RESPONSE = 134;
const NODE_NAME = 140;
const COPY_START = 148;
const COPY_COMPLETE = 149;
const DATABASE = 'residencyWire';
const PEER = 'residency-wire-peer';

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

	for (const mode of ['retry', 'absent', 'unreachable', 'id-derived']) {
		it(`handles ${mode} after the first resident answers not held`, async () => {
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
					this.isConnected = !(mode === 'unreachable' && this.nodeName === peers[1]);
				});
				sandbox.stub(NodeReplicationConnection.prototype, 'getRecord').callsFake(async function () {
					contacted.push(this.nodeName);
					return this.nodeName === peers[1] && mode === 'retry' ? complete : undefined;
				});
				for (const [index, name] of peers.entries())
					getReplicationSharedStatus(Records.auditStore, DATABASE, name)[LATENCY_POSITION] = index;
				Records.dbisDB.putSync([Symbol.for('residency_by_id'), 789], peers);
				const pending = ReplicationSource.load({
					key: mode,
					residencyId: 789,
					...(mode === 'id-derived' ? { residency: peers } : {}),
				});
				if (mode === 'unreachable') await assert.rejects(pending, (error) => error.statusCode === 502);
				else assert.equal(await pending, mode === 'retry' ? complete : undefined);
				assert.deepEqual(contacted, mode === 'unreachable' || mode === 'id-derived' ? peers.slice(0, 1) : peers);
			} finally {
				for (const connection of connections) {
					connection.isFinished = true;
					connection.emit('finished');
				}
				sandbox.restore();
			}
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

	for (const id of ['stub', 'missing', 'full']) {
		it(`answers GET_RECORD for ${id} without promoting partial data`, async () => {
			socket.emit('message', encode([GET_RECORD, 7, Records.tableId, id, Records.tableName]));
			await until(() => socket.sent.some((frame) => frame[0] === GET_RECORD_RESPONSE));
			const response = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE);
			if (id === 'full') {
				assert.equal(response[2].error, undefined);
				const [, structure] = socket.sent.find((frame) => frame[0] === 132);
				const StructonPackr = createStructon(Packr);
				const decoder = new StructonPackr({ typedStructs: structure.typedStructs, structures: structure.structures });
				assert.equal(decoder.decode(response[2].value).body, 'complete');
			} else assert.equal(response[2], undefined, 'a stub or missing row must answer not held');
		});
	}

	it('copies a resident-targeted stub as an invalidation with its residency id', async () => {
		socket.emit(
			'message',
			encode([SUBSCRIPTION_REQUEST, [{ name: PEER, startTime: 0, tables: [], replicateByDefault: true }], []])
		);
		await until(() => socket.sent.some((frame) => frame[0] === COPY_COMPLETE));
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
				if (entry.tableId === Records.tableId) records.set(entry.recordId, entry);
			}
		}
		assert.equal(records.get('stub')?.type, 'invalidate', 'base copy promoted a stub to put');
		assert.equal(records.get('stub').residencyId, residencyId);
		assert.equal(records.get('stub').getValue(Records.primaryStore).body, undefined);
		assert.equal(records.get('full')?.type, 'put');
		assert.equal(records.get('full').residencyId, residencyId);
		assert.equal(records.get('full').getValue(Records.primaryStore).body, 'complete');
	});
});
