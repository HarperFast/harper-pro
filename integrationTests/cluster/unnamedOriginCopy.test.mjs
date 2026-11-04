/**
 * A base copy of rows whose origin id has no node name on the sender completes, and a copy that cannot finish
 * is held instead of looping (harper-pro#1235).
 *
 * The sender holds rows written as origin id 777, which no name maps to there: the state v4-era data or a
 * removed node leaves behind. Before the fix the receiver threw `No node name mapped for origin id 777`,
 * closed, and resumed from the same cursor every few seconds, holding a worker at each end.
 *
 * Fresh receivers join with add_node, which requests a full copy. Per engine:
 * - a receiver copies every row, the unnamed origin's included, finishes the copy, and after an abrupt restart
 *   resumes the next write with no second copy;
 * - with one row's apply forced to throw, the receiver stops after 5 attempts from one
 *   position, reports `stuckCopy: held`, and the sender stops copying to it for the hold.
 * RocksDB additionally runs the mixed-version pairings, through HARPER_TEST_SKIP_ORPHAN_ORIGIN_NAMING: a
 * receiver that throws on an untranslatable origin (as before) behind a sender that names its unnamed
 * origins, including after an older version minted the derived name to another id on the sender
 * (harper-pro#1246), and a sender that does not name them in front of a receiver that does.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { unpack } from 'msgpackr';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, stopNodeProcess, waitForCondition, readLog } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'unnamed_rows';
const UNNAMED_ORIGIN = 777;
const LOCAL_IDS = Array.from({ length: 30 }, (_, i) => `local-${String(i).padStart(2, '0')}`);
const ORPHAN_IDS = Array.from({ length: 10 }, (_, i) => `orphan-${i}`);
const ALL_IDS = [...LOCAL_IDS, ...ORPHAN_IDS].sort();
const STALL_ATTEMPTS = 5;
const COPY_TIMEOUT_MS = 90_000;

for (const engine of ['rocksdb', 'lmdb']) {
	suite(`base copy of rows from an unnamed origin (${engine})`, { timeout: 900_000 }, (ctx) => {
		const nodes = [];

		async function startNode(env = {}, config = {}) {
			const hostname = await getNextAvailableLoopbackAddress();
			const nodeCtx = { name: ctx.name, harper: { hostname } };
			await startHarper(nodeCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
					replication: { port: hostname + ':9933', securePort: null, databases: ['data'], ...config },
					unnamedOriginFixture: { package: join(TEST_DIR, 'fixture-unnamed-origin') },
				},
				env: {
					HARPER_NO_FLUSH_ON_EXIT: true,
					...(engine === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {}),
					...env,
				},
			});
			const node = Object.assign(nodeCtx.harper, { name: ctx.name, testEnv: env, testConfig: config });
			nodes.push(node);
			return node;
		}

		async function rowIds(node, signal) {
			const rows = await sendOperation(
				node,
				{ operation: 'search_by_value', database: 'data', table: TABLE, search_attribute: 'id', search_value: '*' },
				{ signal }
			);
			return Array.isArray(rows) ? rows.map((row) => row.id).sort() : [];
		}

		const addNode = (node, peer) =>
			sendOperation(node, {
				operation: 'add_node',
				hostname: peer.hostname,
				rejectUnauthorized: false,
				authorization: peer.admin,
			});

		async function copiesEverything(receiver, sender) {
			await addNode(receiver, sender);
			await waitForCondition(async (signal) => (await rowIds(receiver, signal)).length === ALL_IDS.length, {
				timeoutMs: COPY_TIMEOUT_MS,
				description: `${receiver.hostname} to copy every row from ${sender.hostname}`,
			});
			deepEqual(await rowIds(receiver), ALL_IDS);
			const log = await readLog(receiver);
			ok(!log.includes('No node name mapped for origin id'), 'the receiver never failed to translate an origin');
		}

		let sender;
		before(async () => {
			sender = await startNode();
			await sendOperation(sender, {
				operation: 'upsert',
				database: 'data',
				table: TABLE,
				records: LOCAL_IDS.map((id) => ({ id, name: id })),
			});
			const response = await fetch(`${sender.httpURL}/UnnamedOriginWrite`, {
				method: 'POST',
				headers: {
					'Authorization':
						'Basic ' + Buffer.from(`${sender.admin.username}:${sender.admin.password}`).toString('base64'),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ nodeId: UNNAMED_ORIGIN, ids: ORPHAN_IDS }),
			});
			equal(response.status, 200, await response.text());
			deepEqual(await rowIds(sender), ALL_IDS);
		});

		after(() => stopAndTeardownNodes(nodes));

		test('a receiver copies the rows of an origin the sender has no name for', async () => {
			const receiver = await startNode();
			await copiesEverything(receiver, sender);
			await waitForCondition(
				async () => (await readLog(receiver)).includes(`bulk copy complete from ${sender.hostname}`),
				{
					timeoutMs: COPY_TIMEOUT_MS,
					description: 'the receiver to finish the copy',
				}
			);
			const copiesTo = async () =>
				(await readLog(sender))
					.split('\n')
					.filter((line) => line.includes(`Replicating all tables to ${receiver.hostname}`)).length;
			const copiesBefore = await copiesTo();
			const afterCopy = (id) =>
				waitForCondition(
					async (signal) =>
						(
							await sendOperation(
								receiver,
								{ operation: 'search_by_id', database: 'data', table: 'after_copy', ids: [id], get_attributes: ['id'] },
								{ signal }
							)
						).length === 1,
					{ timeoutMs: COPY_TIMEOUT_MS, description: `${id} to reach the receiver` }
				);
			const writeAfterCopy = (id) =>
				sendOperation(sender, { operation: 'upsert', database: 'data', table: 'after_copy', records: [{ id }] });
			// a live write first: a kill right after the copy, before the receiver has a resume cursor, rightly copies again
			await writeAfterCopy('before-restart');
			await afterCopy('before-restart');
			await delay(2_000);

			await killHarper({ harper: receiver });
			await stopNodeProcess(receiver);
			Object.assign(
				receiver,
				(
					await startHarper(
						{ name: ctx.name, harper: receiver },
						{
							config: {
								analytics: { aggregatePeriod: -1 },
								logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
								replication: { port: receiver.hostname + ':9933', securePort: null, databases: ['data'] },
								unnamedOriginFixture: { package: join(TEST_DIR, 'fixture-unnamed-origin') },
							},
							env: { HARPER_NO_FLUSH_ON_EXIT: true, ...(engine === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {}) },
						}
					)
				).harper
			);
			deepEqual(await rowIds(receiver), ALL_IDS, 'the copied rows survive the restart');
			await writeAfterCopy('after-restart');
			await afterCopy('after-restart');
			equal(await copiesTo(), copiesBefore, 'no second copy after the restart');
		});

		test('a copy that fails at one row is held after a bounded number of attempts', async () => {
			const receiver = await startNode({ HARPER_TEST_COPY_APPLY_FAILURE_KEY: ORPHAN_IDS[5] });
			await addNode(receiver, sender);
			const stuck = await waitForCondition(
				async (signal) => {
					const status = await sendOperation(receiver, { operation: 'cluster_status' }, { signal });
					const socket = status.connections
						?.find((connection) => connection.name === sender.hostname)
						?.database_sockets?.find((entry) => entry.database === 'data');
					return socket?.stuckCopy?.state === 'held' && socket.stuckCopy;
				},
				{ timeoutMs: COPY_TIMEOUT_MS, description: 'the receiver to hold the copy' }
			);
			equal(stuck.count, STALL_ATTEMPTS, 'held at the attempt limit');
			ok(Date.parse(stuck.retryAt) > Date.now(), `retries at ${stuck.retryAt}`);
			// both ends are released: the sender starts no new copy to this receiver during the hold
			const copiesTo = async () =>
				(await readLog(sender))
					.split('\n')
					.filter((line) => line.includes(`Replicating all tables to ${receiver.hostname}`)).length;
			const copiesBefore = await copiesTo();
			ok(copiesBefore >= STALL_ATTEMPTS, `the sender started ${copiesBefore} copies`);
			await delay(20_000);
			equal(await copiesTo(), copiesBefore, 'no copy started while held');
			const held = (await readLog(receiver)).split('\n').filter((line) => line.includes('copy stopped after'));
			equal(held.length, 1, `one log line for the transition:\n${held.join('\n')}`);
		});

		if (engine === 'rocksdb') {
			async function restartSender(env = {}) {
				await killHarper({ harper: sender });
				await stopNodeProcess(sender);
				const restarted = (
					await startHarper(
						{ name: ctx.name, harper: sender },
						{
							config: {
								analytics: { aggregatePeriod: -1 },
								logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
								replication: { port: sender.hostname + ':9933', securePort: null, databases: ['data'] },
								unnamedOriginFixture: { package: join(TEST_DIR, 'fixture-unnamed-origin') },
							},
							env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
						}
					)
				).harper;
				Object.assign(sender, restarted);
			}

			test('a receiver that cannot translate an unnamed origin copies from a sender that names it', async () => {
				await copiesEverything(await startNode({ HARPER_TEST_SKIP_ORPHAN_ORIGIN_NAMING: '1' }), sender);
			});

			test('a sender still names its unnamed origin after an older version minted that name to another id', async () => {
				// a 5.3 node persists the derived name under a new id when a peer relays it back, then upgrades (harper-pro#1246)
				const auth = {
					Authorization: 'Basic ' + Buffer.from(`${sender.admin.username}:${sender.admin.password}`).toString('base64'),
				};
				const { record } = await (await fetch(`${sender.httpURL}/NodeIdMappingRecord`, { headers: auth })).json();
				const { remoteNameToId } = unpack(Buffer.from(record, 'base64'));
				remoteNameToId[`unnamed-origin-${UNNAMED_ORIGIN}@${sender.hostname}`] =
					Math.max(...Object.values(remoteNameToId)) + 1;
				const written = await fetch(`${sender.httpURL}/NodeIdMappingRecord`, {
					method: 'POST',
					headers: { ...auth, 'Content-Type': 'application/json' },
					body: JSON.stringify({ nodeName: sender.hostname, remoteNameToId }),
				});
				equal(written.status, 200, await written.text());
				await restartSender();
				await copiesEverything(await startNode({ HARPER_TEST_SKIP_ORPHAN_ORIGIN_NAMING: '1' }), sender);
			});

			test('a sender that does not name its unnamed origins copies to a receiver that names them', async () => {
				await restartSender({ HARPER_TEST_SKIP_ORPHAN_ORIGIN_NAMING: '1' });
				await copiesEverything(await startNode(), sender);
			});
		}
	});
}
