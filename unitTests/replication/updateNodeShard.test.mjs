import assert from 'node:assert';
import * as env from '#src/core/utility/environment/environmentManager';
import { getThisNodeName } from '#src/core/server/nodeName';
import { getHDBNodeTable } from '#src/replication/knownNodes';
import { setNode, updateNode } from '#src/replication/setNode';

const SELF_URL = 'wss://update-node-self.test:9933';
const PEER = 'update-node-peer';
const PEER_URL = 'wss://update-node-peer.test:9933';

describe('update_node shard and metadata', function () {
	this.timeout(20_000);
	let priorSelf;
	let priorShard;
	beforeEach(async () => {
		const Nodes = getHDBNodeTable();
		priorSelf = Nodes.primaryStore.getSync(getThisNodeName());
		priorShard = env.get('replication_shard');
		env.setProperty('replication_shard', 0);
		await Nodes.put(getThisNodeName(), { name: getThisNodeName(), url: SELF_URL, shard: 0, replicates: true });
		await Nodes.put(PEER, { name: PEER, url: PEER_URL, shard: 0, replicates: true, ca: 'PEER-CA' });
	});
	afterEach(async () => {
		const Nodes = getHDBNodeTable();
		await Nodes.delete(PEER);
		if (priorSelf) await Nodes.put(getThisNodeName(), priorSelf);
		else await Nodes.delete(getThisNodeName());
		env.setProperty('replication_shard', priorShard);
	});

	it("refuses to move this node's own row off replication.shard, by name or by an alias of its url", async () => {
		for (const request of [
			{ operation: 'update_node', hostname: getThisNodeName(), shard: 1 },
			{ operation: 'update_node', hostname: 'an-alias', url: SELF_URL, shard: 1 },
			{ operation: 'update_node', hostname: getThisNodeName(), shard: 1, start_time: Date.now() },
		]) {
			await assert.rejects(updateNode(request), (error) => {
				assert.equal(error.statusCode, 400);
				assert.match(error.message, /follows replication\.shard \(0\)/);
				return true;
			});
		}
		assert.equal(getHDBNodeTable().primaryStore.getSync(getThisNodeName()).shard, 0, 'the row is unchanged');
	});

	it("accepts this node's own configured shard", async () => {
		await updateNode({ operation: 'update_node', hostname: getThisNodeName(), shard: 0, revoked_certificates: ['aa'] });
		const row = getHDBNodeTable().primaryStore.getSync(getThisNodeName());
		assert.equal(row.shard, 0);
		assert.deepEqual(row.revoked_certificates, ['aa']);
	});

	it("patches a peer's shard and revocations locally, without contacting it", async () => {
		const message = await updateNode({
			operation: 'update_node',
			hostname: PEER,
			shard: 1,
			revoked_certificates: ['dead01'],
		});
		assert.equal(message, `Successfully updated '${PEER_URL}'`);
		const row = getHDBNodeTable().primaryStore.getSync(PEER);
		assert.equal(row.shard, 1, 'the requested shard is stored, not one a handshake reported');
		assert.deepEqual(row.revoked_certificates, ['dead01']);
		assert.equal(row.ca, 'PEER-CA', 'the stored CA survives');
		assert.equal(row.url, PEER_URL);
	});

	it('stores a numeric-string shard as a number, and compares it with replication.shard as one', async () => {
		await updateNode({ operation: 'update_node', hostname: PEER, shard: '1' });
		assert.strictEqual(getHDBNodeTable().primaryStore.getSync(PEER).shard, 1);
		await updateNode({ operation: 'update_node', hostname: getThisNodeName(), shard: '0' });
		await assert.rejects(updateNode({ operation: 'update_node', hostname: PEER, shard: 'one' }), /shard/);
	});

	it('runs the add_node exchange for a request with no metadata to patch', async () => {
		await assert.rejects(
			updateNode({ operation: 'update_node', hostname: PEER }),
			/replication url is missing/,
			'not a local no-op reported as success'
		);
	});

	it("refuses set_node and add_node that would move this node's own row off replication.shard", async () => {
		for (const operation of ['set_node', 'add_node']) {
			await assert.rejects(setNode({ operation, hostname: getThisNodeName(), shard: 1 }), (error) => {
				assert.equal(error.statusCode, 400);
				assert.match(error.message, new RegExp(`${operation} cannot set this node's shard`));
				return true;
			});
		}
		await assert.rejects(
			setNode({ operation: 'set_node', hostname: getThisNodeName(), shard: '0' }),
			(error) => !/cannot set this node's shard/.test(error.message),
			'a numeric-string shard equal to replication.shard passes the guard'
		);
	});
});
