/**
 * A full copy writes `system.hdb_waf_rules` rows as audit-less snapshots on RocksDB, so a worker's live
 * rule subscription sees no per-row event and never ends. Only the copy's reload marker tells it to
 * re-read the table (harper-pro#889). Nothing here writes a rule or control row on the receiver, or on
 * the leader once the copy has started, so no later event can heal the matcher.
 *
 * Each worker compiles its own matcher from its own subscription, so probes use a new connection each to
 * reach more than one worker, and `lastCompiledRuleCounts` reads every http worker's own log lines.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { readLog, sendOperation, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const BLOCK_PROBE = '/waf-copy-block';
const MOVED_BLOCK_PROBE = '/waf-copy-moved-block';
const SCORE_PROBE = '/waf-copy-score';
const DROPPED_PROBE = '/waf-copy-dropped';
const PROBES_PER_CHECK = 24;

const BLOCK_RULE = {
	id: 'copy-block',
	enabled: true,
	priority: 1,
	phase: 'request',
	action: 'block',
	blockStatus: 403,
	match: { path: { prefix: BLOCK_PROBE } },
};
// Below the default threshold of 10, so it blocks only under the replicated control row's threshold.
const SCORE_RULE = {
	id: 'copy-score',
	enabled: true,
	priority: 2,
	phase: 'request',
	action: 'score',
	score: 5,
	match: { path: { prefix: SCORE_PROBE } },
};

const DROPPED_RULE = {
	id: 'copy-dropped',
	enabled: true,
	priority: 3,
	phase: 'request',
	action: 'block',
	blockStatus: 403,
	match: { path: { prefix: DROPPED_PROBE } },
};

function probeStatus(node, path, signal) {
	return new Promise((resolve, reject) => {
		const probe = httpRequest(new URL(path, node.httpURL), { agent: false, signal }, (response) => {
			response.resume();
			response.on('end', () => resolve(response.statusCode));
			response.on('error', reject);
		});
		probe.on('error', reject);
		probe.end();
	});
}

async function blockedProbes(node, path, signal = AbortSignal.timeout(30000)) {
	let blocked = 0;
	for (let i = 0; i < PROBES_PER_CHECK; i++) if ((await probeStatus(node, path, signal)) === 403) blocked++;
	return blocked;
}

async function waitForBlocked(node, path, expected, name) {
	let last;
	await waitForCondition(
		async (signal) => {
			last = await blockedProbes(node, path, signal);
			return last === expected;
		},
		{
			timeoutMs: 90000,
			description: () => `${name}: ${expected}/${PROBES_PER_CHECK} blocked on ${path}, last saw ${last}`,
		}
	);
}

async function persistedRuleIds(node, signal) {
	const rules = await sendOperation(node, { operation: 'list_waf_rules' }, { signal });
	return rules
		.map((rule) => rule.id)
		.filter((id) => id !== '__waf_control__')
		.sort();
}

async function lastCompiledRuleCounts(node) {
	const counts = {};
	for (const [, thread, count] of (await readLog(node)).matchAll(/\[(http\/\d+)\].*WAF compiled (\d+) rules/g))
		counts[thread] = Number(count);
	return counts;
}

async function waitForEveryWorkerToCompile(node, ruleCount) {
	let counts;
	await waitForCondition(
		async () => {
			counts = await lastCompiledRuleCounts(node);
			const workers = Object.keys(counts);
			return workers.length === 2 && workers.every((worker) => counts[worker] === ruleCount);
		},
		{
			timeoutMs: 30000,
			description: () => `both http workers to compile ${ruleCount} rules, last saw ${JSON.stringify(counts)}`,
		}
	);
}

suite('WAF matcher after a full copy', { timeout: 420000 }, (ctx) => {
	before(async () => {
		const contexts = [];
		for (let i = 0; i < 2; i++) {
			const hostname = await getNextAvailableLoopbackAddress();
			contexts.push({ name: ctx.name, harper: { hostname } });
		}
		await Promise.all(
			contexts.map((nodeContext) =>
				startHarper(nodeContext, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: false, console: true, level: 'debug' },
						threads: { count: 2 },
						replication: { port: `${nodeContext.harper.hostname}:9933`, securePort: null },
					},
					env: { HARPER_NO_FLUSH_ON_EXIT: true },
				})
			)
		);
		[ctx.leader, ctx.receiver] = contexts.map((nodeContext) => nodeContext.harper);
	});

	after(async () => {
		await Promise.all(
			[ctx.leader, ctx.receiver].map((node) => node && teardownHarper({ harper: node }).catch(() => {}))
		);
	});

	test('a worker with a live subscription enforces copied rules and control with no later write', async () => {
		const { leader, receiver } = ctx;
		await sendOperation(leader, { operation: 'add_waf_rule', rule: BLOCK_RULE });
		await sendOperation(leader, { operation: 'add_waf_rule', rule: SCORE_RULE });
		await sendOperation(leader, { operation: 'add_waf_rule', rule: DROPPED_RULE });
		await sendOperation(leader, { operation: 'set_waf_mode', scoreThreshold: 5 });
		await waitForBlocked(leader, BLOCK_PROBE, PROBES_PER_CHECK, 'leader');
		await waitForBlocked(leader, SCORE_PROBE, PROBES_PER_CHECK, 'leader');

		deepEqual(await persistedRuleIds(receiver), [], 'the receiver must start with no rules');
		equal(await blockedProbes(receiver, BLOCK_PROBE), 0, 'nothing may block before the copy');
		equal(await blockedProbes(receiver, SCORE_PROBE), 0, 'nothing may block before the copy');

		await sendOperation(receiver, {
			operation: 'add_node',
			hostname: leader.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: leader.admin,
		});
		await waitForCondition(async (signal) => (await persistedRuleIds(receiver, signal)).length === 3, {
			description: 'the copied rules to be persisted on the receiver',
		});

		await waitForBlocked(receiver, BLOCK_PROBE, PROBES_PER_CHECK, 'receiver');
		await waitForBlocked(receiver, SCORE_PROBE, PROBES_PER_CHECK, 'receiver');
		await waitForEveryWorkerToCompile(receiver, 3);
		ok(
			!(await readLog(receiver)).includes('WAF rule subscription ended'),
			'convergence must come from the live subscription, not a resubscribe'
		);
	});

	test('a rejoin converges on rule and control changes made while the node was out', async () => {
		const { leader, receiver } = ctx;
		await sendOperation(receiver, { operation: 'remove_node', hostname: leader.hostname });
		// the receiver has already dropped the leader, so it refuses the leader's fence call: only force removes it
		await sendOperation(leader, { operation: 'remove_node', hostname: receiver.hostname, force: true });

		await sendOperation(leader, {
			operation: 'alter_waf_rule',
			id: BLOCK_RULE.id,
			match: { path: { prefix: MOVED_BLOCK_PROBE } },
		});
		await sendOperation(leader, { operation: 'drop_waf_rule', id: DROPPED_RULE.id });
		await sendOperation(leader, { operation: 'set_waf_mode', scoreThreshold: 100 });
		await waitForBlocked(leader, MOVED_BLOCK_PROBE, PROBES_PER_CHECK, 'leader');
		await waitForBlocked(leader, DROPPED_PROBE, 0, 'leader');
		await waitForBlocked(leader, SCORE_PROBE, 0, 'leader');

		// Removal only stops replication, so the receiver still enforces what it had.
		equal(await blockedProbes(receiver, BLOCK_PROBE), PROBES_PER_CHECK, 'the old rule must still apply while out');
		equal(await blockedProbes(receiver, MOVED_BLOCK_PROBE), 0, 'the moved rule must not apply while out');
		equal(
			await blockedProbes(receiver, DROPPED_PROBE),
			PROBES_PER_CHECK,
			'the dropped rule must still apply while out'
		);

		await sendOperation(receiver, {
			operation: 'add_node',
			hostname: leader.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: leader.admin,
		});

		await waitForBlocked(receiver, MOVED_BLOCK_PROBE, PROBES_PER_CHECK, 'receiver');
		await waitForBlocked(receiver, BLOCK_PROBE, 0, 'receiver');
		await waitForBlocked(receiver, SCORE_PROBE, 0, 'receiver');
		await waitForBlocked(receiver, DROPPED_PROBE, 0, 'receiver');
		deepEqual(await persistedRuleIds(receiver), [BLOCK_RULE.id, SCORE_RULE.id].sort());
		await waitForEveryWorkerToCompile(receiver, 2);
	});

	test('a rejoin with no rules left on the leader empties the matcher', async () => {
		const { leader, receiver } = ctx;
		await sendOperation(receiver, { operation: 'remove_node', hostname: leader.hostname });
		// the receiver has already dropped the leader, so it refuses the leader's fence call: only force removes it
		await sendOperation(leader, { operation: 'remove_node', hostname: receiver.hostname, force: true });

		await sendOperation(leader, { operation: 'drop_waf_rule', id: BLOCK_RULE.id });
		await sendOperation(leader, { operation: 'drop_waf_rule', id: SCORE_RULE.id });
		await waitForBlocked(leader, MOVED_BLOCK_PROBE, 0, 'leader');
		equal(
			await blockedProbes(receiver, MOVED_BLOCK_PROBE),
			PROBES_PER_CHECK,
			'the old rule must still apply while out'
		);

		await sendOperation(receiver, {
			operation: 'add_node',
			hostname: leader.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: leader.admin,
		});

		await waitForBlocked(receiver, MOVED_BLOCK_PROBE, 0, 'receiver');
		deepEqual(await persistedRuleIds(receiver), []);
		await waitForEveryWorkerToCompile(receiver, 0);
	});
});
