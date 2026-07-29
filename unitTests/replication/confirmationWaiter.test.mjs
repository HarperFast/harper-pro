/**
 * Coverage for createConfirmationWaiter — the `replicatedConfirmation` promise a write awaits
 * before responding (replication/knownNodes.ts).
 *
 * harper-pro#213: a write using `replicatedConfirmation` together with `replicateTo` (or any other
 * combination where the requested confirmation count doesn't get fully acked) hung the request
 * forever. The waiter promise had no timeout/reject path at all, and its `awaiting` entry was never
 * removed — not even after a successful resolve — so every confirmed write also permanently leaked an
 * entry that every later replicated-time update iterated over.
 *
 * `awaiting` is a Set, not an array: both settle paths (confirmed, and timed out) remove their own
 * entry immediately via `Set.delete`, an O(1) operation regardless of how many other waiters are
 * pending. Two earlier revisions of this fix used an array instead and were caught by pre-push
 * review: splicing mid-iteration skipped other waiters confirmable in the same batch; a deferred
 * "compact on the next unrelated notify call" scheme could still leak a timed-out entry forever
 * against a peer that never sends another update; and a spread-based compaction
 * (`push(...manyEntries)`) threw `RangeError: Maximum call stack size exceeded` at scale. The Set
 * design has none of these failure modes — a for-of over a Set may safely delete the current or any
 * other entry mid-iteration, and there is no batch-compaction step at all.
 *
 * These tests exercise the extracted waiter directly (no real cluster/commit needed): it must resolve
 * once `confirmationCount` distinct confirmations land, reject with a clear, bounded error if they
 * never arrive, and always end up removed from `awaiting` the instant it settles. In production
 * `onConfirm()` is only ever invoked by notifyConfirmedWaiters (never called directly), so these tests
 * drive confirmations the same way — through notifyConfirmedWaiters — except where a test is
 * specifically about the raw entry contract (the late-onConfirm no-op case).
 */

import { expect } from 'chai';
import { createConfirmationWaiter, notifyConfirmedWaiters } from '#src/replication/knownNodes';

describe('createConfirmationWaiter', () => {
	it('resolves once confirmationCount confirmations land, and is immediately removed from awaiting', async () => {
		const awaiting = new Set();
		const promise = createConfirmationWaiter(awaiting, 'data', 100, 2, 5000);
		expect(awaiting.size).to.equal(1);
		notifyConfirmedWaiters(awaiting, 0, 200); // 1st peer acks — not yet at confirmationCount
		expect(awaiting.size).to.equal(1);
		notifyConfirmedWaiters(awaiting, 0, 200); // 2nd peer acks — reaches confirmationCount
		await promise;
		expect(awaiting.size).to.equal(0);
	});

	it('rejects with a bounded, descriptive error if confirmations never arrive (harper-pro#213 hang), and removes its entry', async () => {
		const awaiting = new Set();
		const promise = createConfirmationWaiter(awaiting, 'data', 100, 1, 20);
		expect(awaiting.size).to.equal(1);
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
		expect(awaiting.size).to.equal(0);
	});

	it('rejects after timeout even if only a partial count of confirmations arrived', async () => {
		const awaiting = new Set();
		const promise = createConfirmationWaiter(awaiting, 'data', 100, 3, 20);
		notifyConfirmedWaiters(awaiting, 0, 200);
		let error;
		try {
			await promise;
		} catch (err) {
			error = err;
		}
		expect(error.message).to.include('received 1');
		expect(awaiting.size).to.equal(0);
	});

	it('ignores late onConfirm() calls that arrive after the waiter already timed out', async () => {
		const awaiting = new Set();
		const promise = createConfirmationWaiter(awaiting, 'data', 100, 1, 10);
		const [entry] = awaiting;
		try {
			await promise;
		} catch {
			// expected: it already timed out
		}
		// A late-arriving ack (e.g. a peer that eventually catches up) must not throw or resolve twice.
		expect(() => entry.onConfirm()).to.not.throw();
	});

	it('does not leak an entry for a request that never gets a single confirmation', async () => {
		const awaiting = new Set();
		await createConfirmationWaiter(awaiting, 'data', 100, 5, 10).catch(() => {});
		expect(awaiting.size).to.equal(0);
	});

	// Regression for a pre-push review finding on an earlier (array-based) revision of this fix:
	// notifyConfirmedWaiters fans one replicated-time crossing out to every pending waiter for a
	// database, and each settling waiter removes itself from the shared collection. With an array and
	// a naive for-of, splicing mid-iteration skips whichever entry shifts into the just-vacated index,
	// silently dropping other waiters confirmable in the same batch. A Set has no such hazard (deleting
	// mid-for-of is well-defined), but this test drives several single-confirmation waiters sharing one
	// `awaiting` Set through the real production helper to confirm every one of them settles.
	it('notifyConfirmedWaiters settles every waiter confirmable in one batch, not just every other one', async () => {
		const awaiting = new Set();
		const promises = [
			createConfirmationWaiter(awaiting, 'data', 100, 1, 5000),
			createConfirmationWaiter(awaiting, 'data', 100, 1, 5000),
			createConfirmationWaiter(awaiting, 'data', 100, 1, 5000),
		];
		expect(awaiting.size).to.equal(3);
		notifyConfirmedWaiters(awaiting, 0, 200);
		await Promise.all(promises);
		expect(awaiting.size).to.equal(0);
	});

	it('notifyConfirmedWaiters only confirms waiters whose txnTime falls in (lastTime, updatedTime]', async () => {
		const awaiting = new Set();
		const before = createConfirmationWaiter(awaiting, 'data', 50, 1, 20); // at/before lastTime: excluded, times out
		const inRange = createConfirmationWaiter(awaiting, 'data', 100, 1, 5000);
		const after = createConfirmationWaiter(awaiting, 'data', 200, 1, 20); // past updatedTime: excluded, times out
		notifyConfirmedWaiters(awaiting, 50, 150);
		await inRange;
		expect(awaiting.size).to.equal(2); // before + after were not confirmed by this call
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
		expect(awaiting.size).to.equal(0); // both timeouts removed themselves independently
	});

	// notifyConfirmedWaiters must only remove entries that actually settle during this call — a
	// partially-confirmed multi-peer waiter sitting alongside a fully-settled one in the same Set must
	// survive untouched.
	it('removes only the settled entry out of a mixed batch, leaving the still-pending one', async () => {
		const awaiting = new Set();
		const single = createConfirmationWaiter(awaiting, 'data', 100, 1, 5000); // settles this call
		const needsTwo = createConfirmationWaiter(awaiting, 'data', 100, 2, 5000); // needs a 2nd notify
		notifyConfirmedWaiters(awaiting, 0, 200);
		await single;
		expect(awaiting.size).to.equal(1); // needsTwo survives, still counting
		notifyConfirmedWaiters(awaiting, 0, 200);
		await needsTwo;
		expect(awaiting.size).to.equal(0);
	});

	// The scenario a prior revision of this fix (deferred/"lazy compaction" timeout cleanup) still got
	// wrong: a peer that never sends another update after some waiters against it have already timed
	// out. With immediate, independent removal on both settle paths, this can no longer leak — nothing
	// about a timed-out entry's cleanup depends on any other waiter or any future notify call.
	it('a peer that goes permanently silent does not accumulate timed-out entries across repeated writes', async () => {
		const awaiting = new Set();
		for (let i = 0; i < 5; i++) {
			await createConfirmationWaiter(awaiting, 'data', 100 + i, 1, 10).catch(() => {});
		}
		expect(awaiting.size).to.equal(0);
	});
});
