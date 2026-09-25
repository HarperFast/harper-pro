/**
 * A replicated transaction carries a single origin (harper#1162).
 *
 * A sender's frame holds every record at one log key from all of its logs, so it can span origins: a node
 * can hold entries at the same key in two origin logs (a 5.1.x base copy re-stamps copied rows with the
 * copier's id at the original version). RocksDB binds a transaction to one log, so applying such a frame as
 * one transaction failed with `already bound to the log store` on every re-delivery.
 *
 * B holds one transaction in its `local` log and one in a removed origin's (`ghost-origin`) log at one
 * timestamp; A also has a `ghost-origin` log. A is down while B writes them, so B sends both in one frame.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import {
	killHarper,
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const GHOST = 'ghost-origin';
const TIMEOUT_MS = 20000;

function startOptions(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: { securePort: hostname + ':9933', databases: ['data'] },
			singleOriginFrame: { package: join(TEST_DIR, 'fixture-single-origin-frame') },
		},
	};
}

async function originLogWrite(node, body) {
	const deadline = Date.now() + TIMEOUT_MS;
	for (;;) {
		try {
			const response = await fetch(node.httpURL + '/OriginLogWrite', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
				},
				body: JSON.stringify({ ghost: GHOST, ...body }),
			});
			if (response.ok) return response.json();
			if (Date.now() > deadline) throw new Error(`OriginLogWrite ${response.status}: ${await response.text()}`);
		} catch (error) {
			if (Date.now() > deadline) throw error;
		}
		await delay(250);
	}
}

async function restart(node) {
	await killHarper({ harper: node });
	return (await startHarper({ harper: node }, startOptions(node.hostname))).harper;
}

async function waitForIds(node, ids) {
	const deadline = Date.now() + TIMEOUT_MS;
	let found = [];
	while (Date.now() < deadline) {
		const records = await sendOperation(node, {
			operation: 'search_by_id',
			database: 'data',
			table: 'OriginRecord',
			get_attributes: ['id'],
			ids,
		});
		found = records.map((record) => record.id).sort();
		if (found.length === ids.length) break;
		await delay(200);
	}
	return found;
}

suite('Replication frame carries a single origin', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const [nodeA, nodeB] = await Promise.all(
			['A', 'B'].map(async (suffix) => {
				const nodeCtx = {
					name: ctx.name + '-' + suffix,
					harper: { hostname: await getNextAvailableLoopbackAddress() },
				};
				await startHarper(nodeCtx, startOptions(nodeCtx.harper.hostname));
				return nodeCtx.harper;
			})
		);
		await Promise.all(
			[nodeA, nodeB].map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					table: 'OriginRecord',
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				})
			)
		);
		// the fixture resource is registered at boot, and a table created afterwards unregisters it
		[ctx.nodeA, ctx.nodeB] = await Promise.all([restart(nodeA), restart(nodeB)]);
		await Promise.all([originLogWrite(ctx.nodeA, {}), originLogWrite(ctx.nodeB, {})]);
		await sendOperation(ctx.nodeA, {
			operation: 'add_node',
			hostname: ctx.nodeB.hostname,
			rejectUnauthorized: false,
			authorization: ctx.nodeB.admin,
		});
		await originLogWrite(ctx.nodeB, { version: Date.now(), records: [{ id: 'warmup' }] });
		deepEqual(await waitForIds(ctx.nodeA, ['warmup']), ['warmup'], 'replication B -> A is not flowing');
	});

	after(async () => {
		await Promise.all([ctx.nodeA, ctx.nodeB].map((node) => node && teardownHarper({ harper: node }).catch(() => null)));
	});

	test('entries at one key in two origin logs are applied as two transactions', async () => {
		await killHarper({ harper: ctx.nodeA });
		await originLogWrite(ctx.nodeB, {
			version: Date.now(),
			records: [{ id: 'from-local' }, { id: 'from-ghost', fromGhost: true }],
		});
		ctx.nodeA = (await startHarper({ harper: ctx.nodeA }, startOptions(ctx.nodeA.hostname))).harper;
		deepEqual(await waitForIds(ctx.nodeA, ['from-ghost', 'from-local']), ['from-ghost', 'from-local']);
	});
});
