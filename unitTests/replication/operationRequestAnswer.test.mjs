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
});
