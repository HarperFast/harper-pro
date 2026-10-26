import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp, writeFile, appendFile, realpath, rm } from 'node:fs/promises';
import { basename, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	sendOperation,
	postOperation,
	stopNodeProcess,
	stopAndTeardownNodes,
	waitForCondition,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const fixture = join(import.meta.dirname, 'fixture-sharding-quarantine');

suite('Native sharding bootstrap', { timeout: 600_000 }, (ctx) => {
	const contexts = [];
	let lastStatuses;
	const start = (context, i) =>
		startHarper(context, {
			config: {
				threads: { count: 1 },
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, level: 'warn' },
				replication: {
					failover: true,
					securePort: context.harper.hostname + ':9933',
					databases: '*',
					shard: i % 2,
					shards: [0, 1],
				},
				operationsApi: { network: { domainSocket: false } },
			},
		});
	async function local(i, signal, origin = contexts[1].harper.hostname, update) {
		const node = contexts[i].harper;
		const response = await fetch(`${node.httpURL}/BootstrapLocal?origin=${encodeURIComponent(origin)}`, {
			signal,
			headers: {
				'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
				'Content-Type': 'application/json',
			},
			...(update ? { method: 'PUT', body: JSON.stringify(update) } : {}),
		});
		assert.equal(response.status, 200);
		return response.json();
	}
	async function dataPath(i) {
		const state = await local(i, AbortSignal.timeout(10_000));
		const path = await realpath(state.path);
		const root = await realpath(contexts[i].harper.dataRootDir);
		const within = relative(root, path);
		assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'wipe only this test node’s data root');
		return path;
	}
	async function ready(indices = [0, 1, 2, 3]) {
		try {
			await waitForCondition(
				async (signal) => {
					lastStatuses = await Promise.all(
						indices.map((i) => sendOperation(contexts[i].harper, { operation: 'cluster_status' }, { signal }))
					);
					return lastStatuses.every((status) => status.sharding?.data?.recovery?.phase === 'ready');
				},
				{ timeoutMs: 120_000, description: 'owners have a complete baseline' }
			);
		} catch (error) {
			console.log(
				'Readiness evidence:',
				JSON.stringify(await Promise.all(indices.map((i) => local(i, AbortSignal.timeout(5000)))))
			);
			throw error;
		}
	}
	async function ownedRows(i) {
		await waitForCondition(
			async (signal) => {
				const state = await local(i, signal);
				return [String(i % 2 ? 0 : 1), String(i % 2 ? 2 : 3)].every((id) =>
					state.rows.some((row) => row.id === id && row.body === 'from-' + id && !(row.flags & 5))
				);
			},
			{ timeoutMs: 30_000, description: `node ${i} stores complete owned bodies` }
		);
	}
	before(async () => {
		for (let i = 0; i < 4; i++) {
			const hostname = await getNextAvailableLoopbackAddress();
			const dataRootDir = await mkdtemp(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'shard-start-')
			);
			const context = { name: ctx.name, harper: { hostname, dataRootDir } };
			contexts.push(context);
			const component = join(dataRootDir, 'components', basename(fixture));
			await cp(fixture, component, { recursive: true });
			await writeFile(
				join(component, 'schema.graphql'),
				`type Rows @table @export @sharded(slots: 2, by: "region", slotFrom: "region == 'asia' ? 0 : 1") {
				id: ID @primaryKey
				region: String @indexed
				body: String
			}`
			);
			await appendFile(
				join(component, 'resources.js'),
				`
export class BootstrapLocal extends Resource {
 async put(update) {
  const Table = tables.Rows;
  const origin = Table.auditStore.loadLogs().indexOf(Table.auditStore.logByName.get(update.origin));
  if (!(origin > 0)) throw new Error('The future-bound fixture requires an existing remote origin');
  let changed = 0;
  for (const { key, value } of Table.dbisDB.getRange({ start: Symbol.for('seq'), end: [Symbol.for('seq'), Buffer.from([255])] })) {
   if (!value.nodes?.some(node => node.id === origin)) continue;
   await Table.dbisDB.put(key, { ...value, nodes: value.nodes.map(node => node.id === origin ? { ...node, closedFloor: update.floor, relayable: true } : node) });
   changed++;
  }
  await Table.dbisDB.flush({ allowWriteStall: true });
  return { changed };
 }
 get(target) {
  const Table = tables.Rows;
  const origin = Table.auditStore.loadLogs().indexOf(Table.auditStore.logByName.get(target.get('origin')));
  const cursors = Array.from(Table.dbisDB.getRange({ start: Symbol.for('seq'), end: [Symbol.for('seq'), Buffer.from([255])] }));
  return { path: Table.primaryStore.rootStore.path,
   localAudit: Array.from(Table.auditStore.getRange({ log: 0, start: 1, includeLogName: true }), entry => ({ table: entry.tableId, type: entry.type, id: entry.recordId, origin: entry.nodeId, log: entry.logName, slot: entry.residencySlot, key: entry.txnLogKey })),
   bootstrap: Array.from(Table.dbisDB.getRange({ start: Symbol.for('sharding-bootstrap-history'), end: [Symbol.for('sharding-bootstrap-history'), Buffer.from([255])] }), entry => entry.value),
   peers: server.nodes?.map(peer => ({ name: peer.name, shard: peer.shard, status: Array.from(new Uint32Array(Table.auditStore.getUserSharedBuffer(['replicated', 'data', peer.name], new ArrayBuffer(512)))) })),
   rows: Array.from(Table.primaryStore.getRange({ start: true }), entry => ({ id: entry.key, body: entry.value?.body, flags: entry.metadataFlags, slot: entry.residencySlot })),
   cursors: cursors.map(entry => ({ key: entry.key, value: entry.value })),
   originProgress: cursors.flatMap(entry => entry.value?.nodes?.filter(node => node.id === origin).map(node => ({ source: entry.key[1], ...node })) ?? []) };
 }
}
`
			);
			await start(context, i);
		}
		const first = contexts[0].harper;
		const { operation_token } = await sendOperation(first, {
			operation: 'create_authentication_tokens',
			authorization: first.admin,
		});
		for (const [index, { harper }] of contexts.slice(1).entries()) {
			await sendOperation(harper, {
				operation: 'add_node',
				hostname: first.hostname,
				authorization: 'Bearer ' + operation_token,
				rejectUnauthorized: false,
			});
			if (index === 0) {
				await ready([0, 1]);
				await sendOperation(first, {
					operation: 'insert',
					database: 'data',
					table: 'Rows',
					records: [{ id: 'before-join', region: 'asia', body: 'existing-before-late-origins' }],
				});
			}
		}
	});
	after(async () => {
		if (lastStatuses) console.log('Last sharding bootstrap statuses:', JSON.stringify(lastStatuses));
		await stopAndTeardownNodes(contexts.map((context) => context.harper));
	});
	test('a fresh four-node, two-shard cluster certifies every owner and serves writes', async () => {
		await ready();
		for (const [i, { harper }] of contexts.entries())
			await sendOperation(harper, {
				operation: 'insert',
				database: 'data',
				table: 'Rows',
				records: [{ id: String(i), region: i % 2 ? 'asia' : 'europe', body: 'from-' + i }],
			});
		try {
			await waitForCondition(
				async (signal) => {
					const responses = await Promise.all(
						contexts.map(({ harper }) =>
							sendOperation(
								harper,
								{
									operation: 'search_by_value',
									database: 'data',
									table: 'Rows',
									search_attribute: 'id',
									search_value: '*',
									get_attributes: ['*'],
								},
								{ signal }
							)
						)
					);
					return responses.every((rows) => rows.length === 5);
				},
				{ timeoutMs: 30_000, description: 'all four nodes read the inserted records' }
			);
		} catch (error) {
			console.log(
				'Startup readback evidence:',
				JSON.stringify(
					await Promise.all(
						contexts.map(async ({ harper }, i) => ({
							node: i,
							local: await local(i, AbortSignal.timeout(5000)),
							status: await sendOperation(
								harper,
								{ operation: 'cluster_status' },
								{ signal: AbortSignal.timeout(5000) }
							),
						}))
					)
				)
			);
			throw error;
		}
		assert.ok(lastStatuses.every((status) => status.connections.length === 3));
		for (let i = 0; i < 4; i++) await ownedRows(i);
	});
	test('an owner resumes an offline origin through its co-owner and visibly waits when both sources are down', async () => {
		try {
			await stopNodeProcess(contexts[2].harper);
			await sendOperation(
				contexts[1].harper,
				{
					operation: 'insert',
					database: 'data',
					table: 'Rows',
					records: [{ id: 'relay', region: 'asia', body: 'retained-by-co-owner' }],
				},
				{ signal: AbortSignal.timeout(30_000) }
			);
			await waitForCondition(
				async (signal) =>
					(await local(0, signal)).rows.some(
						(row) => row.id === 'relay' && row.body === 'retained-by-co-owner' && !(row.flags & 5)
					),
				{ timeoutMs: 30_000, description: 'co-owner stores the origin’s complete body' }
			);
			await stopNodeProcess(contexts[1].harper);
			await start(contexts[2], 2);
			await waitForCondition(
				async (signal) =>
					(await local(2, signal)).rows.some(
						(row) => row.id === 'relay' && row.body === 'retained-by-co-owner' && !(row.flags & 5)
					),
				{ timeoutMs: 90_000, description: 'owner recovers through a co-owner while origin is down' }
			);
			await stopNodeProcess(contexts[0].harper);
			await waitForCondition(
				async (signal) => {
					const status = await sendOperation(contexts[2].harper, { operation: 'cluster_status' }, { signal });
					return status.sharding?.data?.waitingOrigins?.some(
						(wait) => wait.origin === contexts[1].harper.hostname && wait.missingSource.includes('co-owner')
					);
				},
				{ timeoutMs: 60_000, description: 'missing origin and same-shard source are visible in status' }
			);
			const before = (await local(2, AbortSignal.timeout(10_000))).originProgress;
			assert.ok(before.length);
			await sendOperation(contexts[3].harper, {
				operation: 'insert',
				database: 'data',
				table: 'Rows',
				records: [{ id: 'nonowner-live', region: 'europe', body: 'other-stream-progress' }],
			});
			await waitForCondition(
				async (signal) => (await local(2, signal)).rows.some((row) => row.id === 'nonowner-live'),
				{ timeoutMs: 30_000, description: 'the non-owner remains live without advancing the waiting origin' }
			);
			assert.deepEqual((await local(2, AbortSignal.timeout(10_000))).originProgress, before);
		} catch (error) {
			console.log(
				'Relay failure evidence:',
				JSON.stringify(
					await Promise.all(
						[0, 2, 3].map(async (i) => ({
							node: i,
							local: await local(i, AbortSignal.timeout(5000)),
							status: await sendOperation(
								contexts[i].harper,
								{ operation: 'cluster_status' },
								{ signal: AbortSignal.timeout(5000) }
							),
						}))
					)
				)
			);
			throw error;
		} finally {
			for (const i of [0, 1]) {
				await stopNodeProcess(contexts[i].harper);
				await start(contexts[i], i);
			}
		}
		await ready();
	});
	test('a replaced owner recovers through its co-owner and waits for a newer origin bound held by another peer', async () => {
		const future = Date.now() + 30_000;
		const update = await local(3, AbortSignal.timeout(10_000), contexts[2].harper.hostname, {
			origin: contexts[2].harper.hostname,
			floor: future,
		});
		assert.ok(update.changed > 0);
		const path = await dataPath(2);
		await stopNodeProcess(contexts[2].harper);
		await rm(path, { recursive: true });
		await start(contexts[2], 2);
		await waitForCondition(
			async (signal) => {
				const status = await sendOperation(contexts[2].harper, { operation: 'cluster_status' }, { signal });
				return status.sharding?.data?.recovery?.reason?.includes(String(future));
			},
			{ timeoutMs: 15_000, description: 'replacement observes the newer peer-held origin bound before enabling writes' }
		);
		for (const region of ['asia', 'europe']) {
			const response = await postOperation(contexts[2].harper, {
				operation: 'insert',
				database: 'data',
				table: 'Rows',
				records: [{ id: 'held-' + region, region, body: 'must refuse' }],
			});
			assert.equal(response.status, 503);
		}
		await ready();
		assert.ok(Date.now() >= future);
		await ownedRows(2);
		await sendOperation(contexts[2].harper, {
			operation: 'insert',
			database: 'data',
			table: 'Rows',
			records: [{ id: 'after-recovery-bound', region: 'asia', body: 'above-peer-bound' }],
		});
		await waitForCondition(
			async (signal) =>
				(await local(3, signal, contexts[2].harper.hostname)).rows.some((row) => row.id === 'after-recovery-bound'),
			{ timeoutMs: 30_000, description: 'the peer with the newer bound receives the replacement’s write' }
		);
		const state = await local(2, AbortSignal.timeout(10_000));
		assert.ok(state.localAudit.some((row) => row.id === 'after-recovery-bound' && row.key >= future));
	});
	test('losing a whole shard requires a complete backup and cannot mint another empty baseline', async () => {
		const paths = await Promise.all([0, 2].map(dataPath));
		await Promise.all([0, 2].map((i) => stopNodeProcess(contexts[i].harper)));
		const backup = join(contexts[0].harper.dataRootDir, 'saved-shard-backup');
		await cp(paths[0], backup, { recursive: true });
		for (const path of paths) await rm(path, { recursive: true });
		for (const i of [0, 2]) await start(contexts[i], i);
		await waitForCondition(
			async (signal) => {
				lastStatuses = await Promise.all(
					[0, 2].map((i) => sendOperation(contexts[i].harper, { operation: 'cluster_status' }, { signal }))
				);
				return lastStatuses.every((status) => status.sharding?.data?.recovery?.backupRequired === true);
			},
			{ timeoutMs: 60_000, description: 'both lost owners require certified recovery or backup' }
		);
		for (const i of [0, 2]) {
			const response = await postOperation(
				contexts[i].harper,
				{
					operation: 'insert',
					database: 'data',
					table: 'Rows',
					records: [{ id: 'lost-' + i, region: 'asia', body: 'must refuse' }],
				},
				{ signal: AbortSignal.timeout(10_000) }
			);
			assert.equal(response.status, 503, JSON.stringify(response.body));
			assert.ok(!(await local(i, AbortSignal.timeout(10_000))).rows.some((row) => row.id === 'lost-' + i));
		}
		await stopNodeProcess(contexts[0].harper);
		await rm(paths[0], { recursive: true });
		await cp(backup, paths[0], { recursive: true });
		await start(contexts[0], 0);
		await ready();
		await ownedRows(0);
		await ownedRows(2);
	});
});
