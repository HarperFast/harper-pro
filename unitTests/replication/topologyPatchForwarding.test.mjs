import assert from 'node:assert';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { server } from '#src/core/server/Server';
import { getHDBNodeTable, processNodeUpdateEvent } from '#src/replication/knownNodes';

describe('hdb_nodes patch events (harper-pro#1291)', function () {
	this.timeout(10_000);
	const peer = 'topology-patch-peer';
	let priorNodes;
	before(() => setHdbBasePath(process.env.STORAGE_PATH));
	beforeEach(async () => {
		priorNodes = server.nodes;
		await getHDBNodeTable().put(peer, { name: peer, url: 'wss://topology-patch-peer:9933', replicates: true });
		server.nodes = [{ name: peer, url: 'wss://topology-patch-peer:9933', replicates: true }];
	});
	afterEach(async () => {
		server.nodes = priorNodes;
		await getHDBNodeTable().delete(peer);
	});

	it('forwards a patch that changes a region label with the merged row', async () => {
		await getHDBNodeTable().patch(peer, { region: 'east' });
		const forwarded = [];
		await processNodeUpdateEvent({ type: 'patch', id: peer, value: { region: 'east' } }, (node) =>
			forwarded.push(node)
		);
		assert.equal(forwarded.length, 1);
		assert.equal(forwarded[0].region, 'east');
		assert.equal(forwarded[0].replicates, true);
		assert.equal(server.nodes.find((node) => node.name === peer)?.region, 'east');
	});

	it('keeps a peer whose row gets an unrelated patch, without forwarding it', async () => {
		await getHDBNodeTable().patch(peer, { start_time: 5 });
		const forwarded = [];
		await processNodeUpdateEvent({ type: 'patch', id: peer, value: { start_time: 5 } }, (node) => forwarded.push(node));
		assert.equal(forwarded.length, 0);
		assert.ok(
			server.nodes.some((node) => node.name === peer),
			'a patched peer stays in server.nodes'
		);
	});
});
