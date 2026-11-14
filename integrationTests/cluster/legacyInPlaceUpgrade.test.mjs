import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { assertLegacyAuditHasNoEcho } from './legacyAuditHelpers.mjs';
import { sendOperation, waitForCondition, readLog, stopNodeProcess } from './clusterShared.mjs';

const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '../../dist/bin/harper.js');

test(
	'a node upgraded in place from v4 on LMDB keeps replicating to its v4 peer from where the peer left off',
	{ skip: !legacyPath, timeout: 240_000 },
	async (t) => {
		const contexts = [];
		async function start(context, legacy) {
			await startHarper(context, {
				harperBinPath: legacy ? join(legacyPath, 'bin/harperdb.js') : undefined,
				env: legacy ? { TC_AGREEMENT: 'yes' } : { HARPER_STORAGE_ENGINE: 'lmdb' },
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: true, console: true },
					replication: { securePort: context.harper.hostname + ':9933', hostname: context.harper.hostname },
				},
			});
			return context.harper;
		}
		async function newContext(name) {
			const context = { name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			contexts.push(context);
			return context;
		}
		t.after(async () => {
			await Promise.all(
				contexts.filter((context) => context.harper?.process).map((context) => teardownHarper(context))
			);
		});
		async function waitForRecords(node, ids) {
			await waitForCondition(
				async (signal) => {
					const rows = await sendOperation(
						node,
						{ operation: 'search_by_id', database: 'data', table: 'orders', ids, get_attributes: ['id'] },
						{ signal }
					);
					return rows.length === ids.length;
				},
				{ timeoutMs: 60_000, pollMs: 250, description: `${ids.length} orders on ${node.hostname}` }
			);
		}
		async function waitForRole(node, role) {
			await waitForCondition(
				async (signal) => {
					const roles = await sendOperation(node, { operation: 'list_roles' }, { signal });
					return roles.some((entry) => entry.role === role);
				},
				{ timeoutMs: 60_000, pollMs: 250, description: `role ${role} on ${node.hostname}` }
			);
		}
		const permission = {
			structure_user: false,
			data: {
				tables: { orders: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] } },
			},
		};

		const legacyContext = await newContext('legacy-in-place-upgrade-peer');
		const upgradedContext = await newContext('legacy-in-place-upgrade-node');
		const legacy = await start(legacyContext, true);
		let upgraded = await start(upgradedContext, true);
		for (const node of [legacy, upgraded])
			await sendOperation(node, { operation: 'create_table', database: 'data', table: 'orders', primary_key: 'id' });
		await sendOperation(upgraded, {
			operation: 'add_node',
			hostname: legacy.hostname,
			verify_tls: false,
			rejectUnauthorized: false,
			authorization: upgraded.admin,
		});

		const beforeIds = Array.from({ length: 20 }, (_, i) => `before-upgrade-${i}`);
		await sendOperation(upgraded, {
			operation: 'upsert',
			database: 'data',
			table: 'orders',
			records: beforeIds.map((id) => ({ id, name: 'written on v4' })),
		});
		await sendOperation(upgraded, { operation: 'add_role', role: 'before_upgrade', permission });
		await waitForRecords(legacy, beforeIds);
		await waitForRole(legacy, 'before_upgrade');
		// the v4 peer commits a dated cursor only for an incremental entry after its initial copy; without one it
		// resumes from 0, which is a full copy rather than the resume this test covers
		let probe = 0;
		await waitForCondition(
			async (signal) => {
				probe++;
				await sendOperation(
					upgraded,
					{ operation: 'upsert', database: 'data', table: 'orders', records: [{ id: `cursor-probe-${probe}` }] },
					{ signal }
				);
				await sendOperation(upgraded, { operation: 'add_role', role: `cursor_probe_${probe}`, permission }, { signal });
				const log = await readLog(legacy);
				return ['data', 'system'].every((database) =>
					new RegExp(`last sequence committed (?!1970)\\d{4}-\\d{2}-\\d{2}T\\S+ ${database}`).test(log)
				);
			},
			{ timeoutMs: 60_000, pollMs: 1000, description: 'dated replication cursors on the v4 peer' }
		);

		await stopNodeProcess(upgraded);
		upgraded = await start(upgradedContext, false);
		assert.match((await sendOperation(upgraded, { operation: 'registration_info' })).version, /^v?5\./);

		await t.test('writes on the upgraded node reach the v4 peer in both databases', async () => {
			await sendOperation(upgraded, {
				operation: 'upsert',
				database: 'data',
				table: 'orders',
				records: [{ id: 'after-upgrade', name: 'written on v5' }],
			});
			await sendOperation(upgraded, { operation: 'add_role', role: 'after_upgrade', permission });
			await waitForRecords(legacy, ['after-upgrade']);
			await waitForRole(legacy, 'after_upgrade');
		});

		await t.test('the upgraded node replays from the peer position instead of forcing a copy', async () => {
			const log = await readLog(upgraded);
			assert.match(log, /the retained log reaches back to that start/);
			assert.doesNotMatch(log, /Cannot verify replication baseline/);
			assert.doesNotMatch(log, /forcing a bounded base-copy resync/);
		});

		await t.test('the v4 peer received no historical echo of the records written before the upgrade', async () => {
			await stopNodeProcess(legacy);
			await assertLegacyAuditHasNoEcho(legacy, beforeIds);
		});
	}
);
