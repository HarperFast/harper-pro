/**
 * A session that excludes its sender (the region grid's origin fallback lists the origin and excludes every other
 * managed node, the region-mate it is open to included) carries no base copy: copy rows go out under the sender's own
 * entry, so a copy there would be empty and its end would stand as the follower's position past every row of the
 * listed log it lacks. The sender closes instead.
 */
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { decode, encode } from 'msgpackr';
import { table } from '#src/core/resources/databases';
import { server } from '#src/core/server/Server';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { databaseSubscriptions, replicateOverWS } from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';

const SUBSCRIPTION_REQUEST = 129;
const NODE_NAME = 140;
const COPY_START = 148;
const REFUSAL = 'A link excluding its sender takes no base copy';

class Socket extends EventEmitter {
	readyState = 1;
	sent = [];
	closedWith;
	_socket = Object.assign(new EventEmitter(), { bytesRead: 0, bytesWritten: 0, writableNeedDrain: false });
	send(data) {
		this.sent.push(data[0] > 127 ? decode(Buffer.from(data)) : Buffer.from(data));
	}
	close(code = 1000, reason = '') {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.closedWith = { code, reason: String(reason) };
		this.emit('close', code, Buffer.from(String(reason)));
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
		await delay(10);
	}
}

describe('a session that excludes its sender', function () {
	this.timeout(20_000);
	const database = 'listedSessionNoCopy';
	const sockets = [];
	before(async () => {
		const Records = table({
			database,
			table: 'Records',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		setReplicator(database, Records, {});
		await until(() => databaseSubscriptions.get(database)?.auditStore, 'database subscription');
		await Records.put('first', { id: 'first' });
	});
	afterEach(() => {
		for (const socket of sockets.splice(0)) socket.close();
	});

	async function subscribe(listed, startTime, excluded = ['listed-peer', server.hostname]) {
		const socket = new Socket();
		sockets.push(socket);
		replicateOverWS(socket, {}, { name: 'listed-peer', replicates: true });
		socket.emit(
			'message',
			encode([NODE_NAME, 'listed-peer', database, [], buildLocalCapabilities(90_000, false, true)])
		);
		await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME), 'handshake');
		socket.emit(
			'message',
			encode([
				SUBSCRIPTION_REQUEST,
				[{ name: listed, startTime, tables: ['Records'], replicateByDefault: false }],
				excluded,
				undefined,
			])
		);
		return socket;
	}
	const copyStarted = (socket) => socket.sent.some((frame) => frame[0] === COPY_START);

	it('closes on a requested copy instead of sending an empty one', async () => {
		const socket = await subscribe('listed-origin', 0);
		await until(() => socket.closedWith, 'the session closes');
		assert.strictEqual(socket.closedWith.reason, REFUSAL);
		assert.strictEqual(copyStarted(socket), false, 'no base copy');
	});

	it('closes where the sender would force a copy', async () => {
		// a start this node holds no log for: replaying from it would skip what a copy would have carried
		const socket = await subscribe('listed-origin', 2);
		await until(() => socket.closedWith || copyStarted(socket), 'the session decides');
		assert.strictEqual(copyStarted(socket), false, 'no base copy');
		assert.strictEqual(socket.closedWith?.reason, REFUSAL);
	});

	it('still copies when the session lists the sender', async () => {
		const socket = await subscribe(server.hostname, 0, ['listed-peer']);
		await until(() => copyStarted(socket), 'a base copy starts');
		assert.notStrictEqual(socket.closedWith?.reason, REFUSAL);
	});

	it('still copies when it lists another node but does not exclude the sender, whose rows the copy then carries', async () => {
		const socket = await subscribe('listed-origin', 0, ['listed-peer']);
		await until(() => copyStarted(socket), 'a base copy starts');
		assert.notStrictEqual(socket.closedWith?.reason, REFUSAL);
	});
});
