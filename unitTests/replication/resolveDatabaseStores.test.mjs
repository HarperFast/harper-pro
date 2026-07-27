/**
 * Coverage for resolveDatabaseStores / createPendingDatabaseSubscription — how the replication handshake
 * gets a database's audit + `__dbis__` stores.
 *
 * Root cause this guards (harper-pro#622): a connection for a database whose local subscription queue has
 * not been registered yet holds the unresolved *placeholder Promise* that createPendingDatabaseSubscription
 * makes. `Replicator.subscribe()` only later copies `auditStore` / `dbisDB` onto the real
 * `IterableEventQueue`, so reading those off the placeholder yields `undefined`. The subscription-request
 * path did exactly that, and `undefined` there is indistinguishable from "this source has no resume
 * cursor": `getIdOfRemoteNode` returned undefined, no `seq` cursor resolved, `startTime` fell back to 1 and
 * the handshake logged `Requesting full copy of database …` — on every restart, for every database that
 * lost the race, while a current cursor sat on disk. (Same failure shape as readDbisCursorSync/#476, a
 * different source of `undefined`.)
 *
 * The fix: both stores are per-DATABASE (`rootStore.auditStore` / `rootStore.dbisDb`, surfaced on every
 * table of the database) — the subscription queue is only a carrier for them. So resolveDatabaseStores
 * falls back to the database's own tables while the subscription is pending, and returns empty stores only
 * when the database has no local tables at all: an empty node bootstrapping from its leader, which is the
 * case a full copy genuinely exists for.
 */

import { expect } from 'chai';
import {
	resolveDatabaseStores,
	createPendingDatabaseSubscription,
	awaitPendingSubscription,
<<<<<<< HEAD
<<<<<<< HEAD
	positiveMsOr,
=======
>>>>>>> 65dbf7b (fix(replication): don't treat an unresolved subscription placeholder as a resolved subscription)
=======
	positiveMsOr,
>>>>>>> c6c1d8e (fix(replication): guard config-supplied timeouts and the detached subscription handler)
} from '#src/replication/replicationConnection';

const auditStoreA = { name: 'auditStore' };
const dbisA = { name: 'dbisDB' };

/** A database's tables all surface the same per-database stores. */
function makeTables(stores = { auditStore: auditStoreA, dbisDB: dbisA }) {
	return {
		dog: { ...stores },
		cat: { ...stores },
	};
}

describe('resolveDatabaseStores', () => {
	it('reads both stores off a resolved subscription', () => {
		const subscription = { auditStore: auditStoreA, dbisDB: dbisA };
		expect(resolveDatabaseStores(subscription, undefined)).to.deep.equal({
			auditStore: auditStoreA,
			dbisDB: dbisA,
		});
	});

	it('prefers the resolved subscription over the tables', () => {
		const ownAudit = { name: 'subscriptionAudit' };
		const ownDbis = { name: 'subscriptionDbis' };
		const { auditStore, dbisDB } = resolveDatabaseStores({ auditStore: ownAudit, dbisDB: ownDbis }, makeTables());
		expect(auditStore).to.equal(ownAudit);
		expect(dbisDB).to.equal(ownDbis);
	});

	// The #622 regression: a pending placeholder must not shadow the stores that exist on disk.
	it('falls back to a local table while the subscription is still the pending placeholder', () => {
		const pending = createPendingDatabaseSubscription('data', new Map());
		const { auditStore, dbisDB } = resolveDatabaseStores(pending, makeTables());
		expect(auditStore).to.equal(auditStoreA);
		expect(dbisDB).to.equal(dbisA);
	});

	it('never reads stores off the placeholder itself, even if something set them on it', () => {
		const pending = createPendingDatabaseSubscription('data', new Map());
		pending.auditStore = { name: 'notARealQueue' };
		pending.dbisDB = { name: 'notARealQueue' };
		expect(resolveDatabaseStores(pending, makeTables())).to.deep.equal({
			auditStore: auditStoreA,
			dbisDB: dbisA,
		});
	});

	it('returns empty stores for a database with no local tables (genuine bootstrap → full copy)', () => {
		const pending = createPendingDatabaseSubscription('data', new Map());
		expect(resolveDatabaseStores(pending, undefined)).to.deep.equal({ auditStore: undefined, dbisDB: undefined });
		expect(resolveDatabaseStores(pending, {})).to.deep.equal({ auditStore: undefined, dbisDB: undefined });
	});

	it('handles a missing subscription and skips tables that carry neither store', () => {
		const tables = { dog: {}, cat: { auditStore: auditStoreA, dbisDB: dbisA } };
		expect(resolveDatabaseStores(undefined, tables)).to.deep.equal({ auditStore: auditStoreA, dbisDB: dbisA });
	});

	it('fills each store independently when a partially-populated subscription is missing one', () => {
		const { auditStore, dbisDB } = resolveDatabaseStores({ auditStore: auditStoreA }, makeTables());
		expect(auditStore).to.equal(auditStoreA);
		expect(dbisDB).to.equal(dbisA);
	});
});

describe('createPendingDatabaseSubscription', () => {
	it('registers in the map the resolver reads, and resolves through .ready', async () => {
		const subscriptions = new Map();
		const pending = createPendingDatabaseSubscription('data', subscriptions);
		// Registered in the *passed* map: Replicator.subscribe() resolves whatever it finds there, so a
		// placeholder written to any other map would stay pending forever.
		expect(subscriptions.get('data')).to.equal(pending);
		expect(typeof pending.then).to.equal('function');
		const queue = { send() {}, auditStore: auditStoreA, dbisDB: dbisA };
		pending.ready(queue);
		expect(await pending).to.equal(queue);
	});
});

/**
 * The receive path can only deliver records to the resolved queue, so it waits for the registration
 * instead of calling `.send()` on the placeholder (which threw `<x>.send is not a function` once per
 * inbound message while dropping every record in it). The wait is bounded because no watchdog covers a
 * wedged message chain — the receive watchdog is reset by the very frames that are not being processed.
 */
describe('awaitPendingSubscription', () => {
	it('returns an already-resolved subscription as-is', async () => {
		const queue = { send() {} };
		expect(await awaitPendingSubscription(queue, 0)).to.equal(queue);
		expect(await awaitPendingSubscription(undefined, 0)).to.equal(undefined);
	});

	it('resolves to the registered queue once .ready fires', async () => {
		const pending = createPendingDatabaseSubscription('data', new Map());
		const queue = { send() {} };
		setTimeout(() => pending.ready(queue), 5);
		expect(await awaitPendingSubscription(pending, 5000)).to.equal(queue);
	});

	it('resolves to undefined when the registration never lands within the timeout', async () => {
		const pending = createPendingDatabaseSubscription('data', new Map());
		expect(await awaitPendingSubscription(pending, 5)).to.equal(undefined);
	});

	/**
	 * Blocking the serialized `messageProcessing` chain does not stop `ws.on('message')` from appending
	 * closures that each retain a whole inbound frame, so the wait MUST pause socket intake — otherwise a
	 * peer mid-copy queues a full timeout's worth of large frames and OOMs the worker before the timeout
	 * closes the connection. Balance matters as much as the pause itself: `pauseReasons` is a counter, so a
	 * missed resume would leave the socket paused for the life of the connection.
	 */
	describe('backpressure', () => {
		function recorder() {
			const calls = [];
			return { calls, pause: () => calls.push('pause'), resume: () => calls.push('resume') };
		}

		it('pauses and resumes around a wait that resolves', async () => {
			const pending = createPendingDatabaseSubscription('data', new Map());
			const bp = recorder();
			setTimeout(() => pending.ready({ send() {} }), 5);
			await awaitPendingSubscription(pending, 5000, bp);
			expect(bp.calls).to.deep.equal(['pause', 'resume']);
		});

		it('resumes after a wait that times out', async () => {
			const pending = createPendingDatabaseSubscription('data', new Map());
			const bp = recorder();
			expect(await awaitPendingSubscription(pending, 5, bp)).to.equal(undefined);
			expect(bp.calls).to.deep.equal(['pause', 'resume']);
		});

		it('resumes if the subscription rejects', async () => {
			const bp = recorder();
			const rejected = Promise.reject(new Error('boom'));
			try {
				await awaitPendingSubscription(rejected, 5000, bp);
				expect.fail('should have rejected');
			} catch (error) {
				expect(error.message).to.equal('boom');
			}
			expect(bp.calls).to.deep.equal(['pause', 'resume']);
		});

		it('does not pause when there is nothing to wait for', async () => {
			const bp = recorder();
			await awaitPendingSubscription({ send() {} }, 5000, bp);
			await awaitPendingSubscription(undefined, 5000, bp);
			expect(bp.calls).to.deep.equal([]);
		});
	});
});
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> c6c1d8e (fix(replication): guard config-supplied timeouts and the detached subscription handler)

/**
 * A NaN timeout fails silently in BOTH directions, which is why these config reads are coerced rather
 * than trusted: `setTimeout` coerces NaN to ~0 (the subscription-resolve bound would fire immediately and
 * close every raced connection), while a watchdog's `elapsed >= NaN` is always false (PAUSE_STALL_THRESHOLD_MS
 * would leave the paused-liveness watchdog permanently disarmed).
 */
describe('positiveMsOr', () => {
	it('passes through a positive number', () => {
		expect(positiveMsOr(5000, 60000)).to.equal(5000);
	});

	it('accepts a numeric string (env-var overrides arrive as strings)', () => {
		expect(positiveMsOr('5000', 60000)).to.equal(5000);
	});

	it('falls back to the default for anything that is not a positive number', () => {
		for (const bad of [undefined, null, '', 'abc', NaN, 0, -1, '-1', {}, []]) {
			expect(positiveMsOr(bad, 60000), `input ${JSON.stringify(bad) ?? String(bad)}`).to.equal(60000);
		}
	});
});
<<<<<<< HEAD
=======
>>>>>>> 65dbf7b (fix(replication): don't treat an unresolved subscription placeholder as a resolved subscription)
=======
>>>>>>> c6c1d8e (fix(replication): guard config-supplied timeouts and the detached subscription handler)
