/**
 * Drop markers a peer's `DB_SCHEMA` carries for a database not open on this thread are held in memory until
 * the database opens (`replication/DESIGN.md` item 28, harper-pro#956). Another thread can open that database
 * first and accept a stale generation of a dropped table; the holder's next pass must still record the
 * markers, so core retires that generation. These drive the real `replicateOverWS` handler over a fake
 * socket against real core tables; the other thread's open is a direct core create on this thread.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import sinon from 'sinon';
import { decode, encode } from 'msgpackr';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { databases, getTableDrops, isDroppedPeerGeneration, table } from '#src/core/resources/databases';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { heldDropMarkersFor, replicateOverWS } from '#src/replication/replicationConnection';
import { MAX_DROP_MARKERS_PER_FRAME } from '#src/replication/tableLifecycle';

const NODE_NAME = 140;
const DB_SCHEMA = 145;
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

const turns = async (count = 20) => {
	for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve));
};
async function until(predicate, what) {
	for (let turn = 0; turn < 500; turn++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`timed out waiting for ${what}`);
}

const sockets = [];
async function connect(peerName, databaseName) {
	const socket = new FakeSocket();
	sockets.push(socket);
	replicateOverWS(socket, {}, { name: peerName, replicates: true });
	socket.emit('message', encode([NODE_NAME, peerName, databaseName, [], buildLocalCapabilities(90_000, false, true)]));
	await turns();
	return socket;
}
const schemaFrame = (databaseName, definitions, markers) =>
	encode([DB_SCHEMA, definitions, databaseName, undefined, markers]);
const createStaleGeneration = (databaseName, tableName, createdTime) =>
	table({
		database: databaseName,
		table: tableName,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		origin: 'cluster',
		createdTime,
	});

describe('held drop markers (harper-pro#956)', function () {
	this.timeout(30_000);

	before(() => {
		setHdbBasePath(process.env.STORAGE_PATH);
	});

	afterEach(() => {
		sinon.restore();
		while (sockets.length) sockets.pop().close(1000);
	});

	it("retires a stale generation another thread accepted while this thread held the database's markers", async () => {
		const databaseName = 'heldMarkersStale';
		const droppedTime = Date.now() - 1000;
		const socket = await connect('peer-a', databaseName);

		socket.emit('message', schemaFrame(databaseName, [], [{ table: 'Stale', droppedTime }]));
		await until(() => heldDropMarkersFor(databaseName), 'the markers to be held');
		assert.equal(databases[databaseName], undefined, 'premise: the database is not open on this thread');
		assert.deepEqual(heldDropMarkersFor(databaseName), [{ table: 'Stale', droppedTime }]);

		// Another thread opens the database first and accepts the peer generation the held marker retires:
		// the marker is not in the catalog yet, so nothing there refuses it.
		const Stale = createStaleGeneration(databaseName, 'Stale', droppedTime - 60_000);
		await Stale.put({ id: 1, name: 'resurrected' });
		assert.equal(databases[databaseName].Stale, Stale, 'premise: the stale generation is live');
		assert.equal(isDroppedPeerGeneration(databaseName, 'Stale', droppedTime - 60_000), false);

		// The holder's next schema frame finds the database open and records what it held.
		socket.emit('message', schemaFrame(databaseName, [], []));
		await until(() => !databases[databaseName].Stale, 'core to retire the stale generation');
		await until(() => !heldDropMarkersFor(databaseName), 'the held entry to be released');

		assert.deepEqual(
			getTableDrops(databaseName).map(({ table, droppedTime }) => ({ table, droppedTime })),
			[{ table: 'Stale', droppedTime }]
		);
		assert.equal(isDroppedPeerGeneration(databaseName, 'Stale', droppedTime - 60_000), true);
		assert.deepEqual(socket.closes, []);
	});

	it('records held markers once a definition in the frame opens the database, refusing what they retire', async () => {
		const databaseName = 'heldMarkersOpenedByDefinition';
		const droppedTime = Date.now() - 1000;
		const socket = await connect('peer-a', 'system');

		socket.emit('message', schemaFrame(databaseName, [], [{ table: 'Gone', droppedTime }]));
		await until(() => heldDropMarkersFor(databaseName), 'the markers to be held');

		const attributes = [{ name: 'id', isPrimaryKey: true }];
		socket.emit(
			'message',
			schemaFrame(
				databaseName,
				[
					{ table: 'Gone', attributes, createdTime: droppedTime - 60_000 },
					{ table: 'Kept', attributes, createdTime: droppedTime + 1 },
				],
				[]
			)
		);
		await until(() => !heldDropMarkersFor(databaseName), 'the held entry to be released');

		assert.ok(databases[databaseName]?.Kept, "the frame's live definition opens the database");
		assert.equal(databases[databaseName].Gone, undefined, 'the held marker refuses the generation it retires');
		assert.deepEqual(
			getTableDrops(databaseName).map(({ table }) => table),
			['Gone']
		);
		assert.deepEqual(socket.closes, []);
	});

	it('keeps the held entry when an overlapping pass merged in a marker the finishing pass did not record', async () => {
		const databaseName = 'heldMarkersOverlap';
		const droppedTime = Date.now() - 1000;
		const first = await connect('peer-a', databaseName);
		const second = await connect('peer-b', databaseName);

		first.emit('message', schemaFrame(databaseName, [], [{ table: 'Stale', droppedTime }]));
		await until(() => heldDropMarkersFor(databaseName), 'the markers to be held');
		const Stale = createStaleGeneration(databaseName, 'Stale', droppedTime - 60_000);
		// Park each pass in its drop so the two overlap deterministically.
		const parked = [];
		sinon.stub(Stale, 'dropTable').callsFake(() => new Promise((resolve) => parked.push(resolve)));

		first.emit('message', schemaFrame(databaseName, [], []));
		await until(() => parked.length === 1, 'the first pass to reach its drop');
		const firstPass = heldDropMarkersFor(databaseName);

		second.emit('message', schemaFrame(databaseName, [], [{ table: 'Fresh', droppedTime }]));
		await until(() => parked.length === 2, 'the second pass to reach its drop');
		const secondPass = heldDropMarkersFor(databaseName);
		assert.notEqual(secondPass, firstPass, 'premise: the second pass merged in a marker');

		parked[0](false);
		await turns();
		assert.equal(
			heldDropMarkersFor(databaseName),
			secondPass,
			'the first pass must not release what it did not record'
		);
		assert.deepEqual(
			secondPass.map(({ table }) => table),
			['Stale', 'Fresh']
		);

		parked[1](false);
		await until(() => !heldDropMarkersFor(databaseName), 'the second pass to release the entry');
		assert.ok(getTableDrops(databaseName).some(({ table }) => table === 'Fresh'));
	});

	it('bounds a held entry at the newest MAX_DROP_MARKERS_PER_FRAME markers', async () => {
		const databaseName = 'heldMarkersBound';
		const base = Date.now() - 100_000;
		const socket = await connect('peer-a', databaseName);
		const markers = Array.from({ length: MAX_DROP_MARKERS_PER_FRAME }, (_, i) => ({
			table: 't' + i,
			droppedTime: base + i,
		}));

		socket.emit('message', schemaFrame(databaseName, [], markers));
		await until(() => heldDropMarkersFor(databaseName), 'the markers to be held');
		assert.equal(heldDropMarkersFor(databaseName).length, MAX_DROP_MARKERS_PER_FRAME);

		socket.emit('message', schemaFrame(databaseName, [], [{ table: 'newest', droppedTime: base + 50_000 }]));
		await until(
			() => heldDropMarkersFor(databaseName).some(({ table }) => table === 'newest'),
			'the new marker to be held'
		);
		const held = heldDropMarkersFor(databaseName);
		assert.equal(held.length, MAX_DROP_MARKERS_PER_FRAME);
		assert.ok(!held.some(({ table }) => table === 't0'), 'the oldest held marker is dropped');
		assert.ok(held.some(({ table }) => table === 't1'));
	});
});
