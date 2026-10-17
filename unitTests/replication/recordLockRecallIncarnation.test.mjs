/**
 * The receiving side of a restarted home's recall by incarnation (harper#3254), without a cluster:
 * every refusal happens before any sweep, the recalled home is the authenticated principal only, and
 * concurrent requests from one home share a sweep.
 */
import assert from 'node:assert';
// recordLockTransport first, as every production load order does: it installs recordLockRpc's
// ownership readers at module scope.
import '#src/replication/recordLockTransport';
import { executeRecallIncarnation, setRecordLockOwnershipReaders } from '#src/replication/recordLockRpc';
import { RECORD_LOCKS_CAPABILITY } from '#src/replication/protocolCapabilities';
import {
	registerClusterLockTransport,
	unregisterClusterLockTransport,
} from '#src/core/resources/recordLockCoordinator';
import { server } from '#src/core/server/Server';

const DB = 'recall-incarnation';

function request(fields = {}) {
	return { database: DB, generation: 1, incarnation: 2, deadlineMs: 5_000, hdb_user: { name: 'home' }, ...fields };
}

describe('record_lock_recall_incarnation (harper#3254)', () => {
	let previousNodes;
	let previousReaders;
	let mapReads;
	before(() => {
		previousNodes = server.nodes;
		server.nodes = [{ name: 'home' }, { name: 'departed' }];
	});
	after(() => {
		server.nodes = previousNodes;
		setRecordLockOwnershipReaders(previousReaders);
	});
	beforeEach(() => {
		mapReads = 0;
		const installed = setRecordLockOwnershipReaders({
			ownsDatabase: (database) => database === DB,
			ownerFor: () => undefined,
			mainOwns: () => false,
			isMember: (database, node) => database === DB && node === 'home',
			peerLevel: (database, node) => (node === 'home' ? RECORD_LOCKS_CAPABILITY : 3),
			activeGeneration: (database) => (database === DB ? 1 : undefined),
		});
		previousReaders ??= installed;
		registerClusterLockTransport(DB, {
			homeMap: () => {
				mapReads++;
				return { generation: 1, homes: ['self', 'home'], homeIncarnation: 1 };
			},
			ownsCoordination: () => true,
			requestDelegation: () => Promise.reject(new Error('unused')),
			recallDelegation: () => Promise.reject(new Error('unused')),
			establishLockFreshness: async () => [],
		});
	});
	afterEach(() => unregisterClusterLockTransport(DB, true));

	const refuses = (fields, statusCode, why) =>
		assert.rejects(
			() => executeRecallIncarnation(request(fields)),
			(error) => error.statusCode === statusCode,
			why
		);

	it('answers the exact confirmation the home counts, from its own sweep on the coordinating thread', async () => {
		const answer = await executeRecallIncarnation(request());
		assert.deepStrictEqual(answer, { recalled: true, incarnation: 2, generation: 1 });
		assert.strictEqual(mapReads, 1, 'one sweep');
	});

	it('refuses a caller that is not a node, not a member, or not at the exact level, before any sweep', async () => {
		await refuses({ hdb_user: { name: 'operator' } }, 403, 'a super_user is not a home');
		await refuses({ hdb_user: undefined }, 403, 'an anonymous caller is not a home');
		await refuses({ hdb_user: { name: 'departed' } }, 403, 'a known node outside the ring cannot recall');
		setRecordLockOwnershipReaders({
			ownsDatabase: () => true,
			ownerFor: () => undefined,
			mainOwns: () => false,
			isMember: () => true,
			peerLevel: () => RECORD_LOCKS_CAPABILITY - 1,
		});
		await refuses({}, 403, 'a member at another level is not a participant');
		assert.strictEqual(mapReads, 0, 'no refusal reached the sweep');
	});

	it('refuses malformed generation, incarnation and database before any sweep', async () => {
		for (const bad of [
			{ generation: 0 },
			{ generation: '1' },
			{ generation: 1.5 },
			{ incarnation: 0 },
			{ incarnation: -2 },
			{ incarnation: Number.MAX_SAFE_INTEGER + 2 },
			{ database: 7 },
		])
			await refuses(bad, 400, JSON.stringify(bad));
		assert.strictEqual(mapReads, 0);
	});

	it('fails rather than confirms when this node holds another generation', async () => {
		await refuses({ generation: 2 }, 409, 'the two sides must agree which ring the home issued under');
	});

	it('joins concurrent requests from one home into a single sweep', async () => {
		const answers = await Promise.all([
			executeRecallIncarnation(request()),
			executeRecallIncarnation(request()),
			executeRecallIncarnation(request()),
		]);
		assert.strictEqual(answers.length, 3);
		assert.strictEqual(mapReads, 1, 'three requests, one sweep');
		await executeRecallIncarnation(request());
		assert.strictEqual(mapReads, 2, 'a request after the sweep settled starts a new one');
	});

	it('answers a probe after every check, without sweeping', async () => {
		const answer = await executeRecallIncarnation(request({ probe: true }));
		assert.deepStrictEqual(answer, { probed: true, incarnation: 2, generation: 1 });
		assert.strictEqual(mapReads, 0, 'a probe drains nothing');
		await refuses({ probe: true, hdb_user: { name: 'departed' } }, 403, 'a probe passes the same checks');
		await refuses({ probe: true, generation: 2 }, 409, 'a probe is refused for a generation this node does not hold');
	});

	it('does not let a request for a newer incarnation or generation join an older sweep', async () => {
		const answers = await Promise.all([
			executeRecallIncarnation(request({ incarnation: 2 })),
			executeRecallIncarnation(request({ incarnation: 3 })),
		]);
		assert.deepStrictEqual(
			answers.map((answer) => answer.incarnation),
			[2, 3]
		);
		assert.strictEqual(mapReads, 2, 'each question gets its own sweep');
	});
});
