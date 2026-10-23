import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encode } from 'msgpackr';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { createResidencyMap } from '#src/core/resources/residencyPolicy';
import { readResidencyMap } from '#src/core/resources/residencyMaps';
import { replicateOverWS } from '#src/replication/replicationConnection';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';

class Socket extends EventEmitter {
	readyState = 1;
	closes = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send() {}
	close(code, reason) {
		this.closes.push({ code, reason });
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.emit('close', code, Buffer.from(reason ?? ''));
	}
	terminate() {
		this.close(1006);
	}
	ping() {}
	pause() {}
	resume() {}
}
const sockets = [];
const turns = async () => {
	for (let n = 0; n < 30; n++) await new Promise(setImmediate);
};
async function connect(database, authorization, options = {}) {
	const socket = new Socket();
	sockets.push(socket);
	replicateOverWS(socket, options, authorization);
	socket.emit(
		'message',
		encode([140, 'slot-setup-peer', database, [], buildLocalCapabilities(90_000, false, true), null])
	);
	await turns();
	assert.deepEqual(socket.closes, [], 'handshake succeeds before the tested frame');
	return socket;
}
async function sendMap(socket, frameDatabase, snapshot) {
	socket.emit('message', encode([145, [], frameDatabase, undefined, [], { snapshot, shardsDigest: null }]));
	for (let n = 0; n < 200 && !socket.closes.length && !readResidencyMap(snapshot.database); n++)
		await new Promise((resolve) => setTimeout(resolve, 5));
}
const snapshot = (database) => createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 0 }], 1);

describe('residency setup authority', function () {
	this.timeout(10_000);
	before(() => setHdbBasePath(process.env.STORAGE_PATH));
	afterEach(() => {
		while (sockets.length) sockets.pop().close(1000);
	});
	for (const [name, authorization, options] of [
		['credential', { username: 'reader', role: { permission: {} } }, {}],
		['false_grant', { name: 'slot-setup-peer', replicates: false }, {}],
		[
			'false_route',
			{ name: 'slot-setup-peer', replicates: true },
			{ routes: [{ hostname: 'slot-setup-peer', replicates: false }] },
		],
		[
			'send_only_route',
			{ name: 'slot-setup-peer', replicates: true },
			{ routes: [{ hostname: 'slot-setup-peer', replicates: { sends: true } }] },
		],
	])
		it(`refuses a map from ${name}`, async () => {
			const database = `slot_setup_${name}`;
			const socket = await connect(database, authorization, options);
			await sendMap(socket, database, snapshot(database));
			assert.ok(socket.closes.length, 'unauthorized frame closes the stream');
			assert.equal(readResidencyMap(database), undefined);
		});
	it('binds the snapshot to its database frame', async () => {
		const socket = await connect('slot_setup_frame', { replicates: true });
		await sendMap(socket, 'slot_setup_frame', snapshot('slot_setup_other'));
		assert.ok(socket.closes.length);
		assert.equal(readResidencyMap('slot_setup_other'), undefined);
	});
	it('installs an authorized snapshot', async () => {
		const database = 'slot_setup_allowed';
		const expected = snapshot(database);
		const socket = await connect(database, { replicates: true });
		await sendMap(socket, database, expected);
		assert.deepEqual(socket.closes, []);
		assert.deepEqual({ ...readResidencyMap(database) }, expected);
	});
});
