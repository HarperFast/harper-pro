/**
 * A frame whose transaction fails is replayed from the durable cursor (hold) up to
 * `replication.failedFrameReplays` times, then moved past (escalate) so it cannot stall the peer. On A,
 * `poison` fails on its first two deliveries and `stuck` on every delivery.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { teardownHarper } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';
import { startOriginLogNodes, postToFixture, waitForVersions } from './originLogShared.mjs';

const TABLE = 'FailedFrame';

async function upsert(node, id) {
	await sendOperation(node, { operation: 'upsert', database: 'data', table: TABLE, records: [{ id }] });
}

suite('Replication of a frame whose transaction fails', { timeout: 180000 }, (ctx) => {
	before(async () => {
		ctx.nodes = await startOriginLogNodes(
			ctx.name,
			['A', 'B'],
			TABLE,
			{ A: { failedFrameReplays: 3 } },
			{ A: { HARPER_TEST_FAIL_APPLY: 'poison:2,stuck:100' } }
		);
		const [nodeA, nodeB] = ctx.nodes;
		await sendOperation(nodeA, {
			operation: 'add_node',
			hostname: nodeB.hostname,
			rejectUnauthorized: false,
			authorization: nodeB.admin,
		});
		await delay(2000);
	});

	after(async () => {
		await Promise.all((ctx.nodes ?? []).map((node) => teardownHarper({ harper: node }).catch(() => null)));
	});

	test('replays a failed frame until it applies', async () => {
		const [nodeA, nodeB] = ctx.nodes;
		await upsert(nodeB, 'poison');
		await upsert(nodeB, 'after-poison');
		const versions = await waitForVersions(nodeA, TABLE, ['poison', 'after-poison']);
		deepEqual(
			Object.keys(versions)
				.filter((id) => versions[id] !== undefined)
				.sort(),
			['after-poison', 'poison']
		);
	});

	test('moves past a frame that fails on every replay', async () => {
		const [nodeA, nodeB] = ctx.nodes;
		await upsert(nodeB, 'stuck');
		await upsert(nodeB, 'after-stuck');
		const { 'after-stuck': afterVersion } = await postToFixture(nodeB, 'RecordVersions', {
			table: TABLE,
			ids: ['after-stuck'],
		});
		const deadline = Date.now() + 30000;
		let cursor;
		do {
			({ seqId: cursor } = await postToFixture(nodeA, 'ReplicationCursor', { table: TABLE, node: nodeB.hostname }));
			if (cursor >= afterVersion) break;
			await delay(250);
		} while (Date.now() < deadline);
		ok(cursor >= afterVersion, `A's resume cursor for B (${cursor}) never passed the failed frame (${afterVersion})`);
		equal((await postToFixture(nodeA, 'RecordVersions', { table: TABLE, ids: ['stuck'] })).stuck, undefined);
		// the skipped write is missing on A for good: A's receipt for B must not vouch for it (harper-pro#1348)
		let receipt;
		for (const until = Date.now() + 30000; Date.now() < until; await delay(250)) {
			({ data: receipt } = await sendOperation(nodeA, {
				operation: 'get_received_origin_floors',
				origin: nodeB.hostname,
				databases: ['data'],
			}));
			if (receipt?.hole === true) break;
		}
		equal(receipt?.hole, true, `A's receipt for B after the skip: ${JSON.stringify(receipt)}`);
	});
});
