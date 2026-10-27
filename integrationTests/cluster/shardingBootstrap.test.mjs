import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, writeFile, appendFile, realpath, rm, readFile } from 'node:fs/promises';
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
	const retiredNodes = [];
	let lastStatuses;
	const start = (context, i) =>
		startHarper(context, {
			config: {
				threads: { count: 1 },
				analytics: { aggregatePeriod: -1 },
				logging: {
					colors: false,
					stdStreams: false,
					root: join(context.harper.dataRootDir, 'test-logs'),
					level: process.env.HARPER_TEST_SHARDING_LOG_LEVEL || (i === 0 ? 'debug' : 'warn'),
				},
				replication: {
					failover: true,
					threads: Number(process.env.HARPER_TEST_SHARDING_POOL || 0),
					securePort: context.harper.hostname + ':9933',
					databases: '*',
					shard: i % 2,
					shards: [0, 1],
				},
				operationsApi: { network: { domainSocket: false } },
			},
		});
	async function local(i, signal, origin = contexts[1].harper.hostname) {
		const node = contexts[i].harper;
		const response = await fetch(`${node.httpURL}/BootstrapLocal?origin=${encodeURIComponent(origin)}`, {
			signal,
			headers: {
				'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
				'Content-Type': 'application/json',
			},
		});
		assert.equal(response.status, 200);
		return response.json();
	}
	async function blob(i, seed = false, signal = AbortSignal.timeout(10_000)) {
		const node = contexts[i].harper;
		const response = await fetch(`${node.httpURL}/BootstrapBlob${seed ? '?seed=1' : ''}`, {
			signal,
			headers: {
				Authorization: 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
			},
		});
		assert.equal(response.status, 200, 'a ready owner must serve its owned blob');
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
	async function provision(i) {
		const hostname = await getNextAvailableLoopbackAddress();
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'shard-start-')
		);
		const context = { name: ctx.name, harper: { hostname, dataRootDir } };
		contexts[i] = context;
		const component = join(dataRootDir, 'components', basename(fixture));
		await cp(fixture, component, { recursive: true });
		await writeFile(
			join(component, 'schema.graphql'),
			`type Rows @table @export @sharded(slots: 2, by: "region", slotFrom: "region == 'asia' ? 0 : 1") {
				id: ID @primaryKey
				region: String @indexed
				body: String
				payload: Blob
			}`
		);
		await appendFile(
			join(component, 'resources.js'),
			`
import { transaction, createBlob } from 'harper';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
let releaseReservation, reservationDone, reservationTimer;
export class BootstrapReservation extends Resource {
 async get(target) {
  if (target.get('release')) {
   releaseReservation?.();
   await reservationDone;
   return { released: true };
  }
  if (releaseReservation) throw new Error('reservation already held');
  const started = Promise.withResolvers();
  const hold = Promise.withResolvers();
  const released = new Error('test reservation released');
  releaseReservation = hold.resolve;
  reservationTimer = setTimeout(hold.resolve, 120000).unref();
  reservationDone = transaction({}, async () => {
   await tables.Rows.put('held-reservation', { id: 'held-reservation', region: 'asia', body: 'never-committed' });
   started.resolve({ key: tables.Rows.primaryStore.rootStore.getMonotonicTimestamp(), threadId });
   await hold.promise;
   throw released;
  }).catch(error => {
   if (error !== released) { started.reject(error); throw error; }
  }).finally(() => { releaseReservation = undefined; clearTimeout(reservationTimer); });
  reservationDone.catch(() => {});
  return started.promise;
 }
}
export class BootstrapBlob extends Resource {
 async get(target) {
  const bytes = Buffer.alloc(65536, 79);
  if (target.get('seed')) await tables.Rows.put('replacement-blob', { id: 'replacement-blob', region: 'asia', body: 'copy-blob', payload: createBlob(Readable.from([bytes]), {saveBeforeCommit: true}) });
  const entry = await tables.Rows.primaryStore.getEntry('replacement-blob');
  if (!entry?.value?.payload) return { digest: null };
  const actual = Buffer.from(await entry.value.payload.arrayBuffer());
  return { digest: createHash('sha256').update(actual).digest('hex'), size: actual.length, version: entry.version };
 }
}
export class BootstrapLocal extends Resource {
 get(target) {
  const Table = tables.Rows;
  const origin = Table.auditStore.loadLogs().indexOf(Table.auditStore.logByName.get(target.get('origin')));
  const cursors = Array.from(Table.dbisDB.getRange({ start: Symbol.for('seq'), end: [Symbol.for('seq'), Buffer.from([255])] }));
  return { path: Table.primaryStore.rootStore.path,
   recoveryBound: Table.dbisDB.getSync([Symbol.for('sharding-origin-recovery-bound'), 'data']),
   localAudit: Array.from(Table.auditStore.getRange({ log: 0, start: 1, includeLogName: true }), entry => ({ table: entry.tableId, type: entry.type, id: entry.recordId, origin: entry.nodeId, log: entry.logName, slot: entry.residencySlot, key: entry.txnLogKey })),
   bootstrap: Array.from(Table.dbisDB.getRange({ start: Symbol.for('sharding-bootstrap-history'), end: [Symbol.for('sharding-bootstrap-history'), Buffer.from([255])] }), entry => entry.value),
   peers: server.nodes?.map(peer => ({ name: peer.name, shard: peer.shard, status: Array.from(new Uint32Array(Table.auditStore.getUserSharedBuffer(['replicated', 'data', peer.name], new ArrayBuffer(512)))) })),
   rows: Array.from(Table.primaryStore.getRange({ start: true }), entry => ({ id: entry.key, version: entry.version, body: entry.value?.body, flags: entry.metadataFlags, slot: entry.residencySlot })),
   cursors: cursors.map(entry => ({ key: entry.key, value: entry.value })),
   originProgress: cursors.flatMap(entry => entry.value?.nodes?.filter(node => node.id === origin).map(node => ({ source: entry.key[1], ...node })) ?? []) };
 }
}
`
		);
		await start(context, i);
	}
	before(async () => {
		for (let i = 0; i < 4; i++) await provision(i);
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
		await stopAndTeardownNodes([...contexts.map((context) => context.harper), ...retiredNodes]);
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
	test('a reconnect below issuance waits for an older worker reservation without holding writers', async () => {
		await ready();
		const node = contexts[0].harper;
		const headers = {
			Authorization: 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
		};
		const control = async (release = false) => {
			const response = await fetch(`${node.httpURL}/BootstrapReservation${release ? '?release=1' : ''}`, {
				headers,
				signal: AbortSignal.timeout(10_000),
			});
			assert.equal(response.status, 200);
			return response.json();
		};
		const held = await control();
		assert.ok(held.threadId > 0, 'a real request worker owns the reservation');
		try {
			await sendOperation(
				node,
				{
					operation: 'insert',
					database: 'data',
					table: 'Rows',
					records: [{ id: 'resume-cursor', region: 'asia', body: 'committed-above-reservation' }],
				},
				{ signal: AbortSignal.timeout(10_000) }
			);
			await waitForCondition(
				async (signal) =>
					(await local(2, signal)).rows.some((row) => row.id === 'resume-cursor' && row.version > held.key),
				{ timeoutMs: 30_000, description: 'peer holds a committed cursor above the older reservation' }
			);
			await stopNodeProcess(contexts[2].harper);
			await start(contexts[2], 2);
			await waitForCondition(
				async () => {
					const log = await readFile(join(node.logDir ?? join(node.dataRootDir, 'test-logs'), 'hdb.log'), 'utf8');
					return log.includes('Waiting for older local transactions before resuming sharding subscription');
				},
				{ timeoutMs: 30_000, description: 'the real reconnect reaches closed-prefix link admission' }
			);
			const status = await sendOperation(
				node,
				{ operation: 'cluster_status' },
				{ signal: AbortSignal.timeout(10_000) }
			);
			assert.equal(status.sharding.data.recovery.phase, 'ready');
			await sendOperation(
				node,
				{
					operation: 'insert',
					database: 'data',
					table: 'Rows',
					records: [{ id: 'resume-independent', region: 'asia', body: 'writer-remains-live' }],
				},
				{ signal: AbortSignal.timeout(10_000) }
			);
		} finally {
			await control(true);
		}
		await waitForCondition(
			async (signal) =>
				(await local(2, signal)).rows.some(
					(row) => row.id === 'resume-independent' && row.body === 'writer-remains-live' && !(row.flags & 5)
				),
			{ timeoutMs: 60_000, description: 'reconnected peer receives writes after the reservation settles' }
		);
		await ready();
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
	test('a lost origin refuses its old name, then a new name and the retired origin both converge', async () => {
		const oldName = contexts[2].harper.hostname;
		const expectedBlob = await blob(0, true);
		assert.equal(expectedBlob.size, 65_536);
		assert.equal(expectedBlob.digest, createHash('sha256').update(Buffer.alloc(65_536, 79)).digest('hex'));
		await waitForCondition(async (signal) => (await blob(2, false, signal)).digest === expectedBlob.digest, {
			description: 'co-owner receives the original blob before replacement',
		});
		await stopNodeProcess(contexts[3].harper);
		await sendOperation(contexts[2].harper, {
			operation: 'insert',
			database: 'data',
			table: 'Rows',
			records: [{ id: 'pending-old-origin', region: 'europe', body: 'retired-origin-body' }],
		});
		await waitForCondition(
			async (signal) =>
				(await local(1, signal, oldName)).rows.some(
					(row) => row.id === 'pending-old-origin' && row.body === 'retired-origin-body'
				),
			{ timeoutMs: 30_000, description: 'another shard retains the old-origin write while its co-owner is offline' }
		);
		const path = await dataPath(2);
		await stopNodeProcess(contexts[0].harper);
		await stopNodeProcess(contexts[2].harper);
		await rm(path, { recursive: true });
		await start(contexts[2], 2);
		let lost;
		await waitForCondition(
			async (signal) => {
				lost = await sendOperation(contexts[2].harper, { operation: 'cluster_status' }, { signal });
				return lost.sharding?.data?.recovery?.phase === 'origin-history-lost';
			},
			{ timeoutMs: 45_000, description: 'the wiped name reports missing origin history even while a member is offline' }
		);
		assert.match(lost.sharding.data.recovery.reason, /complete backup/);
		assert.match(lost.sharding.data.recovery.reason, /new node name/);
		await sendOperation(contexts[2].harper, {
			operation: 'initialize_shard_map',
			database: 'data',
			existing_owner: true,
			expected_digest: lost.sharding.data.digest,
		});
		const refusedAfter = Date.now() + 6000;
		await waitForCondition(
			async (signal) => {
				const status = await sendOperation(contexts[2].harper, { operation: 'cluster_status' }, { signal });
				assert.equal(
					status.sharding.data.recovery.phase,
					'origin-history-lost',
					JSON.stringify(status.sharding.data.recovery)
				);
				return Date.now() >= refusedAfter;
			},
			{ timeoutMs: 15_000, description: 'advancing wall time cannot clear missing history' }
		);
		for (const operation of [
			{ operation: 'sql', sql: 'SELECT * FROM `data`.`Rows`' },
			{ operation: 'sql', sql: "SELECT * FROM `data`.`Rows` WHERE id = 'lost-key'" },
			{
				operation: 'search_by_hash',
				database: 'data',
				table: 'Rows',
				hash_values: ['lost-key'],
				get_attributes: ['*'],
			},
		]) {
			const ownedQuery = await postOperation(contexts[2].harper, operation);
			assert.equal(ownedQuery.status, 503, JSON.stringify(ownedQuery));
		}
		for (const region of ['asia', 'europe']) {
			const response = await postOperation(contexts[2].harper, {
				operation: 'insert',
				database: 'data',
				table: 'Rows',
				records: [{ id: 'lost-' + region, region, body: 'must refuse' }],
			});
			assert.equal(response.status, 503);
		}
		await stopNodeProcess(contexts[2].harper);
		await start(contexts[0], 0);
		const removeOld = async (i) => {
			const response = await postOperation(contexts[i].harper, { operation: 'remove_node', hostname: oldName });
			if (response.status !== 200) {
				assert.equal(response.status, 400);
				assert.equal(response.body.error, oldName + ' does not exist');
			}
		};
		for (const i of [0, 1]) await removeOld(i);
		retiredNodes.push(contexts[2].harper);
		await provision(2);
		assert.notEqual(contexts[2].harper.hostname, oldName);
		const first = contexts[0].harper;
		const { operation_token } = await sendOperation(first, {
			operation: 'create_authentication_tokens',
			authorization: first.admin,
		});
		await sendOperation(contexts[2].harper, {
			operation: 'add_node',
			hostname: first.hostname,
			authorization: 'Bearer ' + operation_token,
			rejectUnauthorized: false,
		});
		await start(contexts[3], 3);
		await removeOld(3);
		await ready();
		assert.deepEqual(await blob(2), expectedBlob, 'fresh-name readiness includes complete owned blob bytes');
		await ownedRows(2);
		await sendOperation(contexts[2].harper, {
			operation: 'insert',
			database: 'data',
			table: 'Rows',
			records: [{ id: 'after-rename', region: 'europe', body: 'new-origin-body' }],
		});
		await waitForCondition(
			async (signal) => {
				const state = await local(3, signal, oldName);
				return (
					state.rows.some((row) => row.id === 'pending-old-origin' && row.body === 'retired-origin-body') &&
					state.rows.some((row) => row.id === 'after-rename' && row.body === 'new-origin-body')
				);
			},
			{
				timeoutMs: 60_000,
				description: 'the lagging shard owner receives retained old-origin and fresh new-origin bodies after removal',
			}
		);
	});
	test('losing a whole shard requires a complete backup and cannot mint another empty baseline', async () => {
		const paths = await Promise.all([0, 2].map(dataPath));
		await Promise.all([0, 2].map((i) => stopNodeProcess(contexts[i].harper)));
		const backups = [0, 2].map((i) => join(contexts[i].harper.dataRootDir, 'saved-shard-backup'));
		for (let index = 0; index < paths.length; index++) await cp(paths[index], backups[index], { recursive: true });
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
		for (const [index, i] of [0, 2].entries()) {
			await stopNodeProcess(contexts[i].harper);
			await rm(paths[index], { recursive: true });
			await cp(backups[index], paths[index], { recursive: true });
			await start(contexts[i], i);
		}
		await ready();
		await ownedRows(0);
		await ownedRows(2);
		const restored = await local(2, AbortSignal.timeout(10_000));
		const recovered = restored.rows.find((row) => row.id === '1');
		assert.ok(recovered, 'the complete backup preserves an owned record');
		const starts = restored.bootstrap.map((history) => history.localFloor);
		await sendOperation(contexts[2].harper, {
			operation: 'insert',
			database: 'data',
			table: 'Rows',
			records: [{ id: 'after-backup', region: 'asia', body: 'new-after-backup' }],
		});
		await sendOperation(contexts[2].harper, {
			operation: 'update',
			database: 'data',
			table: 'Rows',
			records: [{ id: recovered.id, body: 'updated-after-backup' }],
		});
		await waitForCondition(
			async (signal) => {
				const owner = await local(0, signal);
				const otherShard = await local(3, signal);
				return (
					owner.rows.some((row) => row.id === recovered.id && row.body === 'updated-after-backup') &&
					otherShard.rows.some((row) => row.id === recovered.id && row.version > recovered.version) &&
					otherShard.rows.some((row) => row.id === 'after-backup' && row.version > recovered.version)
				);
			},
			{
				timeoutMs: 30_000,
				description: 'restored origin inserts and updates reach another shard above recovered bounds',
			}
		);
		const updated = await local(2, AbortSignal.timeout(10_000));
		assert.deepEqual(
			updated.bootstrap.map((history) => history.localFloor),
			starts
		);
	});
});
