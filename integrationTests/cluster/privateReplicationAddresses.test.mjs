/**
 * Replication over private network addresses (harper-pro#1292).
 *
 * Three TLS nodes. A and B advertise a private URL on network `net1`, C on `net2`. Each private URL is a
 * TCP forwarder in this process, on its own loopback address, piping to the node's replication listener; it
 * records the source address of every connection (a node dials from its own address) and the bytes it
 * carries from the node. The forwarder's address is in no certificate, so a private dial only passes by
 * checking the certificate against the name the public dial uses.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition, stopAndTeardownNodes } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const PORT = 9933;
const TABLE = 'private_path';

function startForwarder(listenHost, targetHost) {
	const sockets = new Set();
	let server;
	const forwarder = {
		url: `wss://${listenHost}:${PORT}`,
		targetHost,
		sources: [],
		// bytes from the node to whoever dialed it: the replicated data, for a peer subscribed through here
		bytesFromNode: 0,
		open() {
			server = createServer((client) => {
				forwarder.sources.push(client.remoteAddress);
				const upstream = connect({ host: forwarder.targetHost, port: PORT });
				upstream.on('data', (chunk) => (forwarder.bytesFromNode += chunk.length));
				const end = () => {
					sockets.delete(client);
					sockets.delete(upstream);
					client.destroy();
					upstream.destroy();
				};
				for (const socket of [client, upstream]) {
					sockets.add(socket);
					socket.on('error', end);
					socket.on('close', end);
				}
				client.pipe(upstream).pipe(client);
			});
			return new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(PORT, listenHost, resolve);
			});
		},
		// stops accepting and cuts every connection it carries, as a private network outage would
		close() {
			for (const socket of sockets) socket.destroy();
			return new Promise((resolve) => server.close(() => resolve()));
		},
		dialsFrom(node) {
			return forwarder.sources.filter((source) => source === node.hostname).length;
		},
	};
	return forwarder;
}

function nodeOptions(hostname, network, privateUrl) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true },
			replication: {
				securePort: `${hostname}:${PORT}`,
				network,
				privateUrls: [{ url: privateUrl, network }],
			},
		},
	};
}

async function socketsTo(node, peer, signal) {
	const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
	return status.connections.find((connection) => connection.name === peer.hostname)?.database_sockets ?? [];
}

// the path of every database socket from `node` to `peer`, or undefined while any of them is down
async function pathsTo(node, peer, signal) {
	const sockets = await socketsTo(node, peer, signal);
	if (!sockets.length || !sockets.every((socket) => socket.connected)) return undefined;
	return [...new Set(sockets.map((socket) => socket.path))];
}

function waitForPath(node, peer, path, timeoutMs = 60_000) {
	let last;
	return waitForCondition(
		async (signal) => {
			last = await pathsTo(node, peer, signal);
			return last?.length === 1 && last[0] === path;
		},
		{ timeoutMs, description: () => `${node.hostname} → ${peer.hostname} path ${path} (last: ${last})` }
	);
}

async function insert(node, records) {
	await sendOperation(node, { operation: 'insert', database: 'data', table: TABLE, records });
}

async function countWithPrefix(node, prefix, signal) {
	const records = await sendOperation(
		node,
		{
			operation: 'search_by_value',
			database: 'data',
			table: TABLE,
			search_attribute: 'id',
			search_value: `${prefix}*`,
			get_attributes: ['id'],
		},
		{ signal }
	);
	return records.length;
}

function waitForCount(node, prefix, count) {
	let last;
	return waitForCondition(
		async (signal) => {
			last = await countWithPrefix(node, prefix, signal);
			return last === count;
		},
		{ timeoutMs: 60_000, description: () => `${node.hostname} to hold ${count} '${prefix}' records (has ${last})` }
	);
}

suite('replication over private network addresses', { timeout: 480_000 }, (ctx) => {
	before(async () => {
		const hosts = [];
		for (let i = 0; i < 6; i++) hosts.push(await getNextAvailableLoopbackAddress());
		ctx.forwarders = {
			A: startForwarder(hosts[3], hosts[0]),
			B: startForwarder(hosts[4], hosts[1]),
			C: startForwarder(hosts[5], hosts[2]),
		};
		await Promise.all(Object.values(ctx.forwarders).map((forwarder) => forwarder.open()));
		const start = async (hostname, network, forwarder) => {
			const nodeCtx = { name: ctx.name, harper: { hostname } };
			await startHarper(nodeCtx, nodeOptions(hostname, network, forwarder.url));
			return nodeCtx.harper;
		};
		ctx.nodes = await Promise.all([
			start(hosts[0], 'net1', ctx.forwarders.A),
			start(hosts[1], 'net1', ctx.forwarders.B),
			start(hosts[2], 'net2', ctx.forwarders.C),
		]);
		const [A, B, C] = ctx.nodes;
		for (const node of ctx.nodes) {
			await sendOperation(node, {
				operation: 'create_table',
				database: 'data',
				table: TABLE,
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'payload', type: 'String' },
				],
			});
		}
		for (const node of [B, C]) {
			await sendOperation(node, {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: A.hostname,
				authorization: node.admin,
			});
		}
		await waitForCondition(
			async (signal) => {
				for (const node of ctx.nodes)
					for (const peer of ctx.nodes) if (peer !== node && !(await pathsTo(node, peer, signal))) return false;
				return true;
			},
			{ timeoutMs: 120_000, description: 'every node connected to both peers' }
		);
	});

	after(async () => {
		await stopAndTeardownNodes(ctx.nodes ?? []);
		await Promise.all(Object.values(ctx.forwarders ?? {}).map((forwarder) => forwarder.close().catch(() => {})));
	});

	test('nodes on one network replicate over their private addresses; others over public', async () => {
		const [A, B, C] = ctx.nodes;
		for (const [node, peer, path] of [
			[A, B, 'private'],
			[B, A, 'private'],
			[A, C, 'public'],
			[C, A, 'public'],
			[B, C, 'public'],
			[C, B, 'public'],
		])
			// a dial made before add_node finished exchanging CAs fails on either address; the private one recovers
			await waitForPath(node, peer, path);
		ok(ctx.forwarders.A.dialsFrom(B) > 0, "B dials A's private address");
		ok(ctx.forwarders.B.dialsFrom(A) > 0, "A dials B's private address");
		equal(ctx.forwarders.A.dialsFrom(C) + ctx.forwarders.B.dialsFrom(C), 0, 'C never dials a net1 address');
		equal(ctx.forwarders.C.sources.length, 0, "nobody shares C's network");

		// B's writes reach A through B's private address
		const before = ctx.forwarders.B.bytesFromNode;
		const payload = 'x'.repeat(2048);
		await insert(
			B,
			Array.from({ length: 50 }, (_, i) => ({ id: `mesh-b-${i}`, payload }))
		);
		await insert(A, [{ id: 'mesh-a', payload: 'a' }]);
		await insert(C, [{ id: 'mesh-c', payload: 'c' }]);
		for (const node of ctx.nodes) await waitForCount(node, 'mesh-', 52);
		ok(
			ctx.forwarders.B.bytesFromNode - before > 50 * 2048 * 0.9,
			`B's records crossed its private address (${ctx.forwarders.B.bytesFromNode - before} bytes)`
		);
	});

	test('a private outage falls back to public with no lost writes, and recovery returns to private', async () => {
		const [A, B] = ctx.nodes;
		let written = 0;
		let writing = true;
		const writer = (async () => {
			while (writing) {
				await insert(B, [{ id: `flow-${String(written).padStart(5, '0')}`, payload: 'f' }]);
				written++;
				await delay(200);
			}
		})();
		try {
			await ctx.forwarders.B.close();
			await waitForPath(A, B, 'public-fallback');
			const writtenDuringOutage = written;
			await waitForCondition(async (signal) => (await countWithPrefix(A, 'flow-', signal)) >= writtenDuringOutage, {
				timeoutMs: 60_000,
				description: "B's writes during the outage reach A over the public URL",
			});

			const dialsBefore = ctx.forwarders.B.dialsFrom(A);
			const bytesBefore = ctx.forwarders.B.bytesFromNode;
			await ctx.forwarders.B.open();
			await waitForPath(A, B, 'private', 180_000);
			ok(ctx.forwarders.B.dialsFrom(A) > dialsBefore, "A dialed B's private address again");
			await delay(2000);
			ok(ctx.forwarders.B.bytesFromNode > bytesBefore, "B's writes cross its private address again");
		} finally {
			writing = false;
			await writer;
		}
		await waitForCount(A, 'flow-', written);
	});

	test('an address that answers with another node is never used', async () => {
		const [A, B, C] = ctx.nodes;
		await ctx.forwarders.B.close();
		// TCP, TLS and the WebSocket upgrade all succeed here, but with C's certificate
		ctx.forwarders.B.targetHost = C.hostname;
		await ctx.forwarders.B.open();
		await waitForPath(A, B, 'public-fallback');
		const dialsAfterFallback = ctx.forwarders.B.dialsFrom(A);
		await waitForCondition(async () => ctx.forwarders.B.dialsFrom(A) >= dialsAfterFallback + 2, {
			timeoutMs: 120_000,
			description: "A's probes keep checking B's private address",
		});
		deepEqual(await pathsTo(A, B), ['public-fallback'], 'A stays on the public URL');
		await insert(B, [{ id: 'imposter-check', payload: 'i' }]);
		await waitForCount(A, 'imposter-', 1);
	});
});
