/**
 * A receives from B and C at once, with a high-water mark of 1 so its receive loop yields after almost every
 * record, and B and C each write multi-record transactions. Core applies A's shared subscription with one
 * transaction in progress, so another peer's events queued inside a frame would join that frame's transaction:
 * failing with `already bound to the log store`, or taking its timestamp as their version.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { teardownHarper } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';
import { startOriginLogNodes, postToFixture, waitForVersions } from './originLogShared.mjs';

const TABLE = 'Interleave';
const TRANSACTIONS = 40;
const RECORDS_PER_TRANSACTION = 10;

async function writeTransactions(node, prefix) {
	const ids = [];
	for (let t = 0; t < TRANSACTIONS; t++) {
		const records = [];
		for (let r = 0; r < RECORDS_PER_TRANSACTION; r++) records.push({ id: `${prefix}-${t}-${r}`, name: prefix });
		ids.push(...records.map((record) => record.id));
		await sendOperation(node, { operation: 'upsert', database: 'data', table: TABLE, records });
	}
	return ids;
}

suite('Replication frames from two peers', { timeout: 180000 }, (ctx) => {
	before(async () => {
		ctx.nodes = await startOriginLogNodes(ctx.name, ['A', 'B', 'C'], TABLE, { A: { receiveEventHighWaterMark: 1 } });
		const [nodeA, nodeB, nodeC] = ctx.nodes;
		for (const peer of [nodeB, nodeC]) {
			await sendOperation(nodeA, {
				operation: 'add_node',
				hostname: peer.hostname,
				rejectUnauthorized: false,
				authorization: peer.admin,
			});
		}
		await delay(2000);
	});

	after(async () => {
		await Promise.all((ctx.nodes ?? []).map((node) => teardownHarper({ harper: node }).catch(() => null)));
	});

	test('keep every record at its origin version on a node receiving from both', async () => {
		const [nodeA, nodeB, nodeC] = ctx.nodes;
		const [idsB, idsC] = await Promise.all([writeTransactions(nodeB, 'b'), writeTransactions(nodeC, 'c')]);
		const expected = {
			...(await postToFixture(nodeB, 'RecordVersions', { table: TABLE, ids: idsB })),
			...(await postToFixture(nodeC, 'RecordVersions', { table: TABLE, ids: idsC })),
		};
		const ids = [...idsB, ...idsC];
		const received = await waitForVersions(nodeA, TABLE, ids);
		const mismatched = ids.filter((id) => received[id] !== expected[id]);
		deepEqual(
			mismatched.slice(0, 10).map((id) => ({ id, received: received[id], expected: expected[id] })),
			[],
			`${mismatched.length} of ${ids.length} records on A are missing or carry another version`
		);
	});
});
