// A leader that accepts a clone request and never finishes answering is a failed attempt on both transports.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import sinon from 'sinon';
import { requestLeader } from '#src/cloneNode/leaderRequest';
import { cloneSSHKeysFromLeader } from '#src/cloneNode/sshKeyClone';

const require = createRequire(import.meta.url);
const replicationConnection = require('#src/replication/replicationConnection');

const DEADLINE_MS = 100;
const sshKeysThrough = (requestLeader) =>
	cloneSSHKeysFromLeader({
		requestLeader,
		addSSHKey: async () => {},
		localSSHKeyState: async () => 'absent',
		removeLocalSSHKey: async () => {},
		log: () => {},
		retryDelayMs: 1,
	});

// Mocha runs these without a timeout; a deadline that regresses must fail here, not hang the run.
describe('requestLeader', function () {
	this.timeout(5_000);

	describe('over HTTP', () => {
		let server;
		let target;
		let handle;
		let requests;
		let uncaught;
		const onUncaught = (error) => uncaught.push(error);

		before(async () => {
			server = createServer((request, response) => {
				requests++;
				request.resume();
				handle(response);
			});
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			target = {
				http: {
					url: `http://127.0.0.1:${server.address().port}`,
					authorization: 'Bearer token',
					rejectUnauthorized: true,
				},
			};
		});

		beforeEach(() => {
			requests = 0;
			uncaught = [];
			process.on('uncaughtException', onUncaught);
		});

		afterEach(() => {
			process.off('uncaughtException', onUncaught);
			server.closeAllConnections();
		});

		after(() => server.close());

		const deadlineError = { message: `get_status to the leader did not answer within ${DEADLINE_MS}ms` };

		it('rejects at the deadline when the leader accepts and never answers', async () => {
			handle = () => {};
			const started = Date.now();
			await assert.rejects(requestLeader(target, { operation: 'get_status' }, DEADLINE_MS), deadlineError);
			assert.ok(Date.now() - started < 2_000, 'did not wait for the idle timer');
		});

		it('rejects at the deadline when the leader sends headers and then nothing', async () => {
			handle = (response) => response.writeHead(200, { 'Content-Type': 'application/json' }).flushHeaders();
			await assert.rejects(requestLeader(target, { operation: 'get_status' }, DEADLINE_MS), deadlineError);
		});

		it('rejects at the deadline when the body keeps trickling, which the idle timer alone would allow', async () => {
			let trickle;
			handle = (response) => {
				response.writeHead(200, { 'Content-Type': 'application/json' });
				trickle = setInterval(() => response.write(' '), 10);
			};
			try {
				await assert.rejects(requestLeader(target, { operation: 'get_status' }, DEADLINE_MS), deadlineError);
			} finally {
				clearInterval(trickle);
			}
		});

		it('tears down the connection and raises nothing uncaught', async () => {
			let closed;
			handle = (response) => {
				response.writeHead(200, { 'Content-Type': 'application/json' }).flushHeaders();
				closed = once(response, 'close');
			};
			await assert.rejects(requestLeader(target, { operation: 'get_status' }, DEADLINE_MS));
			await closed;
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(uncaught, []);
		});

		it('returns a prompt answer, and the deadline does not fire after it', async () => {
			handle = (response) => {
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ ok: true }));
			};
			assert.deepEqual(await requestLeader(target, { operation: 'get_status' }, DEADLINE_MS), { ok: true });
			await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 2));
			assert.deepEqual(uncaught, []);
		});

		it('keeps reporting a leader failure as that failure, not as the deadline', async () => {
			handle = (response) => {
				response.writeHead(500, 'Internal Server Error', { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ error: 'no such key' }));
			};
			await assert.rejects(requestLeader(target, { operation: 'get_status' }, DEADLINE_MS), {
				message: 'Leader request failed: 500 Internal Server Error: no such key',
			});
		});

		it('counts a silent leader as a failed attempt, so the retry loop advances and gives up', async () => {
			handle = () => {};
			await assert.rejects(
				sshKeysThrough((operation) => requestLeader(target, operation, DEADLINE_MS)),
				/list_ssh_keys failed on the leader 3 times: list_ssh_keys to the leader did not answer/
			);
			assert.equal(requests, 3);
		});

		it('also bounds a leader that holds the connection before reading the request', async () => {
			const silent = createNetServer();
			const sockets = new Set();
			silent.on('connection', (socket) => {
				sockets.add(socket);
				socket.on('error', () => {});
			});
			silent.listen(0, '127.0.0.1');
			await once(silent, 'listening');
			try {
				await assert.rejects(
					requestLeader(
						{ http: { ...target.http, url: `http://127.0.0.1:${silent.address().port}` } },
						{ operation: 'get_status' },
						DEADLINE_MS
					),
					deadlineError
				);
			} finally {
				for (const socket of sockets) socket.destroy();
				silent.close();
			}
		});
	});

	describe('over the replication socket', () => {
		const sandbox = sinon.createSandbox();
		const transport = { replicationURL: 'wss://leader.example.com:9933', rejectUnauthorized: false };
		let socket;
		let sent;
		let answer;

		beforeEach(() => {
			socket = Object.assign(new EventEmitter(), { readyState: 1, close: () => {} });
			sent = 0;
			answer = new Promise(() => {});
			sandbox.stub(replicationConnection, 'createWebSocket').resolves(socket);
			sandbox.stub(replicationConnection, 'replicateOverWS').returns({
				sendOperation: () => {
					sent++;
					return answer;
				},
			});
		});

		afterEach(() => sandbox.restore());

		it('rejects at the deadline when the leader accepts and never answers', async () => {
			await assert.rejects(
				requestLeader(transport, { operation: 'get_status' }, DEADLINE_MS),
				/get_status to wss:\/\/leader.example.com:9933 did not answer within 100ms/
			);
		});

		it('counts a silent leader as a failed attempt, so the retry loop advances and gives up', async () => {
			await assert.rejects(
				sshKeysThrough((operation) => requestLeader(transport, operation, DEADLINE_MS)),
				/list_ssh_keys failed on the leader 3 times/
			);
			assert.equal(sent, 3);
		});

		it('answers an array as an array, as HTTP does, though the socket wraps it to carry the request id', async () => {
			answer = Promise.resolve({ results: [{ name: 'key-1' }], requestId: 1 });
			assert.deepEqual(await requestLeader(transport, { operation: 'list_ssh_keys' }), [{ name: 'key-1' }]);
		});

		it('leaves an object answer alone', async () => {
			answer = Promise.resolve({ version: '5.4.0', requestId: 1 });
			assert.deepEqual(await requestLeader(transport, { operation: 'registration_info' }), {
				version: '5.4.0',
				requestId: 1,
			});
		});
	});
});
