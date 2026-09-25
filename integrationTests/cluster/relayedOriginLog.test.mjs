/**
 * A transaction log holds one origin, so a record relayed through a peer is filed in its origin's log on the
 * receiver rather than in the relaying peer's log (where two origins could share a log key). C replicates only
 * with B, and A only with B, so C's records reach A through B.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual } from 'node:assert';
import { teardownHarper } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';
import { startOriginLogNodes, postToFixture, waitForVersions } from './originLogShared.mjs';

const TABLE = 'Relayed';

suite('Replication relayed through a peer', { timeout: 180000 }, (ctx) => {
	before(async () => {
		ctx.nodes = await startOriginLogNodes(ctx.name, ['A', 'B', 'C'], TABLE);
		const [nodeA, nodeB, nodeC] = ctx.nodes;
		for (const [from, to] of [
			[nodeA, nodeB],
			[nodeC, nodeB],
		]) {
			await sendOperation(from, {
				operation: 'add_node',
				hostname: to.hostname,
				rejectUnauthorized: false,
				authorization: to.admin,
			});
		}
	});

	after(async () => {
		await Promise.all((ctx.nodes ?? []).map((node) => teardownHarper({ harper: node }).catch(() => null)));
	});

	test("files a relayed record in its origin's log", async () => {
		const [nodeA, , nodeC] = ctx.nodes;
		await sendOperation(nodeC, { operation: 'upsert', database: 'data', table: TABLE, records: [{ id: 'from-c' }] });
		await waitForVersions(nodeA, TABLE, ['from-c']);
		deepEqual(await postToFixture(nodeA, 'RecordLogs', { table: TABLE, ids: ['from-c'] }), {
			'from-c': nodeC.hostname,
		});
	});
});
