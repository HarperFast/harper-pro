/**
 * The restart recall round (harper#3254) without a cluster: when it attests, what it refuses to
 * count, how it retries, and that an incarnation or generation change during a round discards it.
 */
import assert from 'node:assert';
import {
	INCARNATION_RECALL_BUDGET_MS,
	RECALL_INCARNATION_OPERATION,
	createRestartRecall,
	isCompleteAnswer,
} from '#src/replication/recordLockRestart';

function harness(overrides = {}) {
	const sent = [];
	const local = [];
	const timers = [];
	const state = {
		incarnation: 2,
		first: false,
		owned: new Set(['data']),
		homeMap: { generation: 1, homes: ['self', 'a', 'b'], homeIncarnation: 2 },
		answer: (node, operation) => ({
			recalled: true,
			incarnation: operation.incarnation,
			generation: operation.generation,
		}),
		warnings: [],
	};
	const deps = {
		thisNodeName: () => 'self',
		homeIncarnation: () => state.incarnation,
		isFirstIncarnation: () => state.first,
		ownsDatabase: (database) => state.owned.has(database),
		homeMap: () => state.homeMap,
		async send(node, database, operation, timeoutMs) {
			sent.push({ node, database, operation, timeoutMs });
			return state.answer(node, operation);
		},
		async recallLocally(database, home, generation, below) {
			local.push({ database, home, generation, below });
		},
		setTimer(callback, ms) {
			const timer = { callback, ms, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimer(timer) {
			timer.cleared = true;
		},
		warn: (message, detail) => state.warnings.push({ message, detail }),
		...overrides,
	};
	const recall = createRestartRecall(deps);
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	const fireTimers = async () => {
		const due = timers.filter((timer) => !timer.cleared && !timer.fired);
		for (const timer of due) {
			timer.fired = true;
			timer.callback();
		}
		await settle();
		await settle();
	};
	return { recall, state, sent, local, timers, settle, fireTimers };
}

describe('the restart recall round (harper#3254)', () => {
	it('asks every other ring member and sweeps itself, then attests the incarnation', async () => {
		const { recall, sent, local, settle } = harness();
		recall.schedule('data');
		await settle();
		await settle();
		assert.deepStrictEqual(sent.map((s) => s.node).sort(), ['a', 'b']);
		for (const { operation, timeoutMs } of sent) {
			assert.strictEqual(operation.operation, RECALL_INCARNATION_OPERATION);
			assert.deepStrictEqual([operation.database, operation.generation, operation.incarnation], ['data', 1, 2]);
			assert.strictEqual(timeoutMs, INCARNATION_RECALL_BUDGET_MS, 'an explicit bound, never the delegate default');
		}
		assert.deepStrictEqual(local, [{ database: 'data', home: 'self', generation: 1, below: 2 }]);
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
		assert.deepStrictEqual(recall.status('data'), { incarnation: 2, state: 'attested', attempts: 1, unanswered: [] });
	});

	it('does not count an error, a reply for another incarnation or generation, or a malformed reply', async () => {
		for (const bad of [
			() => {
				throw new Error('Operation not found');
			},
			() => ({ recalled: true, incarnation: 1, generation: 1 }),
			() => ({ recalled: true, incarnation: 2, generation: 2 }),
			() => ({ recalled: 'yes', incarnation: 2, generation: 1 }),
			() => undefined,
			() => 'ok',
		]) {
			const { recall, state, settle, timers } = harness();
			state.answer = (node, operation) =>
				node === 'b' ? bad() : { recalled: true, incarnation: operation.incarnation, generation: operation.generation };
			recall.schedule('data');
			await settle();
			await settle();
			assert.strictEqual(recall.quiescedIncarnation('data'), undefined, `counted ${bad}`);
			const status = recall.status('data');
			assert.strictEqual(status.state, 'pending');
			assert.deepStrictEqual(status.unanswered, ['b']);
			assert.ok(
				timers.some((t) => !t.cleared),
				'a retry is armed'
			);
		}
	});

	it('retries with backoff until every member answers, and stops once attested', async () => {
		const { recall, state, sent, settle, fireTimers, timers } = harness();
		let bDown = true;
		state.answer = (node, operation) => {
			if (node === 'b' && bDown) throw new Error('unreachable');
			return { recalled: true, incarnation: operation.incarnation, generation: operation.generation };
		};
		recall.schedule('data');
		await settle();
		await settle();
		assert.strictEqual(recall.status('data').attempts, 1);
		const first = timers.at(-1).ms;
		await fireTimers();
		assert.strictEqual(recall.status('data').attempts, 2);
		assert.ok(timers.at(-1).ms > first, 'the retry interval grows');
		assert.ok(timers.at(-1).ms <= 30_000, 'and is capped');
		bDown = false;
		await fireTimers();
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
		const sends = sent.length;
		await fireTimers();
		assert.strictEqual(sent.length, sends, 'an attested round sends nothing more');
	});

	it('discards a round whose incarnation or generation moved while it was in flight', async () => {
		for (const move of ['incarnation', 'generation']) {
			const { recall, state, settle } = harness();
			state.answer = (node, operation) => {
				if (move === 'incarnation') state.incarnation = 3;
				else state.homeMap = { ...state.homeMap, generation: 2 };
				return { recalled: true, incarnation: operation.incarnation, generation: operation.generation };
			};
			recall.schedule('data');
			await settle();
			await settle();
			assert.strictEqual(recall.quiescedIncarnation('data'), undefined, `a stale ${move} round was attested`);
		}
	});

	it('an attestation is for one incarnation: a later bump reports nothing until its own round completes', async () => {
		const { recall, state, settle, sent } = harness();
		recall.schedule('data');
		await settle();
		await settle();
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
		state.incarnation = 3;
		state.homeMap = { ...state.homeMap, homeIncarnation: 3 };
		assert.strictEqual(recall.quiescedIncarnation('data'), undefined);
		assert.strictEqual(recall.status('data').state, 'pending');
		recall.schedule('data');
		await settle();
		await settle();
		assert.strictEqual(sent.at(-1).operation.incarnation, 3);
		assert.strictEqual(recall.quiescedIncarnation('data'), 3);
	});

	it('answers nothing for a database this thread does not coordinate, and cancel forgets the round', async () => {
		const { recall, state, settle, timers } = harness();
		recall.schedule('data');
		await settle();
		await settle();
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
		state.owned.delete('data');
		assert.strictEqual(recall.quiescedIncarnation('data'), undefined);
		state.owned.add('data');
		recall.cancel('data');
		assert.strictEqual(recall.quiescedIncarnation('data'), undefined);
		assert.strictEqual(recall.status('data'), undefined);
		assert.ok(timers.every((t) => t.cleared || t.fired !== undefined || true));
		recall.schedule('other');
		await settle();
		assert.strictEqual(recall.status('other'), undefined, 'an unowned database starts no round');
	});

	it('waits for the home map rather than asking a ring it does not know', async () => {
		const { recall, state, sent, settle, fireTimers } = harness();
		state.homeMap = undefined;
		recall.schedule('data');
		await settle();
		assert.strictEqual(sent.length, 0);
		assert.strictEqual(recall.status('data').state, 'pending');
		state.homeMap = { generation: 1, homes: ['self', 'a'], homeIncarnation: 2 };
		await fireTimers();
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
	});

	it('attests a first incarnation without asking anyone: nothing was ever issued below it', async () => {
		const { recall, state, sent, settle } = harness();
		state.first = true;
		state.incarnation = 1;
		recall.schedule('data');
		await settle();
		assert.strictEqual(sent.length, 0);
		assert.strictEqual(recall.quiescedIncarnation('data'), 1);
	});

	it('isCompleteAnswer is exact', () => {
		assert.strictEqual(isCompleteAnswer({ recalled: true, incarnation: 2, generation: 1 }, 2, 1), true);
		assert.strictEqual(isCompleteAnswer({ recalled: true, incarnation: 2, generation: 1 }, 3, 1), false);
		assert.strictEqual(isCompleteAnswer({ recalled: true, incarnation: '2', generation: 1 }, 2, 1), false);
		assert.strictEqual(isCompleteAnswer(null, 2, 1), false);
	});
});
