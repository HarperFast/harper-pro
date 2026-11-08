/**
 * Failover picks the lowest-latency live peer (harper-pro#1291) in a cluster with no regions.
 *
 * Four nodes, names sorted n1 < n2 < n3 < n4. On n1, `regionNetworkInjector.mjs` delays pings to and messages from n3
 * by 40 ms and n4 by 2 ms, so n1 measures n4 as nearest; the ring order failover used alone would take n3 first after
 * n2. Then the n1–n2 link is cut both ways while n2 keeps running: n1 must fail n2's log over to n4, and a write at
 * n2 must reach n1 through it.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition, stopAndTeardownNodes, logMark, readLogSince } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const INJECTOR = join(import.meta.dirname, 'regionNetworkInjector.mjs');

suite('Failover orders candidates by latency', { timeout: 600_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'failover-latency-'));
		const hostnames = [];
		for (let i = 0; i < 4; i++) hostnames.push(await getNextAvailableLoopbackAddress());
		hostnames.sort();
		const [observer, , far, near] = hostnames;
		for (const name of hostnames) await writeFile(join(workDir, `partition-${name}`), '[]');
		const started = await Promise.allSettled(
			hostnames.map(async (hostname) => {
				const context = { name: ctx.name, harper: { hostname } };
				await startHarper(context, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: {
							colors: false,
							console: true,
							stdStreams: false,
							level: hostname === observer ? 'info' : 'warn',
						},
						replication: { securePort: hostname + ':9933', pingInterval: 1000, failover: true },
						threads: { count: 1, preload: [INJECTOR] },
					},
					env: {
						HARPER_NO_FLUSH_ON_EXIT: true,
						HARPER_TEST_PARTITION_FILE: join(workDir, `partition-${hostname}`),
						...(hostname === observer && {
							HARPER_TEST_PEER_LATENCY_MS: JSON.stringify({ [far]: 40, [near]: 2 }),
						}),
					},
				});
				return context;
			})
		);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		contexts.sort((a, b) => (a.harper.hostname < b.harper.hostname ? -1 : 1));
		for (const node of nodes()) {
			await sendOperation(node, {
				operation: 'create_table',
				table: 'latency',
				primary_key: 'id',
				attributes: [{ name: 'id', type: 'ID' }],
			});
		}
		const seed = nodes()[0];
		const { operation_token } = await sendOperation(seed, {
			operation: 'create_authentication_tokens',
			authorization: seed.admin,
		});
		for (const node of nodes().slice(1)) {
			await sendOperation(node, {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: seed.hostname,
				authorization: 'Bearer ' + operation_token,
			});
		}
	});

	after(async () => {
		await stopAndTeardownNodes(nodes());
		if (workDir) await rm(workDir, { recursive: true, force: true });
	});

	test('a cut link fails over to the nearest live peer, and writes arrive through it', async () => {
		const [observer, origin, far, near] = nodes();
		await waitForCondition(
			async (signal) => {
				const status = await sendOperation(observer, { operation: 'cluster_status' }, { signal });
				const socketOf = (name) =>
					status.connections
						.find((connection) => connection.name === name)
						?.database_sockets.find((socket) => socket.database === 'data');
				const live = (name) => socketOf(name)?.connected === true;
				return (
					live(origin.hostname) &&
					live(near.hostname) &&
					live(far.hostname) &&
					socketOf(near.hostname).latency > 0 &&
					socketOf(far.hostname).latency > 30
				);
			},
			{
				timeoutMs: 300_000,
				description: 'the observer holds live links to every peer and has measured the far one above 30 ms',
			}
		);
		const mark = await logMark(observer);
		await writeFile(join(workDir, `partition-${observer.hostname}`), JSON.stringify([origin.hostname]));
		await writeFile(join(workDir, `partition-${origin.hostname}`), JSON.stringify([observer.hostname]));
		await waitForCondition(
			async () => (await readLogSince(observer, mark)).includes(`Failing over data from ${origin.hostname} to `),
			{ timeoutMs: 60_000, description: 'the observer fails over the cut link' }
		);
		const log = await readLogSince(observer, mark);
		assert.ok(
			log.includes(`Failing over data from ${origin.hostname} to ${near.hostname}`),
			`expected failover to ${near.hostname}: ${log.match(/Failing over data from \S+ to \S+/g)}`
		);
		await sendOperation(origin, {
			operation: 'insert',
			database: 'data',
			table: 'latency',
			records: [{ id: 'through-nearest' }],
		});
		await waitForCondition(
			async (signal) =>
				(
					await sendOperation(
						observer,
						{
							operation: 'search_by_id',
							database: 'data',
							table: 'latency',
							ids: ['through-nearest'],
							get_attributes: ['id'],
						},
						{ signal }
					)
				).length === 1,
			{ timeoutMs: 60_000, description: 'the write at the cut-off origin reaches the observer' }
		);
	});
});
