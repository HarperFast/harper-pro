/**
 * Coverage for `rejectIfUnsettled` — the bound on the base-copy durability flush. The flush is awaited
 * from the copy's `onCommit` and the per-database apply subscription is reused across reconnects, so one
 * that never settles blocks that database's apply loop for the life of the process. A flush that FAILS is
 * already handled (the sequence persist is skipped and the copy re-runs), so the bound exists purely to
 * turn the undefined case into the defined one.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { rejectIfUnsettled } from '#src/replication/replicationConnection';

describe('rejectIfUnsettled', () => {
	let clock;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		clock.restore();
	});

	it('resolves with the work value when it settles in time (the normal flush)', async () => {
		const result = rejectIfUnsettled(Promise.resolve('flushed'), 1000, new Error('too slow'));
		await clock.tickAsync(0);
		expect(await result).to.equal('flushed');
	});

	it('propagates the work rejection unchanged — a failed flush already has a defined path', async () => {
		const failure = new Error('disk full');
		const result = rejectIfUnsettled(Promise.reject(failure), 1000, new Error('too slow'));
		await clock.tickAsync(0);
		await result.then(
			() => expect.fail('should have rejected'),
			(error) => expect(error).to.equal(failure)
		);
	});

	it('rejects with the given error once the bound elapses on a promise that never settles', async () => {
		// Identity, not message: the caller widens its bound only for its own timeout.
		const timeoutError = new Error('flush did not settle');
		const result = rejectIfUnsettled(new Promise(() => {}), 1000, timeoutError);
		await clock.tickAsync(999);
		let settled = false;
		result.catch(() => (settled = true));
		await clock.tickAsync(0);
		expect(settled).to.equal(false);

		await clock.tickAsync(1);
		await result.then(
			() => expect.fail('should have rejected'),
			(error) => expect(error).to.equal(timeoutError)
		);
	});

	it('a late rejection from the work promise does not become an unhandled rejection', async () => {
		let rejectWork;
		const work = new Promise((_, reject) => (rejectWork = reject));
		const result = rejectIfUnsettled(work, 1000, new Error('flush did not settle'));
		await clock.tickAsync(1000);
		await result.catch(() => {});

		const unhandled = sinon.spy();
		process.on('unhandledRejection', unhandled);
		try {
			rejectWork(new Error('flush failed after we gave up on it'));
			for (let i = 0; i < 5; i++) await clock.tickAsync(0);
			expect(unhandled.callCount).to.equal(0);
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});
});
