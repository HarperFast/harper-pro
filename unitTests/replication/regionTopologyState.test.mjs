import assert from 'node:assert';
import * as env from '#src/core/utility/environment/environmentManager';
import { server } from '#src/core/server/Server';
import { getThisNodeName } from '#src/core/server/nodeName';
import {
	currentRegionTopology,
	getHDBNodeTable,
	getReplicationRecipients,
	regionTopologyFor,
	selfTopologyLabels,
} from '#src/replication/knownNodes';

const peers = [
	{ name: 'state-a2', region: 'east', replicates: true },
	{ name: 'state-a3', region: 'east', replicates: true },
	{ name: 'state-b1', region: 'west', replicates: true },
	{ name: 'state-b2', region: 'west', replicates: true },
	{ name: 'state-b3', region: 'west', replicates: true },
];

describe('region topology state (harper-pro#1291)', function () {
	this.timeout(10_000);
	let priorNodes;
	let priorRegion;
	let priorGateway;
	let rows;
	let table;
	let search;
	let getSync;
	// Rows written to the real table would fire node events whose cluster state outlives them and stalls later
	// suites' copies (residencyControls), so the table's two reads are stubbed instead.
	before(() => {
		table = getHDBNodeTable();
		search = table.search;
		getSync = table.primaryStore.getSync;
		table.search = () => rows;
		table.primaryStore.getSync = function (key, ...rest) {
			if (key === getThisNodeName()) return { name: key, replicates: true };
			return rows.find((row) => row.name === key) ?? getSync.call(this, key, ...rest);
		};
	});
	after(() => {
		table.search = search;
		table.primaryStore.getSync = getSync;
	});
	const putRows = async (added) => {
		rows.push(...added);
	};
	afterEach(() => {
		rows = [];
	});
	beforeEach(() => {
		rows = [];
		priorNodes = server.nodes;
		priorRegion = env.get('replication_region');
		priorGateway = env.get('replication_gateway');
		env.setProperty('replication_region', 'east');
		env.setProperty('replication_gateway', true);
	});
	afterEach(() => {
		server.nodes = priorNodes;
		env.setProperty('replication_region', priorRegion);
		env.setProperty('replication_gateway', priorGateway);
	});

	it('publishes the configured labels', () => {
		assert.deepEqual(selfTopologyLabels(), { region: 'east', gateway: true });
		env.setProperty('replication_region', '  ');
		env.setProperty('replication_gateway', 'yes');
		assert.deepEqual(selfTopologyLabels(), { region: null, gateway: null });
	});

	it('reads members from hdb_nodes, and recomputes when server.nodes grows in place as a full rescan grows it', async () => {
		await putRows([peers[0]]);
		server.nodes = [peers[0]];
		assert.equal(currentRegionTopology().active, false);
		await putRows(peers.slice(1));
		server.nodes.push(...peers.slice(1));
		const topology = currentRegionTopology();
		assert.equal(topology.active, true);
		assert.deepEqual(topology.gatewaysByRegion.get('west'), ['state-b1', 'state-b2']);
	});

	it('counts as acknowledging recipients only the peers whose links reach this node', async () => {
		await putRows(peers);
		server.nodes = [...peers];
		assert.deepEqual(
			getReplicationRecipients('data').map((node) => node.name),
			['state-a2', 'state-a3', 'state-b1', 'state-b2']
		);
		env.setProperty('replication_gateway', false);
		await putRows([{ name: 'state-a1', region: 'east', replicates: true }]);
		server.nodes = [...peers, { name: 'state-a1', region: 'east', replicates: true }];
		assert.deepEqual(
			getReplicationRecipients('data').map((node) => node.name),
			['state-a2', 'state-a3', 'state-a1']
		);
	});

	it('keeps the full mesh while a member has no region', async () => {
		await putRows([...peers, { name: 'state-old', replicates: true }]);
		server.nodes = [...peers, { name: 'state-old', replicates: true }];
		assert.equal(regionTopologyFor('data'), undefined);
		assert.equal(getReplicationRecipients('data').length, peers.length + 1);
	});
});
