import { test } from 'node:test';
import assert from 'node:assert';
import { join, basename } from 'node:path';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, postOperation, waitForCondition, stopAndTeardownNodes } from './clusterShared.mjs';

const currentBinary = join(import.meta.dirname, '../../dist/bin/harper.js');
const fixture = join(import.meta.dirname, 'fixture-residency-conversion');
const previousBinary =
	process.env.HARPER_PRO_PREVIOUS_VERSION_PATH &&
	join(process.env.HARPER_PRO_PREVIOUS_VERSION_PATH, 'dist/bin/harper.js');

async function request(node, path, body, signal = AbortSignal.timeout(30_000)) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		signal,
		method: body ? 'PUT' : 'GET',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await response.text();
	const value = text ? JSON.parse(text) : undefined;
	assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(value));
	return value;
}

for (const engine of ['rocksdb']) {
	test(
		`zero-movement conversion with optional previous-binary rollback (${engine})`,
		{ timeout: 900_000 },
		async (ctx) => {
			const contexts = [0, 1].map(() => ({ name: ctx.name }));
			const nodes = () => contexts.map((context) => context.harper);
			const options = (context, i, binary = currentBinary) => ({
				harperBinPath: binary,
				env: { HARPER_STORAGE_ENGINE: engine },
				config: {
					threads: { count: 1 },
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, level: 'warn' },
					replication: {
						threads: 0,
						securePort: context.harper.hostname + ':9933',
						shard: i,
						shards: [0, 1],
						databases: '*',
					},
				},
			});
			ctx.after(() => stopAndTeardownNodes(nodes()));
			for (const [i, context] of contexts.entries()) {
				context.harper = { hostname: await getNextAvailableLoopbackAddress() };
				context.harper.dataRootDir = await mkdtemp(
					join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
				);
				await cp(fixture, join(context.harper.dataRootDir, 'components', basename(fixture)), { recursive: true });
				await startHarper(context, options(context, i));
			}
			const { operation_token: token } = await sendOperation(nodes()[0], {
				operation: 'create_authentication_tokens',
				authorization: nodes()[0].admin,
			});
			await sendOperation(nodes()[1], {
				operation: 'add_node',
				hostname: nodes()[0].hostname,
				authorization: 'Bearer ' + token,
				rejectUnauthorized: false,
			});
			let serial = 0;
			async function settle() {
				for (const writer of nodes()) {
					const id = `barrier-${serial++}`;
					await request(writer, `ConversionBarrier/${id}`, { id });
					await waitForCondition(
						async (signal) =>
							(
								await Promise.all(
									nodes().map((node) =>
										sendOperation(
											node,
											{
												operation: 'search_by_id',
												database: 'data',
												table: 'ConversionBarrier',
												ids: [id],
												get_attributes: ['*'],
											},
											{ signal }
										)
									)
								)
							).every((rows) => rows.length === 1),
						{ description: 'conversion nodes caught up' }
					);
				}
			}
			await settle();
			for (const [i, node] of nodes().entries()) {
				const id = i ? 'legacy7' : 'legacy2';
				await request(node, `Converted/${id}`, { id, tag: 'legacy', body: id });
			}
			await request(nodes()[0], 'Plain/plain2', { id: 'plain2', body: 'before-conversion' });
			await settle();
			const map = await sendOperation(nodes()[0], {
				operation: 'initialize_shard_map',
				database: 'data',
				slots: 10,
				ranges: [
					{ start: 0, end: 5, shard: 0 },
					{ start: 5, end: 10, shard: 1 },
				],
			});
			await waitForCondition(
				async (signal) => {
					try {
						return (
							(
								await sendOperation(
									nodes()[1],
									{
										operation: 'verify_shard_map',
										database: 'data',
										table: 'Converted',
										policy: { slots: 10, slotFrom: 'Number(id.slice(-1))' },
									},
									{ signal }
								)
							).mismatches === 0
						);
					} catch {
						return false;
					}
				},
				{ description: 'custom map installed on both nodes' }
			);
			for (const node of nodes()) {
				const report = await sendOperation(node, {
					operation: 'verify_shard_map',
					database: 'data',
					table: 'Converted',
					policy: { slots: 10, slotFrom: 'Number(id.slice(-1))' },
				});
				assert.ok(report.checked >= 1);
				assert.equal(report.mismatches, 0);
			}
			await sendOperation(nodes()[0], {
				operation: 'initialize_shard_map',
				database: 'data',
				existing_owner: true,
				expected_digest: map.digest,
			});
			const plainBefore = await Promise.all(nodes().map((node) => request(node, 'PlainRows/')));
			assert.ok(plainBefore.every((rows) => rows.length === 1));
			const before = await Promise.all(nodes().map((node) => request(node, 'ConversionRows/')));
			const oldSchema = await readFile(join(fixture, 'schema.graphql'), 'utf8');
			const oldResources = await readFile(join(fixture, 'resources.js'), 'utf8');
			async function reopen(declarative, binary, replicaExpiration = 3600, settleReplication = true) {
				await Promise.all(contexts.map((context) => killHarper(context)));
				for (const [i, context] of contexts.entries()) {
					const declared = Array.isArray(declarative) ? declarative[i] : declarative;
					const schema = oldSchema.replace('replicaExpiration: 3600', `replicaExpiration: ${replicaExpiration}`);
					const component = join(context.harper.dataRootDir, 'components', basename(fixture));
					await writeFile(
						join(component, 'schema.graphql'),
						declared
							? schema
									.replace('type Plain @table', 'type Plain @sharded(slotFrom: "Number(id.slice(-1))") @table')
									.replace(
										'type Converted @table',
										'type Converted @sharded(slots: 10, slotFrom: "Number(id.slice(-1))") @table'
									)
							: schema
					);
					await writeFile(
						join(component, 'resources.js'),
						declared ? oldResources.slice(oldResources.indexOf('\n') + 1) : oldResources
					);
					await startHarper(context, options(context, i, Array.isArray(binary) ? binary[i] : binary));
				}
				if (settleReplication) await settle();
			}
			await reopen(true, currentBinary, 3600, false);
			await waitForCondition(
				async (signal) => {
					const status = await sendOperation(nodes()[1], { operation: 'cluster_status' }, { signal });
					return status.sharding?.data?.recovery?.reason?.includes('Missing existing-owner completeness assertion');
				},
				{ description: 'conversion without an assertion stays uncertified' }
			);
			const mismatch = await postOperation(nodes()[1], {
				operation: 'initialize_shard_map',
				database: 'data',
				existing_owner: true,
				expected_digest: 'mismatch',
			});
			assert.equal(mismatch.status, 409);
			await sendOperation(nodes()[1], {
				operation: 'initialize_shard_map',
				database: 'data',
				existing_owner: true,
				expected_digest: map.digest,
			});
			async function ready() {
				await waitForCondition(
					async (signal) =>
						(
							await Promise.all(nodes().map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal })))
						).every((status) => status.sharding?.data?.recovery?.phase === 'ready'),
					{ timeoutMs: 120_000, description: 'converted owners have explicit completeness assertions' }
				);
			}
			await ready();
			await settle();
			for (const [i, node] of nodes().entries()) assert.deepEqual(await request(node, 'PlainRows/'), plainBefore[i]);
			await request(nodes()[0], 'Plain/plain2', { id: 'plain2', body: 'changed-at-owner' });
			await waitForCondition(
				async (signal) => (await request(nodes()[1], 'Plain/plain2', undefined, signal)).body === 'changed-at-owner',
				{ description: 'non-owner conversion read sources the updated owner body' }
			);
			for (const [i, node] of nodes().entries()) {
				const rows = await request(node, 'ConversionRows/');
				for (const row of before[i])
					assert.deepEqual(
						rows.find((current) => current.id === row.id),
						row
					);
				for (const row of rows.filter((current) => !before[i].some((old) => old.id === current.id))) {
					assert.equal(row.flags & 1, 1, 'bootstrap may fill only non-owner index projections');
					assert.equal(row.record.body, undefined);
				}
			}
			for (const [i, node] of nodes().entries()) {
				const id = i ? 'new7' : 'new2';
				await request(node, `Converted/${id}`, { id, tag: 'declarative', body: id });
			}
			await settle();
			for (const node of nodes())
				for (const row of await request(node, 'ConversionAudit/')) {
					assert.equal(row.slot, undefined);
					assert.equal(row.previousSlot, undefined);
					assert.equal(row.flags & 0x30000, 0);
				}
			if (previousBinary) {
				await reopen([true, false], [currentBinary, previousBinary]);
				await waitForCondition(
					async (signal) => {
						const status = await sendOperation(nodes()[0], { operation: 'cluster_status' }, { signal });
						return status.sharding?.data?.errors?.some((error) => error.includes('does not support sharding recovery'));
					},
					{ description: 'a downgraded peer holds sharded writes' }
				);
				const refused = await postOperation(nodes()[0], {
					operation: 'insert',
					database: 'data',
					table: 'Converted',
					records: [{ id: 'mixed7', tag: 'mixed', body: 'must-refuse' }],
				});
				assert.equal(refused.status, 503);
				assert.ok(!(await request(nodes()[0], 'ConversionRows/')).some((row) => row.id === 'mixed7'));
				await reopen(true, currentBinary);
				await ready();
			}
			// Seed a non-owner writer replica even when the optional mixed-version arm did not run.
			await request(nodes()[0], 'Converted/drain7', { id: 'drain7', tag: 'drain', body: 'temporary writer copy' });
			await settle();
			await reopen(true, currentBinary, 0);
			await ready();
			const drains = await Promise.all(nodes().map((node) => request(node, 'ConversionDrain/', {})));
			assert.ok(drains.every((result) => result.remaining === 0));
			assert.equal(drains.reduce((sum, result) => sum + result.demoted, 0) > 0, engine === 'rocksdb');
			if (!previousBinary) {
				ctx.diagnostic('Previous-binary rollback not exercised: HARPER_PRO_PREVIOUS_VERSION_PATH is unset');
				return;
			}
			await reopen(false, previousBinary);
			for (const node of nodes())
				for (const id of ['legacy2', 'legacy7', 'new2', 'new7'])
					assert.equal((await request(node, `Converted/${id}`)).body, id);
			await request(nodes()[0], 'Converted/new7', { id: 'new7', tag: 'rollback', body: 'written by prior binary' });
			await settle();
			await reopen(true, currentBinary);
			for (const node of nodes()) assert.equal((await request(node, 'Converted/new7')).body, 'written by prior binary');
		}
	);
}
