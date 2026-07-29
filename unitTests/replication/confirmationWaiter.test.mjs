/**
 * Coverage for createConfirmationWaiter — the `replicatedConfirmation` promise a write awaits
 * before responding (replication/knownNodes.ts).
 *
 * harper-pro#213: a write using `replicatedConfirmation` together with `replicateTo` (or any other
 * combination where the requested confirmation count doesn't get fully acked) hung the request
 * forever. The waiter promise had no timeout/reject path at all, and its `awaiting` array entry was
 * never removed — not even after a successful resolve — so every confirmed write also permanently
 * leaked an entry that every later replicated-time update iterated over.
 *
 * These tests exercise the extracted waiter directly (no real cluster/commit needed): it must
 * resolve once `confirmationCount` distinct onConfirm() calls land, reject with a clear, bounded
 * error if they never arrive, and always remove its own entry from `awaiting` when it settles.
 */

import { expect } from 'chai';
import { createConfirmationWaiter, notifyConfirmedWaiters } from '#src/replication/knownNodes';

describe('createConfirmationWaiter', () => {
	it('resolves once confirmationCount onConfirm() calls land, and removes its entry from awaiting', async () => {
		const awaiting = [];
		const promise = createConfirmationWaiter(awaiting, 'data', 100, 2, 5000);
		expect(awaiting).to.have.lengthOf(1);
		const { onConfirm } = awaiting[0];
		onConfirm();
		onConfirm();
		await promise;
		expect(awaiting).to.have.lengthOf(0);
	});

	it('rejects with a bounded, descriptive error if confirmations never arrive (harper-pro#213 hang)', async () => {
		const awaiting = [];
		const promise = createConfirmationWaiter(awaiting, 'data', 100, 1, 20);
		let error;
		try {
			await promise;
		} catch (err) {
			error = err;
		}
		expect(error).to.be.an('error');
		expect(error.message).to.match(/Timed out.*replication confirmation.*1 node.*"data"/);
		expect(error.statusCode).to.equal(504);
		// the whole point: the entry must not be left behind to leak/keep firing after timeout
		expect(awaiting).to.have.lengthOf(0);
	});

	it('rejects after timeout even if only a partial count of confirmations arrived', async () => {
		const awaiting = [];
		const promise = createConfirmationWaiter(awaiting, 'data', 100, 3, 20);
		awaiting[0].onConfirm();
		let error;
		try {
			await promise;
		} catch (err) {
			error = err;
		}
		expect(error.message).to.include('received 1');
		expect(awaiting).to.have.lengthOf(0);
	});

	it('ignores late onConfirm() calls that arrive after the waiter already timed out', async () => {
		const awaiting = [];
		const promise = createConfirmationWaiter(awaiting, 'data', 100, 1, 10);
		const entry = awaiting[0];
		try {
			await promise;
		} catch {
			// expected: it already timed out
		}
		// A late-arriving ack (e.g. a peer that eventually catches up) must not throw or resolve twice.
		expect(() => entry.onConfirm()).to.not.throw();
	});

	it('does not leak an entry for a request that never gets a single confirmation', async () => {
		const awaiting = [];
		await createConfirmationWaiter(awaiting, 'data', 100, 5, 10).catch(() => {});
		expect(awaiting).to.have.lengthOf(0);
	});

	// Regression for the pre-push review finding on this change: notifyConfirmedWaiters (called from
	// the node-update watcher on every replicated-time crossing) fans one update out to every pending
	// waiter for a database, and each onConfirm() splices its own entry out of that SAME `awaiting`
	// array as it settles. A naive for-of over the live array would skip whichever entry shifts into a
	// just-spliced index, silently dropping other waiters confirmable in the same batch. This drives
	// several single-confirmation waiters sharing one `awaiting` array through the real production
	// helper and asserts every one of them settles — not just every other one.
	it('notifyConfirmedWaiters settles every waiter confirmable in one batch, not just every other one', async () => {
		const awaiting = [];
		const promises = [
			createConfirmationWaiter(awaiting, 'data', 100, 1, 5000),
			createConfirmationWaiter(awaiting, 'data', 100, 1, 5000),
			createConfirmationWaiter(awaiting, 'data', 100, 1, 5000),
		];
		expect(awaiting).to.have.lengthOf(3);
		notifyConfirmedWaiters(awaiting, 0, 200);
		await Promise.all(promises);
		expect(awaiting).to.have.lengthOf(0);
	});

	it('notifyConfirmedWaiters only confirms waiters whose txnTime falls in (lastTime, updatedTime]', async () => {
		const awaiting = [];
		const before = createConfirmationWaiter(awaiting, 'data', 50, 1, 20); // at/before lastTime: excluded, times out
		const inRange = createConfirmationWaiter(awaiting, 'data', 100, 1, 5000);
		const after = createConfirmationWaiter(awaiting, 'data', 200, 1, 20); // past updatedTime: excluded, times out
		notifyConfirmedWaiters(awaiting, 50, 150);
		await inRange;
		expect(awaiting).to.have.lengthOf(2); // before + after were not confirmed by this call
		const [beforeError, afterError] = await Promise.all([
			before.then(
				() => undefined,
				(err) => err
			),
			after.then(
				() => undefined,
				(err) => err
			),
		]);
		expect(beforeError).to.be.an('error');
		expect(afterError).to.be.an('error');
	});
});
