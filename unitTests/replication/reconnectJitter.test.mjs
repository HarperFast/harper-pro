import assert from 'node:assert';
import { NodeReplicationConnection } from '#src/replication/replicationConnection';

const INITIAL_RETRY_TIME = 500;
const MAX_RETRY_TIME = 30_000;

function captureTimerDelays(connection) {
	const values = [];
	connection.setReconnectTimer = (_fn, ms) => {
		values.push(ms);
		return { unref() {} };
	};
	return values;
}

function scheduleDelays(connection, attempts) {
	const delays = captureTimerDelays(connection);
	for (let i = 0; i < attempts; i++) {
		connection.reconnectScheduled = false;
		connection.scheduleReconnect();
	}
	return delays;
}

describe('NodeReplicationConnection reconnect jitter (harper-pro#327)', () => {
	function makeConnection(random) {
		const connection = new NodeReplicationConnection(null, null, 'db', 'peer');
		connection.random = random;
		return connection;
	}

	it('two connections failing on identical timing get decorrelated delays', () => {
		const early = scheduleDelays(
			makeConnection(() => 0.1),
			6
		);
		const late = scheduleDelays(
			makeConnection(() => 0.9),
			6
		);

		assert.notDeepEqual(early, late);
		assert.equal(early[0], INITIAL_RETRY_TIME);
		for (let i = 1; i < early.length; i++) assert.ok(early[i] < late[i]);
	});

	it('keeps the unchanged 500ms → 30s ceiling schedule, drawing inside it', () => {
		const connection = makeConnection(() => 0.999999);
		const ceilings = [];
		const delays = captureTimerDelays(connection);
		for (let i = 0; i < 8; i++) {
			connection.reconnectScheduled = false;
			connection.scheduleReconnect();
			ceilings.push(connection.retryBackoff.ceiling);
		}

		assert.deepEqual(ceilings, [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
		const ceilingFor = (i) => Math.min(INITIAL_RETRY_TIME * 2 ** i, MAX_RETRY_TIME);
		delays.forEach((delay, i) => {
			assert.ok(delay >= INITIAL_RETRY_TIME);
			if (ceilingFor(i) === INITIAL_RETRY_TIME) assert.equal(delay, INITIAL_RETRY_TIME);
			else assert.ok(delay < ceilingFor(i));
		});
	});

	it('a zero draw still waits the fixed TLS-safety floor', () => {
		assert.deepEqual(
			scheduleDelays(
				makeConnection(() => 0),
				4
			),
			[500, 500, 500, 500]
		);
	});

	it('onFrameSent resets the ceiling and the retry counter', () => {
		const connection = makeConnection(() => 0.5);
		scheduleDelays(connection, 3);
		connection.retries = 7;
		assert.equal(connection.retryBackoff.ceiling, 4000);

		connection.onFrameSent();

		assert.equal(connection.retries, 0);
		assert.equal(connection.retryBackoff.ceiling, INITIAL_RETRY_TIME);
		assert.equal(scheduleDelays(connection, 1)[0], 500, 'drawing under the initial ceiling again');
	});
});

describe('NodeReplicationConnection durable receive progress', () => {
	function failedAttempts(connection, attempts) {
		scheduleDelays(connection, attempts);
		connection.retries = attempts;
	}

	it('a durable watermark past anything credited ends the failure streak', () => {
		const connection = new NodeReplicationConnection(null, null, 'db', 'peer');
		failedAttempts(connection, 4);
		assert.equal(connection.retryBackoff.ceiling, 8000);

		connection.onDurableProgress(1000);

		assert.equal(connection.retries, 0);
		assert.equal(connection.retryBackoff.ceiling, INITIAL_RETRY_TIME);
	});

	it('a watermark that has not moved is not progress, so the backoff keeps escalating', () => {
		const connection = new NodeReplicationConnection(null, null, 'db', 'peer');
		connection.onDurableProgress(1000);
		failedAttempts(connection, 3);

		connection.onDurableProgress(0);
		connection.onDurableProgress(999);
		connection.onDurableProgress(1000);

		assert.equal(connection.retries, 3);
		assert.equal(connection.retryBackoff.ceiling, 4000);
		failedAttempts(connection, 1);
		assert.equal(connection.retryBackoff.ceiling, 8000);
	});

	it('the credited watermark carries across sockets, so a replay from the old cursor does not reset', () => {
		const connection = new NodeReplicationConnection(null, null, 'db', 'peer');
		connection.onDurableProgress(5000);
		failedAttempts(connection, 3);

		connection.onDurableProgress(4000);
		connection.onDurableProgress(5000);
		assert.equal(connection.retryBackoff.ceiling, 4000);

		connection.onDurableProgress(5001);
		assert.equal(connection.retryBackoff.ceiling, INITIAL_RETRY_TIME);
	});

	it('a malformed sequence neither resets nor stops later progress from resetting', () => {
		const connection = new NodeReplicationConnection(null, null, 'db', 'peer');
		failedAttempts(connection, 3);

		for (const malformed of [NaN, Infinity, 9e15, -1]) connection.onDurableProgress(malformed);
		assert.equal(connection.retryBackoff.ceiling, 4000);

		connection.onDurableProgress(1000);
		assert.equal(connection.retryBackoff.ceiling, INITIAL_RETRY_TIME);
		failedAttempts(connection, 3);
		connection.onDurableProgress(1000);
		assert.equal(connection.retryBackoff.ceiling, 4000, 'the replay guard still holds after the malformed values');
	});

	it('receive progress does not reset a leg whose own sends are failing until a frame goes out again', () => {
		const connection = new NodeReplicationConnection(null, null, 'db', 'peer');
		connection.onSendFailed();
		failedAttempts(connection, 3);

		connection.onDurableProgress(1000);
		assert.equal(connection.retryBackoff.ceiling, 4000);
		failedAttempts(connection, 1);
		assert.equal(connection.retryBackoff.ceiling, 8000);

		connection.onFrameSent();
		assert.equal(connection.retryBackoff.ceiling, INITIAL_RETRY_TIME);
		failedAttempts(connection, 2);
		connection.onDurableProgress(2000);
		assert.equal(connection.retryBackoff.ceiling, INITIAL_RETRY_TIME);
	});
});
