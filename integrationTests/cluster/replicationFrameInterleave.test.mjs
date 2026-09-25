/**
 * Frames from two peers must not interleave on the receiver (harper#1162).
 *
 * Every connection on a worker feeds one subscription per database, and core applies it with one transaction
 * in progress. The receive loop yields partway through a frame (per-record backpressure), so another peer's
 * frame can start meanwhile: that closes the first frame's transaction early, and the first frame's remaining
 * records are applied inside the second frame's transaction. They then take its timestamp as their version,
 * or fail with `already bound to the log store` when the two origins have separate logs.
 *
 * A receives from B and C at once, with a high-water mark of 1 so its receive loop yields after almost every
 * record. B and C each write multi-record transactions; A must end up with every record.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TRANSACTIONS = 40;
const RECORDS_PER_TRANSACTION = 10;
const TIMEOUT_MS = 30000;

async function readValues(node, ids) {
	const records = await sendOperation(node, {
		operation: 'search_by_id',
		database: 'data',
		table: 'Interleave',
		get_attributes: ['id', 'value'],
		ids,
	});
	return Object.fromEntries(records.map((record) => [record.id, record.value]));
}

async function writeTransactions(node, prefix) {
	for (let t = 0; t < TRANSACTIONS; t++) {
		const records = [];
		for (let r = 0; r < RECORDS_PER_TRANSACTION; r++) records.push({ id: `${prefix}-${t}-${r}`, value: t });
		await sendOperation(node, { operation: 'upsert', database: 'data', table: 'Interleave', records });
	}
}

suite('Replication frames from two peers do not interleave', { timeout: 180000 }, (ctx) => {
	before(async () => {
		ctx.nodes = await Promise.all(
			['A', 'B', 'C'].map(async (suffix) => {
				const hostname = await getNextAvailableLoopbackAddress();
				const nodeCtx = { name: ctx.name + '-' + suffix, harper: { hostname } };
				await startHarper(nodeCtx, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: true, console: true },
						replication: {
							securePort: hostname + ':9933',
							databases: ['data'],
							...(suffix === 'A' ? { receiveEventHighWaterMark: 1 } : {}),
						},
					},
				});
				return nodeCtx.harper;
			})
		);
		await Promise.all(
			ctx.nodes.map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: 'data',
					table: 'Interleave',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'value', type: 'Int' },
					],
				})
			)
		);
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

	test('a node receiving from two peers applies every record', async () => {
		const [nodeA, nodeB, nodeC] = ctx.nodes;
		await Promise.all([writeTransactions(nodeB, 'b'), writeTransactions(nodeC, 'c')]);
		const idsFor = (prefix) =>
			Array.from({ length: TRANSACTIONS * RECORDS_PER_TRANSACTION }, (_, i) =>
				[prefix, Math.floor(i / RECORDS_PER_TRANSACTION), i % RECORDS_PER_TRANSACTION].join('-')
			);
		const expected = { ...(await readValues(nodeB, idsFor('b'))), ...(await readValues(nodeC, idsFor('c'))) };
		const ids = Object.keys(expected);
		let received = {};
		const deadline = Date.now() + TIMEOUT_MS;
		while (Date.now() < deadline) {
			received = await readValues(nodeA, ids);
			if (Object.keys(received).length === ids.length) break;
			await delay(250);
		}
		const mismatched = ids.filter((id) => received[id] !== expected[id]);
		deepEqual(
			mismatched.map((id) => ({ id, received: received[id], expected: expected[id] })).slice(0, 10),
			[],
			`${mismatched.length} of ${ids.length} records on A are missing or differ`
		);
	});
});
