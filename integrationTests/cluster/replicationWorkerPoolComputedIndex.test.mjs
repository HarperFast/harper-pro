/**
 * A replication pool worker never runs application code, so it cannot maintain a computed index whose
 * resolver the application assigns with `setComputedAttribute`. It must refuse to replicate that table
 * loudly rather than apply writes that leave the index silently wrong (harper-pro#975).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, readLog, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const FIXTURE = join(import.meta.dirname, 'fixture-computed-index');

suite('a replication pool refuses a table with application-resolved computed indexes', (ctx) => {
	before(async () => {
		ctx.nodes = await Promise.all(
			[0, 1].map(async () => {
				const hostname = await getNextAvailableLoopbackAddress();
				const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
				await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
				const node = { name: ctx.name, harper: { hostname, dataRootDir } };
				await startHarper(node, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, console: true, level: 'warn' },
						replication: { securePort: hostname + ':9933', threads: 2 },
					},
				});
				return node.harper;
			})
		);
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
	});
	after(async () => {
		if (ctx.nodes) await Promise.all(ctx.nodes.map((harper) => teardownHarper({ harper })));
	});

	test('names the table and its indexes instead of replicating it with a wrong index', async () => {
		const response = await fetch(new URL('/ComputedRow/a', ctx.nodes[0].httpURL), {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'a', name: 'alpha' }),
		});
		ok(response.status < 300, `put: ${response.status}`);
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
