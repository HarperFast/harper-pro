import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';
import {
	DB,
	bootstrapHomeMap,
	call,
	clusterStatusOf,
	restartStoppedNode,
	startNode,
	stopNode,
	waitForCounter,
	waitForMesh,
	waitForRing,
} from './recordLockShared.mjs';

const LOCK_TIMEOUT_MS = 20_000;

function cloneEnv(leader, token, extra = {}) {
	return {
		HDB_LEADER_URL: `http://${leader.hostname}:9925`,
		HDB_LEADER_TOKEN: token,
		ALLOW_SELF_SIGNED: true,
		...extra,
	};
}

/** The attempt marker is stamped on completion and removed a minute later; either way the clone finished. */
function waitForCompletedClone(node) {
	return waitForCondition(
		() => {
			try {
				const attempt = JSON.parse(readFileSync(join(node.dataRootDir, '.cloneAttempt.json'), 'utf8'));
				return typeof attempt?.completedAt === 'number';
			} catch (error) {
				if (error?.code !== 'ENOENT') return false;
				return /^cloned:\s*true\s*$/m.test(readFileSync(join(node.dataRootDir, 'harper-config.yaml'), 'utf8'));
			}
		},
		{ timeoutMs: 240_000, pollMs: 1_000, description: `${node.hostname} to complete its clone` }
	);
}

function increment(node, id) {
	return call(
		node,
		'LockedIncrement/',
		{ id, scope: 'cluster', timeout: LOCK_TIMEOUT_MS },
		AbortSignal.timeout(60_000)
	);
}

async function freshnessOf(node) {
	return (await clusterStatusOf(node)).recordLocks?.[DB]?.freshness;
}

suite('cluster record locks on a node that joined by cloning (harper-pro#1236)', { timeout: 900_000 }, (ctx) => {
	const contexts = [];
	let leader;
	let joined;
	let token;

	before(async () => {
		contexts.push(await startNode(ctx.name));
		leader = contexts[0].harper;
		({ operation_token: token } = await sendOperation(leader, {
			operation: 'create_authentication_tokens',
			authorization: leader.admin,
		}));
		contexts.push(await startNode(ctx.name, cloneEnv(leader, token)));
		joined = contexts[1].harper;
		await waitForCompletedClone(joined);
		await waitForMesh([leader, joined]);
		await bootstrapHomeMap([leader, joined]);
		await waitForRing([leader, joined], 2);
	});

	after(async () => {
		for (const c of contexts) await stopNode(c);
	});

	test('a key hands off between the leader and the joined node in both directions', async () => {
		for (const [label, sequence] of [
			['leader-first', [leader, joined, leader, joined, leader, joined]],
			['joined-first', [joined, leader, joined, leader]],
		]) {
			const id = `${label}-${Date.now()}`;
			for (const [index, node] of sequence.entries()) {
				const result = await increment(node, id);
				assert.equal(
					result.status,
					200,
					`${label} step ${index} on ${node === joined ? 'the joined node' : 'the leader'}: ${JSON.stringify(result.body)}`
				);
				assert.equal(result.body.n, index + 1, `${label} step ${index} read every earlier increment`);
			}
			await waitForCounter([leader, joined], id, sequence.length);
		}
		const freshness = await freshnessOf(joined);
		assert.ok(freshness.applied > 0, `the joined node proved its handoffs by barrier: ${JSON.stringify(freshness)}`);
		assert.equal(freshness.rejected?.recloned, undefined, JSON.stringify(freshness));
	});

	test('a clone after losing the database storage, with the home-map row kept, refuses its own earlier lineage', async () => {
		await stopNodeProcess(joined);
		const databaseDir = join(joined.dataRootDir, 'database');
		const removed = readdirSync(databaseDir).filter((entry) => entry === DB || entry.startsWith(`${DB}.`));
		assert.ok(removed.length > 0, `found the ${DB} storage in ${readdirSync(databaseDir).join(', ')}`);
		for (const entry of removed) rmSync(join(databaseDir, entry), { recursive: true, force: true });
		rmSync(join(joined.dataRootDir, 'blobs', DB), { recursive: true, force: true });

		await restartStoppedNode(contexts[1], cloneEnv(leader, token, { FORCE_CLONE: 'true' }));
		joined = contexts[1].harper;
		await waitForCompletedClone(joined);
		await waitForMesh([leader, joined]);
		await waitForRing([leader, joined], 2);

		const id = `recloned-${Date.now()}`;
		await waitForCondition(async () => (await increment(joined, id).catch(() => undefined))?.status === 200, {
			timeoutMs: 180_000,
			pollMs: 2_000,
			description: 'the re-cloned node to take a fresh key',
		});
		const byLeader = await increment(leader, id);
		assert.equal(byLeader.status, 200, JSON.stringify(byLeader.body));
		const refused = await increment(joined, id);
		assert.equal(refused.status, 503, JSON.stringify(refused.body));
		const freshness = await freshnessOf(joined);
		assert.ok(freshness.rejected?.recloned >= 1, `refused as recloned: ${JSON.stringify(freshness)}`);
	});
});
