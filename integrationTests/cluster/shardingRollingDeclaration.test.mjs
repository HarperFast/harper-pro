import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, postOperation, waitForCondition, stopAndTeardownNodes, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '../../dist/bin/harper.js');
const fixture = join(import.meta.dirname, 'fixture-sharding-rolling');

suite('Rolling local sharding declaration', { timeout: 360_000 }, (ctx) => {
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	// A peer's replicated map activation holds the map lock briefly; that 503 is thrown before anything is written.
	function initializeShardMap(node, operation) {
		return waitForCondition(
			async (signal) => {
				const { status, body } = await postOperation(
					node,
					{ operation: 'initialize_shard_map', database: 'data', ...operation },
					{ signal }
				);
				if (status === 503 && body?.error === 'Shard map update or activation is in progress for data; retry')
					return false;
				assert.equal(status, 200, JSON.stringify(body));
				return body;
			},
			{ timeoutMs: 30_000, description: `initialize_shard_map on ${node.hostname}` }
		);
	}
	async function local(node, signal) {
		const response = await fetch(node.httpURL + '/RollingLocal', {
			signal,
			headers: {
				Connection: 'close',
				Authorization: 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
			},
		});
		assert.equal(response.status, 200);
		return response.json();
	}
	before(async () => {
		for (let shard = 0; shard < 2; shard++) {
			const context = {
				name: ctx.name,
				harper: {
					hostname: await getNextAvailableLoopbackAddress(),
					dataRootDir: await mkdtemp(
						join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'rolling-shard-')
					),
				},
			};
			contexts.push(context);
			await cp(fixture, join(context.harper.dataRootDir, 'components', basename(fixture)), { recursive: true });
			await startHarper(context, {
				config: {
					threads: { count: 3 },
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, level: 'warn' },
					replication: {
						experimentalAttributeSlots: true,
						securePort: context.harper.hostname + ':9933',
						shard,
						shards: [0, 1],
						threads: 0,
						databases: '*',
					},
				},
			});
		}
		const [a, b] = nodes();
		const { operation_token } = await sendOperation(a, {
			operation: 'create_authentication_tokens',
			authorization: a.admin,
		});
		await sendOperation(b, {
			operation: 'add_node',
			hostname: a.hostname,
			authorization: 'Bearer ' + operation_token,
			rejectUnauthorized: false,
		});
		await waitForCondition(
			async (signal) =>
				(
					await Promise.all(nodes().map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal })))
				).every((status) =>
					status.connections.some((peer) =>
						peer.database_sockets.some((socket) => socket.database === 'data' && socket.connected)
					)
				),
			{ description: 'legacy peers connected' }
		);
	});
	after(() => stopAndTeardownNodes(nodes()));
	test('B then A activate equivalent local directives without a full process restart (F-1021)', async () => {
		for (const [shard, node] of nodes().entries()) {
			const response = await fetch(node.httpURL + '/RollingRows/' + shard, {
				method: 'PUT',
				signal: AbortSignal.timeout(10_000),
				headers: {
					'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ id: String(shard), tag: 'owned', body: 'row-' + shard }),
			});
			assert.ok(response.ok, await response.text());
		}
		let digest;
		for (const node of nodes()) {
			const map = await initializeShardMap(node, {
				slots: 2,
				ranges: [
					{ start: 0, end: 1, shard: 0 },
					{ start: 1, end: 2, shard: 1 },
				],
			});
			digest = map.digest;
			const comparison = await sendOperation(node, {
				operation: 'verify_shard_map',
				database: 'data',
				table: 'RollingRows',
				policy: { slots: 2, slotFrom: 'Number(id)' },
			});
			assert.equal(comparison.mismatches, 0);
		}
		const before = await Promise.all(nodes().map((node) => local(node, AbortSignal.timeout(10_000))));
		for (const index of [1, 0]) {
			const node = nodes()[index];
			const component = join(node.dataRootDir, 'components', basename(fixture));
			await writeFile(
				join(component, 'resources.js'),
				(await readFile(join(fixture, 'resources.js'), 'utf8')).replace(
					'tables.RollingRows.setResidencyById((id) => Number(id));',
					''
				)
			);
			await writeFile(
				join(component, 'schema.graphql'),
				(await readFile(join(fixture, 'schema.graphql'), 'utf8')).replace(
					'type RollingRows @table @export',
					'type RollingRows @table @export @sharded(slots: 2, slotFrom: "Number(id)")'
				)
			);
			await sendOperation(node, { operation: 'restart_service', service: 'http_workers' });
			const workers = new Set();
			await waitForCondition(
				async (signal) => {
					const states = await Promise.all(Array.from({ length: 6 }, () => local(node, signal)));
					for (const state of states) {
						if (state.policy?.slotFrom !== 'Number(id)') continue;
						workers.add(state.threadId);
						assert.equal(
							state.rows.find((row) => row.id === String(index)).version,
							before[index].rows.find((row) => row.id === String(index)).version
						);
					}
					return workers.size >= 3;
				},
				{ timeoutMs: 60_000, description: `node ${index} activates the local policy on all three HTTP workers` }
			);
			await initializeShardMap(node, { existing_owner: true, expected_digest: digest });
			if (index === 1) {
				await waitForCondition(
					async (signal) => {
						await local(nodes()[0], signal);
						return (await readLog(nodes()[0])).includes('Local schema does not declare sharding for data.RollingRows');
					},
					{ description: 'A observes B’s declaration before its own reload' }
				);
				assert.equal((await local(nodes()[0], AbortSignal.timeout(10_000))).policy, null);
			}
		}
		await waitForCondition(
			async (signal) =>
				(
					await Promise.all(nodes().map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal })))
				).every((status) => status.sharding?.data?.recovery?.phase === 'ready' && !status.sharding.data.errors.length),
			{ timeoutMs: 90_000, description: 'matching declarations recover live agreement' }
		);
		for (const node of nodes()) {
			await sendOperation(node, {
				operation: 'insert',
				database: 'healthy',
				table: 'HealthyRows',
				records: [{ id: node.hostname }],
			});
			const own = nodes().indexOf(node);
			const rows = await sendOperation(node, {
				operation: 'search_by_id',
				database: 'data',
				table: 'RollingRows',
				ids: [String(own)],
				get_attributes: ['*'],
			});
			assert.equal(rows[0].body, 'row-' + own);
		}
	});
});
