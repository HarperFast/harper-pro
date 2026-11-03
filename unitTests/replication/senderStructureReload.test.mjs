/**
 * A shared-structure save that throws leaves this thread's `primaryStore.encoder` reset (structon's
 * save guard empties `typedStructs`/`structures` and marks them `uninitialized`). The sender forwards
 * stored record bytes without packing, so it must reload the dictionaries itself before comparing them
 * with what this peer was last sent; otherwise it advertises empty dictionaries, the peer replaces its
 * decoder with them, and every record that references a dropped id is skipped as undecodable.
 *
 * Drives the real sender over a fake socket. Backpressure parks it after the first record, so the
 * failing save lands between two records it forwards, as a local write on the sending thread would.
 */
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { decode, encode, Packr } from 'msgpackr';
import { createStructon } from 'structon';
import { loadGQLSchema } from '#src/core/resources/graphql';
import { databases } from '#src/core/resources/databases';
import { Decoder, readAuditEntry } from '#src/core/resources/auditStore';
import { HAS_STRUCTURE_UPDATE } from '#src/core/resources/RecordEncoder';
import { getThisNodeName } from '#src/core/server/nodeName';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';

const SUBSCRIPTION_REQUEST = 129;
const TABLE_FIXED_STRUCTURE = 132;
const NODE_NAME = 140;
const REMOTE_SEQUENCE_UPDATE = 11;
const COPY_START = 148;
const COPY_COMPLETE = 149;
const DATABASE = 'senderStructureReload';
const StructonPackr = createStructon(Packr);

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

// Decodes the stream as the receiver does: each TABLE_FIXED_STRUCTURE replaces the table's decoder.
function receive(socket, tableId) {
	let decoder;
	const records = new Map();
	const advertised = [];
	let flagged = false;
	for (const frame of socket.sent) {
		if (!Buffer.isBuffer(frame)) {
			if (frame[0] === TABLE_FIXED_STRUCTURE && frame[2] === tableId) {
				const { typedStructs, structures } = frame[1];
				advertised.push({
					typed: typedStructs?.length ?? 0,
					classic: structures?.length ?? 0,
					missingClassic: structures?.filter((structure) => !structure).length ?? 0,
				});
				decoder = new StructonPackr({ useBigIntExtension: true, freezeData: true, typedStructs, structures });
			}
			continue;
		}
		const reader = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
		reader.position = 8;
		while (reader.position < frame.length) {
			const length = reader.readInt();
			const start = reader.position;
			reader.position += length;
			if (length === 9 && frame[start] === REMOTE_SEQUENCE_UPDATE) continue;
			const entry = readAuditEntry(frame, start, start + length);
			if (entry.tableId !== tableId) continue;
			flagged ||= (entry.extendedType & HAS_STRUCTURE_UPDATE) !== 0;
			try {
				records.set(entry.recordId, { ...entry.getValue({ decoder }) });
			} catch (error) {
				records.set(entry.recordId, { error: error.message });
			}
		}
	}
	return { records, advertised, flagged };
}

// The failed write commits nothing, so it adds no audit entry; only the thread's encoder is left reset.
async function failStructureSave(Rows) {
	const encoder = Rows.primaryStore.encoder;
	const save = encoder.saveStructures;
	encoder.saveStructures = () => {
		throw new Error('injected shared-structure save failure');
	};
	try {
		await assert.rejects(async () => Rows.put({ id: 'unsaved', unseen: 'shape', total: 3 }), /injected/);
	} finally {
		encoder.saveStructures = save;
	}
	assert.ok(encoder.structures.uninitialized, 'the failed save must mark the structures for reload');
	assert.equal(encoder.typedStructs.length, 0);
}

describe('sender reloads structures a failed shared-structure save reset', function () {
	this.timeout(30_000);
	let socket;

	afterEach(() => {
		socket?.close(1000);
	});

	for (const randomAccessFields of [true, false]) {
		for (const path of ['audit', 'catch-up', 'copy']) {
			it(`advertises the durable dictionaries after the reset (${path}, typed: ${randomAccessFields})`, async () => {
				const name = `SenderStructures${path.replace('-', '')}${randomAccessFields}`;
				await loadGQLSchema(
					`type ${name} @table(database: "${DATABASE}", audit: true, randomAccessFields: ${randomAccessFields}) { id: ID @primaryKey }`
				);
				const Rows = databases[DATABASE][name];
				const expected = [
					{ id: 'a', label: 'alpha', count: 1 },
					{ id: 'b', label: 'beta', count: 2 },
				];
				// Mint the shapes before the start key: an entry that adds a structure carries
				// HAS_STRUCTURE_UPDATE, which reloads on its own. The start key must also not predate retained
				// history, or the sender upgrades to a base copy.
				await Rows.put({ id: 'seed-1', label: 'seed', count: 0 });
				const laterShape = { id: 'seed-2', label: 'seed', count: 0, nested: { flag: false } };
				if (path !== 'catch-up') await Rows.put(laterShape);
				await new Promise((resolve) => setTimeout(resolve, 5));
				const startTime = path === 'copy' ? 0 : Date.now();
				await new Promise((resolve) => setTimeout(resolve, 5));
				for (const row of expected) await Rows.put(row);
				// A peer catching up reads rows older than the newest shape: their structureVersion is lower
				// than the table's current count.
				if (path === 'catch-up') {
					await Rows.put(laterShape);
					expected.push(laterShape);
				}
				const encoder = Rows.primaryStore.encoder;
				const { typed, classic } = encoder.getStructureCounts();
				if (randomAccessFields) assert.ok(typed > 0, 'the table must hold typed structures');
				else assert.ok(classic > 0, 'the table must hold named structures');

				setReplicator(DATABASE, Rows, {});
				await until(() => databaseSubscriptions.get(DATABASE)?.auditStore, 'database subscription');
				socket = new Socket();
				replicateOverWS(socket, {}, { name: 'structure-peer', replicates: true });
				socket.emit(
					'message',
					encode([NODE_NAME, 'structure-peer', DATABASE, [], buildLocalCapabilities(90_000, false, true)])
				);
				await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME), 'handshake');
				socket._socket.writableNeedDrain = true;
				socket.emit(
					'message',
					encode([
						SUBSCRIPTION_REQUEST,
						[
							{
								name: getThisNodeName(),
								startTime,
								tables: [],
								replicateByDefault: true,
							},
						],
						[],
					])
				);
				await until(() => socket._socket.listenerCount('drain') > 0, 'sender parked after the first record');

				await failStructureSave(Rows);

				socket._socket.writableNeedDrain = false;
				socket._socket.emit('drain');
				if (path === 'copy') await until(() => socket.sent.some((frame) => frame[0] === COPY_COMPLETE), 'copy done');
				await until(() => expected.every(({ id }) => receive(socket, Rows.tableId).records.has(id)), 'both rows sent');

				const { records, advertised, flagged } = receive(socket, Rows.tableId);
				if (path !== 'copy')
					assert.ok(!socket.sent.some((frame) => frame[0] === COPY_START), 'expected the audit path');
				if (path === 'audit') assert.ok(!flagged, 'no forwarded entry may carry its own reload trigger');
				assert.ok(!records.has('unsaved'), 'the failed write must not replicate');
				assert.ok(advertised.length > 0, 'the peer needs a dictionary');
				for (const dictionary of advertised) assert.deepEqual(dictionary, { typed, classic, missingClassic: 0 });
				for (const row of expected) assert.deepEqual(records.get(row.id), row);
				assert.ok(!encoder.structures.uninitialized, 'the reload must clear the mark, or every record reloads');
			});
		}
	}
});
