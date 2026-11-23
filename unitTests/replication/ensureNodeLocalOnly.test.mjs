import assert from 'node:assert';
import { getThisNodeName } from '#src/core/server/nodeName';
import { getHDBNodeTable } from '#src/replication/knownNodes';
import { ensureNode, isLocalOnlyEntry } from '#src/replication/subscriptionManager';

const PEER = 'ensure-node-local-only-peer';
const URL = 'wss://ensure-node-local-only-peer.test:9933';

describe('ensureNode local-only rows (harper-pro #246, #1487)', function () {
	this.timeout(20_000);
	const storedLocalOnly = async () =>
		isLocalOnlyEntry(await getHDBNodeTable().primaryStore.getEntry(PEER, { async: true }));
	afterEach(() => getHDBNodeTable().delete(PEER));

	it('keeps a bridge peer local-only across writes that do not say either way', async () => {
		await ensureNode(PEER, { url: URL, replicates: true, isLeader: true }, { localOnly: true });
		assert.equal(await storedLocalOnly(), true);
		await ensureNode(PEER, { url: URL, replicates: true });
		assert.equal(await storedLocalOnly(), true, 'a later plain write must not send the row to the mesh');
		assert.equal(getHDBNodeTable().primaryStore.getSync(PEER).isLeader, true);
	});

	it('does not hide a row that only carries a replicated isLeader', async () => {
		await getHDBNodeTable().put(PEER, { name: PEER, url: URL, replicates: true, isLeader: true });
		await ensureNode(PEER, { url: URL, replicates: true });
		assert.equal(await storedLocalOnly(), false);
	});

	it("does not inherit local-only on this node's own row, but honors an explicit request", async () => {
		const self = getThisNodeName();
		const table = getHDBNodeTable();
		const prior = table.primaryStore.getSync(self);
		const selfLocalOnly = async () => isLocalOnlyEntry(await table.primaryStore.getEntry(self, { async: true }));
		try {
			await ensureNode(self, { recordLockIncarnation: 1 }, { localOnly: true });
			assert.equal(await selfLocalOnly(), true);
			await ensureNode(self, { url: URL, replicates: true });
			assert.equal(await selfLocalOnly(), false);
		} finally {
			if (prior) await table.put(self, prior);
			else await table.delete(self);
		}
	});

	it('releases a row on localOnly: false without changing it, which is how a finished clone publishes its leader', async () => {
		await ensureNode(PEER, { url: URL, replicates: true, isLeader: true }, { localOnly: true });
		await ensureNode(PEER, {}, { localOnly: false });
		assert.equal(await storedLocalOnly(), false);
		const row = getHDBNodeTable().primaryStore.getSync(PEER);
		assert.equal(row.isLeader, true);
		assert.equal(row.url, URL);
	});

	it('clears the bit on an isLeader: false demotion', async () => {
		await ensureNode(PEER, { url: URL, replicates: true, isLeader: true }, { localOnly: true });
		await ensureNode(PEER, { isLeader: false });
		assert.equal(await storedLocalOnly(), false);
	});
});
