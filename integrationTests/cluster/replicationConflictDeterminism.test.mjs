/**
 * Replication conflict-resolution determinism (2-node bidirectional cluster)
 *
 * Regression guard for LWW convergence and CRDT addTo cross-node merge behaviour.
 *
 * What is tested:
 *   1. CONVERGENCE — after concurrent writes to the same key on both nodes, both
 *      nodes converge to the same final value (no split-brain).
 *   2. WINNER DETERMINISM — the LWW winner is stable; both nodes pick the same winner.
 *   3. ANOMALY ABSENCE — no torn records (fields from both writers mixed) and no ghost
 *      values (a value neither writer wrote).
 *   4. addTo CRDT — concurrent addTo(counter, 1) on both nodes merges correctly
 *      (counter=2 on both sides) rather than losing one delta via LWW.
 *
 * Setup: 2-node bidirectional cluster (A↔B). Both nodes replicate the `data` database.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import {
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..', '..', 'dist', 'bin', 'harper.js'
);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';
const FIXTURE_PATH = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'fixture-replication-conflict-determinism'
);

const DB = 'data';
const TABLE = 'ConflictRecord';
const RACE_TRIALS = 20;
const ADDTO_TRIALS = 20;
// Settle time: empirically sufficient for loopback replication (<10ms typical).
const SETTLE_MS = 3000;

function sharedConfig(host) {
	return {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, console: true, level: 'debug' },
		replication: {
			securePort: host + ':9933',
			databases: [DB],
		},
	};
}

async function getRecord(node, id) {
	try {
		const r = await sendOperation(node, {
			operation: 'search_by_value',
			database: DB,
			table: TABLE,
			search_attribute: 'id',
			search_value: id,
			get_attributes: ['*'],
		});
		return Array.isArray(r) ? r[0] ?? null : null;
	} catch {
		return null;
	}
}

async function putRecord(node, id, fields) {
	return sendOperation(node, {
		operation: 'upsert',
		database: DB,
		table: TABLE,
		records: [{ id, ...fields }],
	});
}

/** Poll until both nodes hold the expected field value for a key (or timeout). */
async function waitForKeyOnBoth(nodeA, nodeB, id, expectedVal, fieldName = 'score', timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const [rA, rB] = await Promise.all([getRecord(nodeA, id), getRecord(nodeB, id)]);
		if (rA !== null && rB !== null && rA[fieldName] === expectedVal && rB[fieldName] === expectedVal) return true;
		await delay(300);
	}
	return false;
}

suite('Replication conflict-resolution determinism (2-node bidirectional)', { skip: !STRESS, timeout: 600000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();

		const ctxA = { name: ctx.name + '-A', harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name + '-B', harper: { hostname: hostnameB } };

		await Promise.all([
			startHarper(ctxA, {
				config: sharedConfig(hostnameA),
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			}),
			startHarper(ctxB, {
				config: sharedConfig(hostnameB),
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			}),
		]);
		ctx.nodeA = ctxA.harper;
		ctx.nodeB = ctxB.harper;

		// Deploy fixture to both nodes so both have the ConflictRecord schema.
		const payload = await targz(FIXTURE_PATH);
		await Promise.all([
			sendOperation(ctx.nodeA, {
				operation: 'deploy_component',
				project: 'qa014-conflict',
				payload,
				restart: true,
			}),
			sendOperation(ctx.nodeB, {
				operation: 'deploy_component',
				project: 'qa014-conflict',
				payload,
				restart: true,
			}),
		]);
		await delay(25000);

		// Bidirectional cluster: B→A (B treats A as leader, full-copy), A→B (writes on B flow back).
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: ctx.nodeA.admin,
		});
		await sendOperation(ctx.nodeA, {
			operation: 'add_node',
			hostname: ctx.nodeB.hostname,
			rejectUnauthorized: false,
			isLeader: false,
			authorization: ctx.nodeB.admin,
		});

		await delay(5000);
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }).catch(() => null),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }).catch(() => null),
		]);
	});

	test('baseline replication A→B and B→A', async (t) => {
		t.timeout = 60000;
		const { nodeA, nodeB } = ctx;

		await putRecord(nodeA, 'baseline-1', { score: 100, label: 'from-A', counter: 0 });
		const bOK = await waitForKeyOnBoth(nodeA, nodeB, 'baseline-1', 100, 'score');
		ok(bOK, 'B should receive baseline-1 written on A');

		await putRecord(nodeB, 'baseline-2', { score: 200, label: 'from-B', counter: 0 });
		const aOK = await waitForKeyOnBoth(nodeB, nodeA, 'baseline-2', 200, 'score');
		ok(aOK, 'A should receive baseline-2 written on B');
	});

	test(`plain-field concurrent writes — ${RACE_TRIALS} LWW trials`, async (t) => {
		t.timeout = 600000;
		const { nodeA, nodeB } = ctx;

		const results = {
			diverged: 0,
			converged: 0,
			aWon: 0,
			bWon: 0,
			neitherWon: 0,
			tornRecord: 0,
			perTrial: [],
		};

		for (let i = 0; i < RACE_TRIALS; i++) {
			const id = `lww-race-${i}`;
			const scoreA = 1000 + i * 2;      // A always writes even scores
			const scoreB = 1001 + i * 2;      // B always writes odd scores
			const labelA = `writer-A-trial-${i}`;
			const labelB = `writer-B-trial-${i}`;

			// Seed a known value, wait for both nodes to have it, then race.
			await putRecord(nodeA, id, { score: -i - 1, label: 'seed', counter: 0 });
			await waitForKeyOnBoth(nodeA, nodeB, id, -i - 1, 'score', 30000);

			await Promise.all([
				sendOperation(nodeA, {
					operation: 'update',
					database: DB,
					table: TABLE,
					records: [{ id, score: scoreA, label: labelA }],
				}),
				sendOperation(nodeB, {
					operation: 'update',
					database: DB,
					table: TABLE,
					records: [{ id, score: scoreB, label: labelB }],
				}),
			]);

			await delay(SETTLE_MS);

			const [finalA, finalB] = await Promise.all([
				getRecord(nodeA, id),
				getRecord(nodeB, id),
			]);

			const converged = finalA?.score === finalB?.score && finalA?.label === finalB?.label;
			if (!converged) results.diverged++;
			else results.converged++;

			let winner;
			if (finalA?.score === scoreA && finalA?.label === labelA) winner = 'A';
			else if (finalA?.score === scoreB && finalA?.label === labelB) winner = 'B';
			else winner = 'neither';

			if (winner === 'A') results.aWon++;
			else if (winner === 'B') results.bWon++;
			else results.neitherWon++;

			const torn = (finalA?.score === scoreA && finalA?.label === labelB) ||
				(finalA?.score === scoreB && finalA?.label === labelA);
			if (torn) results.tornRecord++;

			results.perTrial.push({ id, converged, winner, torn });
		}

		ctx.lwwResults = results;

		// Both nodes must agree (eventual consistency).
		equal(results.diverged, 0,
			`LWW CONVERGENCE FAILURE: ${results.diverged} trials ended with A and B holding different values.\n` +
			JSON.stringify(results.perTrial.filter(t => !t.converged), null, 2));

		// Torn records are a corruption anomaly.
		equal(results.tornRecord, 0,
			`TORN RECORD: ${results.tornRecord} records had fields from different writers mixed together`);

		// Neither-won means a ghost value (neither writer's value survived).
		equal(results.neitherWon, 0,
			`GHOST VALUE: ${results.neitherWon} records ended with a value neither writer wrote`);
	});

	test(`addTo CRDT — ${ADDTO_TRIALS} concurrent cross-node increment trials`, async (t) => {
		t.timeout = 600000;
		const { nodeA, nodeB } = ctx;

		const results = {
			bothDeltasApplied: 0,
			oneDeltaLost: 0,
			diverged: 0,
			unexpected: 0,
			perTrial: [],
		};

		for (let i = 0; i < ADDTO_TRIALS; i++) {
			const id = `crdt-counter-${i}`;

			await putRecord(nodeA, id, { score: 0, label: 'seed', counter: 0 });
			await waitForKeyOnBoth(nodeA, nodeB, id, 0, 'counter', 30000);

			// Fire addTo(counter, 1) on BOTH nodes simultaneously.
			await Promise.all([
				sendOperation(nodeA, {
					operation: 'update',
					database: DB,
					table: TABLE,
					records: [{ id, counter: { __op__: 'add', value: 1 } }],
				}),
				sendOperation(nodeB, {
					operation: 'update',
					database: DB,
					table: TABLE,
					records: [{ id, counter: { __op__: 'add', value: 1 } }],
				}),
			]);

			await delay(SETTLE_MS);

			const [finalA, finalB] = await Promise.all([
				getRecord(nodeA, id),
				getRecord(nodeB, id),
			]);

			const counterA = finalA?.counter;
			const counterB = finalB?.counter;
			const converged = counterA === counterB;

			let outcome;
			if (!converged) {
				outcome = 'diverged';
				results.diverged++;
			} else if (counterA === 2) {
				outcome = 'both-merged';
				results.bothDeltasApplied++;
			} else if (counterA === 1) {
				outcome = 'one-lost';
				results.oneDeltaLost++;
			} else {
				outcome = `unexpected(${counterA})`;
				results.unexpected++;
			}

			results.perTrial.push({ id, counterA, counterB, converged, outcome });
		}

		ctx.addToResults = results;

		// Convergence: A and B must agree.
		equal(results.diverged, 0,
			`addTo CONVERGENCE FAILURE: ${results.diverged} trials ended with A and B holding different counter values.\n` +
			JSON.stringify(results.perTrial.filter(t => !t.converged), null, 2));

		// Ghost values (counter neither 1 nor 2) are a serious anomaly.
		equal(results.unexpected, 0,
			`addTo GHOST VALUE: ${results.unexpected} trials ended with a counter value that was neither 1 nor 2`);
	});

	test('addTo vs plain-field — concurrent mixed updates on same record', async (t) => {
		t.timeout = 600000;
		const { nodeA, nodeB } = ctx;
		const TRIALS = 10;

		const results = { converged: 0, addToMerged: 0, addToLost: 0, diverged: 0 };

		for (let i = 0; i < TRIALS; i++) {
			const id = `mixed-${i}`;
			const scoreA = 5000 + i;

			await putRecord(nodeA, id, { score: -1, label: 'seed', counter: 0 });
			await waitForKeyOnBoth(nodeA, nodeB, id, -1, 'score', 30000);

			// A writes a plain score; B writes an addTo delta on counter — concurrently.
			await Promise.all([
				sendOperation(nodeA, {
					operation: 'update',
					database: DB,
					table: TABLE,
					records: [{ id, score: scoreA }],
				}),
				sendOperation(nodeB, {
					operation: 'update',
					database: DB,
					table: TABLE,
					records: [{ id, counter: { __op__: 'add', value: 5 } }],
				}),
			]);

			await delay(SETTLE_MS);

			const [finalA, finalB] = await Promise.all([
				getRecord(nodeA, id),
				getRecord(nodeB, id),
			]);

			const converged = finalA?.score === finalB?.score && finalA?.counter === finalB?.counter;
			if (!converged) results.diverged++;
			else results.converged++;

			if (finalA?.counter === 5) results.addToMerged++;
			else results.addToLost++;
		}

		ctx.mixedResults = results;

		equal(results.diverged, 0,
			`CONVERGENCE FAILURE in mixed addTo + plain trial: ${results.diverged} trials diverged`);
	});

	test('summary assertions — LWW + addTo structural invariants', async () => {
		const lww = ctx.lwwResults;
		const addTo = ctx.addToResults;

		// Structural hard assertions — no permanent divergence.
		equal(lww?.diverged ?? 1, 0, 'LWW convergence must hold across all trials');
		equal(lww?.tornRecord ?? 1, 0, 'No torn records (mixed-writer fields) allowed');
		equal(addTo?.diverged ?? 1, 0, 'addTo convergence must hold across all trials');
		equal(addTo?.unexpected ?? 1, 0, 'No ghost counter values in addTo trials');
	});
});
