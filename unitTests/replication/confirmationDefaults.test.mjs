import assert from 'node:assert';
import { createRequire } from 'node:module';
import { table } from '#src/core/resources/databases';
import { server } from '#src/core/server/Server';
import {
	createConfirmationWaiter,
	lockConfirmersReachable,
	parseConfirmationDefault,
	registerConfirmationDefaults,
	sweepWatchedWaiters,
} from '#src/replication/knownNodes';
import { countSendingTo, registerResidencySender } from '#src/replication/residencyTopology';
import {
	confirmationDefaultsConfigured,
	writeConfirmationDefaultConfigured,
} from '#src/core/resources/DatabaseTransaction';

const { setupTestDBPath } = createRequire(import.meta.url)('../testUtils.js');

describe('replication confirmation defaults', () => {
	after(() => registerConfirmationDefaults(() => undefined, false));

	it('reads an absent key as 0', () => {
		for (const raw of [undefined, null, ''])
			assert.strictEqual(parseConfirmationDefault('replication.confirmation', raw), 0);
	});

	it('accepts non-negative integers, as numbers or integer strings', () => {
		assert.strictEqual(parseConfirmationDefault('replication.confirmation', 0), 0);
		assert.strictEqual(parseConfirmationDefault('replication.confirmation', 2), 2);
		for (const raw of [' 1 ', '1.0', '+1', '1e0'])
			assert.strictEqual(parseConfirmationDefault('replication.recordLockConfirmation', raw), 1, raw);
	});

	it('throws on any other value rather than turning confirmation off', () => {
		for (const raw of [-1, 1.5, Number.NaN, 'one', '-1', '1.5', true, {}, Number.MAX_SAFE_INTEGER + 1])
			assert.throws(
				() => parseConfirmationDefault('replication.recordLockConfirmation', raw),
				/Invalid replication\.recordLockConfirmation .*: expected a non-negative integer/
			);
	});

	it('registers the values a clone installs, read through the given source', () => {
		const installed = { replication_confirmation: 2, replication_recordLockConfirmation: '1' };
		registerConfirmationDefaults((key) => installed[key], false);
		assert.strictEqual(writeConfirmationDefaultConfigured(), true);
		registerConfirmationDefaults((key) => (key === 'replication_recordLockConfirmation' ? '1' : undefined), false);
		assert.strictEqual(writeConfirmationDefaultConfigured(), false);
		assert.strictEqual(confirmationDefaultsConfigured(), true);
		assert.throws(() => registerConfirmationDefaults(() => -1, false), /Invalid replication\.confirmation/);
		registerConfirmationDefaults(() => undefined, false);
		assert.strictEqual(confirmationDefaultsConfigured(), false);
	});

	it('defaults the lock count to 1 only while cluster record locks are on, and lets a configured 0 opt out', () => {
		for (const [lockCount, recordLocksEnabled, configured] of [
			[undefined, true, true],
			['', true, true],
			[0, true, false],
			['0', true, false],
			[2, true, true],
			[undefined, false, false],
			[1, false, true],
		]) {
			registerConfirmationDefaults(
				(key) => (key === 'replication_recordLockConfirmation' ? lockCount : undefined),
				recordLocksEnabled
			);
			const label = `${lockCount} with locks ${recordLocksEnabled}`;
			assert.strictEqual(confirmationDefaultsConfigured(), configured, label);
			assert.strictEqual(writeConfirmationDefaultConfigured(), false, label);
		}
	});
});

describe('lock-governed confirmation waits', () => {
	const watch = (reachable, graceMs = 3000) => ({ reachable, graceMs });

	it('fails once the confirming peers have been gone for the grace period, saying the write committed', async () => {
		const awaiting = new Set();
		const waiting = createConfirmationWaiter(
			awaiting,
			'data',
			5,
			1,
			60_000,
			new Set(),
			undefined,
			watch(() => false)
		);
		sweepWatchedWaiters(1000);
		sweepWatchedWaiters(3999);
		assert.strictEqual(awaiting.size, 1, 'still inside the grace period');
		sweepWatchedWaiters(4000);
		await assert.rejects(waiting, (error) => {
			assert.strictEqual(error.statusCode, 504);
			assert.match(
				error.message,
				/^The write committed on this node but was not confirmed: the peers that could confirm it for database "data" have not been receiving replication from this node for 3000ms \(needed 1, received 0\)$/
			);
			return true;
		});
		assert.strictEqual(awaiting.size, 0);
	});

	it('starts the grace period again when a peer comes back', async () => {
		let reachable = false;
		const awaiting = new Set();
		const waiting = createConfirmationWaiter(
			awaiting,
			'data',
			5,
			1,
			60_000,
			new Set(),
			undefined,
			watch(() => reachable)
		);
		sweepWatchedWaiters(0);
		reachable = true;
		sweepWatchedWaiters(2000);
		reachable = false;
		sweepWatchedWaiters(2500);
		sweepWatchedWaiters(5000);
		assert.strictEqual(awaiting.size, 1, 'a reconnect inside the grace period does not fail the wait');
		[...awaiting][0].onConfirm('peer');
		await waiting;
		sweepWatchedWaiters(100_000);
	});

	it('treats a probe that throws as reachable, leaving the timeout to bound the wait', async () => {
		const awaiting = new Set();
		const waiting = createConfirmationWaiter(
			awaiting,
			'data',
			5,
			1,
			60_000,
			new Set(),
			undefined,
			watch(() => {
				throw new Error('no hdb_nodes');
			})
		);
		sweepWatchedWaiters(0);
		sweepWatchedWaiters(10_000);
		assert.strictEqual(awaiting.size, 1);
		[...awaiting][0].onConfirm('peer');
		await waiting;
	});

	it('words a lock-governed timeout as committed but unconfirmed, and leaves other timeouts as they were', async () => {
		const locked = createConfirmationWaiter(
			new Set(),
			'data',
			5,
			1,
			1,
			new Set(),
			undefined,
			watch(() => true)
		);
		await assert.rejects(locked, {
			message: /^The write committed on this node but was not confirmed: Timed out after 1ms/,
		});
		const explicit = createConfirmationWaiter(new Set(), 'data', 5, 1, 1, new Set());
		await assert.rejects(explicit, { message: /^Timed out after 1ms waiting for replication confirmation/ });
	});
});

describe('peers this node is sending a database to', () => {
	const database = 'confirmation-sending';
	let store;
	before(() => {
		setupTestDBPath();
		store = table({
			database,
			table: 'Records',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		}).auditStore;
	});

	it('counts only peers with an active, fresh sender', () => {
		const b = registerResidencySender(store, database, 'node-b');
		const c = registerResidencySender(store, database, 'node-c', Date.now() - 10 * 60_000);
		assert.strictEqual(countSendingTo(database, ['node-b', { name: 'node-c' }, 'node-d']), 1);
		assert.strictEqual(countSendingTo(database, ['node-b'], new Set(['node-b'])), 0);
		c.touch();
		assert.strictEqual(countSendingTo(database, ['node-b', 'node-c']), 2);
		b.close();
		c.close();
		assert.strictEqual(countSendingTo(database, ['node-b', 'node-c']), 0);
		assert.strictEqual(countSendingTo('no-such-database', ['node-b']), 0);
	});

	it('reaches a resident count from confirmed peers plus connected recipients', () => {
		const b = registerResidencySender(store, database, 'node-b');
		const e = registerResidencySender(store, database, 'node-e');
		const nodes = server.nodes;
		server.nodes = [{ name: 'node-b' }, { name: 'node-c' }];
		try {
			assert.strictEqual(lockConfirmersReachable(database, 1, new Set(), [['node-e', 'node-c']]), false);
			assert.strictEqual(lockConfirmersReachable(database, 1, new Set(), [['node-b', 'node-c']]), true);
			assert.strictEqual(lockConfirmersReachable(database, 2, new Set(), [['node-b', 'node-c']]), false);
			assert.strictEqual(lockConfirmersReachable(database, 2, new Set(['node-c']), [['node-b', 'node-c']]), true);
			assert.strictEqual(lockConfirmersReachable(database, 1, new Set(), [['node-b'], ['node-c']]), false);
		} finally {
			server.nodes = nodes;
			b.close();
			e.close();
		}
	});
});
