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
import { ClientError, ServerError } from '#src/core/utility/errors/hdbError';

const OPERATION_REQUEST = 136;
const OPERATION_RESPONSE = 137;
const DISCONNECT = 142;
const OPEN = 1;
const CLOSING = 2;
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

class DelayedCloseSocket extends FakeSocket {
	close(code) {
		this.closes.push(code);
		this.readyState = CLOSING;
	}
	finishClose() {
		super.close(1000);
	}
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
			server.operation = (data, context, authorize) => {
				received.push({ data, context, authorize });
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

		for (const [label, principal, authorize] of [
			['node identity', { name: 'peer-c' }, false],
			['directional grant', { replicates: { sendsTo: [{ database: 'data' }] } }, false],
			['super_user', { role: { permission: { super_user: true } } }, true],
		]) {
			it(`admits a ${label} principal`, async () => {
				const admitted = new FakeSocket();
				try {
					replicateOverWS(admitted, {}, Promise.resolve(principal));
					admitted.emit('message', encode([OPERATION_REQUEST, { operation: 'user_info', requestId: 1 }]));
					await settled(admitted);
					expect(admitted.closes).to.deep.equal([]);
					expect(received).to.have.length(1);
					expect(received[0].authorize).to.equal(authorize);
				} finally {
					admitted.close(1000);
				}
			});
		}

		it('stops queued messages before the socket emits close', async () => {
			const denied = new DelayedCloseSocket();
			try {
				replicateOverWS(denied, {}, Promise.resolve({ username: 'reader', role: { permission: {} } }));
				for (const requestId of [1, 2])
					denied.emit('message', encode([OPERATION_REQUEST, { operation: 'user_info', requestId }]));
				await new Promise(setImmediate);
				expect(denied.closes).to.deep.equal([1008]);
				expect(received).to.deep.equal([]);
				expect(denied.sent).to.deep.equal([]);
			} finally {
				denied.finishClose();
			}
		});

		it('is left unset on every other operation', async () => {
			socket.emit('message', encode([OPERATION_REQUEST, { operation: 'set_configuration', logging_level: 'warn' }]));
			await settled(socket);
			expect(received).to.have.length(1);
			expect(received[0].context.replicatedFrom).to.equal(undefined);
			expect(received[0].data).to.not.have.property('replicatedFrom');
		});
	});

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

		it("answers a shared result with each request's own requestId", async () => {
			const shared = { granted: false, reason: 'not-home', requestId: 'stale' };
			server.operation = () => Promise.resolve(shared);
			expect(await answerTo(9)).to.deep.equal({ granted: false, reason: 'not-home', requestId: 9 });
			expect(await answerTo(10)).to.deep.equal({ granted: false, reason: 'not-home', requestId: 10 });
			server.operation = () => Promise.resolve(Object.freeze({ recalled: true, requestId: 'stale' }));
			expect(await answerTo(15)).to.deep.equal({ recalled: true, requestId: 15 });
		});

		it('encodes a copy as it would the original: a toJSON hook applies, a symbol getter is never read', async () => {
			const hooked = Object.assign(Object.create(null), { internal: 'not for the wire', message: 'ok' });
			Object.defineProperty(hooked, 'toJSON', {
				value() {
					return { message: this.message, requestId: this.requestId };
				},
			});
			server.operation = () => Promise.resolve(Object.freeze(hooked));
			expect(await answerTo(13)).to.deep.equal({ message: 'ok', requestId: 13 });
			const symbolGetter = Object.defineProperty(Object.create(null), Symbol('unencoded'), {
				enumerable: true,
				get() {
					throw new Error('the encoder never reads symbol keys');
				},
			});
			symbolGetter.recalled = true;
			server.operation = () => Promise.resolve(Object.freeze(symbolGetter));
			expect(await answerTo(14)).to.deep.equal({ recalled: true, requestId: 14 });
			server.operation = () =>
				Promise.resolve({
					recalled: true,
					get [Symbol('unencoded')]() {
						throw new Error('the encoder never reads symbol keys');
					},
				});
			expect(await answerTo(17)).to.deep.equal({ recalled: true, requestId: 17 });
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

describe("an operation error's status across the connection", function () {
	this.timeout(10_000);
	const ANSWER_DEADLINE_MS = 3_000;
	let realOperation;

	beforeEach(() => {
		realOperation = server.operation;
	});

	afterEach(() => {
		server.operation = realOperation;
	});

	const rejectionOf = (answered) =>
		answered.then(
			(result) => expect.fail(`expected a rejection, got ${JSON.stringify(result)}`),
			(error) => error
		);

	describe('between two sessions', () => {
		class PairedSocket extends FakeSocket {
			peer;
			send(data) {
				super.send(data);
				setImmediate(() => this.peer.readyState === OPEN && this.peer.emit('message', data));
			}
		}
		let requesterSocket, answererSocket, requester;

		beforeEach(() => {
			requesterSocket = new PairedSocket();
			answererSocket = new PairedSocket();
			requesterSocket.peer = answererSocket;
			answererSocket.peer = requesterSocket;
			requester = replicateOverWS(requesterSocket, {}, { name: 'peer-b', replicates: true });
			replicateOverWS(answererSocket, {}, { name: 'peer-a', replicates: true });
		});

		afterEach(() => {
			requesterSocket?.close(1000);
			answererSocket?.close(1000);
		});

		const fail = () => rejectionOf(requester.sendOperation({ operation: 'remove_node_fence' }, ANSWER_DEADLINE_MS));
		const lastAnswer = () => answererSocket.sent.at(-1)[1];

		for (const [label, thrown, statusCode, text] of [
			[
				'a 409 refusal',
				() => new ClientError('the removal was finalized', 409),
				409,
				'ClientError: the removal was finalized',
			],
			[
				'a refusal with the default status',
				() => new ClientError('node is required'),
				400,
				'ClientError: node is required',
			],
			[
				'a server error',
				() => new ServerError('another fence change is running', 503),
				503,
				'ServerError: another fence change is running',
			],
		]) {
			it(`rejects ${label} with its status and its rendered text`, async () => {
				server.operation = () => Promise.reject(thrown());
				const error = await fail();
				expect(error.statusCode).to.equal(statusCode);
				expect(error.message).to.equal(text);
			});
		}

		it('rejects an error that has no status without one', async () => {
			server.operation = () => Promise.reject(new Error('boom'));
			const error = await fail();
			expect(error.message).to.equal('Error: boom');
			expect(error).to.not.have.property('statusCode');
			expect(lastAnswer()).to.not.have.property('statusCode');
		});

		it('keeps the status of an operation that throws before it returns a promise', async () => {
			server.operation = () => {
				throw new ClientError('not while a removal is running', 409);
			};
			expect((await fail()).statusCode).to.equal(409);
		});

		it('keeps the status of an error raised while the result is read for sending', async () => {
			server.operation = () =>
				Promise.resolve(
					(async function* () {
						yield { id: 1 };
						throw new ClientError('the rows are gone', 409);
					})()
				);
			const error = await fail();
			expect(error.statusCode).to.equal(409);
			expect(error.message).to.equal('ClientError: the rows are gone');
		});

		it('sends only an integer error status', async () => {
			for (const statusCode of [200, 204, 399, 600, 409.5, '409', Number.NaN, null]) {
				server.operation = () => Promise.reject(Object.assign(new Error('odd'), { statusCode }));
				const error = await fail();
				expect(error, `statusCode ${String(statusCode)}`).to.not.have.property('statusCode');
				expect(lastAnswer(), `statusCode ${String(statusCode)}`).to.not.have.property('statusCode');
			}
		});

		it('answers an error that renders as no text as an error', async () => {
			for (const thrown of ['', { toString: () => '' }, { toString: () => 409 }]) {
				server.operation = () => Promise.reject(thrown);
				const error = await fail();
				expect(error.message).to.equal('Error');
				expect(error).to.not.have.property('statusCode');
			}
		});

		it('contains an error answer that cannot be sent: the request ends at its own deadline', async () => {
			server.operation = () => Promise.reject(new ClientError('the removal was finalized', 409));
			answererSocket.send = () => {
				throw new Error('socket write failed');
			};
			const unhandled = [];
			const noteUnhandled = (reason) => unhandled.push(reason);
			process.on('unhandledRejection', noteUnhandled);
			try {
				const error = await rejectionOf(requester.sendOperation({ operation: 'remove_node_fence' }, 200));
				expect(error.message).to.match(/did not answer within 200ms/);
			} finally {
				process.off('unhandledRejection', noteUnhandled);
			}
			expect(unhandled).to.deep.equal([]);
			expect(answererSocket.closes).to.deep.equal([]);
		});

		it('answers an error whose status throws on read as text, and answers the next operation', async () => {
			server.operation = () =>
				Promise.reject(
					Object.defineProperty(new Error('boom'), 'statusCode', {
						get() {
							throw new Error('unreadable status');
						},
					})
				);
			const error = await fail();
			expect(error.message).to.equal('Error: boom');
			expect(error).to.not.have.property('statusCode');
			server.operation = () => Promise.resolve({ fenced: true });
			const answer = await requester.sendOperation({ operation: 'remove_node_fence' }, ANSWER_DEADLINE_MS);
			expect(answer.fenced).to.equal(true);
			expect(requesterSocket.closes).to.deep.equal([]);
			expect(answererSocket.closes).to.deep.equal([]);
		});
	});

	describe('for an answer as received', () => {
		let socket, session;

		beforeEach(() => {
			socket = new FakeSocket();
			session = replicateOverWS(socket, {}, { name: 'peer-a', replicates: true });
		});

		afterEach(() => {
			socket?.close(1000);
		});

		async function rejectionFor(answer) {
			const before = socket.sent.length;
			const answered = rejectionOf(session.sendOperation({ operation: 'remove_node_fence' }, ANSWER_DEADLINE_MS));
			expect(socket.sent).to.have.length(before + 1);
			const [command, request] = socket.sent[before];
			expect(command).to.equal(OPERATION_REQUEST);
			socket.emit('message', encode([OPERATION_RESPONSE, { ...answer, requestId: request.requestId }]));
			return answered;
		}

		it('reads a ClientError from a peer that sends no status as a 400', async () => {
			const error = await rejectionFor({ error: 'ClientError: the removal was finalized' });
			expect(error.statusCode).to.equal(400);
			expect(error.message).to.equal('ClientError: the removal was finalized');
		});

		it('gives no status to any other error from a peer that sends none', async () => {
			for (const text of ['ServerError: busy', 'Error: boom', 'ClientErrors: not the class', 'a ClientError: inside'])
				expect(await rejectionFor({ error: text }), text).to.not.have.property('statusCode');
		});

		it("takes the peer's status whatever the error's class", async () => {
			expect((await rejectionFor({ error: 'ClientError: finalized', statusCode: 409 })).statusCode).to.equal(409);
			expect((await rejectionFor({ error: 'HdbError: not permitted', statusCode: 403 })).statusCode).to.equal(403);
			expect((await rejectionFor({ error: 'FenceLockTimeout: busy', statusCode: 503 })).statusCode).to.equal(503);
		});

		it('falls back the same way when the status is not an integer error status', async () => {
			for (const statusCode of [0, 200, 204, 302, 600, 409.5, '409', true, { valueOf: 409 }]) {
				const label = `statusCode ${JSON.stringify(statusCode)}`;
				expect((await rejectionFor({ error: 'ClientError: refused', statusCode })).statusCode, label).to.equal(400);
				expect(await rejectionFor({ error: 'ServerError: busy', statusCode }), label).to.not.have.property(
					'statusCode'
				);
			}
		});

		it('rejects an error that is not text without reading a class from it, and keeps the connection', async () => {
			for (const malformed of [
				{ toString: 1 },
				{ name: 'ClientError', message: 'refused' },
				['ClientError: refused'],
			]) {
				const error = await rejectionFor({ error: malformed });
				expect(error.message).to.equal('The peer answered with an error that is not text');
				expect(error, JSON.stringify(malformed)).to.not.have.property('statusCode');
			}
			expect(socket.closes).to.deep.equal([]);
		});
	});
});

describe('receiving operation replies', () => {
	it('settles a disconnected operation as closed before accepting later replies', async () => {
		const socket = new DelayedCloseSocket();
		try {
			const session = replicateOverWS(socket, {}, undefined, 'operation-replies');
			const result = session.sendOperation({ operation: 'user_info' }, 1_000).then(
				() => 'fulfilled',
				(error) => error.message
			);
			const [, { requestId }] = socket.sent[0];
			socket.emit('message', encode([DISCONNECT]));
			socket.emit('message', encode([OPERATION_RESPONSE, { requestId }]));
			await new Promise(setImmediate);
			expect(socket.readyState).to.equal(CLOSING);
			socket.finishClose();
			expect(await result).to.match(/^Connection closed/);
		} finally {
			if (socket.readyState !== CLOSED) socket.finishClose();
		}
	});

	it('correlates the reply to the outgoing request', async () => {
		const socket = new FakeSocket();
		try {
			const session = replicateOverWS(socket, {}, undefined, 'operation-replies');
			const result = session.sendOperation({ operation: 'user_info' }, 1_000);
			const [, { requestId }] = socket.sent[0];
			const answer = { requestId, username: 'peer-user' };
			socket.emit('message', encode([OPERATION_RESPONSE, answer]));
			expect(await result).to.deep.equal(answer);
		} finally {
			socket.close(1000);
		}
	});

	it('preserves forwarded refusal status and legacy ClientError fallback on error replies', async () => {
		const socket = new FakeSocket();
		try {
			const session = replicateOverWS(socket, {}, undefined, 'operation-replies');
			const replyError = async (answer) => {
				const before = socket.sent.length;
				const rejected = session.sendOperation({ operation: 'remove_node_fence' }, 1_000).then(
					(result) => expect.fail(`expected a rejection, got ${JSON.stringify(result)}`),
					(error) => error
				);
				const [, { requestId }] = socket.sent[before];
				socket.emit('message', encode([OPERATION_RESPONSE, { ...answer, requestId }]));
				return rejected;
			};
			const conflict = await replyError({ error: 'ClientError: the removal was finalized', statusCode: 409 });
			expect(conflict.statusCode).to.equal(409);
			expect(conflict.message).to.equal('ClientError: the removal was finalized');
			const legacy = await replyError({ error: 'ClientError: node is required' });
			expect(legacy.statusCode).to.equal(400);
			expect(legacy.message).to.equal('ClientError: node is required');
			expect(socket.closes).to.deep.equal([]);
		} finally {
			socket.close(1000);
		}
	});

	for (const [label, frame] of [
		['operation request', encode([OPERATION_REQUEST, { operation: 'user_info', requestId: 1 }])],
		['binary frame', Buffer.alloc(1)],
	]) {
		it(`closes the reply-only session on a ${label}`, async () => {
			const socket = new FakeSocket();
			try {
				replicateOverWS(socket, {}, undefined, 'operation-replies');
				socket.emit('message', frame);
				await settled(socket);
				expect(socket.closes).to.deep.equal([1008]);
				expect(socket.sent).to.deep.equal([]);
			} finally {
				socket.close(1000);
			}
		});
	}
});
