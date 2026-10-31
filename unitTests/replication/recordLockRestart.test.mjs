/**
 * The restart recall round without a cluster: when it attests, what it refuses to count, that nobody
 * is drained while a member cannot answer, how it retries, and that an incarnation or generation
 * change during a round discards it.
 */
import assert from 'node:assert';
import {
	INCARNATION_RECALL_BUDGET_MS,
	RECALL_INCARNATION_OPERATION,
	createRestartRecall,
	isCompleteAnswer,
} from '#src/replication/recordLockRestart';

const confirm = (operation) => ({
	[operation.probe ? 'probed' : 'recalled']: true,
	incarnation: operation.incarnation,
	generation: operation.generation,
});

function harness(overrides = {}) {
	const sent = [];
	const local = [];
	const timers = [];
	const state = {
		incarnation: 2,
		first: false,
		owned: new Set(['data']),
		homeMap: { generation: 1, homes: ['self', 'a', 'b'], homeIncarnation: 2 },
		answer: (node, operation) => confirm(operation),
		warnings: [],
		debugs: [],
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
			const timer = { callback, ms, cleared: false, fired: false };
			timers.push(timer);
			return timer;
		},
		clearTimer(timer) {
			timer.cleared = true;
		},
		random: () => 1,
		warn: (message, detail) => state.warnings.push({ message, detail }),
		debug: (message, detail) => state.debugs.push({ message, detail }),
		...overrides,
	};
	const recall = createRestartRecall(deps);
	const settle = async () => {
		for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	const fireTimers = async () => {
		for (const timer of timers.filter((t) => !t.cleared && !t.fired)) {
			timer.fired = true;
			timer.callback();
		}
		await settle();
	};
	const recalls = () => sent.filter((s) => !s.operation.probe);
	const probes = () => sent.filter((s) => s.operation.probe);
	return { recall, state, sent, local, timers, settle, fireTimers, recalls, probes };
}

describe('the restart recall round', () => {
	it('probes every other ring member, then recalls from every member including itself, and attests', async () => {
		const { recall, local, settle, recalls, probes } = harness();
		recall.schedule('data');
		await settle();
		assert.deepStrictEqual(
			probes()
				.map((s) => s.node)
				.sort(),
			['a', 'b']
		);
		assert.deepStrictEqual(
			recalls()
				.map((s) => s.node)
				.sort(),
			['a', 'b']
		);
		for (const { operation, timeoutMs } of recalls()) {
			assert.strictEqual(operation.operation, RECALL_INCARNATION_OPERATION);
			assert.deepStrictEqual([operation.database, operation.generation, operation.incarnation], ['data', 1, 2]);
			assert.strictEqual(timeoutMs, INCARNATION_RECALL_BUDGET_MS, 'an explicit bound, never the delegate default');
		}
		assert.deepStrictEqual(local, [{ database: 'data', home: 'self', generation: 1, below: 2 }]);
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
		assert.deepStrictEqual(recall.status('data'), { incarnation: 2, state: 'attested', attempts: 1, unanswered: [] });
	});

	it('recalls nobody while a member cannot answer the probe', async () => {
		for (const bad of [
			() => {
				throw new Error('Operation not found');
			},
			() => ({ probed: true, incarnation: 1, generation: 1 }),
			() => ({ recalled: true, incarnation: 2, generation: 1 }),
			() => undefined,
		]) {
			const { recall, state, settle, recalls, local, timers } = harness();
			state.answer = (node, operation) => (node === 'b' && operation.probe ? bad() : confirm(operation));
			recall.schedule('data');
			await settle();
			assert.strictEqual(recalls().length, 0, `a recall went out although b could not answer: ${bad}`);
			assert.strictEqual(local.length, 0, 'the local sweep ran although b could not answer');
			assert.strictEqual(recall.quiescedIncarnation('data'), undefined);
			const status = recall.status('data');
			assert.strictEqual(status.state, 'pending');
			assert.deepStrictEqual(status.unanswered, ['b']);
			assert.ok(
				timers.some((t) => !t.cleared),
				'a retry is armed'
			);
		}
	});

	it('does not count a recall answered with an error, another incarnation or generation, or a malformed reply', async () => {
		for (const bad of [
			() => {
				throw new Error('did not reach the coordinating worker');
			},
			() => ({ recalled: true, incarnation: 1, generation: 1 }),
			() => ({ recalled: true, incarnation: 2, generation: 2 }),
			() => ({ recalled: 'yes', incarnation: 2, generation: 1 }),
			() => ({ probed: true, incarnation: 2, generation: 1 }),
			() => 'ok',
		]) {
			const { recall, state, settle, timers } = harness();
			state.answer = (node, operation) => (node === 'b' && !operation.probe ? bad() : confirm(operation));
			recall.schedule('data');
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

	it('retries with a growing, capped, jittered backoff until every member answers, then stops', async () => {
		const { recall, state, sent, settle, fireTimers, timers } = harness();
		let bDown = true;
		state.answer = (node, operation) => {
			if (node === 'b' && bDown) throw new Error('unreachable');
			return confirm(operation);
		};
		recall.schedule('data');
		await settle();
		assert.strictEqual(recall.status('data').attempts, 1);
		assert.strictEqual(state.warnings.length, 1, 'the first failure warns');
		const first = timers.at(-1).ms;
		await fireTimers();
		assert.strictEqual(recall.status('data').attempts, 2);
		assert.ok(timers.at(-1).ms > first, 'the ceiling grows');
		assert.ok(timers.at(-1).ms <= 30_000, 'and is capped');
		assert.strictEqual(state.warnings.length, 1, 'the same failure again does not warn again');
		assert.ok(state.debugs.length >= 1);
		bDown = false;
		await fireTimers();
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
		const sends = sent.length;
		await fireTimers();
		assert.strictEqual(sent.length, sends, 'an attested round sends nothing more');

		const jittered = harness({ random: () => 0.25 });
		jittered.state.answer = () => {
			throw new Error('down');
		};
		jittered.recall.schedule('data');
		await jittered.settle();
		assert.ok(jittered.timers.at(-1).ms < 1_000, 'full jitter draws below the ceiling');
	});

	it('discards a round whose incarnation or generation moved while it was in flight', async () => {
		for (const move of ['incarnation', 'generation']) {
			const { recall, state, settle } = harness();
			state.answer = (node, operation) => {
				if (!operation.probe) {
					if (move === 'incarnation') state.incarnation = 3;
					else state.homeMap = { ...state.homeMap, generation: 2 };
				}
				return confirm(operation);
			};
			recall.schedule('data');
			await settle();
			assert.strictEqual(recall.quiescedIncarnation('data'), undefined, `a stale ${move} round was attested`);
		}
	});

	it('an attestation is for one incarnation: a later bump reports nothing until its own round completes', async () => {
		const { recall, state, settle, recalls } = harness();
		recall.schedule('data');
		await settle();
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
		state.incarnation = 3;
		state.homeMap = { ...state.homeMap, homeIncarnation: 3 };
		assert.strictEqual(recall.quiescedIncarnation('data'), undefined);
		assert.strictEqual(recall.status('data').state, 'pending');
		recall.schedule('data');
		await settle();
		assert.strictEqual(recalls().at(-1).operation.incarnation, 3);
		assert.strictEqual(recall.quiescedIncarnation('data'), 3);
	});

	it('a cancel while the answers are in flight arms no retry and attests nothing', async () => {
		const { recall, state, settle, timers } = harness();
		const pending = [];
		state.answer = (node, operation) =>
			operation.probe ? confirm(operation) : new Promise((resolve) => pending.push(() => resolve(confirm(operation))));
		recall.schedule('data');
		await settle();
		assert.strictEqual(pending.length, 2, 'both recalls are in flight');
		recall.cancel('data');
		for (const release of pending) release();
		await settle();
		assert.strictEqual(recall.status('data'), undefined);
		assert.strictEqual(recall.quiescedIncarnation('data'), undefined);
		assert.ok(
			timers.every((t) => t.cleared || t.fired),
			'an orphaned round armed a retry'
		);
	});

	it('a schedule during a round for the same question does not ask again; a changed question does', async () => {
		const { recall, state, settle, recalls } = harness();
		const pending = [];
		state.answer = (node, operation) =>
			operation.probe ? confirm(operation) : new Promise((resolve) => pending.push(() => resolve(confirm(operation))));
		recall.schedule('data');
		await settle();
		recall.schedule('data');
		for (const release of pending.splice(0)) release();
		await settle();
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
		assert.strictEqual(recalls().length, 2, 'the same question was asked twice');

		state.incarnation = 3;
		state.homeMap = { ...state.homeMap, homeIncarnation: 3 };
		recall.schedule('data');
		await settle();
		state.incarnation = 4;
		state.homeMap = { ...state.homeMap, homeIncarnation: 4 };
		recall.schedule('data');
		for (const release of pending.splice(0)) release();
		await settle();
		for (const release of pending.splice(0)) release();
		await settle();
		assert.strictEqual(recall.quiescedIncarnation('data'), 4, 'the changed question was not asked again');
	});

	it('drains nobody when the round is cancelled or moved on between the probes and the recall', async () => {
		for (const move of ['cancel', 'incarnation', 'generation']) {
			const { recall, state, settle, recalls, local } = harness();
			const pending = [];
			state.answer = (node, operation) =>
				operation.probe
					? new Promise((resolve) => pending.push(() => resolve(confirm(operation))))
					: confirm(operation);
			recall.schedule('data');
			await settle();
			assert.strictEqual(pending.length, 2, 'both probes are in flight');
			if (move === 'cancel') recall.cancel('data');
			else if (move === 'incarnation') state.incarnation = 3;
			else state.homeMap = { ...state.homeMap, generation: 2 };
			for (const release of pending) release();
			await settle();
			assert.strictEqual(recalls().length, 0, `a recall went out after ${move}`);
			assert.strictEqual(local.length, 0);
			assert.strictEqual(recall.quiescedIncarnation('data'), undefined);
		}
	});

	it('a node the ring does not name has nothing to recall and attests at once', async () => {
		const { recall, state, sent, local, settle } = harness();
		state.homeMap = { generation: 1, homes: ['a', 'b'], homeIncarnation: 2 };
		recall.schedule('data');
		await settle();
		assert.strictEqual(sent.length, 0);
		assert.strictEqual(local.length, 0);
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
	});

	it('answers nothing for a database this thread does not coordinate, and cancel forgets the round', async () => {
		const { recall, state, settle } = harness();
		recall.schedule('data');
		await settle();
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
		state.owned.delete('data');
		assert.strictEqual(recall.quiescedIncarnation('data'), undefined);
		state.owned.add('data');
		recall.cancel('data');
		assert.strictEqual(recall.quiescedIncarnation('data'), undefined);
		assert.strictEqual(recall.status('data'), undefined);
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
		assert.strictEqual(isCompleteAnswer({ probed: true, incarnation: 2, generation: 1 }, 2, 1), false);
		assert.strictEqual(isCompleteAnswer({ probed: true, incarnation: 2, generation: 1 }, 2, 1, 'probed'), true);
		assert.strictEqual(isCompleteAnswer(null, 2, 1), false);
	});
});

describe('the restart round carries the delegate epoch (record-locks.md §4.5)', () => {
	it('sends the epoch on probes and recalls, and records each member’s echoed epoch before any drain', async () => {
		const retired = [];
		const timeline = [];
		const { recall, state, settle, probes, recalls } = harness({
			delegateEpoch: (database) => (database === 'data' ? 7 : undefined),
			retireLocally(database, delegate, belowEpoch) {
				retired.push({ database, delegate, belowEpoch });
				timeline.push(`retire:${delegate}`);
			},
		});
		state.answer = (node, operation) => {
			timeline.push(`${operation.probe ? 'probe' : 'recall'}:${node}`);
			// `a` is a current build and echoes its epoch; `b` is an older one and does not.
			return { ...confirm(operation), ...(node === 'a' ? { delegateEpoch: 3 } : {}) };
		};
		recall.schedule('data');
		await settle();
		for (const { operation } of [...probes(), ...recalls()]) assert.strictEqual(operation.delegateEpoch, 7);
		assert.deepStrictEqual(retired, [{ database: 'data', delegate: 'a', belowEpoch: 3 }], 'once per member per round');
		assert.ok(
			timeline.indexOf('retire:a') < timeline.indexOf('recall:a'),
			`the member's epoch was not recorded before the drain: ${timeline}`
		);
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
	});

	it('still retires on a probe answer when another member cannot answer and nobody is drained', async () => {
		const retired = [];
		const { recall, state, settle, recalls, probes } = harness({
			delegateEpoch: () => 7,
			retireLocally: (database, delegate, belowEpoch) => retired.push({ database, delegate, belowEpoch }),
		});
		state.answer = (node, operation) => {
			if (node === 'b') throw new Error('b is down');
			return { ...confirm(operation), delegateEpoch: 4 };
		};
		recall.schedule('data');
		await settle();
		assert.strictEqual(probes().length, 2);
		assert.strictEqual(recalls().length, 0, 'a round that cannot complete drains nobody');
		assert.deepStrictEqual(retired, [{ database: 'data', delegate: 'a', belowEpoch: 4 }]);
		assert.strictEqual(recall.quiescedIncarnation('data'), undefined);
	});

	it('ignores a malformed echoed epoch, and a floor that cannot be recorded leaves its member unanswered', async () => {
		const retired = [];
		const { recall, settle, state } = harness({
			delegateEpoch: () => 7,
			retireLocally(database, delegate) {
				retired.push(delegate);
				throw new Error('not the owner any more');
			},
		});
		state.answer = (node, operation) => ({ ...confirm(operation), delegateEpoch: node === 'a' ? 1.5 : 2 });
		recall.schedule('data');
		await settle();
		assert.deepStrictEqual(retired, ['b']);
		assert.strictEqual(recall.quiescedIncarnation('data'), undefined, 'attested without b’s floor');
		assert.deepStrictEqual(recall.status('data').unanswered, ['b']);
	});

	it('reports recovering while the round runs or waits to run with nobody having refused it', async () => {
		const { recall, state, settle, fireTimers } = harness({ delegateEpoch: () => 7 });
		assert.strictEqual(recall.recovering('data'), false, 'no round yet');
		state.homeMap = undefined;
		recall.schedule('data');
		await settle();
		assert.strictEqual(recall.recovering('data'), true, 'a mapless first attempt is retried shortly');
		state.answer = (node, operation) => {
			if (node === 'b') throw new Error('b is down');
			return confirm(operation);
		};
		state.homeMap = { generation: 1, homes: ['self', 'a', 'b'], homeIncarnation: 2 };
		await fireTimers();
		assert.strictEqual(recall.recovering('data'), false, 'a member that could not answer is not "soon"');
		state.answer = (node, operation) => confirm(operation);
		await fireTimers();
		assert.strictEqual(recall.quiescedIncarnation('data'), 2);
		assert.strictEqual(recall.recovering('data'), false, 'attested');
	});
});
