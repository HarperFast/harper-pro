/**
 * Coverage for `rejectIfUnsettled` — the bound on the base-copy durability flush. The flush is awaited
 * from the copy's `onCommit` and the per-database apply subscription is reused across reconnects, so one
 * that never settles blocks that database's apply loop for the life of the process. A flush that FAILS is
 * already handled (the sequence persist is skipped and the copy re-runs), so the bound exists purely to
 * turn the undefined case into the defined one.
 */

import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { rejectIfUnsettled } from '#src/replication/replicationConnection';

const BOUND = 100;

describe('rejectIfUnsettled', () => {
	it('resolves with the work value when it settles in time (the normal flush)', async () => {
		const result = await rejectIfUnsettled(Promise.resolve('flushed'), BOUND, new Error('too slow'));
		assert.strictEqual(result, 'flushed');
	});

	it('propagates the work rejection unchanged — a failed flush already has a defined path', async () => {
		const failure = new Error('disk full');
		await assert.rejects(
			rejectIfUnsettled(Promise.reject(failure), BOUND, new Error('too slow')),
			(error) => error === failure
		);
	});

	it('rejects with the caller-supplied error once the bound elapses', async () => {
		// Identity, not message: the caller widens its bound only for its own timeout.
		const timeoutError = new Error('flush did not settle');
		await assert.rejects(
			rejectIfUnsettled(new Promise(() => {}), BOUND, timeoutError),
			(error) => error === timeoutError
		);
	});

	it('a work rejection arriving after the bound does not go unhandled', async () => {
		let rejectWork;
		const work = new Promise((_, reject) => (rejectWork = reject));
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			await assert.rejects(rejectIfUnsettled(work, BOUND, new Error('flush did not settle')));
			rejectWork(new Error('flush failed after we gave up on it'));
			await delay(50);
			assert.deepStrictEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
});
