/**
 * A replication pool worker never runs application code, so it cannot maintain a computed index whose
 * resolver the application assigns with `setComputedAttribute`. An explicit pool must refuse to replicate
 * that table loudly rather than apply writes that leave the index silently wrong (harper-pro#975); a
 * defaulted pool (`replication.threads` omitted) is not started, so the table replicates on HTTP workers
 * with a correct index (harper-pro#1197).
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, readLog, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const FIXTURE = join(import.meta.dirname, 'fixture-computed-index');

async function startComputedIndexCluster(ctx, nodeConfig) {
	const started = await Promise.allSettled(
		[0, 1].map(async () => {
			const hostname = await getNextAvailableLoopbackAddress();
			let dataRootDir;
			try {
				dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
				await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
				const node = { name: ctx.name, harper: { hostname, dataRootDir } };
				await startHarper(node, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, console: true, level: 'warn' },
						...nodeConfig(hostname),
					},
					env: { HARPER_CONFIG: '' },
				});
				return node.harper;
			} catch (error) {
				// not yet in ctx.nodes, so release the reserved address and data root here
				await teardownHarper({ harper: { hostname, dataRootDir } }).catch(() => {});
				throw error;
			}
		})
	);
	// a node that did start must still reach after()'s teardown when its sibling failed
	ctx.nodes = started.filter((result) => result.status === 'fulfilled').map((result) => result.value);
	const failed = started.find((result) => result.status === 'rejected');
	if (failed) throw failed.reason;
	const { operation_token } = await sendOperation(ctx.nodes[0], {
		operation: 'create_authentication_tokens',
		authorization: ctx.nodes[0].admin,
	});
	await sendOperation(ctx.nodes[1], {
		operation: 'add_node',
		rejectUnauthorized: false,
		hostname: ctx.nodes[0].hostname,
		authorization: 'Bearer ' + operation_token,
	});
}

async function putComputedRow(node, id, name) {
	const response = await fetch(new URL(`/ComputedRow/${id}`, node.httpURL), {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ id, name }),
	});
	ok(response.status < 300, `put: ${response.status}`);
}

async function threadCounts(node) {
	const { threads } = await sendOperation(node, { operation: 'system_information', attributes: ['threads'] });
	return {
		http: threads.filter((thread) => thread.name === 'http').length,
		replication: threads.filter((thread) => thread.name === 'replication').length,
	};
}

suite('an explicit replication pool refuses a table with application-resolved computed indexes', (ctx) => {
	before(() =>
		startComputedIndexCluster(ctx, (hostname) => ({ replication: { securePort: hostname + ':9933', threads: 2 } }))
	);
	after(async () => {
		if (ctx.nodes) await Promise.all(ctx.nodes.map((harper) => teardownHarper({ harper })));
	});

	test('names the table and its indexes instead of replicating it with a wrong index', async () => {
		await putComputedRow(ctx.nodes[0], 'a', 'alpha');
		await waitForCondition(
			async () =>
				(await readLog(ctx.nodes[1])).includes('Refusing to replicate: data.ComputedRow has computed indexes (upper)'),
			{ timeoutMs: 60_000, description: 'the replica to refuse the table' }
		);
		await delay(2000);
		const replicated = await sendOperation(ctx.nodes[1], {
			operation: 'search_by_id',
			table: 'ComputedRow',
			ids: ['a'],
			get_attributes: ['id'],
		});
		strictEqual(replicated.length, 0, 'the write was not applied with an unmaintained index');
	});
});

suite('a defaulted replication pool yields to application-resolved computed indexes', (ctx) => {
	before(() =>
		startComputedIndexCluster(ctx, (hostname) => ({
			threads: { count: 4 },
			replication: { securePort: hostname + ':9933' },
		}))
	);
	after(async () => {
		if (ctx.nodes) await Promise.all(ctx.nodes.map((harper) => teardownHarper({ harper })));
	});

	test('starts no pool and names the table that needs application code', async () => {
		for (const node of ctx.nodes) {
			deepStrictEqual(await threadCounts(node), { http: 4, replication: 0 });
			const log = await readLog(node);
			ok(
				log.includes(
					"Table 'data.ComputedRow' assigned setComputedAttribute for the indexed @computed attribute 'upper', which is deprecated"
				),
				'registering the resolver logs its deprecation'
			);
			ok(
				/Starting no replication pool: replication\.threads is not set and data\.ComputedRow/.test(log),
				'the defaulted pool is declined, naming the table'
			);
			ok(!log.includes('Refusing to replicate'), 'no table is refused');
		}
	});

	test('replicates the table with its application-resolved index maintained on the receiver', async () => {
		await putComputedRow(ctx.nodes[0], 'b', 'bravo');
		const [indexed] = await waitForCondition(
			async (signal) => {
				const found = await sendOperation(
					ctx.nodes[1],
					{
						operation: 'search_by_value',
						table: 'ComputedRow',
						search_attribute: 'upper',
						search_value: 'BRAVO',
						get_attributes: ['id', 'name'],
					},
					{ signal }
				);
				return found.length > 0 && found;
			},
			{ timeoutMs: 60_000, description: 'the replica to find the row through its computed index' }
		);
		deepStrictEqual(indexed, { id: 'b', name: 'bravo' });
	});

	test('moves the replicated index entry when the source value changes', async () => {
		await putComputedRow(ctx.nodes[0], 'b', 'charlie');
		const searchUpper = (value, signal) =>
			sendOperation(
				ctx.nodes[1],
				{
					operation: 'search_by_value',
					table: 'ComputedRow',
					search_attribute: 'upper',
					search_value: value,
					get_attributes: ['id', 'name'],
				},
				{ signal }
			);
		const [moved] = await waitForCondition(
			async (signal) => {
				const found = await searchUpper('CHARLIE', signal);
				return found.length > 0 && found;
			},
			{ timeoutMs: 60_000, description: 'the replica to index the updated value' }
		);
		deepStrictEqual(moved, { id: 'b', name: 'charlie' });
		deepStrictEqual(await searchUpper('BRAVO'), [], 'the old index entry is removed');
	});
});
