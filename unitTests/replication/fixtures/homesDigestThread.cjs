'use strict';
/**
 * One thread's side of a node's record-lock home map: its own cache and transport, over the per-(database,
 * peer) shared status buffer every thread of the process shares. Loaded the same way on the test thread and
 * in a worker, so the two run identical code against one buffer.
 */
const path = require('node:path');
const dist = path.join(__dirname, '../../../dist');
const { table } = require(path.join(dist, 'core/resources/databases.js'));
const transport = require(path.join(dist, 'replication/recordLockTransport.js'));
const { getReplicationSharedStatus } = require(path.join(dist, 'replication/knownNodes.js'));

function homesDigestThread(database, homes) {
	const Item = table({ database, table: 'Item', attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }] });
	let active;
	const previousReader = transport.setRecordLockHomesRowReader((key) =>
		key === database ? Promise.resolve(active ? { active } : undefined) : previousReader(key)
	);
	let cached;
	const lockTransport = transport.createRecordLockTransport(
		database,
		{
			thisNodeName: () => homes[0],
			auditStore: () => Item.auditStore,
			ownsDatabase: () => true,
			homeIncarnation: () => 1,
			send: async () => ({}),
			isFirstIncarnation: () => false,
			monotonicNow: () => 0,
		},
		() => {
			const generation = transport.cachedActiveGeneration(database);
			if (generation === undefined) return undefined;
			if (cached?.generation !== generation)
				cached = { generation, homes, digest: transport.currentHomesDigest(database) };
			return cached;
		}
	);
	return {
		async activate(generation, digest) {
			active = { generation, homes, digest };
			await transport.refreshRecordLockHomesCache(database, true);
		},
		peerSupportsLocks(peer) {
			transport.recordPeerLockCapability(getReplicationSharedStatus(Item.auditStore, database, peer), true);
		},
		receive(peer, digest) {
			transport.recordPeerHomesDigest(database, peer, digest);
		},
		homeMapGeneration() {
			return lockTransport.homeMap(database)?.generation;
		},
		dispose() {
			transport.setRecordLockHomesRowReader(previousReader);
			transport.forgetRecordLockHomesCache(database);
		},
	};
}

module.exports = { homesDigestThread };
