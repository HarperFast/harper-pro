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

	it('fails a leader that stops sending mid-archive, without an unhandled error', async () => {
		respond = (response) => {
			response.writeHead(200, { 'Content-Type': 'application/gzip' });
			response.write(Buffer.from('partial'));
		};
		const payload = await readPackageResponse(await postToLeader(target, operation, 200));
		// Nothing reads yet, as while preparation waits for its lock: the abort must still reach the late reader.
		await new Promise((resolve) => setTimeout(resolve, 400));
		await assert.rejects(
			async () => {
				for await (const _chunk of payload);
			},
			{ code: 'ECONNRESET' }
		);
	});

	it('fails a leader that never answers', async () => {
		respond = () => {};
		await assert.rejects(postToLeader(target, { operation: 'get_status' }, 200), {
			message: 'get_status to the leader sent nothing for 200ms',
		});
	});
});
