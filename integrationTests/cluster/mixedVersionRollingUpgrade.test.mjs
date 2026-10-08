/**
 * Mixed-version 5.x clusters: a rolling upgrade from a previous release, and a one-node rollback.
 *
 * Every node keeps its data directory across a binary switch — the operation customers run. "Converge"
 * (checked after every step) means exact agreement with an independent oracle — fields, secondary index,
 * blob bytes over HTTP and in local blob files — not merely agreement between nodes. The last step joins
 * a node on the old release: it must converge if that release advertises safeCopyAudit, otherwise this
 * build refuses it a base copy (harper-pro#1007), and the step pins that refusal instead.
 *
 * HARPER_PRO_PREVIOUS_VERSION_PATHS lists previous installs (each `.../node_modules/@harperfast/harper-pro`),
 * separated by path.delimiter; one suite runs per install. Unset, the file skips. Set to a path that
 * has no install, the file fails rather than skipping.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition, stopAndTeardownNodes, readLog } from './clusterShared.mjs';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const CURRENT_BIN = join(PACKAGE_ROOT, 'dist', 'bin', 'harper.js');
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = CURRENT_BIN;
const CURRENT_VERSION = readVersion(PACKAGE_ROOT);
const FIXTURE_PATH = join(import.meta.dirname, 'fixture-mixed-version');
const PREVIOUS_INSTALLS = (process.env.HARPER_PRO_PREVIOUS_VERSION_PATHS ?? '').split(delimiter).filter(Boolean);

const DATABASE = 'data';
const ITEM = 'MixedVersionItem';
const TYPED = 'MixedVersionTyped';
const TYPED_OPTIONAL_FIELDS = ['label', 'count', 'ratio', 'flag', 'tags'];
// above blob.ts's FILE_STORAGE_THRESHOLD (8192): stored as its own file and streamed between nodes
const FILE_BLOB_BYTES = 20 * 1024;
const INLINE_BLOB_BYTES = 200;
const BLOB_HEADER_BYTES = 8;
const CONVERGE_TIMEOUT_MS = 120_000;
const KNOWN_ISSUE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
// Known per-release safeCopyAudit advertisement (harper-pro#848 added it; neither pinned release ships it).
// A fixed table, not a version comparison: this is what decides the join step's branch below, so the test
// must catch this build misreporting it, not just infer it from "is newer than #848".
const PREVIOUS_SAFE_COPY_AUDIT = { '5.2.15': 0, '5.3.1': 0 };
// a rolling upgrade stops each node cleanly; the harness default escalates to SIGKILL after 5 s
const SHUTDOWN_GRACE_MS = 30_000;

function readVersion(packageRoot) {
	return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
}

function blobText(seed, bytes) {
	return `${seed};`.repeat(Math.ceil(bytes / (seed.length + 1))).slice(0, bytes);
}

function nodeOptions(hostname, harperBinPath, env) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true },
			replication: { securePort: hostname + ':9933' },
		},
		env,
		harperBinPath,
	};
}

// so no node is still launching during teardown when an earlier one's start rejects
async function settleAll(promises) {
	const failed = (await Promise.allSettled(promises)).find(({ status }) => status === 'rejected');
	if (failed) throw failed.reason;
}

async function localBlobContents(dataRootDir) {
	const contents = [];
	const walk = async (dir) => {
		const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
			if (error.code === 'ENOENT') return [];
			throw error;
		});
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else {
				// a blob file can be unlinked between readdir and readFile (an aborted write, orphan cleanup)
				const file = await readFile(path).catch((error) => {
					if (error.code === 'ENOENT') return undefined;
					throw error;
				});
				// blob compression is off by default, so the body after the header is the raw content
				if (file) contents.push(file.subarray(BLOB_HEADER_BYTES).toString());
			}
		}
	};
	await walk(join(dataRootDir, 'blobs', DATABASE));
	return new Set(contents);
}

if (PREVIOUS_INSTALLS.length === 0) {
	suite('mixed-version rolling upgrade', { skip: 'HARPER_PRO_PREVIOUS_VERSION_PATHS is not set' }, () => {});
}

for (const previousInstall of PREVIOUS_INSTALLS) {
	const previousVersion = readVersion(previousInstall);
	const previousBin = join(previousInstall, 'dist', 'bin', 'harper.js');

	suite(
		`rolling upgrade ${previousVersion} -> this build (${CURRENT_VERSION}), then one node back`,
		{ timeout: 900_000 },
		(ctx) => {
			const nodes = [];
			const [nodeA, nodeB, nodeC] = [0, 1, 2].map(() => ({ name: ctx.name }));
			const expected = { [ITEM]: new Map(), [TYPED]: new Map() };
			const categories = new Set();
			let batchCount = 0;

			async function assertRunning(nodeCtx, harperBinPath, version) {
				ok(
					nodeCtx.harper.process.spawnargs.includes(harperBinPath),
					`${nodeCtx.harper.hostname} should have been launched from ${harperBinPath}`
				);
				const info = await sendOperation(
					nodeCtx.harper,
					{ operation: 'registration_info' },
					{ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
				);
				equal(info.version, version, `${nodeCtx.harper.hostname} should be running ${version}`);
			}

			// setupHarperWithFixture picks the hostname itself, but replication.securePort needs it first
			async function startFresh(nodeCtx) {
				const hostname = await getNextAvailableLoopbackAddress();
				const parentDir = process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir();
				const dataRootDir = await mkdtemp(join(parentDir, 'harper-integration-test-'));
				nodeCtx.harper = { hostname, dataRootDir };
				nodes.push(nodeCtx);
				await cp(FIXTURE_PATH, join(dataRootDir, 'components', basename(FIXTURE_PATH)), {
					recursive: true,
					dereference: true,
				});
				await startHarper(nodeCtx, nodeOptions(hostname, previousBin));
				await assertRunning(nodeCtx, previousBin, previousVersion);
			}

			async function stop(nodeCtx) {
				const outgoing = nodeCtx.harper.process;
				await killHarper(nodeCtx, { graceMs: SHUTDOWN_GRACE_MS });
				const { exitCode, signalCode } = outgoing;
				// Harper's SIGTERM handler (core/bin/run.ts) always calls process.exit(0); by the time `stop` can run
				// on a node that passed `assertRunning`, that handler is long installed, so SIGTERM never surfaces as
				// `signalCode` here — if it did, the handler itself is gone and the "clean" stop was an abrupt kill.
				ok(
					exitCode === 0,
					`${nodeCtx.harper.hostname} did not stop cleanly within ${SHUTDOWN_GRACE_MS}ms (exit code ${exitCode}, signal ${signalCode})`
				);
			}

			async function start(nodeCtx, harperBinPath, version, env) {
				await startHarper(nodeCtx, nodeOptions(nodeCtx.harper.hostname, harperBinPath, env));
				await assertRunning(nodeCtx, harperBinPath, version);
			}

			async function waitForMesh() {
				let summary;
				await waitForCondition(
					async (signal) => {
						const statuses = await Promise.all(
							nodes.map((nodeCtx) => sendOperation(nodeCtx.harper, { operation: 'cluster_status' }, { signal }))
						);
						summary = statuses.map((status, i) => ({
							node: nodes[i].harper.hostname,
							peers: status.connections.map((connection) => ({
								name: connection.name,
								sockets: connection.database_sockets?.map(({ database, connected }) => `${database}:${connected}`),
							})),
						}));
						return statuses.every((status, i) => {
							const peers = nodes.filter((_, j) => j !== i).map((nodeCtx) => nodeCtx.harper.hostname);
							return (
								isDeepStrictEqual(status.connections.map(({ name }) => name).sort(), peers.sort()) &&
								status.connections.every((connection) =>
									[DATABASE, 'system'].every((database) =>
										connection.database_sockets?.some((socket) => socket.database === database && socket.connected)
									)
								)
							);
						});
					},
					{
						timeoutMs: CONVERGE_TIMEOUT_MS,
						pollMs: 1000,
						description: () => `a full mesh of connected data and system sockets; last: ${JSON.stringify(summary)}`,
					}
				);
			}

			function write(nodeCtx, operation) {
				return sendOperation(
					nodeCtx.harper,
					{ database: DATABASE, ...operation },
					{ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
				);
			}

			// Batches that run concurrently never touch the same record.
			async function writeBatch(nodeCtx, tag, { updateFrom, deleteFrom } = {}) {
				const batch = batchCount++;
				categories.add(tag);
				const items = [
					{
						id: `${tag}-file`,
						category: tag,
						rank: batch,
						payload: blobText(`${tag}-file`, FILE_BLOB_BYTES),
						[`detail${batch}`]: { writer: tag, list: [1, 2, 3] },
					},
					{ id: `${tag}-inline`, category: tag, payload: blobText(`${tag}-inline`, INLINE_BLOB_BYTES), note: tag },
					{ id: `${tag}-plain`, category: tag, rank: batch, flags: [true, false] },
				];
				const typedValues = { label: tag, count: batch, ratio: batch / 4, flag: batch % 2 === 0, tags: ['typed', tag] };
				const typed = [1, 2, 3].map((n) => {
					const shape = (batch * 3 + n) % 2 ** TYPED_OPTIONAL_FIELDS.length || 1;
					const record = { id: `${tag}-t${n}`, category: tag };
					TYPED_OPTIONAL_FIELDS.forEach((field, bit) => {
						if (shape & (1 << bit)) record[field] = typedValues[field];
					});
					return record;
				});
				await write(nodeCtx, { operation: 'insert', table: ITEM, records: items });
				await write(nodeCtx, { operation: 'insert', table: TYPED, records: typed });
				for (const record of items) expected[ITEM].set(record.id, record);
				for (const record of typed) expected[TYPED].set(record.id, record);

				if (updateFrom) {
					const itemUpdate = {
						id: `${updateFrom}-plain`,
						category: tag,
						payload: blobText(`${updateFrom}-plain@${tag}`, FILE_BLOB_BYTES),
						updatedBy: tag,
					};
					const typedUpdate = { id: `${updateFrom}-t2`, category: tag, count: 1000 + batch };
					await write(nodeCtx, { operation: 'update', table: ITEM, records: [itemUpdate] });
					await write(nodeCtx, { operation: 'update', table: TYPED, records: [typedUpdate] });
					expected[ITEM].set(itemUpdate.id, { ...expected[ITEM].get(itemUpdate.id), ...itemUpdate });
					expected[TYPED].set(typedUpdate.id, { ...expected[TYPED].get(typedUpdate.id), ...typedUpdate });
				}
				if (deleteFrom) {
					const [itemId, typedId] = [`${deleteFrom}-inline`, `${deleteFrom}-t1`];
					await write(nodeCtx, { operation: 'delete', table: ITEM, ids: [itemId] });
					await write(nodeCtx, { operation: 'delete', table: TYPED, ids: [typedId] });
					expected[ITEM].delete(itemId);
					expected[TYPED].delete(typedId);
				}
			}

			async function findMismatch(node, signal) {
				for (const table of [ITEM, TYPED]) {
					const rows = await sendOperation(
						node,
						{
							operation: 'search_by_value',
							database: DATABASE,
							table,
							search_attribute: 'id',
							search_value: '*',
							get_attributes: ['*'],
						},
						{ signal }
					);
					const actual = new Map(rows.map(({ payload: _blob, ...record }) => [record.id, record]));
					for (const [id, { payload: _blob, ...record }] of expected[table]) {
						if (!actual.has(id)) return `${table} ${id} is missing`;
						if (!isDeepStrictEqual(actual.get(id), record))
							return `${table} ${id} is ${JSON.stringify(actual.get(id))}, expected ${JSON.stringify(record)}`;
					}
					for (const id of actual.keys()) if (!expected[table].has(id)) return `${table} ${id} should not exist`;

					for (const category of categories) {
						const hits = await sendOperation(
							node,
							{
								operation: 'search_by_value',
								database: DATABASE,
								table,
								search_attribute: 'category',
								search_value: category,
								get_attributes: ['id'],
							},
							{ signal }
						);
						const found = hits.map(({ id }) => id).sort();
						const wanted = [...expected[table].values()]
							.filter((record) => record.category === category)
							.map(({ id }) => id)
							.sort();
						if (!isDeepStrictEqual(found, wanted))
							return `${table} index on category=${category} returns [${found}], expected [${wanted}]`;
					}
				}
				for (const [id, { payload }] of expected[ITEM]) {
					if (payload === undefined) continue;
					const response = await fetch(`${node.httpURL}/${ITEM}/${encodeURIComponent(id)}.payload`, { signal });
					const body = await response.text();
					if (response.status !== 200)
						return `${ITEM} ${id} blob read returned ${response.status}: ${body.slice(0, 200)}`;
					if (body !== payload)
						return `${ITEM} ${id} blob read returned ${body.length} bytes that differ from the ${payload.length} written`;
				}
				// a blob served over HTTP could have been fetched from a peer; the replica must hold its own copy
				const localBlobs = await localBlobContents(node.dataRootDir);
				for (const [id, { payload }] of expected[ITEM]) {
					if (payload?.length === FILE_BLOB_BYTES && !localBlobs.has(payload))
						return `${ITEM} ${id} has no local blob file holding its ${FILE_BLOB_BYTES} bytes`;
				}
			}

			async function assertConverged(step) {
				let mismatch;
				await waitForCondition(
					async (signal) => {
						for (const nodeCtx of nodes) {
							const difference = await findMismatch(nodeCtx.harper, signal);
							if (difference) {
								mismatch = `${nodeCtx.harper.hostname}: ${difference}`;
								return false;
							}
						}
						return true;
					},
					{
						timeoutMs: CONVERGE_TIMEOUT_MS,
						pollMs: 1000,
						description: () => `${step}: every node to hold exactly the written records; ${mismatch}`,
					}
				);
			}

			async function switchBinary(nodeCtx, harperBinPath, version, env, whileDown) {
				await stop(nodeCtx);
				await whileDown();
				await start(nodeCtx, harperBinPath, version, env);
				await waitForMesh();
				await assertConverged(
					`${nodeCtx.harper.hostname} catching up on writes it missed while switching to ${version}`
				);
			}

			let failedStep;
			// each step builds on the cluster the previous one left; after a failure the rest would only time out
			function step(name, body) {
				test(name, async (t) => {
					if (failedStep) return t.skip(`"${failedStep}" failed`);
					try {
						await body();
					} catch (error) {
						failedStep = name;
						throw error;
					}
				});
			}

			before(async () => {
				await settleAll([nodeA, nodeB, nodeC].map(startFresh));
			});

			after(async () => {
				await stopAndTeardownNodes(nodes.map((nodeCtx) => nodeCtx.harper));
			});

			step(`all nodes on ${previousVersion}: each seeds alone, then they connect`, async () => {
				// writing before connecting gives each node its own typed-structure dictionary
				await Promise.all([writeBatch(nodeA, 'seed-a'), writeBatch(nodeB, 'seed-b'), writeBatch(nodeC, 'seed-c')]);
				for (const joiner of [nodeB, nodeC]) {
					await sendOperation(
						joiner.harper,
						{
							operation: 'add_node',
							hostname: nodeA.harper.hostname,
							rejectUnauthorized: false,
							authorization: nodeA.harper.admin,
						},
						{ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
					);
				}
				await waitForMesh();
				await assertConverged('seed');
				// A cursor from a base copy is persisted only after a memtable flush, and a peer that switches
				// binaries before then is asked for a base copy again — which this build refuses to an
				// old-release peer (harper-pro#1007). A cursor from a live write is persisted right after it
				// applies, so writing live here closes that window before any switch.
				await Promise.all([writeBatch(nodeA, 'live-a'), writeBatch(nodeB, 'live-b'), writeBatch(nodeC, 'live-c')]);
				await assertConverged('first live writes');
			});

			step('1 of 3 upgraded: old and new nodes both write', async () => {
				await switchBinary(nodeC, CURRENT_BIN, CURRENT_VERSION, undefined, () =>
					writeBatch(nodeA, 'c-down', { updateFrom: 'seed-c', deleteFrom: 'seed-c' })
				);
				await Promise.all([
					writeBatch(nodeA, 'p1-old', { updateFrom: 'seed-b', deleteFrom: 'seed-a' }),
					writeBatch(nodeC, 'p1-new', { updateFrom: 'seed-a', deleteFrom: 'seed-b' }),
				]);
				await assertConverged('1 of 3 upgraded');
			});

			step('2 of 3 upgraded: old and new nodes both write', async () => {
				await switchBinary(nodeB, CURRENT_BIN, CURRENT_VERSION, undefined, () =>
					writeBatch(nodeA, 'b-down', { updateFrom: 'c-down', deleteFrom: 'c-down' })
				);
				await Promise.all([
					writeBatch(nodeA, 'p2-old', { updateFrom: 'p1-new', deleteFrom: 'p1-new' }),
					writeBatch(nodeB, 'p2-new', { updateFrom: 'p1-old', deleteFrom: 'p1-old' }),
				]);
				await assertConverged('2 of 3 upgraded');
			});

			step('3 of 3 upgraded', async () => {
				await switchBinary(nodeA, CURRENT_BIN, CURRENT_VERSION, undefined, () =>
					writeBatch(nodeB, 'a-down', { updateFrom: 'b-down', deleteFrom: 'b-down' })
				);
				await writeBatch(nodeA, 'p3', { updateFrom: 'p2-old', deleteFrom: 'p2-new' });
				await assertConverged('3 of 3 upgraded');
			});

			step('a cold restart of every node keeps convergence', async () => {
				await settleAll(nodes.map(stop));
				await settleAll(nodes.map((nodeCtx) => start(nodeCtx, CURRENT_BIN, CURRENT_VERSION)));
				await waitForMesh();
				await assertConverged('after a cold restart');
				await writeBatch(nodeB, 'cold', { updateFrom: 'p2-new', deleteFrom: 'p2-old' });
				await assertConverged('a write after the cold restart');
			});

			step(`one node rolled back to ${previousVersion} rejoins`, async () => {
				await switchBinary(nodeC, previousBin, previousVersion, { CONFIRM_DOWNGRADE: 'yes' }, () =>
					writeBatch(nodeA, 'rollback-down', { updateFrom: 'a-down', deleteFrom: 'a-down' })
				);
				await Promise.all([
					writeBatch(nodeC, 'rb-old', { updateFrom: 'p3', deleteFrom: 'p3' }),
					writeBatch(nodeA, 'rb-new', { updateFrom: 'cold', deleteFrom: 'cold' }),
				]);
				await assertConverged('after a one-node rollback');
			});

			step(`a node joining on ${previousVersion} while the others run this build`, async () => {
				let socket;
				await waitForCondition(
					async (signal) => {
						const status = await sendOperation(nodeA.harper, { operation: 'cluster_status' }, { signal });
						socket = status.connections
							.find(({ name }) => name === nodeC.harper.hostname)
							?.database_sockets?.find(({ database }) => database === DATABASE);
						return socket?.peerCapabilities;
					},
					{
						timeoutMs: CONVERGE_TIMEOUT_MS,
						pollMs: 1000,
						description: () =>
							`${nodeA.harper.hostname} to report the capabilities of ${previousVersion} node ${nodeC.harper.hostname}; last socket: ${JSON.stringify(socket)}`,
					}
				);
				const nodeD = { name: ctx.name };
				await startFresh(nodeD);
				await sendOperation(
					nodeD.harper,
					{
						operation: 'add_node',
						hostname: nodeA.harper.hostname,
						rejectUnauthorized: false,
						authorization: nodeA.harper.admin,
					},
					{ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
				);
				ok(
					previousVersion in PREVIOUS_SAFE_COPY_AUDIT,
					`no known safeCopyAudit expectation recorded for ${previousVersion}; add one to PREVIOUS_SAFE_COPY_AUDIT`
				);
				equal(
					socket.peerCapabilities.safeCopyAudit,
					PREVIOUS_SAFE_COPY_AUDIT[previousVersion],
					`${nodeA.harper.hostname} reported safeCopyAudit=${socket.peerCapabilities.safeCopyAudit} for ${previousVersion} node ${nodeC.harper.hostname}, expected ${PREVIOUS_SAFE_COPY_AUDIT[previousVersion]} — a capability-decode regression, or ${previousVersion} now ships harper-pro#848`
				);
				if (socket.peerCapabilities.safeCopyAudit) {
					await writeBatch(nodeA, 'join');
					await assertConverged(`${nodeD.harper.hostname} joining on ${previousVersion}`);
					return;
				}
				// Pins https://github.com/HarperFast/harper-pro/issues/1007: this build refuses a base copy to a peer
				// that does not advertise safeCopyAudit (every 5.x release before it) when a table has no numeric
				// update-timestamp attribute, and that peer's subscription closes 1008 and retries forever. Once this
				// times out, the issue is fixed: drop this branch so the joining node must converge.
				const refusal = new RegExp(
					`closing ${nodeD.harper.hostname.replaceAll('.', '\\.')} data 1008 .*Cannot verify replication baseline`
				);
				await waitForCondition(async () => refusal.test(await readLog(nodeA.harper)), {
					timeoutMs: KNOWN_ISSUE_TIMEOUT_MS,
					pollMs: 1000,
					description: `${nodeA.harper.hostname} to refuse ${nodeD.harper.hostname} a base copy (harper-pro#1007); if that is fixed, drop this branch`,
				});
			});
		}
	);
}
