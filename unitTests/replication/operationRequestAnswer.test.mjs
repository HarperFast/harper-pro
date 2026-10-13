/**
 * A peer's OPERATION_REQUEST is always answered on the connection it arrived on, with an error answer when
 * the body is not an operation, and the connection stays open. A request body that is not an object used to
 * throw again from its own error answer, which closed the connection (1011).
 */
import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import { replicateOverWS } from '#src/replication/replicationConnection';
// Registers server.operation, which the receive path dispatches through.
import '#src/core/server/serverHelpers/serverUtilities';
import { server } from '#src/core/server/Server';

const OPERATION_REQUEST = 136;
const OPERATION_RESPONSE = 137;
const OPEN = 1;
const CLOSED = 3;

class FakeSocket extends EventEmitter {
	readyState = OPEN;
	sent = [];
	closes = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		this.sent.push(decode(data));
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

async function settled(socket) {
	for (let turn = 0; turn < 50 && !socket.sent.length && !socket.closes.length; turn++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe('answering an OPERATION_REQUEST', function () {
	this.timeout(5_000);
	let socket;

	beforeEach(() => {
		socket = new FakeSocket();
		replicateOverWS(socket, {}, { name: 'peer-a', replicates: true });
	});

	afterEach(() => {
		socket.close(1000);
	});

	for (const [label, body] of [
		['null', null],
		['a string', 'not an operation'],
	]) {
		it(`answers a request whose body is ${label} with an error, and keeps the connection`, async () => {
			socket.emit('message', encode([OPERATION_REQUEST, body]));
			await settled(socket);
			expect(socket.closes).to.deep.equal([]);
			expect(socket.sent).to.have.length(1);
			const [command, answer] = socket.sent[0];
			expect(command).to.equal(OPERATION_RESPONSE);
			expect(answer.error).to.be.a('string');
			expect(answer.error.length).to.be.greaterThan(0);
		});
	}

	it('sends nothing once the connection has closed, and does not throw', async () => {
		socket.readyState = CLOSED;
		socket.emit('message', encode([OPERATION_REQUEST, null]));
		await settled(socket);
		await new Promise((resolve) => setImmediate(resolve));
		expect(socket.sent).to.deep.equal([]);
		expect(socket.closes).to.deep.equal([]);
	});

	// harper#1212: core trusts a drop's provenance only from the operation context, which a client's JSON body
	// cannot reach; it is passed only for drop_table, the one operation that reads it.
	describe('replicatedFrom', () => {
		let realOperation, received;

		beforeEach(() => {
			realOperation = server.operation;
			received = [];
			server.operation = (data, context) => {
				received.push({ data, context });
				return Promise.resolve({});
			};
		});

		afterEach(() => {
			server.operation = realOperation;
		});

		it('is passed in the context of a forwarded drop_table, never in its body', async () => {
			socket.emit('message', encode([OPERATION_REQUEST, { operation: 'drop_table', schema: 'data', table: 't' }]));
			await settled(socket);
			expect(received).to.have.length(1);
			expect(received[0].context.replicatedFrom).to.equal('peer-a');
			expect(received[0].data).to.not.have.property('replicatedFrom');
		});

		it('names the peer of an operation connection, which sends no NODE_NAME', async () => {
			const operationSocket = new FakeSocket();
			// a server-side socket: its authorization settles after the connection opens
			replicateOverWS(operationSocket, {}, Promise.resolve({ name: 'peer-b', replicates: true }));
			operationSocket.emit(
				'message',
				encode([OPERATION_REQUEST, { operation: 'drop_table', schema: 'data', table: 't', replicated: false }])
			);
			await settled(operationSocket);
			operationSocket.close(1000);
			expect(received).to.have.length(1);
			expect(received[0].context.replicatedFrom).to.equal('peer-b');
		});

		it('is left unset on every other operation', async () => {
			socket.emit('message', encode([OPERATION_REQUEST, { operation: 'set_configuration', logging_level: 'warn' }]));
			await settled(socket);
			expect(received).to.have.length(1);
			expect(received[0].context.replicatedFrom).to.equal(undefined);
			expect(received[0].data).to.not.have.property('replicatedFrom');
		});
	});

	// A relayed record_lock_recall answers with a frozen constant.
	describe('a result the operation still owns', () => {
		let realOperation;

		beforeEach(() => {
			realOperation = server.operation;
		});

		afterEach(() => {
			server.operation = realOperation;
		});

		async function answerTo(requestId) {
			const before = socket.sent.length;
			socket.emit('message', encode([OPERATION_REQUEST, { operation: 'record_lock_recall', requestId }]));
			for (let turn = 0; turn < 50 && socket.sent.length === before; turn++) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			expect(socket.sent).to.have.length(before + 1);
			const [command, answer] = socket.sent[before];
			expect(command).to.equal(OPERATION_RESPONSE);
			return answer;
		}

		it('answers a frozen result, ordinary or null-prototype, as a success carrying the requestId', async () => {
			server.operation = () => Promise.resolve(Object.freeze({ recalled: true }));
			expect(await answerTo(7)).to.deep.equal({ recalled: true, requestId: 7 });
			server.operation = () => Promise.resolve(Object.freeze(Object.assign(Object.create(null), { recalled: true })));
			expect(await answerTo(8)).to.deep.equal({ recalled: true, requestId: 8 });
			expect(socket.closes).to.deep.equal([]);
		});

		it('never writes into a shared result, which answers each request with its own requestId', async () => {
			const shared = { granted: false, reason: 'not-home', requestId: 'stale' };
			server.operation = () => Promise.resolve(shared);
			expect(await answerTo(9)).to.deep.equal({ granted: false, reason: 'not-home', requestId: 9 });
			expect(await answerTo(10)).to.deep.equal({ granted: false, reason: 'not-home', requestId: 10 });
			expect(shared).to.deep.equal({ granted: false, reason: 'not-home', requestId: 'stale' });
			server.operation = () => Promise.resolve(Object.freeze({ recalled: true, requestId: 'stale' }));
			expect(await answerTo(15)).to.deep.equal({ recalled: true, requestId: 15 });
		});

		it('encodes the copy as it would the original: a toJSON hook still applies, a skipped field is never read', async () => {
			const hooked = Object.assign(Object.create(null), { internal: 'not for the wire', message: 'ok' });
			Object.defineProperty(hooked, 'toJSON', {
				value() {
					return { message: this.message, requestId: this.requestId };
				},
			});
			server.operation = () => Promise.resolve(Object.freeze(hooked));
			expect(await answerTo(13)).to.deep.equal({ message: 'ok', requestId: 13 });
			server.operation = () =>
				Promise.resolve({
					recalled: true,
					get [Symbol('unencoded')]() {
						throw new Error('the encoder never reads symbol keys');
					},
				});
			expect(await answerTo(14)).to.deep.equal({ recalled: true, requestId: 14 });
		});

		it('answers a result whose field throws on read with one correlated error, and keeps the connection', async () => {
			server.operation = () =>
				Promise.resolve({
					get recalled() {
						throw new Error('unreadable result');
					},
				});
			const answer = await answerTo(11);
			expect(answer.requestId).to.equal(11);
			expect(answer.error).to.match(/unreadable result/);
			server.operation = () => Promise.resolve({ recalled: true });
			expect(await answerTo(12)).to.deep.equal({ recalled: true, requestId: 12 });
			expect(socket.closes).to.deep.equal([]);
		});
	});
});
