import assert from 'node:assert';
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
		// How a clone leader's row looks on every other node: isLeader set, never written local-only.
		await getHDBNodeTable().put(PEER, { name: PEER, url: URL, replicates: true, isLeader: true });
		await ensureNode(PEER, { url: URL, replicates: true });
		assert.equal(await storedLocalOnly(), false);
	});

	it('writes an ordinary row for a clone leader that is a mesh member', async () => {
		await ensureNode(PEER, { url: URL, replicates: true, isLeader: true }, { localOnly: false });
		assert.equal(await storedLocalOnly(), false);
	});

	it('clears the bit on an explicit localOnly: false and on an isLeader: false demotion', async () => {
		await ensureNode(PEER, { url: URL, replicates: true, isLeader: true }, { localOnly: true });
		await ensureNode(PEER, { url: URL, replicates: true, isLeader: true }, { localOnly: false });
		assert.equal(await storedLocalOnly(), false, 're-cloning from a mesh-member leader heals an old row');

		await ensureNode(PEER, { url: URL, replicates: true, isLeader: true }, { localOnly: true });
		await ensureNode(PEER, { url: URL, replicates: true, isLeader: false });
		assert.equal(await storedLocalOnly(), false);
	});
});
