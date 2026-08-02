/**
 * Regression coverage for harper-pro#642: an outbound subscription can remain transport-live forever
 * while the sender is stuck before DB_SCHEMA/replay setup. Ping/pong must not count as application setup;
 * the one-shot watchdog retires only when the requested database's subscription path responds.
 */

import assert from 'node:assert/strict';
import sinon from 'sinon';
import {
	awaitWithTimeout,
	createSubscriptionSetupWatchdog,
	isSubscriptionSetupProgressFrame,
	resolveSendSubscriptionSetup,
} from '#src/replication/replicationConnection';

const COPY_START = 148;
const DB_SCHEMA = 145;
const NODE_NAME = 140;
const SEQUENCE_ID_UPDATE = 143;

describe('awaitWithTimeout', () => {
	it('returns an already-resolved value without waiting', async () => {
		const value = { ready: true };
		assert.equal(await awaitWithTimeout(value, 5), value);
	});

	it('returns a promise value when it settles inside the bound', async () => {
		assert.equal(await awaitWithTimeout(Promise.resolve('ready'), 5), 'ready');
	});

	it('returns undefined when a setup promise never settles', async () => {
		assert.equal(await awaitWithTimeout(new Promise(() => {}), 5), undefined);
	});

	it('preserves a setup rejection for the existing handler catch', async () => {
		await assert.rejects(awaitWithTimeout(Promise.reject(new Error('setup failed')), 5), /setup failed/);
	});
});

describe('resolveSendSubscriptionSetup', () => {
	it('returns the database subscription after both gates resolve', async () => {
		const database = { auditStore: {} };
		const timedOut = sinon.spy();
		assert.equal(
			await resolveSendSubscriptionSetup(Promise.resolve({ end() {} }), Promise.resolve(database), 5, timedOut),
			database
		);
		assert.equal(timedOut.callCount, 0);
	});

	it('identifies an authorization gate that never settles', async () => {
		const timedOut = sinon.spy();
		assert.equal(
			await resolveSendSubscriptionSetup(new Promise(() => {}), Promise.resolve({}), 5, timedOut),
			undefined
		);
		assert.deepEqual(timedOut.args, [['authorization']]);
	});

	it('identifies a database gate that never settles', async () => {
		const timedOut = sinon.spy();
		assert.equal(
			await resolveSendSubscriptionSetup(Promise.resolve({ end() {} }), new Promise(() => {}), 5, timedOut),
			undefined
		);
		assert.deepEqual(timedOut.args, [['database']]);
	});
});

describe('isSubscriptionSetupProgressFrame', () => {
	it('accepts the requested database schema', () => {
		assert.equal(isSubscriptionSetupProgressFrame(DB_SCHEMA, 'flair', 'flair'), true);
	});

	it('rejects schema traffic for a sibling database', () => {
		assert.equal(isSubscriptionSetupProgressFrame(DB_SCHEMA, 'flair', 'data'), false);
	});

	it('accepts copy, sequence, and replication-data progress', () => {
		assert.equal(isSubscriptionSetupProgressFrame(COPY_START, 'flair'), true);
		assert.equal(isSubscriptionSetupProgressFrame(SEQUENCE_ID_UPDATE, 'flair'), true);
		assert.equal(isSubscriptionSetupProgressFrame(undefined, 'flair'), true);
	});

	it('does not accept transport/identity handshake traffic', () => {
		assert.equal(isSubscriptionSetupProgressFrame(NODE_NAME, 'flair'), false);
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
		const onTimeout = sinon.spy();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		clock.tick(60_000);
		clock.tick(60_000);

		assert.equal(onTimeout.callCount, 1);
	});

	it('is cancelled by setup progress', () => {
		const onTimeout = sinon.spy();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		clock.tick(30_000);
		watchdog.complete();
		clock.tick(60_000);

		assert.equal(onTimeout.callCount, 0);
	});

	it('stop cancels and a later non-empty request can rearm', () => {
		const onTimeout = sinon.spy();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		watchdog.stop();
		clock.tick(60_000);
		assert.equal(onTimeout.callCount, 0);

		watchdog.arm();
		clock.tick(60_000);
		assert.equal(onTimeout.callCount, 1);
	});

	it('a superseding request restarts the full timeout window', () => {
		const onTimeout = sinon.spy();
		const watchdog = createSubscriptionSetupWatchdog({ timeoutMs: 60_000, onTimeout });

		watchdog.arm();
		clock.tick(30_000);
		watchdog.arm();
		clock.tick(30_000);
		assert.equal(onTimeout.callCount, 0);
		clock.tick(30_000);
		assert.equal(onTimeout.callCount, 1);
	});
});
