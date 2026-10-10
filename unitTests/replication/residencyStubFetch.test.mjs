/**
 * `GET_RECORD` never answers with an INVALIDATED stub's bytes (HarperFast/harper#2257): the requester
 * stores and serves whatever comes back as the complete record, so a stub answers as a miss. Drives the
 * real inbound handler of `replicateOverWS` over a fake socket.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { loadGQLSchema } from '#src/core/resources/graphql';
import { tables } from '#src/core/resources/databases';
import { INVALIDATED } from '#src/core/resources/Table';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { replicateOverWS } from '#src/replication/replicationConnection';

const GET_RECORD = 133;
const GET_RECORD_RESPONSE = 134;
const NODE_NAME = 140;
const OPEN = 1;
const CLOSED = 3;

class FakeSocket extends EventEmitter {
	readyState = OPEN;
	sent = [];
	closes = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		this.sent.push(data[0] > 127 ? decode(data) : { recordFrame: data.length });
	}
	close(code) {
		this.closes.push(code);
		if (this.readyState === CLOSED) return;
		this.readyState = CLOSED;
		this.emit('close', code, Buffer.from(''));
	}
	terminate() {
		this.close(1006);
	}
	ping() {}
	pause() {}
	resume() {}
}

async function getRecordResponse(socket, requestId) {
	for (let turn = 0; turn < 100; turn++) {
		const response = socket.sent.find((frame) => frame[0] === GET_RECORD_RESPONSE && frame[1] === requestId);
		if (response) return response;
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe('GET_RECORD over an INVALIDATED stub (harper#2257)', function () {
	this.timeout(20_000);
	let socket;

	before(async () => {
		setHdbBasePath(process.env.STORAGE_PATH);
		await loadGQLSchema(`
			type ResidencyStubFetch @table {
				id: ID @primaryKey
				home: String @indexed
				name: String
			}
		`);
		const table = tables.ResidencyStubFetch;
		await table.put({ id: 'complete', home: 'here', name: 'whole' });
		await table.put({ id: 'stub', home: 'here', name: 'lost' });
		await table.invalidate('stub');
		const stub = await table.primaryStore.getEntry('stub');
		assert.ok(stub.metadataFlags & INVALIDATED, 'premise: the row is an INVALIDATED stub');
		assert.equal(stub.value?.name, undefined, 'premise: the stub keeps only indexed fields');
	});

	beforeEach(async () => {
		socket = new FakeSocket();
		replicateOverWS(socket, {}, { name: 'peer-a', replicates: true });
		socket.emit('message', encode([NODE_NAME, 'peer-a', 'data', [], buildLocalCapabilities(90_000, false, true)]));
		for (let turn = 0; turn < 100 && socket.sent.length < 1; turn++) await new Promise(setImmediate);
	});

	afterEach(() => {
		socket.close(1000);
	});

	it('answers a stub as a miss, not with its bytes', async () => {
		const table = tables.ResidencyStubFetch;
		socket.emit('message', encode([GET_RECORD, 21, table.tableId, 'stub', 'ResidencyStubFetch']));
		const response = await getRecordResponse(socket, 21);
		assert.ok(response, 'the requester must be answered');
		const entry = response[2];
		// a boolean, not the entry: a failing diff of the served bytes is large enough to exhaust mocha
		assert.ok(
			entry === undefined,
			`a stub must answer as a miss, got an entry with ${entry?.value?.length} value bytes`
		);
	});

	it('still answers a complete row with its value', async () => {
		const table = tables.ResidencyStubFetch;
		socket.emit('message', encode([GET_RECORD, 22, table.tableId, 'complete', 'ResidencyStubFetch']));
		const response = await getRecordResponse(socket, 22);
		assert.ok(response?.[2]?.value, 'a complete row must be served');
	});
});
