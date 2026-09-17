/**
 * The caller side of the owner relay (harper-pro#852), checked without a cluster: what a relayed
 * `lock()` acquire does when the coordinating thread goes away while it is in flight, what happens to
 * a grant that lands after that, and what a release may still address afterwards. These are the
 * guards the PR's two-writer window turned on, so they are pinned here rather than left to the
 * integration suite's happy path.
 *
 * The owner thread is driven through the real ownership path — `recordLockOwnerFor` /
 * `releaseRecordLockOwner` write `ownerThreadByDatabase`, which is exactly what the relay reads — and
 * the mesh is a fake port registered in the thread port list `sendToThread` searches.
 */
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
// recordLockTransport first, as every production load order does: it installs recordLockRpc's
// ownership readers at module scope, and reaching recordLockRpc first walks the replicator cycle back
// into that install before this module's own state exists.
import { recordLockOwnerFor, releaseRecordLockOwner } from '#src/replication/recordLockTransport';
import { setMainIsWorker } from '#js/core/server/threads/manageThreads';
import {
	acquireOnOwnerRelay,
	handleAcquireReply,
	handleAcquireRequest,
	handleRelease,
	handleRevokeAck,
	releaseOnOwnerRelay,
} from '#src/replication/recordLockRpc';

const OWNER_THREAD = 8101;
const SIBLING_THREAD = 8102;
/**
 * Far beyond what these tests need to settle, so a settle is always a guard's doing — but short
 * enough that a regression which drops a guard fails on the acquire's own timeout instead of hanging.
 */
const WAIT_MS = 2_000;

/** Main's handle on the owner worker: enough of one for `confer` and the owner-exit watch. */
function fakeOwnerWorker(threadId = OWNER_THREAD) {
	const listeners = new Map();
	return {
		name: 'http',
		threadId,
		postMessage() {},
		once(event, listener) {
			listeners.set(event, listener);
		},
		removeListener(event) {
			listeners.delete(event);
		},
	};
}

/** This thread's mesh port to the owner worker, as `sendToThread` resolves it. */
function fakeOwnerPort(threadId = OWNER_THREAD) {
	const posted = [];
	return {
		threadId,
		posted,
		postMessage(message) {
			posted.push(message);
		},
		acquires() {
			return posted.filter((message) => message.type === 'record-lock-acquire');
		},
		releases() {
			return posted.filter((message) => message.type === 'record-lock-release');
		},
	};
}

describe('relaying a lock() to the coordinating worker', () => {
	let port;
	let database;

	beforeEach(() => {
		port = fakeOwnerPort();
		globalThis.threads.push(port);
	});

	afterEach(() => {
		const index = globalThis.threads.indexOf(port);
		if (index !== -1) globalThis.threads.splice(index, 1);
		if (database) releaseRecordLockOwner(database);
		database = undefined;
	});

	/** Assign the owner thread and start one relayed acquire; returns the request that reached it. */
	function acquireAgainstOwner(db, key = 'k') {
		database = db;
		recordLockOwnerFor(db, [fakeOwnerWorker()]);
		const acquiring = acquireOnOwnerRelay(db, 'Counter', key, 1_000, WAIT_MS);
		const request = port.acquires().at(-1);
		assert.ok(request, 'the acquire goes straight to the owner thread, with no hop through main');
		return { acquiring, request };
	}

	it('fails an in-flight acquire retryably when the coordinating thread goes away', async () => {
		const { acquiring } = acquireAgainstOwner('rpc-handoff');
		releaseRecordLockOwner('rpc-handoff');
		await assert.rejects(
			acquiring,
			(error) => error.statusCode === 503 && /retry against the successor/.test(error.message),
			'a caller retries against the successor rather than waiting out its whole timeout'
		);
	});

	it('hands a grant that lands after the handoff back to the thread that minted it', async () => {
		const { acquiring, request } = acquireAgainstOwner('rpc-late-grant');
		releaseRecordLockOwner('rpc-late-grant');
		await assert.rejects(acquiring);
		handleAcquireReply(
			{
				requestId: request.requestId,
				database: 'rpc-late-grant',
				table: 'Counter',
				key: 'k',
				round: { admissionId: 41, mintedMono: 0 },
				session: 'granting-owner',
			},
			port
		);
		const handback = port.releases().at(-1);
		assert.ok(handback, 'the owner is told to drop an admission nobody will install');
		assert.strictEqual(handback.admissionId, 41);
		assert.strictEqual(
			handback.session,
			'granting-owner',
			'stamped with the GRANTING session, so it drops rather than being rejected by the successor'
		);
	});

	it('ignores a grant from a thread the acquire was not sent to', async () => {
		const { acquiring, request } = acquireAgainstOwner('rpc-forged');
		// A sibling that coordinates its OWN database, so only the request's owner id can tell the two
		// apart: the reply names a database this sender does legitimately own.
		const sibling = fakeOwnerPort(SIBLING_THREAD);
		globalThis.threads.push(sibling);
		recordLockOwnerFor('rpc-forged-sibling', [fakeOwnerWorker(SIBLING_THREAD)]);
		try {
			handleAcquireReply(
				{
					requestId: request.requestId,
					database: 'rpc-forged-sibling',
					table: 'Counter',
					key: 'k',
					round: { admissionId: 99, mintedMono: 0 },
					session: 'sibling-session',
				},
				sibling
			);
			assert.strictEqual(
				sibling.releases().at(-1)?.admissionId,
				99,
				'the grant is handed straight back to the sibling that minted it'
			);
			handleAcquireReply(
				{
					requestId: request.requestId,
					database: 'rpc-forged',
					table: 'Counter',
					key: 'k',
					round: { admissionId: 12, mintedMono: 0 },
					session: 'owner-session',
				},
				port
			);
			assert.strictEqual(
				(await acquiring).admissionId,
				12,
				"the acquire stays live for the owner it addressed, and settles on that owner's round"
			);
		} finally {
			releaseRecordLockOwner('rpc-forged-sibling');
			const index = globalThis.threads.indexOf(sibling);
			if (index !== -1) globalThis.threads.splice(index, 1);
		}
	});

	it('stamps a release with the session the owner minted the admission under', async () => {
		const { acquiring, request } = acquireAgainstOwner('rpc-release');
		handleAcquireReply(
			{
				requestId: request.requestId,
				database: 'rpc-release',
				table: 'Counter',
				key: 'k',
				round: { admissionId: 7, mintedMono: 0 },
				session: 'owner-session',
			},
			port
		);
		assert.strictEqual((await acquiring).admissionId, 7);
		releaseOnOwnerRelay('rpc-release', 'Counter', 'k', 7);
		const release = port.releases().at(-1);
		assert.strictEqual(release.admissionId, 7);
		assert.strictEqual(release.session, 'owner-session');
	});

	it('sends no release once the coordinating thread is gone', async () => {
		const { acquiring, request } = acquireAgainstOwner('rpc-orphan-release');
		handleAcquireReply(
			{
				requestId: request.requestId,
				database: 'rpc-orphan-release',
				table: 'Counter',
				key: 'k',
				round: { admissionId: 9, mintedMono: 0 },
				session: 'owner-session',
			},
			port
		);
		await acquiring;
		releaseRecordLockOwner('rpc-orphan-release');
		port.posted.length = 0;
		releaseOnOwnerRelay('rpc-orphan-release', 'Counter', 'k', 9);
		assert.deepStrictEqual(port.posted, [], 'nothing addresses an admission the departed owner minted');
	});
});

/**
 * The OWNER side of the relay: who is allowed to release an admission, and who is allowed to say a
 * handle is fenced. Both gates are the same rule the acquire handler states — identity comes from the
 * port the harness stamped, never the payload — and both were missing until cb1kenobi's review.
 *
 * The coordinator is stubbed rather than driven: `acquireForRelay` only has to invoke the grant
 * callback (which is what mints the `OwnerAdmission` and builds the revoker) and hand back a round, so
 * no table registry or storage is involved.
 */
describe('the owner side will only take an admission from the worker it belongs to', () => {
	const coordinator = createRequire(import.meta.url)('#js/core/resources/recordLockCoordinator');
	const HOLDER = 8202;
	const OTHER = 8203;
	let saved;
	let released;
	let revokers;
	// A distinct database per test: once one has had an owner, re-claiming it takes the handoff path
	// (PENDING_BUMP) and this thread would not coordinate it synchronously.
	let ownedDatabase;

	beforeEach(() => {
		saved = { acquireForRelay: coordinator.acquireForRelay, releaseForRelay: coordinator.releaseForRelay };
		released = [];
		revokers = [];
		coordinator.acquireForRelay = async (database, table, key, leaseMs, waitMs, onGranted) => {
			// Minted NOW, not 0: `revokeRemoteHandle` derives the fence's fallback timer from
			// `mintedMono + leaseMs - performance.now()`, which is ms since PROCESS start. A literal 0 arms
			// that timer at 0ms once the suite has run longer than `leaseMs`, which is a second way for the
			// fence to settle and is not the one the wrong-thread assertion below is testing.
			const round = { admissionId: 55, mintedMono: performance.now() };
			revokers.push(onGranted(round));
			return round;
		};
		coordinator.releaseForRelay = (database, table, key, admissionId) => released.push(admissionId);
	});

	afterEach(() => {
		Object.assign(coordinator, saved);
		if (ownedDatabase) releaseRecordLockOwner(ownedDatabase);
		ownedDatabase = undefined;
		setMainIsWorker(false);
	});

	/** One minted admission, held by thread HOLDER, with its grant reply captured. */
	async function admissionHeldByHolder(database) {
		// This thread must coordinate the database, or the acquire fails closed before minting anything.
		ownedDatabase = database;
		setMainIsWorker(true);
		recordLockOwnerFor(database, []);
		const posted = [];
		const port = { threadId: HOLDER, postMessage: (message) => posted.push(message) };
		await handleAcquireRequest(
			{ requestId: 1, database, table: 'Counter', key: 'k', leaseMs: 60_000, waitMs: 1_000 },
			port
		);
		const reply = posted.find((message) => message.type === 'record-lock-acquire-reply');
		assert.ok(reply?.round, 'the acquire minted an admission for the holder');
		return { posted, session: reply.session };
	}

	it('ignores a release from a thread the admission was not minted for', async () => {
		const { session } = await admissionHeldByHolder('owner-side-release');
		const release = { database: 'owner-side-release', table: 'Counter', admissionId: 55, session };
		handleRelease(release, { threadId: OTHER });
		assert.deepStrictEqual(released, [], 'the session alone must not let a sibling drop this admission');
		handleRelease(release, { threadId: HOLDER });
		assert.deepStrictEqual(released, [55], 'the worker it was minted for still releases it');
	});

	it('forgets a relayed admission when this thread stops coordinating the database', async () => {
		// The callers fenced their handles and dropped their owner sessions the moment they learned the
		// owner changed, so nothing will ever release these entries; only this thread can retire them.
		// The positive control is the release test above: the same call with the same session and thread
		// releases 55 while this thread still owns the database.
		const { session } = await admissionHeldByHolder('owner-side-unowned');
		releaseRecordLockOwner('owner-side-unowned');
		ownedDatabase = undefined;
		handleRelease({ database: 'owner-side-unowned', table: 'Counter', admissionId: 55, session }, { threadId: HOLDER });
		assert.deepStrictEqual(released, [], 'the bookkeeping went with the ownership rather than leaking');
	});

	it('grants nothing once ownership is lost while the admission is being minted', async () => {
		ownedDatabase = 'owner-side-lost-mid-acquire';
		setMainIsWorker(true);
		recordLockOwnerFor(ownedDatabase, []);
		const granting = coordinator.acquireForRelay;
		coordinator.acquireForRelay = async (...args) => {
			releaseRecordLockOwner('owner-side-lost-mid-acquire');
			return granting(...args);
		};
		const posted = [];
		await handleAcquireRequest(
			{ requestId: 1, database: ownedDatabase, table: 'Counter', key: 'k', leaseMs: 60_000, waitMs: 1_000 },
			{ threadId: HOLDER, postMessage: (message) => posted.push(message) }
		);
		ownedDatabase = undefined;
		const reply = posted.find((message) => message.type === 'record-lock-acquire-reply');
		assert.strictEqual(reply?.round, undefined, 'a grant from a thread that stopped coordinating is not handed out');
		assert.strictEqual(reply?.error?.statusCode, 503, 'the caller retries against the successor');
		assert.deepStrictEqual(released, [55], 'and the admission is released rather than held to its lease');
	});

	it('ignores a revoke ack from a thread that does not hold the handle', async () => {
		const { posted } = await admissionHeldByHolder('owner-side-revoke');
		let fenced = false;
		revokers[0]().then(() => (fenced = true));
		// The id the owner actually minted for this revoke, not a guess: `nextRevokeId` is module-global.
		const revokeId = posted.findLast((message) => message.type === 'record-lock-revoke')?.revokeId;
		assert.ok(revokeId !== undefined, 'the holder was asked to fence over its own port');
		const ack = { revokeId };
		handleRevokeAck(ack, { threadId: OTHER });
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(fenced, false, 'only the holder can tell the owner its handle is fenced');
		handleRevokeAck(ack, { threadId: HOLDER });
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(fenced, true, 'the holder settles the fence core awaits before lockRelease');
	});
});
