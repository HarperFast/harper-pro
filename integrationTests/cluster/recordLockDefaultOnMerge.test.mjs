/**
 * Two clusters that each established a generation-1 home map automatically (harper-pro#853), then joined:
 * as soon as their nodes connect, every node withholds its map, on both sides, until an operator applies
 * one map to all of them.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendOperation, waitForCondition } from './clusterShared.mjs';
import {
	call,
	connectMesh,
	currentRow,
	lockStatus,
	nodeNames,
	putCounter,
	startDefaultNode,
	stopNode,
	waitForCounter,
	waitForMesh,
} from './recordLockShared.mjs';

suite('two clusters with automatic home maps, joined', { timeout: 600_000 }, (ctx) => {
	const contexts = [];
	let nodes;

	before(async () => {
		const started = await Promise.allSettled(Array.from({ length: 4 }, () => startDefaultNode(ctx.name)));
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		nodes = contexts.map((c) => c.harper);
		await connectMesh(nodes.slice(0, 2));
		await connectMesh(nodes.slice(2));
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('each cluster establishes its own generation 1', async () => {
		for (const pair of [nodes.slice(0, 2), nodes.slice(2)]) {
			const id = 'pair-' + Date.now();
			await putCounter(pair[0], id, 0);
			await waitForCounter(pair, id, 0);
			const results = await Promise.all(pair.map((node) => call(node, 'LockedIncrement/', { id })));
			assert.deepEqual(
				results.map((result) => result.status),
				[200, 200],
				JSON.stringify(results)
			);
			const names = [...(await nodeNames(pair))].sort();
			for (const node of pair) assert.deepEqual((await currentRow(node)).active?.homes, names, node.hostname);
		}
	});

	test('once joined, every node on both sides refuses cluster locks', async () => {
		const { operation_token: token } = await sendOperation(nodes[0], {
			operation: 'create_authentication_tokens',
			authorization: nodes[0].admin,
		});
		await sendOperation(nodes[2], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: nodes[0].hostname,
			authorization: 'Bearer ' + token,
		});
		await waitForMesh(nodes);
		let last;
		await waitForCondition(
			async () => {
				last = [];
				for (const node of nodes) last.push(await lockStatus(node, 'merged-' + Date.now()));
				return last.every((status) => status === 503) ? last : undefined;
			},
			{ timeoutMs: 60_000, description: () => `every node to refuse cluster locks; last ${JSON.stringify(last)}` }
		);
	});
});
