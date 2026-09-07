/**
 * The two decisions core delegates to harper-pro, checked without a cluster: who is in a database's
 * lock participant set (omission is the two-holder case), and which single thread coordinates it.
 */
import assert from 'node:assert';
import { setMainIsWorker } from '#js/core/server/threads/manageThreads';
import {
	LOCK_CAPABILITY_SUPPORTED,
	LOCK_CAPABILITY_UNKNOWN,
	LOCK_CAPABILITY_UNSUPPORTED,
	RECORD_LOCKS_CAPABILITY_POSITION,
	RECORD_LOCKS_DISABLED_MESSAGE,
	collectRecordLockStatus,
	createDisabledRecordLockTransport,
	createRecordLockTransport,
	isReplicationGroupMember,
	ownsRecordLockCoordination,
	readPeerLockCapability,
	recordLockOwnerFor,
	recordLockOwnerThreadIds,
	recordPeerLockCapability,
	releaseRecordLockOwner,
} from '#src/replication/recordLockTransport';
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
	const dbs = ['data', { name: 'sharded', sharded: true }];
	it('admits a full or directional replicator for a replicated database, regardless of direction', () => {
		assert.strictEqual(isReplicationGroupMember({ name: 'a', replicates: true }, 'data', dbs, undefined), true);
		assert.strictEqual(
			isReplicationGroupMember({ name: 'a', replicates: { sends: true } }, 'data', dbs, undefined),
			true,
			'a node that only sends to us can still run a round'
		);
		assert.strictEqual(
			isReplicationGroupMember({ name: 'a', replicates: { receivesFrom: [{ target: 'x' }] } }, 'data', dbs, undefined),
			true,
			'a node that only receives from us can still run a round'
		);
	});

	it('rejects a node that replicates nothing, a removed row, and a database this node does not replicate', () => {
		assert.strictEqual(isReplicationGroupMember({ name: 'a', replicates: false }, 'data', dbs, undefined), false);
		assert.strictEqual(isReplicationGroupMember({ name: 'a' }, 'data', dbs, undefined), false);
		assert.strictEqual(isReplicationGroupMember({ name: 'a', replicates: {} }, 'data', dbs, undefined), false);
		assert.strictEqual(isReplicationGroupMember(undefined, 'data', dbs, undefined), false);
		assert.strictEqual(isReplicationGroupMember({ name: 'a', replicates: true }, 'other', dbs, undefined), false);
	});

	it('applies the shard test only to a sharded database entry', () => {
		assert.strictEqual(isReplicationGroupMember({ name: 'a', replicates: true, shard: 1 }, 'sharded', dbs, 1), true);
		assert.strictEqual(isReplicationGroupMember({ name: 'a', replicates: true, shard: 2 }, 'sharded', dbs, 1), false);
		assert.strictEqual(isReplicationGroupMember({ name: 'a', replicates: true, shard: 2 }, 'data', dbs, 1), true);
	});

	it('admits an explicit subscription even when the node does not replicate by default, across shards', () => {
		const node = { name: 'a', replicates: false, shard: 2, subscriptions: [{ database: 'sharded', subscribe: true }] };
		assert.strictEqual(isReplicationGroupMember(node, 'sharded', dbs, 1), true);
		assert.strictEqual(isReplicationGroupMember(node, 'data', dbs, 1), false);
	});
});

describe('the capability slot', () => {
	it('round-trips both answers and reads anything else as never learned', () => {
		const status = new Float64Array(16);
		assert.strictEqual(readPeerLockCapability(status), LOCK_CAPABILITY_UNKNOWN);
		recordPeerLockCapability(status, true);
		assert.strictEqual(readPeerLockCapability(status), LOCK_CAPABILITY_SUPPORTED);
		recordPeerLockCapability(status, false);
		assert.strictEqual(readPeerLockCapability(status), LOCK_CAPABILITY_UNSUPPORTED);
		status[RECORD_LOCKS_CAPABILITY_POSITION] = 7;
		assert.strictEqual(readPeerLockCapability(status), LOCK_CAPABILITY_UNKNOWN);
		status[RECORD_LOCKS_CAPABILITY_POSITION] = NaN;
		assert.strictEqual(readPeerLockCapability(status), LOCK_CAPABILITY_UNKNOWN);
	});

	it('uses a slot outside the ones the connection truth and blob signals occupy', () => {
		assert.ok(RECORD_LOCKS_CAPABILITY_POSITION >= 13 && RECORD_LOCKS_CAPABILITY_POSITION <= 15);
	});
});

describe('createRecordLockTransport().participants', () => {
	function transportFor(overrides = {}) {
		const auditStore = fakeAuditStore();
		const deps = {
			thisNodeName: () => 'self',
			nodes: () => [
				{ name: 'peer-supported', replicates: true },
				{ name: 'peer-legacy', replicates: { sends: true } },
				{ name: 'peer-unknown', replicates: true },
				// Blanket replication off, but subscribed to this database explicitly: still a contender.
				{ name: 'peer-explicit', replicates: false, subscriptions: [{ database: 'data', subscribe: true }] },
				{ name: 'bystander', replicates: false },
				{ name: 'self', replicates: true },
				{ replicates: true },
			],
			replicationDatabases: () => ['data'],
			shard: () => undefined,
			auditStore: () => auditStore,
			downSince: (status) => (status[9] === 0 && status[12] ? status[12] : undefined),
			ownsDatabase: () => true,
			...overrides,
		};
		recordPeerLockCapability(getReplicationSharedStatus(auditStore, 'data', 'peer-supported'), true);
		recordPeerLockCapability(getReplicationSharedStatus(auditStore, 'data', 'peer-legacy'), false);
		recordPeerLockCapability(getReplicationSharedStatus(auditStore, 'data', 'peer-explicit'), true);
		return { transport: createRecordLockTransport('data', deps), auditStore };
	}

	it('lists this node first and every group member with the capability its own bag asserted', () => {
		const { transport } = transportFor();
		assert.deepStrictEqual(
			transport.participants('data').map(({ nodeId, capable }) => [nodeId, capable]),
			[
				['self', true],
				['peer-supported', true],
				['peer-legacy', false],
				['peer-unknown', false],
				['peer-explicit', true],
			]
		);
	});

	it('reports a never-learned capability as not capable, so an unknown peer fails closed', () => {
		const { transport } = transportFor();
		const unknown = transport.participants('data').find((participant) => participant.nodeId === 'peer-unknown');
		assert.strictEqual(unknown.capable, false);
	});

	it('carries the W1 down timestamp but never asserts a cluster-agreed DOWN', () => {
		const { transport, auditStore } = transportFor();
		const status = getReplicationSharedStatus(auditStore, 'data', 'peer-supported');
		status[9] = 0; // CONNECTION_STATE_DOWN
		status[12] = 1234; // LAST_ERROR_TIME
		const peer = transport.participants('data').find((participant) => participant.nodeId === 'peer-supported');
		assert.strictEqual(peer.downSince, 1234);
		assert.strictEqual(peer.agreedDown, undefined);
	});

	it('resolves each peer buffer once and reuses the view on later acquisitions', () => {
		const { transport, auditStore } = transportFor();
		const before = auditStore.lookups;
		transport.participants('data');
		const afterFirst = auditStore.lookups;
		assert.strictEqual(afterFirst - before, 4, 'one lookup per group member');
		transport.participants('data');
		transport.participants('data');
		assert.strictEqual(auditStore.lookups, afterFirst, 'no lookups on repeat');
	});

	it('leaves every peer not capable when the database has no audit store yet', () => {
		const { transport } = transportFor({ auditStore: () => undefined });
		const peers = transport.participants('data').filter((participant) => participant.nodeId !== 'self');
		assert.strictEqual(peers.length, 4);
		assert.ok(peers.every((participant) => participant.capable === false));
	});

	it('answers ownsCoordination from the injected ownership view', () => {
		let owned = false;
		const { transport } = transportFor({ ownsDatabase: () => owned });
		assert.strictEqual(transport.ownsCoordination(), false);
		owned = true;
		assert.strictEqual(transport.ownsCoordination(), true);
	});
});

describe('createDisabledRecordLockTransport', () => {
	it('owns coordination so the participant refusal is what a caller sees, and names the switch', () => {
		const transport = createDisabledRecordLockTransport();
		assert.strictEqual(transport.ownsCoordination(), true);
		assert.throws(
			() => transport.participants('data'),
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
