/**
 * A sender's frame holds every entry at one log key across its logs, which can be several origins'
 * transactions, and RocksDB binds a transaction to one log. B holds one transaction in its `local` log and one
 * in a removed origin's (`ghost-origin`) log at one timestamp; A also has a `ghost-origin` log. A is down while
 * B writes them, so B sends both in one frame.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual } from 'node:assert';
import { killHarper, teardownHarper } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';
import { startOriginLogNodes, startNode, postToFixture, waitForVersions } from './originLogShared.mjs';

const TABLE = 'OriginRecord';
const GHOST = 'ghost-origin';

suite('Replication frame spanning two origin logs', { timeout: 180000 }, (ctx) => {
	before(async () => {
		[ctx.nodeA, ctx.nodeB] = await startOriginLogNodes(ctx.name, ['A', 'B'], TABLE);
		for (const node of [ctx.nodeA, ctx.nodeB])
			await postToFixture(node, 'OriginLogWrite', { table: TABLE, ghost: GHOST });
		await sendOperation(ctx.nodeA, {
			operation: 'add_node',
			hostname: ctx.nodeB.hostname,
			rejectUnauthorized: false,
			authorization: ctx.nodeB.admin,
		});
		await postToFixture(ctx.nodeB, 'OriginLogWrite', {
			table: TABLE,
			ghost: GHOST,
			version: Date.now(),
			records: [{ id: 'warmup' }],
		});
		await waitForVersions(ctx.nodeA, TABLE, ['warmup']);
	});

	after(async () => {
		await Promise.all([ctx.nodeA, ctx.nodeB].map((node) => node && teardownHarper({ harper: node }).catch(() => null)));
	});

	test('applies each origin in the frame as its own transaction', async () => {
		await killHarper({ harper: ctx.nodeA });
		const version = Date.now();
		await postToFixture(ctx.nodeB, 'OriginLogWrite', {
			table: TABLE,
			ghost: GHOST,
			version,
			records: [{ id: 'from-local' }, { id: 'from-ghost', fromGhost: true }],
		});
		ctx.nodeA = await startNode(ctx.nodeA);
		deepEqual(await waitForVersions(ctx.nodeA, TABLE, ['from-local', 'from-ghost']), {
			'from-local': version,
			'from-ghost': version,
		});
	});
});
