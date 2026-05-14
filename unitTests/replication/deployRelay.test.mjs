/**
 * Unit test for the direct-HTTPS deploy relay.
 *
 * Spins up a local HTTP server playing the role of a peer's operations API, stubs the
 * JWT mint function, and verifies that `relayDeployToNode` posts a multipart/form-data
 * body containing the expected fields and the staged payload file, with the right
 * Authorization header, and parses the response correctly.
 *
 * Run: `node --test unitTests/replication/deployRelay.test.mjs`
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { relayDeployToNode } from '#src/replication/deployRelay';

/**
 * Minimal multipart parser sufficient for tests — extracts field-name → string-value pairs
 * and the single file part's bytes/filename/mime. Doesn't depend on busboy (which would
 * mean adding a harper-pro dep just for tests). Assumes the request body fits in memory
 * (true for the test-sized fixtures here).
 */
function parseMultipart(body, boundary) {
	const out = { fields: {}, fileBytes: Buffer.alloc(0), fileFilename: undefined, fileMimeType: undefined };
	const sep = Buffer.from('\r\n--' + boundary);
	const parts = splitBuffer(Buffer.concat([Buffer.from('\r\n'), body]), sep);
	for (const part of parts) {
		// Drop the leading empty segment and the trailing `--` closing marker.
		if (part.length === 0 || part.equals(Buffer.from('--\r\n'))) continue;
		// Each part: \r\nheader-line\r\nheader-line\r\n\r\nbody\r\n
		const split = indexOfDouble(part);
		if (split === -1) continue;
		const headers = part.slice(0, split).toString('utf8');
		let value = part.slice(split + 4);
		if (value.length >= 2 && value[value.length - 2] === 0x0d && value[value.length - 1] === 0x0a) {
			value = value.slice(0, -2);
		}
		const nameMatch = /name="([^"]+)"/.exec(headers);
		const filenameMatch = /filename="([^"]*)"/.exec(headers);
		const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
		if (!nameMatch) continue;
		if (filenameMatch) {
			out.fileBytes = value;
			out.fileFilename = filenameMatch[1];
			out.fileMimeType = typeMatch?.[1];
		} else {
			out.fields[nameMatch[1]] = value.toString('utf8');
		}
	}
	return out;
}

function splitBuffer(buf, sep) {
	const out = [];
	let start = 0;
	while (start <= buf.length) {
		const idx = buf.indexOf(sep, start);
		if (idx === -1) {
			out.push(buf.slice(start));
			break;
		}
		out.push(buf.slice(start, idx));
		start = idx + sep.length;
	}
	return out;
}

function indexOfDouble(buf) {
	for (let i = 0; i < buf.length - 3; i++) {
		if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
	}
	return -1;
}

async function withPeerServer(handler) {
	const received = {
		method: '',
		url: '',
		headers: {},
		fields: {},
		fileBytes: Buffer.alloc(0),
		fileFilename: undefined,
		fileMimeType: undefined,
	};
	const server = createServer((req, res) => {
		received.method = req.method ?? '';
		received.url = req.url ?? '';
		received.headers = req.headers;
		const contentType = req.headers['content-type'] || '';
		if (typeof contentType === 'string' && contentType.startsWith('multipart/form-data')) {
			const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
			if (!boundary) {
				res.statusCode = 400;
				res.end('no boundary');
				return;
			}
			const chunks = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				const parsed = parseMultipart(Buffer.concat(chunks), boundary);
				Object.assign(received, parsed);
				const out = handler(received);
				res.statusCode = out.status;
				res.setHeader('content-type', 'application/json');
				res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
			});
		} else {
			res.statusCode = 415;
			res.end('expected multipart');
		}
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const addr = server.address();
	if (!addr || typeof addr === 'string') throw new Error('no server address');
	const port = addr.port;
	return {
		port,
		received,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

describe('relayDeployToNode', () => {
	test('streams a multipart deploy and parses the JSON response', async () => {
		const tmp = await mkdtemp(join(tmpdir(), 'relay-test-'));
		const payloadPath = join(tmp, 'payload.tar.gz');
		const payloadBytes = Buffer.alloc(100 * 1024).fill(0xab);
		await writeFile(payloadPath, payloadBytes);
		const server = await withPeerServer(() => ({
			status: 200,
			body: { message: 'Successfully deployed: demo' },
		}));
		try {
			const node = {
				name: 'peer-1',
				host: '127.0.0.1',
				port: server.port,
				rejectUnauthorized: false,
			};
			const result = await relayDeployToNode(
				node,
				{ operation: 'deploy_component', project: 'demo', restart: true, payload: 'should-be-stripped' },
				payloadPath,
				{ mintToken: async () => 'test-jwt-token' }
			);
			assert.equal(result.status, 'success');
			assert.equal(result.node, 'peer-1');
			assert.equal(result.message, 'Successfully deployed: demo');
			assert.equal(server.received.method, 'POST');
			assert.equal(server.received.headers.authorization, 'Bearer test-jwt-token');
			assert.equal(server.received.fields.operation, 'deploy_component');
			assert.equal(server.received.fields.project, 'demo');
			assert.equal(server.received.fields.restart, 'true', 'JSON-encoded booleans on the wire');
			assert.equal(server.received.fields.replicated, 'false', 'peer must NOT re-replicate');
			assert.equal(server.received.fields.payload, undefined, 'CLI/internal fields are stripped');
			assert.equal(server.received.fileBytes.length, payloadBytes.length, 'file part is intact');
			assert.deepEqual(server.received.fileBytes, payloadBytes);
			assert.equal(server.received.fileFilename, 'package.tar.gz');
			assert.equal(server.received.fileMimeType, 'application/gzip');
		} finally {
			await server.close();
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test('returns a failed result when the peer responds with a 4xx/5xx', async () => {
		const tmp = await mkdtemp(join(tmpdir(), 'relay-test-'));
		const payloadPath = join(tmp, 'payload.tar.gz');
		await writeFile(payloadPath, 'data');
		const server = await withPeerServer(() => ({
			status: 500,
			body: { error: 'Failed to install dependencies for demo' },
		}));
		try {
			const result = await relayDeployToNode(
				{ name: 'peer-1', host: '127.0.0.1', port: server.port, rejectUnauthorized: false },
				{ operation: 'deploy_component', project: 'demo' },
				payloadPath,
				{ mintToken: async () => 'token' }
			);
			assert.equal(result.status, 'failed');
			assert.equal(result.statusCode, 500);
			assert.match(String(result.reason), /Failed to install dependencies/);
		} finally {
			await server.close();
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test('returns a failed result when the token mint fails (no HTTP call attempted)', async () => {
		const tmp = await mkdtemp(join(tmpdir(), 'relay-test-'));
		const payloadPath = join(tmp, 'payload.tar.gz');
		await writeFile(payloadPath, 'data');
		let httpHit = false;
		const server = await withPeerServer(() => {
			httpHit = true;
			return { status: 200, body: {} };
		});
		try {
			const result = await relayDeployToNode(
				{ name: 'peer-1', host: '127.0.0.1', port: server.port, rejectUnauthorized: false },
				{ operation: 'deploy_component', project: 'demo' },
				payloadPath,
				{
					mintToken: async () => {
						throw new Error('peer rejected token request');
					},
				}
			);
			assert.equal(result.status, 'failed');
			assert.match(String(result.reason), /token mint failed: peer rejected token request/);
			assert.equal(httpHit, false, 'no HTTPS call should be made when token mint fails');
		} finally {
			await server.close();
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test('returns a failed result when the staged payload file is missing', async () => {
		const result = await relayDeployToNode(
			{ name: 'peer-1', host: '127.0.0.1', port: 1, rejectUnauthorized: false },
			{ operation: 'deploy_component', project: 'demo' },
			'/nonexistent/path/payload.tar.gz',
			{ mintToken: async () => 'token' }
		);
		assert.equal(result.status, 'failed');
		assert.match(String(result.reason), /staged payload missing/);
	});
});
