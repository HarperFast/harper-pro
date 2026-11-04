import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { decode, encode } from 'msgpackr';
import { table } from '#src/core/resources/databases';
import { server } from '#src/core/server/Server';
import { Decoder, getAuditResumeFloor, getDatabaseGeneration, readAuditEntry } from '#src/core/resources/auditStore';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import {
	databaseSubscriptions,
	floorFromAnotherGeneration,
	replicateOverWS,
} from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';

const SUBSCRIPTION_REQUEST = 129;
const NODE_NAME = 140;
const COPY_START = 148;

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
		await delay(10);
	}
}

function rows(socket) {
	const ids = [];
	for (const frame of socket.sent) {
		if (!Buffer.isBuffer(frame)) continue;
		const decoder = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
		decoder.position = 8;
		while (decoder.position < frame.length) {
			const length = decoder.readInt();
			const offset = decoder.position;
			decoder.position += length;
			if (length === 9 && frame[offset] === 11) continue;
			ids.push(readAuditEntry(frame, offset, offset + length).recordId);
		}
	}
	return ids;
}

async function youngDatabase(database) {
	const Records = table({ database, table: 'Records', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
	setReplicator(database, Records, {});
	await until(() => databaseSubscriptions.get(database)?.auditStore, 'database subscription');
	const { auditStore } = Records;
	const resumeFloor = getAuditResumeFloor(auditStore);
	assert.ok(Number.isFinite(resumeFloor), 'a fresh database records a finite resume floor');
	const floorStart = resumeFloor;
	await delay(5);
	await Records.put('first', { id: 'first' });
	let oldest;
	for (const entry of auditStore.getRange({ start: 1, log: 'local' })) {
		oldest = entry.txnLogKey;
		break;
	}
	assert.ok(oldest > floorStart, 'the start precedes the first log entry');
	return { Records, auditStore, generation: getDatabaseGeneration(auditStore)?.id, floorStart, oldest };
}

describe('a floor-only start below the sender’s first log entry', function () {
	this.timeout(20_000);
	const sockets = [];
	afterEach(() => {
		for (const socket of sockets.splice(0)) socket.close();
	});

	describe('floorFromAnotherGeneration', () => {
		let auditStore, generation;
		before(async () => {
			({ auditStore, generation } = await youngDatabase('floorGenerationHelper'));
			assert.equal(typeof generation, 'string');
		});

		it('is false for the generation this database is on', () => {
			assert.equal(floorFromAnotherGeneration(auditStore, generation), false);
		});

		it('is true for another generation, including an empty one', () => {
			for (const floorGeneration of ['f'.repeat(32), ''])
				assert.equal(floorFromAnotherGeneration(auditStore, floorGeneration), true);
		});

		it('says nothing for a start without a generation, or a malformed one', () => {
			for (const floorGeneration of [undefined, 7, { id: generation }])
				assert.equal(floorFromAnotherGeneration(auditStore, floorGeneration), false);
		});

		it('is true while this store has established no generation', () => {
			assert.equal(floorFromAnotherGeneration({}, generation), true);
		});
	});

	async function subscribe(database, startTime, subscription, extra = [], originCursors) {
		const socket = new Socket();
		sockets.push(socket);
		replicateOverWS(socket, {}, { name: 'floor-peer', replicates: true });
		socket.emit(
			'message',
			encode([NODE_NAME, 'floor-peer', database, [], buildLocalCapabilities(90_000, false, true)])
		);
		await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME), 'handshake');
		socket.emit(
			'message',
			encode([
				SUBSCRIPTION_REQUEST,
				[
					{ name: server.hostname, startTime, tables: ['Records'], replicateByDefault: false, ...subscription },
					...extra,
				],
				[],
				undefined,
				originCursors,
			])
		);
		return socket;
	}

	const copies = (socket) => until(() => socket.sent.some((frame) => frame[0] === COPY_START), 'a base copy starts');

	async function replaysIncrementally(socket) {
		await until(() => rows(socket).includes('first'), 'the log entry above the floor is replayed');
		assert.equal(
			socket.sent.some((frame) => frame[0] === COPY_START),
			false,
			'no base copy'
		);
	}

	describe('the sender', () => {
		let generation, floorStart, oldest;
		const database = 'floorStartSender';
		before(async () => {
			({ generation, floorStart, oldest } = await youngDatabase(database));
		});

		it('replays incrementally from a floor that names its generation', async () => {
			await replaysIncrementally(await subscribe(database, floorStart, { floorGeneration: generation }));
		});

		it('replays incrementally from the same start without a generation (a receiver that predates it)', async () => {
			await replaysIncrementally(await subscribe(database, floorStart, {}));
		});

		it('forces a base copy for the same start under another generation', async () => {
			await copies(await subscribe(database, floorStart, { floorGeneration: 'f'.repeat(32) }));
		});

		it('copies the rows at or below a start taken from another generation', async () => {
			const socket = await subscribe(database, oldest + 60_000, { floorGeneration: 'f'.repeat(32) });
			await copies(socket);
			await until(() => rows(socket).includes('first'), 'a row below the follower’s start is copied');
		});

		it('copies the rows below a start from another generation when another subscription already requests 0', async () => {
			const socket = await subscribe(database, oldest + 60_000, { floorGeneration: 'f'.repeat(32) }, [
				{ name: 'floor-relayed-origin', startTime: 0, tables: ['Records'], replicateByDefault: false },
			]);
			await copies(socket);
			await until(() => rows(socket).includes('first'), 'a row below the follower’s start is copied');
		});

		it('forces a base copy for another generation even when an earlier subscription would resume', async () => {
			await copies(
				await subscribe(database, oldest + 1, { floorGeneration: 'f'.repeat(32) }, [
					{ name: 'floor-relayed-origin', startTime: oldest, tables: ['Records'], replicateByDefault: false },
				])
			);
		});
	});
});
