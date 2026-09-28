/**
 * The decisions core delegates to harper-pro, checked without a cluster: reading the operator-agreed
 * home map from a frozen, injected cache (never derived from `hdb_nodes`), when it is withheld (no
 * active generation, an unknown incarnation, or a peer digest disagreement), how a delegation request
 * and a recall reach the wire, and which single thread coordinates a database — including the
 * incarnation-bump gate on a genuine ownership handoff (harper-pro#825, round 2 of the planning
 * review).
 */
import assert from 'node:assert';
import { notifyThreadExit, setMainIsWorker } from '#js/core/server/threads/manageThreads';
import {
	HOMES_AGREEMENT_MATCH,
	HOMES_AGREEMENT_MISMATCH,
	HOMES_AGREEMENT_UNKNOWN,
	LOCK_CAPABILITY_SUPPORTED,
	LOCK_CAPABILITY_UNKNOWN,
	LOCK_CAPABILITY_UNSUPPORTED,
	RECORD_LOCK_HOMES_AGREEMENT_POSITION,
	RECORD_LOCKS_CAPABILITY_POSITION,
	RECORD_LOCKS_DISABLED_MESSAGE,
	RECORD_LOCK_LEVEL_POSITION,
	readPeerLockLevel,
	recordPeerLockLevel,
	collectRecordLockStatus,
	createDisabledRecordLockTransport,
	createRecordLockTransport,
	handleOwnerThreadAck,
	readOwnIncarnation,
	setHomeIncarnation,
	isFirstIncarnation,
	currentHomeIncarnation,
	ownsRecordLockCoordination,
	readPeerHomesAgreement,
	readPeerLockCapability,
	recordLockOwnerFor,
	recordLockOwnerThreadIds,
	recordPeerHomesAgreement,
	recordPeerLockCapability,
	releaseRecordLockOwner,
} from '#src/replication/recordLockTransport';
import { DELEGATE_OPERATION, RECALL_OPERATION } from '#src/replication/recordLockRpc';
import { REPLICATION_SHARED_STATUS_SLOTS, getReplicationSharedStatus } from '#src/replication/knownNodes';
import { FIRE_COUNTER_BASE_POSITION, FIRE_MECHANISMS } from '#src/replication/replicationConnection';

/** Enough of an audit store for `getReplicationSharedStatus`: one stable buffer per (db, peer) key. */
function fakeAuditStore() {
	const buffers = new Map();
	let lookups = 0;
	return {
		get lookups() {
			return lookups;
		},
		getUserSharedBuffer(key, initial) {
			lookups++;
			const id = JSON.stringify(key);
			let buffer = buffers.get(id);
			if (!buffer) buffers.set(id, (buffer = initial));
			return buffer;
		},
	};
}

function fakeWorker(threadId) {
	const posted = [];
	// A LIST per event, as `EventEmitter.once` gives: two overlapping handoff attempts register their
	// own `exit` listener on the same worker, and a last-one-wins map silently drops the first — which
	// leaves its arm of `broadcastOwnerlessAndWait` pending until the 10s timeout, a fixture artifact
	// that has nothing to do with the code under test.
	const listeners = new Map();
	const fire = (event) => {
		const registered = listeners.get(event);
		if (!registered) return;
		listeners.delete(event); // `once`
		for (const listener of registered) listener();
	};
	return {
		name: 'http',
		threadId,
		posted,
		postMessage(message) {
			posted.push(message);
			// A worker resolves `broadcastOwnerlessAndWait`'s per-worker wait on `exit` as well as on an
			// ack, so fire that to complete a handoff's fence gate — every handoff below therefore travels
			// the EXIT arm of that wait. `fenceAckWorker` is the same worker holding its ack back, for the
			// tests that drive the live ack arm instead.
			if (message?.type === 'record-lock-owner-thread' && message.requestId !== undefined)
				queueMicrotask(() => fire('exit'));
		},
		once(event, listener) {
			const registered = listeners.get(event);
			if (registered) registered.push(listener);
			else listeners.set(event, [listener]);
		},
		removeListener(event, listener) {
			const registered = listeners.get(event);
			const index = registered?.indexOf(listener) ?? -1;
			if (index !== -1) registered.splice(index, 1);
		},
		exit() {
			fire('exit');
		},
	};
}

/**
 * A live worker that does NOT exit: it holds its fence ack back so a test can deliver it through main's
 * own route (`handleOwnerThreadAck`). Without this, every handoff resolves on the exit arm and the ack
 * arm — the one a real running worker uses — is never exercised.
 */
function fenceAckWorker(threadId) {
	const worker = fakeWorker(threadId);
	worker.postMessage = (message) => worker.posted.push(message);
	worker.fenceRequestId = () =>
		worker.posted.findLast((message) => message.type === 'record-lock-owner-thread' && message.requestId !== undefined)
			?.requestId;
	return worker;
}

describe('peer lock capability in the shared status buffer', () => {
	it('records what the peer asserted and reads never-learned as unknown', () => {
		const status = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
		assert.strictEqual(readPeerLockCapability(status), LOCK_CAPABILITY_UNKNOWN);
		recordPeerLockCapability(status, true);
		assert.strictEqual(readPeerLockCapability(status), LOCK_CAPABILITY_SUPPORTED);
		recordPeerLockCapability(status, false);
		assert.strictEqual(readPeerLockCapability(status), LOCK_CAPABILITY_UNSUPPORTED);
		status[RECORD_LOCKS_CAPABILITY_POSITION] = 42;
		assert.strictEqual(readPeerLockCapability(status), LOCK_CAPABILITY_UNKNOWN);
		status[RECORD_LOCKS_CAPABILITY_POSITION] = NaN;
		assert.strictEqual(readPeerLockCapability(status), LOCK_CAPABILITY_UNKNOWN);
	});

	it('uses a slot outside the ones connection truth, blob signals, and the fire counters occupy', () => {
		const fireCountersEnd = FIRE_COUNTER_BASE_POSITION + FIRE_MECHANISMS.length * 2; // exclusive
		assert.ok(RECORD_LOCKS_CAPABILITY_POSITION >= fireCountersEnd);
		assert.ok(RECORD_LOCKS_CAPABILITY_POSITION < REPLICATION_SHARED_STATUS_SLOTS);
	});
});

describe('peer home-map digest agreement in the shared status buffer', () => {
	it('records match/mismatch and reads never-learned as unknown', () => {
		const status = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
		assert.strictEqual(readPeerHomesAgreement(status), HOMES_AGREEMENT_UNKNOWN);
		recordPeerHomesAgreement(status, true);
		assert.strictEqual(readPeerHomesAgreement(status), HOMES_AGREEMENT_MATCH);
		recordPeerHomesAgreement(status, false);
		assert.strictEqual(readPeerHomesAgreement(status), HOMES_AGREEMENT_MISMATCH);
	});

	it('uses the slot right after the capability-level flag, still inside headroom', () => {
		assert.strictEqual(RECORD_LOCK_HOMES_AGREEMENT_POSITION, RECORD_LOCKS_CAPABILITY_POSITION + 1);
		assert.ok(RECORD_LOCK_HOMES_AGREEMENT_POSITION < REPLICATION_SHARED_STATUS_SLOTS);
	});

	it('records the exact advertised level in the last slot, reading garbage as 0', () => {
		assert.strictEqual(RECORD_LOCK_LEVEL_POSITION, RECORD_LOCK_HOMES_AGREEMENT_POSITION + 1);
		assert.ok(RECORD_LOCK_LEVEL_POSITION < REPLICATION_SHARED_STATUS_SLOTS);
		const status = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
		assert.strictEqual(readPeerLockLevel(status), 0);
		recordPeerLockLevel(status, 4);
		assert.strictEqual(readPeerLockLevel(status), 4);
		recordPeerLockLevel(status, -1);
		assert.strictEqual(readPeerLockLevel(status), 0);
		status[RECORD_LOCK_LEVEL_POSITION] = 2.5;
		assert.strictEqual(readPeerLockLevel(status), 0);
	});
});

describe('createRecordLockTransport().homeMap', () => {
	function transportFor(options = {}) {
		const {
			homeIncarnation = 3,
			agreements = {},
			capabilities,
			auditStore: overrideStore,
			reply,
			firstIncarnation = false,
		} = options;
		const auditStore = overrideStore !== undefined ? overrideStore : fakeAuditStore();
		const sent = [];
		const deps = {
			thisNodeName: () => 'self',
			auditStore: () => auditStore,
			ownsDatabase: () => true,
			homeIncarnation: () => homeIncarnation,
			send: async (node, database, operation) => {
				sent.push({ node, database, operation });
				return reply ?? { granted: true, token: [1, 3, 1], leaseMs: 1000 };
			},
			isFirstIncarnation: () => firstIncarnation,
			monotonicNow: () => 12345,
		};
		if (auditStore) {
			for (const [peer, matches] of Object.entries(agreements)) {
				const status = getReplicationSharedStatus(auditStore, 'data', peer);
				// A peer agreeing on the home map is assumed to also speak the right protocol level
				// unless the test says otherwise — these are independent checks (see homeMap's comment).
				recordPeerLockCapability(status, capabilities?.[peer] ?? matches);
				recordPeerHomesAgreement(status, matches);
			}
		}
		const cached = 'active' in options ? options.active : { generation: 1, homes: ['self', 'peer-a'] };
		return { transport: createRecordLockTransport('data', deps, () => cached), auditStore, sent };
	}

	it('returns the cached generation and homes once every peer agrees', () => {
		const { transport } = transportFor({ agreements: { 'peer-a': true } });
		const homeMap = transport.homeMap('data');
		assert.deepStrictEqual(homeMap, { generation: 1, homes: ['self', 'peer-a'], homeIncarnation: 3 });
	});

	it('waives the restart quarantine only when this is provably the first incarnation ever', () => {
		// core reads `grantableAfterMono` once at coordinator construction — a fresh node has granted
		// nothing before and can be trusted immediately; a genuine restart must not skip core's own
		// construction-anchored quarantine (`DELEGATION_LEASE_MS + skew`), which core applies whenever
		// this is left undefined.
		const fresh = transportFor({ firstIncarnation: true });
		assert.strictEqual(fresh.transport.grantableAfterMono, 12345);
		const restarted = transportFor({ firstIncarnation: false });
		assert.strictEqual(restarted.transport.grantableAfterMono, undefined);
	});

	it('is undefined with no cached active generation', () => {
		const { transport } = transportFor({ active: undefined, agreements: { 'peer-a': true } });
		assert.strictEqual(transport.homeMap('data'), undefined);
	});

	it('is undefined until the home incarnation is known', () => {
		const { transport } = transportFor({ homeIncarnation: 0, agreements: { 'peer-a': true } });
		assert.strictEqual(transport.homeMap('data'), undefined);
	});

	it('is undefined on a digest mismatch with any named peer — not a shrunk ring', () => {
		// A shrunk ring (excluding only the disagreeing peer) is itself a two-arbiter bug: with
		// homes {A,B}, A deriving {A} and B deriving {B} both self-home every key.
		const { transport } = transportFor({ agreements: { 'peer-a': false } });
		assert.strictEqual(transport.homeMap('data'), undefined);
	});

	it('is undefined while a named peer has not sent a digest at all — unknown fails closed too', () => {
		const { transport } = transportFor({ agreements: {} });
		assert.strictEqual(transport.homeMap('data'), undefined);
	});

	it('is undefined for a matching digest from a peer at the wrong protocol level — independent checks', () => {
		// A coincidentally-matching digest string from a peer speaking a different wire shape is not
		// enough; capability level and home-map agreement are checked independently.
		const { transport } = transportFor({ agreements: { 'peer-a': true }, capabilities: { 'peer-a': false } });
		assert.strictEqual(transport.homeMap('data'), undefined);
	});

	it('is undefined with no audit store yet, when other homes are named', () => {
		const { transport } = transportFor({ auditStore: undefined });
		assert.strictEqual(transport.homeMap('data'), undefined);
	});

	it('needs no peer agreement when this node is the only home', () => {
		const { transport } = transportFor({ active: { generation: 1, homes: ['self'] } });
		assert.deepStrictEqual(transport.homeMap('data'), { generation: 1, homes: ['self'], homeIncarnation: 3 });
	});

	it('answers ownsCoordination from the injected ownership view', () => {
		let owned = false;
		const auditStore = fakeAuditStore();
		const transport = createRecordLockTransport(
			'data',
			{
				thisNodeName: () => 'self',
				auditStore: () => auditStore,
				ownsDatabase: () => owned,
				homeIncarnation: () => 1,
				send: async () => ({}),
				isFirstIncarnation: () => false,
				monotonicNow: () => 0,
			},
			() => undefined
		);
		assert.strictEqual(transport.ownsCoordination(), false);
		owned = true;
		assert.strictEqual(transport.ownsCoordination(), true);
	});

	it('sends a delegation request as the delegate operation and returns the home’s reply verbatim', async () => {
		const reply = { granted: false, reason: 'contended', retryAfterMs: 25 };
		const { transport, sent } = transportFor({ reply });
		const answer = await transport.requestDelegation('peer-supported', 'data', 'Counter', {
			key: 'k1',
			requester: 'self',
			generation: 1,
			leaseMs: 5000,
		});
		assert.deepStrictEqual(answer, reply);
		assert.deepStrictEqual(sent, [
			{
				node: 'peer-supported',
				database: 'data',
				operation: {
					operation: DELEGATE_OPERATION,
					database: 'data',
					table: 'Counter',
					key: 'k1',
					generation: 1,
					leaseMs: 5000,
				},
			},
		]);
	});

	it('sends a recall as the recall operation carrying the whole fencing token', async () => {
		const { transport, sent } = transportFor({ reply: { recalled: true } });
		await transport.recallDelegation('peer-supported', 'data', 'Counter', { key: 'k1', token: [1, 3, 7] });
		assert.deepStrictEqual(sent[0].operation, {
			operation: RECALL_OPERATION,
			database: 'data',
			table: 'Counter',
			key: 'k1',
			token: [1, 3, 7],
		});
	});
});

describe('readOwnIncarnation', () => {
	// The production reader must go to the hdb_nodes table, not server.nodes: that mirror excludes the
	// local node on every path, so a mirror read is 0 forever and the home map is withheld for the life
	// of the process — which is exactly how the first cluster run of this transport failed.
	const tableWith = (row) => ({ primaryStore: { getSync: (key) => (key === 'self' ? row : undefined) } });
	it('reads the persisted counter from this node’s own row', () => {
		assert.strictEqual(readOwnIncarnation(tableWith({ name: 'self', recordLockIncarnation: 4 }), 'self'), 4);
	});
	it('reads 0 for a missing row, a missing field, or a value that is not a positive number', () => {
		assert.strictEqual(readOwnIncarnation(tableWith(undefined), 'self'), 0);
		assert.strictEqual(readOwnIncarnation(tableWith({ name: 'self' }), 'self'), 0);
		for (const bad of [0, -1, '3', NaN, null])
			assert.strictEqual(readOwnIncarnation(tableWith({ recordLockIncarnation: bad }), 'self'), 0);
	});
});

describe('setHomeIncarnation (worker side)', () => {
	it('adopts what main persisted and never moves backwards', () => {
		// A worker only ever learns the incarnation from main; a stale or malformed value must not
		// lower it, or the worker would mint tokens that compare below the previous process's.
		setHomeIncarnation(5);
		assert.strictEqual(currentHomeIncarnation(), 5);
		setHomeIncarnation(3);
		assert.strictEqual(currentHomeIncarnation(), 5);
		for (const bad of ['7', NaN, null, undefined, -1]) setHomeIncarnation(bad);
		assert.strictEqual(currentHomeIncarnation(), 5);
		setHomeIncarnation(6);
		assert.strictEqual(currentHomeIncarnation(), 6);
	});

	it('clears the first-incarnation quarantine waiver on the first handoff bump', () => {
		// The waiver lets a fresh node's successor coordinator grant immediately. But once ownership
		// has changed hands at least once (main bumps the incarnation with first=false), a departed
		// worker's relayed handle could still be in flight, so the waiver MUST drop or we get a
		// two-writer window. The true->false transition is one-way: it never re-waives afterward.
		setHomeIncarnation(10, true);
		assert.strictEqual(isFirstIncarnation(), true);
		setHomeIncarnation(11, false);
		assert.strictEqual(isFirstIncarnation(), false);
		setHomeIncarnation(12, true);
		assert.strictEqual(isFirstIncarnation(), false);
	});
});

describe('createDisabledRecordLockTransport', () => {
	it('owns coordination so the homeMap refusal is what a caller sees, and names the switch, as a real 503', async () => {
		// A plain Error here would surface as a 500, not the 503 the message promises — a real bug
		// independently found by the delegation cost bench (harper-pro#824's follow-up).
		const transport = createDisabledRecordLockTransport();
		assert.strictEqual(transport.ownsCoordination(), true);
		assert.throws(
			() => transport.homeMap('data'),
			(error) => error.message === RECORD_LOCKS_DISABLED_MESSAGE && error.statusCode === 503
		);
		await assert.rejects(
			() =>
				transport.requestDelegation('peer', 'data', 'Counter', {
					key: 'k',
					requester: 'self',
					generation: 1,
					leaseMs: 1000,
				}),
			(error) => error.message === RECORD_LOCKS_DISABLED_MESSAGE && error.statusCode === 503
		);
		await assert.rejects(
			() => transport.establishLockFreshness('data', 'Counter', 'k', [['peer', 5]], 1000),
			(error) => error.message === RECORD_LOCKS_DISABLED_MESSAGE && error.statusCode === 503
		);
		assert.match(RECORD_LOCKS_DISABLED_MESSAGE, /replication\.recordLocks/);
		assert.match(RECORD_LOCKS_DISABLED_MESSAGE, /scope: 'node'/);
	});
});

describe('recordLockOwnerFor (main thread)', () => {
	it('assigns one worker per database, keeps it stable, and spreads databases across workers', () => {
		const workers = [fakeWorker(11), fakeWorker(12)];
		const first = recordLockOwnerFor('owner-a', workers);
		assert.ok(workers.includes(first));
		assert.strictEqual(recordLockOwnerFor('owner-a', workers), first, 'stable across calls');
		assert.deepStrictEqual(first.posted, [{ type: 'record-lock-owner', database: 'owner-a', owned: true }]);
		const second = recordLockOwnerFor('owner-b', workers);
		assert.notStrictEqual(second, first, 'the next database goes to the other worker');
		assert.deepStrictEqual(recordLockOwnerThreadIds()['owner-a'], first.threadId);
		releaseRecordLockOwner('owner-a');
		releaseRecordLockOwner('owner-b');
		assert.deepStrictEqual(first.posted.at(-1), { type: 'record-lock-owner', database: 'owner-a', owned: false });
	});

	it('never moves a database off a live owner, even when other workers are offered', () => {
		const first = fakeWorker(21);
		const second = fakeWorker(22);
		// Which of the two the round robin lands on depends on how many databases were assigned before
		// this test; what must hold is that the second call does not move the database off it.
		const owner = recordLockOwnerFor('owner-c', [first, second]);
		const other = owner === first ? second : first;
		assert.strictEqual(recordLockOwnerFor('owner-c', [other, owner]), owner);
		assert.strictEqual(other.posted.length, 0);
		releaseRecordLockOwner('owner-c');
	});

	it('the first assignment has no incarnation bump to wait for and stays synchronous', () => {
		// Nothing was live before, so there is no stale incarnation a replacement could re-mint
		// against — the bump-gating path below applies only to a genuine handoff.
		let bumpCalls = 0;
		const bump = async () => (bumpCalls++, 1);
		const only = fakeWorker(91);
		const owner = recordLockOwnerFor('owner-first', [only], bump);
		assert.strictEqual(owner, only);
		assert.strictEqual(bumpCalls, 0);
		releaseRecordLockOwner('owner-first');
	});

	it('a genuine handoff withholds ownership until the incarnation bump resolves', async () => {
		const dead = fakeWorker(31);
		const live = fakeWorker(32);
		let resolveBump;
		const bump = () => new Promise((resolve) => (resolveBump = resolve));
		assert.strictEqual(recordLockOwnerFor('owner-d', [dead], bump), dead);
		// The handoff: `dead` is no longer in the live set, so a replacement is due, but must not be
		// conferred until the bump resolves.
		const duringHandoff = recordLockOwnerFor('owner-d', [live], bump);
		assert.strictEqual(duringHandoff, undefined, 'unowned while the bump is in flight, not yet live');
		assert.strictEqual(recordLockOwnerThreadIds()['owner-d'], undefined);
		// It may already have received the ownerless fence request, but not the ownership conferral.
		assert.ok(!live.posted.some((m) => m.type === 'record-lock-owner' && m.owned === true), 'not conferred yet');
		resolveBump(1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(recordLockOwnerThreadIds()['owner-d'], 32);
		assert.deepStrictEqual(live.posted.at(-1), { type: 'record-lock-owner', database: 'owner-d', owned: true });
		releaseRecordLockOwner('owner-d');
	});

	it('a second handoff attempt while one is already in flight does not start a second bump', () => {
		const dead = fakeWorker(33);
		const live = fakeWorker(34);
		let bumpCalls = 0;
		const bump = () => (bumpCalls++, new Promise(() => {})); // never resolves in this test
		recordLockOwnerFor('owner-e', [dead], bump);
		recordLockOwnerFor('owner-e', [live], bump);
		assert.strictEqual(bumpCalls, 1, 'the handoff started one bump');
		recordLockOwnerFor('owner-e', [live], bump);
		assert.strictEqual(bumpCalls, 1, 'a second call while pending does not start another');
	});

	it('a bump failure leaves the database unowned rather than confer ownership under a stale incarnation', async () => {
		const dead = fakeWorker(35);
		const live = fakeWorker(36);
		const bump = async () => {
			throw new Error('persistence failed');
		};
		recordLockOwnerFor('owner-f', [dead], bump);
		recordLockOwnerFor('owner-f', [live], bump);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(recordLockOwnerThreadIds()['owner-f'], undefined);
		assert.ok(!live.posted.some((m) => m.type === 'record-lock-owner' && m.owned === true), 'never conferred');
		// Unowned, not stuck: a later call may retry the handoff — and it must still be gated on a
		// fresh bump (`dead` could have granted under the current incarnation before it left), not
		// treated as a first assignment just because the failed attempt cleared the live owner map.
		const retried = recordLockOwnerFor('owner-f', [live], async () => 1);
		assert.strictEqual(retried, undefined, 'still gated on the retried bump, not a first-assignment fast path');
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(recordLockOwnerThreadIds()['owner-f'], 36, 'the retried bump succeeded');
		releaseRecordLockOwner('owner-f');
	});

	it('a handoff that fails after a release superseded it leaves the attempt that replaced it alone', async () => {
		const dead = fakeWorker(45);
		const live = fakeWorker(46);
		let failSuperseded;
		const supersededBump = () => new Promise((_, reject) => (failSuperseded = reject));
		let resolveCurrent;
		const currentBump = () => new Promise((resolve) => (resolveCurrent = resolve));
		recordLockOwnerFor('owner-superseded', [dead], supersededBump);
		recordLockOwnerFor('owner-superseded', [live], supersededBump);
		// The database is given up on mid-handoff, then claimed again: the second attempt is the live one.
		releaseRecordLockOwner('owner-superseded');
		recordLockOwnerFor('owner-superseded', [live], currentBump);
		failSuperseded(new Error('persistence failed'));
		await new Promise((resolve) => setImmediate(resolve));
		resolveCurrent(2);
		await new Promise((resolve) => setImmediate(resolve));
		// Without the per-attempt token the first rejection deletes the second attempt's PENDING_BUMP,
		// which makes the second attempt read itself as superseded and abandon — the database ends up
		// unowned, and only the failed attempt's 10s retry recovers it.
		assert.strictEqual(recordLockOwnerThreadIds()['owner-superseded'], 46, 'the current attempt still lands');
		releaseRecordLockOwner('owner-superseded');
	});

	it('moves a database off a worker that has left the live set, telling the old owner and the new one, once the bump resolves', async () => {
		const dead = fakeWorker(37);
		const live = fakeWorker(38);
		const bump = async () => 1;
		assert.strictEqual(recordLockOwnerFor('owner-g', [dead], bump), dead);
		const duringHandoff = recordLockOwnerFor('owner-g', [live], bump);
		assert.strictEqual(duringHandoff, undefined);
		assert.deepStrictEqual(dead.posted.at(-1), { type: 'record-lock-owner', database: 'owner-g', owned: false });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(live.posted.at(-1), { type: 'record-lock-owner', database: 'owner-g', owned: true });
		releaseRecordLockOwner('owner-g');
	});

	it('forgets an owner that exits, so a database nothing else drives can be re-assigned', () => {
		const first = fakeWorker(41);
		assert.strictEqual(recordLockOwnerFor('owner-h', [first]), first);
		// No other http worker is registered with manageThreads in this process, so the exit hand-over
		// has nowhere to go; what it must do is drop the dead owner rather than keep reporting it.
		first.exit();
		assert.strictEqual(recordLockOwnerThreadIds()['owner-h'], undefined);
		releaseRecordLockOwner('owner-h');
	});

	it('tolerates a previous owner whose port is already closed', () => {
		const gone = fakeWorker(51);
		gone.postMessage = () => {
			throw new Error('port closed');
		};
		const live = fakeWorker(52);
		assert.strictEqual(recordLockOwnerFor('owner-i', [gone]), gone);
		const duringHandoff = recordLockOwnerFor('owner-i', [live], async () => 1);
		assert.strictEqual(duringHandoff, undefined, 'still gated on the bump, same as any other handoff');
		releaseRecordLockOwner('owner-i');
	});

	it('takes ownership on the main thread itself when this process runs its listeners there', () => {
		setMainIsWorker(true);
		try {
			assert.strictEqual(recordLockOwnerFor('owner-main', []), undefined);
			assert.strictEqual(ownsRecordLockCoordination('owner-main'), true);
			assert.strictEqual(recordLockOwnerThreadIds()['owner-main'], 'main');
			assert.strictEqual(recordLockOwnerFor('owner-main', [fakeWorker(61)]), undefined, 'main keeps it');
			releaseRecordLockOwner('owner-main');
			assert.strictEqual(ownsRecordLockCoordination('owner-main'), false);
		} finally {
			setMainIsWorker(false);
		}
	});

	it('assigns nobody while no worker is live and the main thread does not serve requests', () => {
		assert.strictEqual(recordLockOwnerFor('owner-nobody', []), undefined);
		assert.strictEqual(recordLockOwnerThreadIds()['owner-nobody'], undefined);
	});

	it('a release racing an in-flight handoff supersedes it — the bump completing does not resurrect it', async () => {
		const dead = fakeWorker(71);
		const live = fakeWorker(72);
		let resolveBump;
		const bump = () => new Promise((resolve) => (resolveBump = resolve));
		recordLockOwnerFor('owner-j', [dead], bump);
		recordLockOwnerFor('owner-j', [live], bump);
		releaseRecordLockOwner('owner-j');
		resolveBump(1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(recordLockOwnerThreadIds()['owner-j'], undefined, 'the release superseded the pending handoff');
		assert.ok(!live.posted.some((m) => m.type === 'record-lock-owner' && m.owned === true), 'never conferred');
	});

	it('does not confer ownership on a successor that exited during the fence wait', async () => {
		const departing = fakeWorker(91);
		const successor = fakeWorker(92);
		recordLockOwnerFor('owner-k', [departing]);
		let resolveBump;
		const bump = () => new Promise((resolve) => (resolveBump = resolve));
		recordLockOwnerFor('owner-k', [successor], bump);
		// A real Worker reports `threadId` -1 from the moment it exits, so the tombstone keeps the id
		// `manageThreads` captured while it was live. Model both, or this passes against a check that
		// reads the worker's id after the fact and never matches.
		notifyThreadExit(successor.threadId);
		successor.threadId = -1;
		resolveBump(1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(
			recordLockOwnerThreadIds()['owner-k'],
			undefined,
			'no database is left pointing at a thread whose exit handler can no longer fire'
		);
		assert.ok(!successor.posted.some((m) => m.type === 'record-lock-owner' && m.owned === true), 'never conferred');
	});

	it('withholds the successor until a live worker acks its fence, and confers on that ack', async () => {
		// The gate in both directions, on the arm a real running worker uses: a live worker that has not
		// answered must NOT be conferred on (the ack is main's only evidence the departed owner's relayed
		// handles can no longer commit), and the ack is what releases the handoff. The exit arm every
		// other test here travels cannot show either — it resolves whether or not the route exists.
		const departing = fakeWorker(101);
		const successor = fenceAckWorker(102);
		recordLockOwnerFor('owner-ack', [departing]);
		assert.strictEqual(
			recordLockOwnerFor('owner-ack', [successor], async () => 1),
			undefined
		);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(
			recordLockOwnerThreadIds()['owner-ack'],
			undefined,
			'the bump resolved, but an unfenced live worker still holds the handoff'
		);
		const requestId = successor.fenceRequestId();
		assert.ok(requestId !== undefined, 'the successor was asked to fence before it could be conferred');
		handleOwnerThreadAck({ requestId: requestId + 1000 }, { threadId: 102 });
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(
			recordLockOwnerThreadIds()['owner-ack'],
			undefined,
			'an ack for another request does not settle this one'
		);
		handleOwnerThreadAck({ requestId }, { threadId: 999 });
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(
			recordLockOwnerThreadIds()['owner-ack'],
			undefined,
			'a thread that is not the one asked to fence cannot answer for it, even with the right request id'
		);
		handleOwnerThreadAck({ requestId }, { threadId: 102 });
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(recordLockOwnerThreadIds()['owner-ack'], 102, 'the ack is what releases the handoff');
		releaseRecordLockOwner('owner-ack');
	});
});

describe('collectRecordLockStatus (main thread)', () => {
	it('reports every owner and does not hang on a worker that never answers', async () => {
		const silent = fakeWorker(71);
		recordLockOwnerFor('status-a', [silent]);
		const started = Date.now();
		const status = await collectRecordLockStatus([silent]);
		assert.deepStrictEqual(status['status-a'], { ownerThreadId: 71 });
		assert.ok(Date.now() - started < 5000, 'bounded by the status timeout');
		const request = silent.posted.find((message) => message.type === 'record-lock-status-request');
		assert.deepStrictEqual(request.databases, ['status-a']);
		releaseRecordLockOwner('status-a');
	});

	it('asks every live worker, not only the owner, so misrouted entries are counted where they landed', async () => {
		const owner = fakeWorker(81);
		const other = fakeWorker(82);
		recordLockOwnerFor('status-b', [owner, other]);
		const collecting = collectRecordLockStatus([owner, other]);
		assert.ok(owner.posted.some((message) => message.type === 'record-lock-status-request'));
		assert.ok(other.posted.some((message) => message.type === 'record-lock-status-request'));
		await collecting;
		releaseRecordLockOwner('status-b');
	});

	it('answers for a main-thread owner inline', async () => {
		setMainIsWorker(true);
		try {
			recordLockOwnerFor('status-main', []);
			const status = await collectRecordLockStatus([]);
			assert.strictEqual(status['status-main'].ownerThreadId, 'main');
			releaseRecordLockOwner('status-main');
		} finally {
			setMainIsWorker(false);
		}
	});
});

describe('createRecordLockTransport().establishLockFreshness', () => {
	it('builds the barrier once, over its own homeMap(), and forwards the dependency set and deadline', async () => {
		const calls = [];
		const barrier = {
			establish(table, dependencies, deadlineMs) {
				calls.push({ table, dependencies, deadlineMs });
				return Promise.resolve();
			},
			noteBarrierApplied: () => false,
			stats: () => ({ outstanding: 0, applied: 0, timeouts: 0, rejected: {} }),
			close() {},
		};
		let built = 0;
		let homeMapReader;
		const deps = {
			thisNodeName: () => 'self',
			auditStore: () => undefined,
			ownsDatabase: () => true,
			homeIncarnation: () => 1,
			send: () => Promise.reject(new Error('no wire in this test')),
			isFirstIncarnation: () => false,
			monotonicNow: () => 0,
			freshness(database, homeMap) {
				built++;
				assert.strictEqual(database, 'data');
				homeMapReader = homeMap;
				return barrier;
			},
		};
		const transport = createRecordLockTransport('data', deps, () => undefined);
		await transport.establishLockFreshness('data', 'Counter', 'k', [['peer', 5]], 250);
		await transport.establishLockFreshness('data', 'Counter', 'k', null, 300);
		assert.strictEqual(built, 1);
		assert.deepStrictEqual(calls, [
			{ table: 'Counter', dependencies: [['peer', 5]], deadlineMs: 250 },
			{ table: 'Counter', dependencies: null, deadlineMs: 300 },
		]);
		assert.strictEqual(homeMapReader(), undefined, 'the barrier reads the map the transport itself would answer');
	});
});
