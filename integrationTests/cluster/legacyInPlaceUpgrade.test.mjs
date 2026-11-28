import { test } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mqtt from 'mqtt';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { assertLegacyAuditHasNoEcho } from './legacyAuditHelpers.mjs';
import { sendOperation, waitForCondition, readLog, stopNodeProcess } from './clusterShared.mjs';

const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '../../dist/bin/harper.js');
const FIXTURE = join(import.meta.dirname, 'fixture-replicated-messages');

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
		async function newContext(name, hostname) {
			const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
			const context = { name, harper: { hostname, dataRootDir } };
			contexts.push(context);
			await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
			return context;
		}
		t.after(async () => {
			await Promise.all(
				contexts.map((context) =>
					context.harper?.process
						? teardownHarper(context)
						: rm(context.harper.dataRootDir, { recursive: true, force: true })
				)
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

		// A same-version tie goes to the greater node name, so the v4 peer's message takes over the record the upgraded node
		// copied as v4 only when the peer's name sorts higher; every later message to the topic then ties with it
		const [peerHostname, nodeHostname] = [
			await getNextAvailableLoopbackAddress(),
			await getNextAvailableLoopbackAddress(),
		].sort((a, b) => (a > b ? -1 : 1));
		const legacyContext = await newContext('legacy-in-place-upgrade-peer', peerHostname);
		const upgradedContext = await newContext('legacy-in-place-upgrade-node', nodeHostname);
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
		// a topic that already has a record: a v4 publish to it carries that record's version
		await sendOperation(legacy, {
			operation: 'upsert',
			database: 'data',
			table: 'Message',
			records: [{ id: 'existing-topic', n: -1 }],
		});
		await waitForRecords(legacy, beforeIds);
		await waitForCondition(
			async (signal) => {
				const rows = await sendOperation(
					upgraded,
					{
						operation: 'search_by_id',
						database: 'data',
						table: 'Message',
						ids: ['existing-topic'],
						get_attributes: ['id'],
					},
					{ signal }
				);
				return rows.length === 1;
			},
			{ timeoutMs: 60_000, pollMs: 250, description: `the topic record on ${upgraded.hostname}` }
		);
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

		await t.test(
			'messages the v4 peer publishes to an existing topic reach a subscriber on the upgraded node',
			async () => {
				const clients = [];
				const connect = (node, clientId) =>
					new Promise((resolve, reject) => {
						const client = mqtt.connect(`mqtt://${node.hostname}:1883`, {
							username: node.admin.username,
							password: node.admin.password,
							clientId,
							clean: true,
							reconnectPeriod: 0,
							connectTimeout: 8000,
						});
						clients.push(client);
						client.once('connect', () => resolve(client));
						client.on('error', reject);
						// a connect timeout or a dropped socket before CONNACK emits only close
						client.once('close', () => reject(new Error(`MQTT connection to ${node.hostname} closed`)));
					});
				const count = 20;
				const seen = new Set();
				const setupDeadline = new AbortController();
				try {
					await Promise.race([
						(async () => {
							const subscriber = await connect(upgraded, 'sub-upgraded');
							const publisher = await connect(legacy, 'pub-legacy');
							subscriber.on('message', (_topic, payload) => seen.add(JSON.parse(payload.toString()).n));
							await subscriber.subscribeAsync('Message/existing-topic', { qos: 1 });
							for (let n = 0; n < count; n++)
								await publisher.publishAsync('Message/existing-topic', JSON.stringify({ n }), { qos: 1 });
						})(),
						sleep(30_000, undefined, { signal: setupDeadline.signal }).then(
							() => {
								throw new Error('Timed out after 30000ms connecting, subscribing and publishing over MQTT');
							},
							() => {}
						),
					]);
					const expected = Array.from({ length: count }, (_, n) => n);
					await waitForCondition(() => expected.every((n) => seen.has(n)), {
						timeoutMs: 30_000,
						pollMs: 250,
						description: () =>
							`all ${count} messages on the upgraded node, missing ${expected.filter((n) => !seen.has(n))}`,
					});
				} finally {
					setupDeadline.abort();
					for (const client of clients) client.end(true);
				}
			}
		);

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
