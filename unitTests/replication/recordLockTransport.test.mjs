/**
 * The decisions core delegates to harper-pro, checked without a cluster: which membership a key's
 * home is derived from (omission is a stale ring, over-inclusion of a wrong-level peer is a second
 * arbiter), when that membership is withheld, how a delegation request and a recall reach the wire,
 * and which single thread coordinates a database.
 */
import assert from 'node:assert';
import { setMainIsWorker } from '#js/core/server/threads/manageThreads';
import {
	LOCK_CAPABILITY_SUPPORTED,
	LOCK_CAPABILITY_UNKNOWN,
	LOCK_CAPABILITY_UNSUPPORTED,
	RECORD_LOCKS_CAPABILITY_POSITION,
	RECORD_LOCKS_DISABLED_MESSAGE,
	EPOCH_MEMO_MS,
	RESTART_HOLD_MS,
	STATIC_EPOCH_NUMBER,
	collectRecordLockStatus,
	createDisabledRecordLockTransport,
	createRecordLockTransport,
	isReplicationGroupMember,
	readOwnIncarnation,
	setHomeIncarnation,
	currentHomeIncarnation,
	ownsRecordLockCoordination,
	readPeerLockCapability,
	recordLockOwnerFor,
	recordLockOwnerThreadIds,
	recordPeerLockCapability,
	releaseRecordLockOwner,
} from '#src/replication/recordLockTransport';
import { DELEGATE_OPERATION, RECALL_OPERATION } from '#src/replication/recordLockRpc';
import { getReplicationSharedStatus } from '#src/replication/knownNodes';

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
	const listeners = new Map();
	return {
		name: 'http',
		threadId,
		posted,
		postMessage(message) {
			posted.push(message);
		},
		once(event, listener) {
			listeners.set(event, listener);
		},
		exit() {
			listeners.get('exit')?.();
		},
	};
}

describe('isReplicationGroupMember', () => {
	const databases = ['data'];
	it('admits full and directional replicators in the shard, and explicit subscribers outside it', () => {
		assert.strictEqual(isReplicationGroupMember({ replicates: true }, 'data', databases, undefined), true);
		assert.strictEqual(
			isReplicationGroupMember({ replicates: { sendsTo: ['x'] } }, 'data', databases, undefined),
			true
		);
		assert.strictEqual(
			isReplicationGroupMember({ replicates: { receives: true } }, 'data', databases, undefined),
			true
		);
		assert.strictEqual(
			isReplicationGroupMember(
				{ replicates: false, subscriptions: [{ database: 'data', subscribe: true }] },
				'data',
				databases,
				undefined
			),
			true
		);
	});
	it('excludes a node that replicates nothing, or only other databases', () => {
		assert.strictEqual(isReplicationGroupMember({ replicates: false }, 'data', databases, undefined), false);
		assert.strictEqual(isReplicationGroupMember({ replicates: {} }, 'data', databases, undefined), false);
		assert.strictEqual(isReplicationGroupMember({ replicates: true }, 'other', databases, undefined), false);
	});
});

describe('peer lock capability in the shared status buffer', () => {
	it('records what the peer asserted and reads never-learned as unknown', () => {
		const status = new Float64Array(16);
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

	it('uses a slot outside the ones the connection truth and blob signals occupy', () => {
		assert.ok(RECORD_LOCKS_CAPABILITY_POSITION >= 13 && RECORD_LOCKS_CAPABILITY_POSITION <= 15);
	});
});

describe('createRecordLockTransport().epoch', () => {
	function transportFor(overrides = {}) {
		const auditStore = fakeAuditStore();
		const sent = [];
		const deps = {
			thisNodeName: () => 'self',
			nodes: () => [
				{ name: 'peer-supported', replicates: true },
				{ name: 'peer-legacy', replicates: { sends: true } },
				{ name: 'peer-unknown', replicates: true },
				// Blanket replication off, but subscribed to this database explicitly: still a member.
				{ name: 'peer-explicit', replicates: false, subscriptions: [{ database: 'data', subscribe: true }] },
				{ name: 'bystander', replicates: false },
				{ name: 'self', replicates: true },
				{ replicates: true },
			],
			replicationDatabases: () => ['data'],
			shard: () => undefined,
			auditStore: () => auditStore,
			ownsDatabase: () => true,
			homeIncarnation: () => 3,
			advertisesLevel: () => true,
			// Past the restart hold unless a test says otherwise.
			sinceStartMs: () => RESTART_HOLD_MS + 1,
			restartHoldMs: RESTART_HOLD_MS,
			send: async (node, database, operation) => {
				sent.push({ node, database, operation });
				return overrides.reply ?? { granted: true, token: [1, 3, 1], leaseMs: 1000 };
			},
			...overrides,
		};
		recordPeerLockCapability(getReplicationSharedStatus(auditStore, 'data', 'peer-supported'), true);
		recordPeerLockCapability(getReplicationSharedStatus(auditStore, 'data', 'peer-legacy'), false);
		recordPeerLockCapability(getReplicationSharedStatus(auditStore, 'data', 'peer-explicit'), true);
		return { transport: createRecordLockTransport('data', deps), auditStore, sent };
	}

	it('names this node and every group member that advertised the delegation level, sorted', () => {
		const { transport } = transportFor();
		const epoch = transport.epoch('data');
		assert.deepStrictEqual(epoch.members, ['peer-explicit', 'peer-supported', 'self']);
		assert.strictEqual(epoch.number, STATIC_EPOCH_NUMBER);
		assert.strictEqual(epoch.homeIncarnation, 3);
	});

	it('leaves out a peer whose capability was never learned, and one at another level', () => {
		// Never learned fails closed; a level-1 (Ricart–Agrawala) peer would be a second arbiter.
		const { transport } = transportFor();
		const { members } = transport.epoch('data');
		assert.ok(!members.includes('peer-unknown'));
		assert.ok(!members.includes('peer-legacy'));
	});

	it('derives the same ringVersion for the same member set regardless of hdb_nodes order', () => {
		const a = transportFor().transport.epoch('data');
		const b = transportFor({
			nodes: () => [
				{ name: 'self', replicates: true },
				{ name: 'peer-explicit', replicates: false, subscriptions: [{ database: 'data', subscribe: true }] },
				{ name: 'peer-supported', replicates: true },
			],
		}).transport.epoch('data');
		assert.deepStrictEqual(a.members, b.members);
		assert.strictEqual(a.ringVersion, b.ringVersion);
	});

	it('changes ringVersion when membership changes', () => {
		const a = transportFor().transport.epoch('data');
		const b = transportFor({ nodes: () => [{ name: 'self', replicates: true }] }).transport.epoch('data');
		assert.notStrictEqual(a.ringVersion, b.ringVersion);
	});

	it('withholds the epoch during the restart hold, then serves it', () => {
		let since = 0;
		const { transport } = transportFor({ sinceStartMs: () => since });
		// A previous incarnation may still have delegations admitting; a static epoch cannot invalidate
		// them by advancing, so it must not name this node as a home until they could have expired.
		assert.strictEqual(transport.epoch('data'), undefined);
		since = RESTART_HOLD_MS - 1;
		assert.strictEqual(transport.epoch('data'), undefined);
		since = RESTART_HOLD_MS;
		assert.ok(transport.epoch('data'));
	});

	it('withholds the epoch until the home incarnation has been bumped and propagated', () => {
		let incarnation = 0;
		const { transport } = transportFor({ homeIncarnation: () => incarnation });
		// A token minted under incarnation 0 could sit below the previous process's, so none is minted.
		assert.strictEqual(transport.epoch('data'), undefined);
		incarnation = 1;
		assert.strictEqual(transport.epoch('data').homeIncarnation, 1);
	});

	it('withholds the epoch when this node does not advertise the delegation level', () => {
		// Its peers exclude it from their rings, so it must not build one that includes itself — the
		// first cluster run of this transport had the bag-less node self-homing keys its peer homed.
		const { transport } = transportFor({ advertisesLevel: () => false });
		assert.strictEqual(transport.epoch('data'), undefined);
	});

	it('is a lone-node epoch when the database has no audit store yet', () => {
		const { transport } = transportFor({ auditStore: () => undefined });
		assert.deepStrictEqual(transport.epoch('data').members, ['self']);
	});

	it('reuses a derived epoch within the memo window and re-derives after it', () => {
		let since = RESTART_HOLD_MS + 1;
		const { transport, auditStore } = transportFor({ sinceStartMs: () => since });
		const first = transport.epoch('data');
		const lookups = auditStore.lookups;
		since += EPOCH_MEMO_MS - 1;
		assert.strictEqual(transport.epoch('data'), first, 'the same epoch object inside the window');
		assert.strictEqual(auditStore.lookups, lookups, 'no membership scan inside the window');
		since += EPOCH_MEMO_MS;
		const later = transport.epoch('data');
		assert.notStrictEqual(later, first, 'a fresh derivation after the window');
		assert.deepStrictEqual(later.members, first.members);
	});

	it('resolves each peer buffer once and reuses the view on later acquisitions', () => {
		let since = RESTART_HOLD_MS + 1;
		const { transport, auditStore } = transportFor({ sinceStartMs: () => since });
		const before = auditStore.lookups;
		transport.epoch('data');
		const afterFirst = auditStore.lookups;
		assert.strictEqual(afterFirst - before, 4, 'one lookup per group member');
		// Past the memo window so the membership is genuinely re-read; the buffer views must still hit.
		since += EPOCH_MEMO_MS + 1;
		transport.epoch('data');
		since += EPOCH_MEMO_MS + 1;
		transport.epoch('data');
		assert.strictEqual(auditStore.lookups, afterFirst, 'no lookups on repeat');
	});

	it('answers ownsCoordination from the injected ownership view', () => {
		let owned = false;
		const { transport } = transportFor({ ownsDatabase: () => owned });
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
			epoch: 1,
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
					epoch: 1,
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
	// local node on every path, so a mirror read is 0 forever and the epoch is withheld for the life
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
});

describe('createDisabledRecordLockTransport', () => {
	it('owns coordination so the epoch refusal is what a caller sees, and names the switch', async () => {
		const transport = createDisabledRecordLockTransport();
		assert.strictEqual(transport.ownsCoordination(), true);
		assert.throws(
			() => transport.epoch('data'),
			(error) => error.message === RECORD_LOCKS_DISABLED_MESSAGE
		);
		await assert.rejects(
			() =>
				transport.requestDelegation('peer', 'data', 'Counter', {
					key: 'k',
					requester: 'self',
					epoch: 1,
					leaseMs: 1000,
				}),
			(error) => error.message === RECORD_LOCKS_DISABLED_MESSAGE
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
		const owner = fakeWorker(21);
		const other = fakeWorker(22);
		assert.strictEqual(recordLockOwnerFor('owner-c', [owner, other]), owner);
		assert.strictEqual(recordLockOwnerFor('owner-c', [other, owner]), owner);
		assert.strictEqual(other.posted.length, 0);
		releaseRecordLockOwner('owner-c');
	});

	it('moves a database off a worker that has left the live set, telling the old owner and the new one', () => {
		const dead = fakeWorker(31);
		const live = fakeWorker(32);
		assert.strictEqual(recordLockOwnerFor('owner-d', [dead]), dead);
		const moved = recordLockOwnerFor('owner-d', [live]);
		assert.strictEqual(moved, live);
		assert.deepStrictEqual(dead.posted.at(-1), { type: 'record-lock-owner', database: 'owner-d', owned: false });
		assert.deepStrictEqual(live.posted.at(-1), { type: 'record-lock-owner', database: 'owner-d', owned: true });
		releaseRecordLockOwner('owner-d');
	});

	it('forgets an owner that exits, so a database nothing else drives can be re-assigned', () => {
		const first = fakeWorker(41);
		assert.strictEqual(recordLockOwnerFor('owner-e', [first]), first);
		// No other http worker is registered with manageThreads in this process, so the exit hand-over
		// has nowhere to go; what it must do is drop the dead owner rather than keep reporting it.
		first.exit();
		assert.strictEqual(recordLockOwnerThreadIds()['owner-e'], undefined);
		releaseRecordLockOwner('owner-e');
	});

	it('tolerates a previous owner whose port is already closed', () => {
		const gone = fakeWorker(51);
		gone.postMessage = () => {
			throw new Error('port closed');
		};
		const live = fakeWorker(52);
		assert.strictEqual(recordLockOwnerFor('owner-f', [gone]), gone);
		assert.strictEqual(recordLockOwnerFor('owner-f', [live]), live);
		releaseRecordLockOwner('owner-f');
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
