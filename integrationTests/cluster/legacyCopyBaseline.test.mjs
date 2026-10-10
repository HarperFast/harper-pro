import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import {
	startHarper,
	killHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { assertLegacyAuditHasNoEcho, resetLegacyReplicationCursors } from './legacyAuditHelpers.mjs';
import { sendOperation, waitForCondition, readLog } from './clusterShared.mjs';

const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '../../dist/bin/harper.js');

for (const engine of ['rocksdb', 'lmdb'])
	test(
		`legacy migration from LMDB to ${engine} verifies a reverse baseline without historical puts`,
		{
			skip: !legacyPath,
			timeout: 180_000,
		},
		async (t) => {
			const contexts = [];
			const startOptions = new Map();
			async function start(legacy) {
				const context = { name: 'legacy-copy-baseline', harper: { hostname: await getNextAvailableLoopbackAddress() } };
				contexts.push(context);
				const options = {
					harperBinPath: legacy ? join(legacyPath, 'bin/harperdb.js') : undefined,
					env: legacy ? { TC_AGREEMENT: 'yes' } : { HARPER_STORAGE_ENGINE: engine },
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: true, console: true },
						replication: { securePort: context.harper.hostname + ':9933', databases: ['data'] },
					},
				};
				startOptions.set(context, options);
				await startHarper(context, options);
				return context.harper;
			}
			t.after(async () => {
				await Promise.all(
					contexts.filter((context) => context.harper?.process).map((context) => teardownHarper(context))
				);
			});
			let legacy = await start(true);
			const current = await start(false);
			await sendOperation(current, { operation: 'create_database', database: 'data' });
			const sourceKeys = [];
			for (const table of ['orders', 'users', 'events']) {
				await sendOperation(legacy, { operation: 'create_table', database: 'data', table, primary_key: 'id' });
				const records = Array.from({ length: 100 }, (_, i) => ({
					id: table === 'orders' && i === 0 ? 'old-data-1' : `${table}-${i}`,
					name: `${table} record ${i}`,
				}));
				sourceKeys.push(...records.map((record) => record.id));
				await sendOperation(legacy, { operation: 'upsert', database: 'data', table, records });
			}
			async function connect(peer) {
				await sendOperation(current, {
					operation: 'add_node',
					hostname: peer.hostname,
					rejectUnauthorized: false,
					authorization: current.admin,
				});
			}
			async function waitForRecords(node, table, ids) {
				await waitForCondition(
					async (signal) => {
						const description = await sendOperation(
							node,
							{ operation: 'describe_database', database: 'data' },
							{ signal }
						);
						if (!description[table]) return false;
						const rows = await sendOperation(
							node,
							{
								operation: 'search_by_id',
								database: 'data',
								table,
								ids,
								get_attributes: ['id', 'name'],
							},
							{ signal }
						);
						return rows.length === ids.length && rows;
					},
					{ timeoutMs: 30_000, pollMs: 100, description: `${table} records on ${node.hostname}` }
				);
			}
			await connect(legacy);
			await t.test('all three source tables arrive and subsequent new writes reach v4', async () => {
				for (const table of ['orders', 'users', 'events']) {
					const ids = Array.from({ length: 100 }, (_, i) =>
						table === 'orders' && i === 0 ? 'old-data-1' : `${table}-${i}`
					);
					await waitForRecords(current, table, ids);
				}
				await sendOperation(current, {
					operation: 'upsert',
					database: 'data',
					table: 'orders',
					records: [{ id: 'new-v5-write', name: 'after migration' }],
				});
				await waitForRecords(legacy, 'orders', ['new-v5-write']);
				const context = contexts.find((context) => context.harper === legacy);
				await killHarper(context);
				await resetLegacyReplicationCursors(legacy);
				await startHarper(context, startOptions.get(context));
				legacy = context.harper;
				await waitForCondition(async () => (await readLog(legacy)).includes('last sequence committed'), {
					timeoutMs: 30_000,
					pollMs: 100,
					description: 'verified non-empty reverse baseline after cursor reset',
				});
				await sendOperation(current, {
					operation: 'upsert',
					database: 'data',
					table: 'orders',
					records: [{ id: 'after-cursor-reset', name: 'after verified baseline' }],
				});
				await waitForRecords(legacy, 'orders', ['after-cursor-reset']);
			});
			await t.test('missing historical data fails explicitly while forward migration continues', async () => {
				const missing = await start(true);
				await sendOperation(missing, {
					operation: 'create_table',
					database: 'data',
					table: 'orders',
					primary_key: 'id',
				});
				await connect(missing);
				await waitForCondition(
					async () =>
						(await readLog(current)).includes('Historical restoration into an unverified peer is unsupported'),
					{
						timeoutMs: 30_000,
						pollMs: 100,
						description: 'explicit unsupported historical restoration error',
					}
				);
				const rows = await sendOperation(missing, {
					operation: 'search_by_id',
					database: 'data',
					table: 'orders',
					ids: ['old-data-1'],
					get_attributes: ['id'],
				});
				assert.deepStrictEqual(rows, []);
				await sendOperation(missing, {
					operation: 'upsert',
					database: 'data',
					table: 'orders',
					records: [{ id: 'still-forward', name: 'forward migration' }],
				});
				await waitForRecords(current, 'orders', ['still-forward']);
				const log = await readLog(missing);
				assert.doesNotMatch(log, /last sequence committed/);
			});
			await t.test('legacy audit contains no duplicate echoes of the source records', async () => {
				await killHarper({ harper: legacy });
				await assertLegacyAuditHasNoEcho(legacy, sourceKeys);
			});
		}
	);

for (const engine of ['rocksdb', 'lmdb'])
	test(
		`a ${engine} v5 peer without safeCopyAudit receives historical records and subsequent writes`,
		{ timeout: 180_000 },
		async (t) => {
			const contexts = [];
			const startOptions = new Map();
			async function start(env, harperBinPath) {
				const context = {
					name: 'legacy-copy-baseline-capless',
					harper: { hostname: await getNextAvailableLoopbackAddress() },
				};
				contexts.push(context);
				const options = {
					harperBinPath,
					env: { HARPER_STORAGE_ENGINE: engine, ...env },
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: true, console: true },
						replication: { securePort: context.harper.hostname + ':9933', databases: ['data'] },
					},
				};
				startOptions.set(context, options);
				await startHarper(context, options);
				return context.harper;
			}
			t.after(async () => {
				await Promise.all(
					contexts.filter((context) => context.harper?.process).map((context) => teardownHarper(context))
				);
			});
			const current = await start({});
			// Set this to an installed published 5.x package to test its unmodified handshake.
			const previousPath = process.env.HARPER_PRO_PREVIOUS_VERSION_PATH;
			let capless = await start(
				previousPath ? {} : { HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1' },
				previousPath && join(previousPath, 'dist/bin/harper.js')
			);
			const registration = await sendOperation(capless, { operation: 'registration_info' });
			assert.match(registration.version, /^v?5\./, 'this compatibility regression requires a 5.x peer');
			await sendOperation(current, { operation: 'create_database', database: 'data' });
			await sendOperation(current, { operation: 'create_table', database: 'data', table: 'orders', primary_key: 'id' });
			await sendOperation(current, {
				operation: 'upsert',
				database: 'data',
				table: 'orders',
				records: [{ id: 'preexisting', name: 'already on current' }],
			});
			await sendOperation(capless, { operation: 'create_database', database: 'data' });
			await sendOperation(capless, { operation: 'create_table', database: 'data', table: 'orders', primary_key: 'id' });
			await sendOperation(current, {
				operation: 'add_node',
				hostname: capless.hostname,
				rejectUnauthorized: false,
				authorization: current.admin,
			});
			async function waitForRecord(node, id, name) {
				await waitForCondition(
					async (signal) => {
						const rows = await sendOperation(
							node,
							{
								operation: 'search_by_id',
								database: 'data',
								table: 'orders',
								ids: [id],
								get_attributes: ['*'],
							},
							{ signal }
						);
						return rows.length === 1 && rows[0].id === id && rows[0].name === name;
					},
					{ timeoutMs: 30_000, pollMs: 100, description: `${id} reaches ${node.hostname}` }
				);
			}
			await waitForRecord(capless, 'preexisting', 'already on current');
			await sendOperation(current, {
				operation: 'upsert',
				database: 'data',
				table: 'orders',
				records: [{ id: 'later-write', name: 'after base copy' }],
			});
			await waitForRecord(capless, 'later-write', 'after base copy');
			const third = await start({});
			await sendOperation(third, { operation: 'create_database', database: 'data' });
			await sendOperation(third, { operation: 'create_table', database: 'data', table: 'orders', primary_key: 'id' });
			await sendOperation(current, {
				operation: 'add_node',
				hostname: third.hostname,
				rejectUnauthorized: false,
				authorization: current.admin,
			});
			await waitForRecord(third, 'preexisting', 'already on current');
			if (engine === 'lmdb') {
				const context = contexts.find((context) => context.harper === capless);
				await killHarper(context);
				await resetLegacyReplicationCursors(capless);
				await sendOperation(current, {
					operation: 'upsert',
					database: 'data',
					table: 'orders',
					records: [{ id: 'written-while-down', name: 'requires historical recopy' }],
				});
				const logStart = (await readLog(current)).length;
				await startHarper(context, startOptions.get(context));
				capless = context.harper;
				await waitForCondition(
					async () =>
						(await readLog(current)).slice(logStart).includes(`Replicating all tables to ${capless.hostname}`),
					{ timeoutMs: 30_000, pollMs: 100, description: 'a populated 5.x LMDB peer receives a fresh base copy' }
				);
				await waitForRecord(capless, 'written-while-down', 'requires historical recopy');
				await sendOperation(current, {
					operation: 'upsert',
					database: 'data',
					table: 'orders',
					records: [{ id: 'after-recopy', name: 'after redundant copy' }],
				});
				await waitForRecord(capless, 'after-recopy', 'after redundant copy');
			}
			await sendOperation(capless, {
				operation: 'upsert',
				database: 'data',
				table: 'orders',
				records: [{ id: 'forward-write', name: 'from capability-less peer' }],
			});
			await waitForRecord(current, 'forward-write', 'from capability-less peer');
			await waitForRecord(third, 'forward-write', 'from capability-less peer');
		}
	);
