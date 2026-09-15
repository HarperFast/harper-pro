import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import {
	startHarper,
	killHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { assertLegacyAuditHasNoEcho } from './legacyAuditHelpers.mjs';
import { sendOperation, waitForCondition, readLog } from './clusterShared.mjs';

const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '../../dist/bin/harper.js');

test(
	'legacy migration verifies a reverse baseline without replaying historical puts',
	{
		skip: !legacyPath,
		timeout: 180_000,
	},
	async (t) => {
		const contexts = [];
		async function start(legacy) {
			const context = { name: 'legacy-copy-baseline', harper: { hostname: await getNextAvailableLoopbackAddress() } };
			contexts.push(context);
			await startHarper(context, {
				harperBinPath: legacy ? join(legacyPath, 'bin/harperdb.js') : undefined,
				env: legacy ? { TC_AGREEMENT: 'yes' } : {},
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: true, console: true },
					replication: { securePort: context.harper.hostname + ':9933', databases: ['data'] },
				},
			});
			return context.harper;
		}
		t.after(async () => {
			await Promise.all(
				contexts.filter((context) => context.harper?.process).map((context) => teardownHarper(context))
			);
		});
		const legacy = await start(true);
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
		});
		await t.test('missing historical data fails explicitly while forward migration continues', async () => {
			const missing = await start(true);
			await sendOperation(missing, { operation: 'create_table', database: 'data', table: 'orders', primary_key: 'id' });
			await connect(missing);
			await waitForCondition(
				async () => (await readLog(current)).includes('Historical restoration from v5 to v4 is unsupported'),
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
