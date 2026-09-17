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
// recordLockTransport first, as every production load order does: it installs recordLockRpc's
// ownership readers at module scope, and reaching recordLockRpc first walks the replicator cycle back
// into that install before this module's own state exists.
import { recordLockOwnerFor, releaseRecordLockOwner } from '#src/replication/recordLockTransport';
import { acquireOnOwnerRelay, handleAcquireReply, releaseOnOwnerRelay } from '#src/replication/recordLockRpc';

const OWNER_THREAD = 8101;
/**
 * Far beyond what these tests need to settle, so a settle is always a guard's doing — but short
 * enough that a regression which drops a guard fails on the acquire's own timeout instead of hanging.
 */
const WAIT_MS = 2_000;

/** Main's handle on the owner worker: enough of one for `confer` and the owner-exit watch. */
function fakeOwnerWorker() {
	const listeners = new Map();
	return {
		name: 'http',
		threadId: OWNER_THREAD,
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
function fakeOwnerPort() {
	const posted = [];
	return {
		threadId: OWNER_THREAD,
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
