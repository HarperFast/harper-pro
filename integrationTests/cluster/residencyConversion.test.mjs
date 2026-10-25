import { test } from 'node:test';
import assert from 'node:assert';
import { join, basename } from 'node:path';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition, stopAndTeardownNodes } from './clusterShared.mjs';

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

for (const engine of ['rocksdb', 'lmdb']) {
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
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, level: 'warn' },
					replication: { threads: 0, securePort: context.harper.hostname + ':9933', shard: i, databases: '*' },
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
			await settle();
			await sendOperation(nodes()[0], {
				operation: 'initialize_residency_slots',
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
										operation: 'verify_residency_slots',
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
					operation: 'verify_residency_slots',
					database: 'data',
					table: 'Converted',
					policy: { slots: 10, slotFrom: 'Number(id.slice(-1))' },
				});
				assert.ok(report.checked >= 1);
				assert.equal(report.mismatches, 0);
			}
			const before = await Promise.all(nodes().map((node) => request(node, 'ConversionRows/')));
			const oldSchema = await readFile(join(fixture, 'schema.graphql'), 'utf8');
			const oldResources = await readFile(join(fixture, 'resources.js'), 'utf8');
			async function reopen(declarative, binary, replicaExpiration = 3600) {
				await Promise.all(contexts.map((context) => killHarper(context)));
				for (const [i, context] of contexts.entries()) {
					const declared = Array.isArray(declarative) ? declarative[i] : declarative;
					const schema = oldSchema.replace('replicaExpiration: 3600', `replicaExpiration: ${replicaExpiration}`);
					const component = join(context.harper.dataRootDir, 'components', basename(fixture));
					await writeFile(
						join(component, 'schema.graphql'),
						declared
							? schema.replace(
									'type Converted @table',
									'type Converted @residency(slots: 10, slotFrom: "Number(id.slice(-1))") @table'
								)
							: schema
					);
					await writeFile(
						join(component, 'resources.js'),
						declared ? oldResources.slice(oldResources.indexOf('\n') + 1) : oldResources
					);
					await startHarper(context, options(context, i, Array.isArray(binary) ? binary[i] : binary));
				}
				await settle();
			}
			await reopen(true, currentBinary);
			for (const [i, node] of nodes().entries()) assert.deepEqual(await request(node, 'ConversionRows/'), before[i]);
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
				await request(nodes()[0], 'Converted/mixed7', { id: 'mixed7', tag: 'mixed', body: 'legacy reader' });
				await settle();
				for (const node of nodes()) assert.equal((await request(node, 'Converted/mixed7')).body, 'legacy reader');
				const legacyRows = await request(nodes()[1], 'ConversionRows/');
				assert.equal(legacyRows.find((row) => row.id === 'mixed7').slot, undefined);
			}
			// Seed a non-owner writer replica even when the optional mixed-version arm did not run.
			await request(nodes()[0], 'Converted/drain7', { id: 'drain7', tag: 'drain', body: 'temporary writer copy' });
			await settle();
			await reopen(true, currentBinary, 0);
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
