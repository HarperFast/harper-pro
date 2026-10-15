import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { encode as cborEncode } from 'cbor-x';
import { postToLeader, readLeaderResponse, readPackageResponse } from '#src/cloneNode/leaderHTTP';

describe('leaderHTTP', () => {
	let server;
	let target;
	let respond;
	let received;

	before(async () => {
		server = createServer(async (request, response) => {
			let body = '';
			for await (const chunk of request) body += chunk;
			received.push({ body: JSON.parse(body), authorization: request.headers.authorization });
			respond(response);
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		target = {
			url: `http://127.0.0.1:${server.address().port}`,
			authorization: 'Bearer token',
			rejectUnauthorized: true,
		};
	});

	beforeEach(() => {
		received = [];
	});

	after(async () => {
		server.closeAllConnections();
		server.close();
	});

	const operation = { operation: 'package_component', project: 'app', skip_node_modules: false, stream: true };

	it('returns a streamed archive as the response itself', async () => {
		respond = (response) => {
			response.writeHead(200, { 'Content-Type': 'application/gzip' });
			response.end(Buffer.from('archive bytes'));
		};
		const payload = await readPackageResponse(await postToLeader(target, operation));

		assert.ok(payload instanceof Readable);
		const chunks = [];
		for await (const chunk of payload) chunks.push(chunk);
		assert.equal(Buffer.concat(chunks).toString(), 'archive bytes');
		assert.deepEqual(received, [{ body: operation, authorization: 'Bearer token' }]);
	});

	it('returns the payload of a leader that answers with the envelope, in that one request', async () => {
		respond = (response) => {
			response.writeHead(200, { 'Content-Type': 'application/cbor' });
			response.end(cborEncode({ project: 'app', payload: 'YmFzZTY0' }));
		};
		assert.equal(await readPackageResponse(await postToLeader(target, operation)), 'YmFzZTY0');
		assert.equal(received.length, 1);
	});

	it('throws the leader reason for a failed package request', async () => {
		respond = (response) => {
			response.writeHead(500, 'Internal Server Error', { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: "Unable to locate project 'app'" }));
		};
		await assert.rejects(readPackageResponse(await postToLeader(target, operation)), {
			message: "Leader request failed: 500 Internal Server Error: Unable to locate project 'app'",
		});
	});

	it('decodes a JSON answer', async () => {
		respond = (response) => {
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ status: 'ok' }));
		};
		assert.deepEqual(await readLeaderResponse(await postToLeader(target, { operation: 'get_status' })), {
			status: 'ok',
		});
	});

	// The repository runs Mocha without a timeout; these bound themselves so a broken idle timeout fails them.
	const IDLE_MS = 200;
	const TEST_DEADLINE_MS = 5000;

	const stallMidArchive = (response) => {
		response.writeHead(200, { 'Content-Type': 'application/gzip' });
		response.write(Buffer.from('partial'));
	};
	const readAll = async (payload) => {
		for await (const _chunk of payload);
	};

	it('fails an archive the leader stops sending, naming the idle timeout', async function () {
		this.timeout(TEST_DEADLINE_MS);
		respond = stallMidArchive;
		const payload = await readPackageResponse(await postToLeader(target, operation, IDLE_MS));
		await assert.rejects(readAll(payload), {
			message: `package_component to the leader sent nothing for ${IDLE_MS}ms`,
		});
	});

	it('fails a stalled archive that nothing was reading yet', async function () {
		this.timeout(TEST_DEADLINE_MS);
		respond = stallMidArchive;
		const payload = await readPackageResponse(await postToLeader(target, operation, IDLE_MS));
		// as while preparation waits for its lock before extracting
		await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2));
		await assert.rejects(readAll(payload));
	});

	it('fails a leader that never answers', async function () {
		this.timeout(TEST_DEADLINE_MS);
		respond = () => {};
		await assert.rejects(postToLeader(target, { operation: 'get_status' }, IDLE_MS), {
			message: `get_status to the leader sent nothing for ${IDLE_MS}ms`,
		});
	});
});
