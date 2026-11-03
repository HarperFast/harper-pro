import assert from 'node:assert';
import { createRequire } from 'node:module';
import { table } from '#src/core/resources/databases';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { getThisNodeName } from '#src/core/server/nodeName';
import { exportIdMappingWithUnnamed, translateIdMap } from '#src/replication/replicationConnection';
import { unnamedOriginName } from '#src/replication/unnamedOrigins';
import { setMainIsWorker } from '#js/core/server/threads/manageThreads';
import '#src/core/server/serverHelpers/serverUtilities';

const { setupTestDBPath } = createRequire(import.meta.url)('../testUtils.js');

describe('unnamed origins in the replication id map', () => {
	let databaseCount = 0;
	const freshAuditStore = () =>
		table({
			table: 'UnnamedOrigins',
			database: `unnamedOriginMapping_${databaseCount++}`,
			attributes: [{ name: 'id', isPrimaryKey: true }],
			audit: true,
		}).auditStore;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	after(() => setMainIsWorker(false));

	it('names each sent origin id this node has no name for, and only those', () => {
		const auditStore = freshAuditStore();
		const peer = getIdOfRemoteNode('peer-a', auditStore);
		const exported = exportIdMappingWithUnnamed(auditStore, [peer, 777, 0]);
		assert.strictEqual(exported['peer-a'], peer);
		assert.strictEqual(exported[unnamedOriginName(getThisNodeName(), 777)], 777);
		assert.deepStrictEqual(
			Object.values(exported).sort((a, b) => a - b),
			[0, peer, 777]
		);
	});

	it('names an unnamed origin even after an earlier version minted its derived name to another id', () => {
		const auditStore = freshAuditStore();
		const name = unnamedOriginName(getThisNodeName(), 777);
		// what a 5.3 node stores when a peer relays the derived name back to it (harper-pro#1246)
		const minted = getIdOfRemoteNode(name, auditStore);
		assert.strictEqual(exportIdMappingWithUnnamed(auditStore, [777])[name], 777);
		// that other id, if it is sent too, keeps a name a receiver can translate
		const both = exportIdMappingWithUnnamed(auditStore, [minted, 777]);
		assert.strictEqual(both[name], 777);
		assert.strictEqual(both[unnamedOriginName(getThisNodeName(), minted)], minted);
	});

	it('maps its own derived name home, until that id is given to a node', () => {
		const auditStore = freshAuditStore();
		const ownName = unnamedOriginName(getThisNodeName(), 50);
		const home = translateIdMap({ [ownName]: 5, 'peer-b': 6 }, auditStore);
		assert.strictEqual(home.get(5), 50);
		assert.strictEqual(home.get(6), getIdOfRemoteNode('peer-b', auditStore));
		for (let i = 0; i < 50; i++) getIdOfRemoteNode(`peer-${i}`, auditStore);
		const taken = translateIdMap({ [ownName]: 5 }, auditStore);
		assert.notStrictEqual(taken.get(5), 50);
		assert.strictEqual(taken.get(5), getIdOfRemoteNode(ownName, auditStore));
	});

	it('does not map home onto an id the same map gives a new peer', () => {
		const auditStore = freshAuditStore();
		const translated = translateIdMap({ [unnamedOriginName(getThisNodeName(), 1)]: 5, 'peer-b': 6 }, auditStore);
		assert.notStrictEqual(translated.get(5), translated.get(6));
	});
});
