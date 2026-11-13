/**
 * Failover keeps the shared name order in an unlabeled cluster so asymmetric cuts and latencies cannot form a cycle
 * (harper-pro#1291).
 *
 * Four nodes, names sorted n1 < n2 < n3 < n4. On n2, `regionNetworkInjector.mjs` delays pings to and messages from n4
 * by 40 ms and n1 by 2 ms, so n2 measures n1 as nearest. First n1's links to n4 and then n3 are cut, so n1 fails n3 over
 * to n2 (its only live peer). Then n2's link to n3 is cut: n2 must follow the shared ring order after n3 and fail n3 over
 * to n4 rather than back to the nearer n1, and a write at n3 must reach both n2 and n1.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition, stopAndTeardownNodes, logMark, readLogSince } from './clusterShared.mjs';
import { waitForCopiesSettled } from './regionTopologyShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const INJECTOR = join(import.meta.dirname, 'regionNetworkInjector.mjs');
// A failover socket excludes its peer, so it carries no base copy: it is refused while this node's copy from the cut
// node is unfinished, or while its start sits below the peer's own base copy, which a certified floor lifts it above.
// Every origin certifies one at this interval (30 s by default).
const FLOOR_INTERVAL_MS = 1000;

suite('Failover ring order avoids a latency cycle', { timeout: 600_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'failover-order-'));
		const hostnames = [];
		for (let i = 0; i < 4; i++) hostnames.push(await getNextAvailableLoopbackAddress());
		hostnames.sort();
		const [n1, n2, , n4] = hostnames;
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
							level: hostname === n1 || hostname === n2 ? 'info' : 'warn',
						},
						replication: { securePort: hostname + ':9933', pingInterval: 1000, failover: true },
						threads: { count: 1, preload: [INJECTOR] },
					},
					env: {
						HARPER_NO_FLUSH_ON_EXIT: true,
						HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: String(FLOOR_INTERVAL_MS),
						HARPER_TEST_PARTITION_FILE: join(workDir, `partition-${hostname}`),
						...(hostname === n2 && {
							HARPER_TEST_PEER_LATENCY_MS: JSON.stringify({ [n1]: 2, [n4]: 40 }),
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

	test('cutting n1 from n3 and n4 and then n2 from n3 fails n2 over to n4 rather than cycling with nearer n1', async () => {
		const [n1, n2, n3, n4] = nodes();
		await waitForCondition(
			async (signal) => {
				const [s1, s2] = await Promise.all([
					sendOperation(n1, { operation: 'cluster_status' }, { signal }),
					sendOperation(n2, { operation: 'cluster_status' }, { signal }),
				]);
				const socketOf = (status, name) =>
					status.connections
						.find((connection) => connection.name === name)
						?.database_sockets.find((socket) => socket.database === 'data');
				const live = (status, name) => socketOf(status, name)?.connected === true;
				return (
					live(s1, n2.hostname) &&
					live(s1, n3.hostname) &&
					live(s1, n4.hostname) &&
					live(s2, n1.hostname) &&
					live(s2, n3.hostname) &&
					live(s2, n4.hostname) &&
					socketOf(s2, n1.hostname).latency > 0 &&
					socketOf(s2, n4.hostname).latency > 30
				);
			},
			{
				timeoutMs: 300_000,
				description: 'n1 and n2 hold live links to every peer and n2 has measured n4 above 30 ms',
			}
		);
		await waitForCopiesSettled(nodes(), 'formation copies');
		// no operation reports a certified floor
		await delay(10 * FLOOR_INTERVAL_MS);
		// n4 first: cut together, n1 can fail n3 over to n4 before it sees n4 down, and then n4 over to n2
		const mark0 = await logMark(n1);
		await writeFile(join(workDir, `partition-${n1.hostname}`), JSON.stringify([n4.hostname]));
		await writeFile(join(workDir, `partition-${n4.hostname}`), JSON.stringify([n1.hostname]));
		await waitForCondition(
			async () => (await readLogSince(n1, mark0)).includes(`Failing over data from ${n4.hostname} to ${n2.hostname}`),
			{ timeoutMs: 60_000, description: 'n1 fails n4 over to n2 once n4 is cut' }
		);
		const mark1 = await logMark(n1);
		await writeFile(join(workDir, `partition-${n1.hostname}`), JSON.stringify([n3.hostname, n4.hostname]));
		await writeFile(join(workDir, `partition-${n3.hostname}`), JSON.stringify([n1.hostname]));
		await waitForCondition(
			async () => (await readLogSince(n1, mark1)).includes(`Failing over data from ${n3.hostname} to ${n2.hostname}`),
			{ timeoutMs: 60_000, description: 'n1 fails n3 over to n2 once n3 and n4 are cut' }
		);
		const mark2 = await logMark(n2);
		await writeFile(join(workDir, `partition-${n2.hostname}`), JSON.stringify([n3.hostname]));
		await writeFile(join(workDir, `partition-${n3.hostname}`), JSON.stringify([n1.hostname, n2.hostname]));
		await waitForCondition(
			async () => (await readLogSince(n2, mark2)).includes(`Failing over data from ${n3.hostname} to `),
			{ timeoutMs: 60_000, description: 'n2 fails over its cut link to n3' }
		);
		const log2 = await readLogSince(n2, mark2);
		assert.ok(
			log2.includes(`Failing over data from ${n3.hostname} to ${n4.hostname}`),
			`expected failover to ${n4.hostname} in ring order: ${log2.match(/Failing over data from \S+ to \S+/g)}`
		);
		await sendOperation(n3, {
			operation: 'insert',
			database: 'data',
			table: 'latency',
			records: [{ id: 'acyclic-failover' }],
		});
		for (const receiver of [n2, n1]) {
			await waitForCondition(
				async (signal) =>
					(
						await sendOperation(
							receiver,
							{
								operation: 'search_by_id',
								database: 'data',
								table: 'latency',
								ids: ['acyclic-failover'],
								get_attributes: ['id'],
							},
							{ signal }
						)
					).length === 1,
				{ timeoutMs: 60_000, description: `the write at n3 reaches ${receiver.hostname}` }
			);
		}
	});
});
