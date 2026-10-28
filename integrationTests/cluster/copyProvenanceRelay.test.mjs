import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const FIXTURE = join(import.meta.dirname, 'fixture-copy-provenance');

async function request(node, path, options = {}) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		...options,
		headers: {
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
			'Content-Type': 'application/json',
			...options.headers,
		},
		signal: options.signal ?? AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	assert.ok(response.status < 300, `${path}: ${response.status} ${text}`);
	return body;
}

// harper#3703: a base-copy frame past the replay boundary is applied as a put of the source row's body. The
// copy must stay a copy on every node that relays or receives that entry.
suite('copied puts keep their provenance through a relay', { timeout: 300_000, skip: isLMDB }, (ctx) => {
	const contexts = [];
	let center, origin, leaf;

	before(async () => {
		const settled = await Promise.allSettled(
			Array.from({ length: 3 }, async () => {
				const hostname = await getNextAvailableLoopbackAddress();
				const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
				const context = { name: ctx.name, harper: { hostname, dataRootDir } };
				contexts.push(context);
				await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true });
				await startHarper(context, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
						replication: { securePort: hostname + ':9933', databases: ['data'] },
					},
				});
				return context.harper;
			})
		);
		const failed = settled.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		const started = settled.map((result) => result.value);
		[center, origin, leaf] = started;
		// a star: the leaf reaches the origin's writes only through the center, which relays them
		for (const node of [origin, leaf])
			await sendOperation(node, {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: center.hostname,
				authorization: node.admin,
			});
		await waitForCondition(
			async (signal) => {
				const statuses = await Promise.all(
					started.map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }).catch(() => undefined))
				);
				return statuses.every(
					(status, index) =>
						status?.connections.length === (index === 0 ? 2 : 1) &&
						status.connections.every((connection) => connection.database_sockets.every((socket) => socket.connected))
				);
			},
			{ timeoutMs: 120_000, description: 'a three-node star' }
		);
	});

	after(async () => {
		for (const context of contexts) {
			await stopNodeProcess(context.harper).catch(() => {});
			await teardownHarper(context).catch((error) => console.error(error));
		}
	});

	const stateOn = (node, id, signal) => request(node, `RelayState/${id}`, { signal });

	test('the next hop does not certify a relayed copied put, which still supersedes a late write', async () => {
		await request(origin, 'Relayed/seed', { method: 'PUT', body: JSON.stringify({ id: 'seed', name: 'seed' }) });
		await waitForCondition(async (signal) => (await stateOn(leaf, 'seed', signal)).present, {
			timeoutMs: 30_000,
			description: 'the seed to reach the leaf through the center',
		});
		const version = Date.now() + 3_600_000;
		await request(center, 'RelayState', {
			method: 'POST',
			body: JSON.stringify({ copyPut: { id: 'copied', name: 'copied', count: 5 }, seed: 'seed', version }),
		});
		const relayed = await waitForCondition(
			async (signal) => {
				const state = await stateOn(leaf, 'copied', signal);
				return state.version === version && state;
			},
			{ timeoutMs: 30_000, description: 'the copied put to be relayed to the leaf' }
		);
		assert.equal(relayed.certified, false, 'the next hop certified a copied body');
		assert.equal((await stateOn(center, 'copied')).certified, false);

		// The origin's older increment reaches both after the copied put. The post-copy replay re-delivers writes a
		// copied body already holds, so the copy still supersedes it (harper#3704 tracks the ones it lacks).
		await request(origin, 'RelayState/copied', {
			method: 'PUT',
			body: JSON.stringify({ id: 'copied', version: version - 60_000 }),
		});
		await request(origin, 'Relayed/barrier', {
			method: 'PUT',
			body: JSON.stringify({ id: 'barrier', name: 'barrier' }),
		});
		for (const node of [center, leaf]) {
			await waitForCondition(async (signal) => (await stateOn(node, 'barrier', signal)).present, {
				timeoutMs: 30_000,
				description: 'the origin writes before the barrier to arrive',
			});
			const copied = await stateOn(node, 'copied');
			assert.equal(copied.value.count, 5, 'an increment the copied body may hold is not applied again');
			assert.equal(copied.certified, false);
		}
	});
});
