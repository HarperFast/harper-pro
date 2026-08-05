import assert from 'node:assert';
// Only for the fake-timer seam, as in receiveWatchdog.test.mjs / pauseStallWatchdog.test.mjs.
import sinon from 'sinon';
import {
	awaitWithTimeout,
	createSubscriptionSetupWatchdog,
	isSubscriptionSetupProgressFrame,
	resolveSubscriptionSetupCapability,
	resolveSendSubscriptionSetup,
} from '#src/replication/replicationConnection';

const COPY_START = 148;
const DB_SCHEMA = 145;
const NODE_NAME = 140;
const SEQUENCE_ID_UPDATE = 143;

function counter() {
	const calls = [];
	const fn = (...args) => calls.push(args);
	fn.calls = calls;
	return fn;
}

describe('awaitWithTimeout', () => {
	it('returns an already-resolved value without waiting', async () => {
		const value = { ready: true };
		assert.strictEqual(await awaitWithTimeout(value, 5), value);
	});

	it('returns a promise value when it settles inside the bound', async () => {
		assert.strictEqual(await awaitWithTimeout(Promise.resolve('ready'), 5), 'ready');
	});

	it('returns undefined when a setup promise never settles', async () => {
		assert.strictEqual(await awaitWithTimeout(new Promise(() => {}), 5), undefined);
	});

	it('preserves a setup rejection for the existing handler catch', async () => {
		await assert.rejects(awaitWithTimeout(Promise.reject(new Error('setup failed')), 5), /setup failed/);
	});
});

describe('resolveSendSubscriptionSetup', () => {
	it('returns the database subscription after both gates resolve', async () => {
		const database = { auditStore: {} };
		const timedOut = counter();
		assert.strictEqual(
			await resolveSendSubscriptionSetup(Promise.resolve({ end() {} }), Promise.resolve(database), 5, timedOut),
			database
		);
		assert.strictEqual(timedOut.calls.length, 0);
	});

	it('identifies an authorization gate that never settles', async () => {
		const timedOut = counter();
		assert.strictEqual(
			await resolveSendSubscriptionSetup(new Promise(() => {}), Promise.resolve({}), 5, timedOut),
			undefined
		);
		assert.deepStrictEqual(timedOut.calls, [['authorization', 'timeout']]);
	});

	it('identifies a database gate that never settles', async () => {
		const timedOut = counter();
		assert.strictEqual(
			await resolveSendSubscriptionSetup(Promise.resolve({ end() {} }), new Promise(() => {}), 5, timedOut),
			undefined
		);
		assert.deepStrictEqual(timedOut.calls, [['database', 'timeout']]);
	});

	it('distinguishes a settled-but-unavailable gate from a timeout', async () => {
		const failed = counter();
		assert.strictEqual(
			await resolveSendSubscriptionSetup(Promise.resolve(null), Promise.resolve({}), 5, failed),
			undefined
		);
		assert.deepStrictEqual(failed.calls, [['authorization', 'unavailable']]);
	});
});

describe('resolveSubscriptionSetupCapability', () => {
	it('accepts newer additive versions and honors a longer sender budget', () => {
		assert.deepStrictEqual(
			resolveSubscriptionSetupCapability({ subscriptionSetupAck: 2, subscriptionSetupBudgetMs: 300 }, 150),
			{
				supported: true,
				timeoutMs: 300,
			}
		);
	});

	it('keeps the local timeout for an old peer or an explicit test override', () => {
		assert.deepStrictEqual(resolveSubscriptionSetupCapability(undefined, 150), { supported: false, timeoutMs: 150 });
		assert.deepStrictEqual(
			resolveSubscriptionSetupCapability({ subscriptionSetupAck: 1, subscriptionSetupBudgetMs: 300 }, 25, false),
			{ supported: true, timeoutMs: 25 }
		);
	});

	it('caps a peer budget that would disable the local recovery net', () => {
		assert.deepStrictEqual(
			resolveSubscriptionSetupCapability({ subscriptionSetupAck: 1, subscriptionSetupBudgetMs: 86_400_000 }, 150_000),
			{ supported: true, timeoutMs: 600_000 }
		);
	});
});

describe('isSubscriptionSetupProgressFrame', () => {
	it('accepts the requested database schema with the matching request id', () => {
		assert.strictEqual(isSubscriptionSetupProgressFrame(DB_SCHEMA, 'flair', 'flair', 7, 7), true);
	});

	it('rejects schema traffic for a sibling database', () => {
		assert.strictEqual(isSubscriptionSetupProgressFrame(DB_SCHEMA, 'flair', 'data', 7, 7), false);
	});

	it('rejects an unsolicited handshake schema and a stale response', () => {
		assert.strictEqual(isSubscriptionSetupProgressFrame(DB_SCHEMA, 'flair', 'flair', 7, undefined), false);
		assert.strictEqual(isSubscriptionSetupProgressFrame(DB_SCHEMA, 'flair', 'flair', 7, 6), false);
	});

	it('does not let uncorrelated copy, sequence, or replication data retire setup', () => {
		assert.strictEqual(isSubscriptionSetupProgressFrame(COPY_START, 'flair', undefined, 7, undefined), false);
		assert.strictEqual(isSubscriptionSetupProgressFrame(SEQUENCE_ID_UPDATE, 'flair', undefined, 7, undefined), false);
		assert.strictEqual(isSubscriptionSetupProgressFrame(undefined, 'flair', undefined, 7, undefined), false);
	});

	it('does not accept transport/identity handshake traffic', () => {
		assert.strictEqual(isSubscriptionSetupProgressFrame(NODE_NAME, 'flair', undefined, 7, undefined), false);
	});
});

describe('createSubscriptionSetupWatchdog', () => {
	let clock;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		clock.restore();
	});

	it('fires exactly once when setup never progresses', () => {
		const onTimeout = counter();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		clock.tick(60_000);
		clock.tick(60_000);

		assert.strictEqual(onTimeout.calls.length, 1);
	});

	it('is cancelled by setup progress', () => {
		const onTimeout = counter();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		clock.tick(30_000);
		watchdog.complete();
		clock.tick(60_000);

		assert.strictEqual(onTimeout.calls.length, 0);
	});

	it('stop cancels and a later non-empty request can rearm', () => {
		const onTimeout = counter();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		watchdog.stop();
		clock.tick(60_000);
		assert.strictEqual(onTimeout.calls.length, 0);

		watchdog.arm();
		clock.tick(60_000);
		assert.strictEqual(onTimeout.calls.length, 1);
	});

	it('a superseding request restarts the full timeout window', () => {
		const onTimeout = counter();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		clock.tick(30_000);
		watchdog.arm();
		clock.tick(30_000);
		assert.strictEqual(onTimeout.calls.length, 0);
		clock.tick(30_000);
		assert.strictEqual(onTimeout.calls.length, 1);
	});

	it('uses the peer-adjusted timeout when a request is armed', () => {
		const onTimeout = counter();
		let timeoutMs = 60_000;
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: () => timeoutMs, onTimeout });

		timeoutMs = 120_000;
		watchdog.arm();
		clock.tick(60_000);
		assert.strictEqual(onTimeout.calls.length, 0);
		clock.tick(60_000);
		assert.strictEqual(onTimeout.calls.length, 1);
	});

	it('does not count paused time against a pending setup window, but preserves unpaused progress', () => {
		const onTimeout = counter();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		clock.tick(30_000);
		watchdog.pause();
		clock.tick(120_000);
		assert.strictEqual(onTimeout.calls.length, 0);

		watchdog.resume();
		clock.tick(29_999);
		assert.strictEqual(onTimeout.calls.length, 0);
		clock.tick(1);
		assert.strictEqual(onTimeout.calls.length, 1);
	});

	it('recurring short pause/resume cycles still consume down to firing, never re-granting a full window', () => {
		const onTimeout = counter();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		for (let i = 0; i < 5; i++) {
			clock.tick(10_000); // active progress
			watchdog.pause();
			clock.tick(5_000); // paused; must not count
			watchdog.resume();
		}
		assert.strictEqual(onTimeout.calls.length, 0);
		clock.tick(9_999);
		assert.strictEqual(onTimeout.calls.length, 0);
		clock.tick(1);
		assert.strictEqual(onTimeout.calls.length, 1);
	});

	it('does not rearm on resume after setup completed while paused', () => {
		const onTimeout = counter();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		watchdog.pause();
		watchdog.complete();
		watchdog.resume();
		clock.tick(60_000);

		assert.strictEqual(onTimeout.calls.length, 0);
	});

	it('defers a request armed during back pressure until the socket resumes', () => {
		const onTimeout = counter();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.pause();
		watchdog.arm();
		clock.tick(120_000);
		assert.strictEqual(onTimeout.calls.length, 0);

		watchdog.resume();
		clock.tick(60_000);
		assert.strictEqual(onTimeout.calls.length, 1);
	});
});
