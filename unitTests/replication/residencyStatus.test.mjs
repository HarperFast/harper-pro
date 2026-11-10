import assert from 'node:assert';
import { server } from '#src/core/server/Server';
import * as env from '#src/core/utility/environment/environmentManager';
import { createResidencyMap } from '#src/core/resources/residencyPolicy';
import { installResidencyMap, recordResidencyDeclaration } from '#src/core/resources/residencyMaps';
import { residencyStatus } from '#src/replication/residencyTopology';
import { clusterStatus } from '#src/replication/clusterStatus';
import { getHDBNodeTable } from '#src/replication/knownNodes';

const range = (start, end, shard) => ({ start, end, shard });
const json = (value) => JSON.parse(JSON.stringify(value));

describe('cluster_status shard summary', function () {
	this.timeout(10_000);
	let restore;
	let sequence = 0;
	beforeEach(() => {
		const priorNodes = server.nodes;
		const priorShards = server.shards;
		const priorList = env.get('replication_shards');
		const priorShard = env.get('replication_shard');
		restore = () => {
			server.nodes = priorNodes;
			server.shards = priorShards;
			env.setProperty('replication_shards', priorList);
			env.setProperty('replication_shard', priorShard);
		};
		server.nodes = [];
		server.shards = new Map();
		env.setProperty('replication_shards', [0, 1]);
		env.setProperty('replication_shard', 0);
	});
	afterEach(() => {
		restore?.();
		restore = undefined;
	});

	async function declare(ranges, slots = 10) {
		const database = `status_summary_${sequence++}`;
		recordResidencyDeclaration(database);
		if (ranges) await installResidencyMap(createResidencyMap(database, slots, ranges, 1));
		return database;
	}

	it("sums slots across a shard's ranges and lists its owners, ordered by numeric shard", async () => {
		const database = await declare([range(0, 2, 10), range(2, 5, 2), range(5, 7, 10), range(7, 10, 2)]);
		server.nodes = [{ name: 'peer-b' }, { name: 'peer-a' }];
		server.shards = new Map([
			[10, [{ name: server.hostname }, { name: 'peer-b' }]],
			[2, [{ name: 'peer-a' }]],
		]);
		const entry = residencyStatus()[database];
		assert.deepEqual(entry.shards, [
			{ shard: 2, slots: 6, owners: ['peer-a'] },
			{ shard: 10, slots: 4, owners: ['peer-b', server.hostname].sort() },
		]);
		assert.equal(
			entry.shards.reduce((total, { slots }) => total + slots, 0),
			10,
			'every slot is counted once'
		);
		assert.deepEqual(entry.nodesOwningNoSlots, []);
	});

	it('reports shard 0 and sorts and de-duplicates owner names, whether members are names or records', async () => {
		const database = await declare([range(0, 5, 0), range(5, 10, 1)]);
		server.nodes = [{ name: 'peer-z' }, { name: 'peer-a' }, { name: 'peer-m' }];
		server.shards = new Map([
			[0, ['peer-z', { name: 'peer-a' }, { name: 'peer-z' }]],
			[1, [{ name: 'peer-m' }, { name: server.hostname }]],
		]);
		const entry = residencyStatus()[database];
		assert.deepEqual(entry.shards, [
			{ shard: 0, slots: 5, owners: ['peer-a', 'peer-z'] },
			{ shard: 1, slots: 5, owners: ['peer-m', server.hostname].sort() },
		]);
	});

	it('names members that own no slot: no shard, a shard the map lacks, and this node itself', async () => {
		const database = await declare([range(0, 10, 0)]);
		server.nodes = [
			{ name: 'peer-owner', shard: 0 },
			{ name: 'peer-unsharded' },
			{ name: 'peer-other-shard', shard: 7 },
		];
		server.shards = new Map([
			[0, [{ name: 'peer-owner' }]],
			[7, [{ name: 'peer-other-shard' }]],
		]);
		const entry = residencyStatus()[database];
		assert.deepEqual(entry.shards, [{ shard: 0, slots: 10, owners: ['peer-owner'] }]);
		assert.deepEqual(entry.nodesOwningNoSlots, [server.hostname, 'peer-other-shard', 'peer-unsharded'].sort());
	});

	it('does not call a peer slotless while the membership is still publishing its shard', async () => {
		const database = await declare([range(0, 10, 0)]);
		server.nodes = [
			{ name: 'peer-joining', shard: 0 },
			{ name: 'peer-owner', shard: 0 },
		];
		server.shards = new Map([[0, [{ name: 'peer-owner' }, { name: server.hostname }]]]);
		const entry = residencyStatus()[database];
		assert.deepEqual(entry.shards, [{ shard: 0, slots: 10, owners: ['peer-owner', server.hostname].sort() }]);
		assert.deepEqual(
			entry.nodesOwningNoSlots,
			[],
			'the joining peer is missing from owners, not listed as owning nothing'
		);
	});

	it('keeps a mapped shard that has no member node, with no owners', async () => {
		const database = await declare([range(0, 4, 0), range(4, 10, 1)]);
		server.nodes = [{ name: 'peer-a' }];
		server.shards = new Map([[0, [{ name: 'peer-a' }]]]);
		const entry = json(residencyStatus()[database]);
		assert.deepEqual(entry.shards, [
			{ shard: 0, slots: 4, owners: ['peer-a'] },
			{ shard: 1, slots: 6, owners: [] },
		]);
		assert.deepEqual(entry.nodesOwningNoSlots, [server.hostname]);
	});

	it('omits both fields when no map is installed, without reading owners from node configuration', async () => {
		const database = await declare(undefined);
		server.nodes = [{ name: 'peer-a', shard: 0 }];
		server.shards = new Map([[0, [{ name: 'peer-a' }, { name: server.hostname }]]]);
		const entry = residencyStatus()[database];
		assert.ok(entry.errors.includes('no shard map is installed'));
		const serialized = json(entry);
		assert.ok(!('shards' in serialized), 'shards is absent');
		assert.ok(!('nodesOwningNoSlots' in serialized), 'nodesOwningNoSlots is absent');
	});

	it('stays inspectable beside a configuration error', async () => {
		const database = await declare([range(0, 10, 0)]);
		env.setProperty('replication_shards', [1, 2]);
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		const entry = residencyStatus()[database];
		assert.ok(entry.errors.includes('replication.shard is not in replication.shards'));
		assert.deepEqual(entry.shards, [{ shard: 0, slots: 10, owners: [server.hostname] }]);
	});

	it('follows the membership on each call and leaves it untouched', async () => {
		const database = await declare([range(0, 10, 0)]);
		const owners = [{ name: 'peer-b' }, { name: 'peer-a' }];
		server.nodes = [...owners];
		server.shards = new Map([[0, owners]]);
		assert.deepEqual(residencyStatus()[database].shards[0].owners, ['peer-a', 'peer-b']);
		assert.deepEqual(owners, [{ name: 'peer-b' }, { name: 'peer-a' }], 'the membership list is not sorted in place');
		server.nodes = [{ name: 'peer-a' }];
		server.shards = new Map([[0, [{ name: 'peer-a' }]]]);
		const entry = residencyStatus()[database];
		assert.deepEqual(entry.shards[0].owners, ['peer-a']);
		assert.deepEqual(entry.nodesOwningNoSlots, [server.hostname]);
	});

	it('does not copy the node records into the report', async () => {
		const database = await declare([range(0, 10, 0)]);
		server.nodes = [{ name: 'peer-a', url: 'wss://peer-a:9933', ca: 'PRIVATE', shard: 0 }];
		server.shards = new Map([[0, server.nodes]]);
		assert.doesNotMatch(JSON.stringify(residencyStatus()[database]), /wss:|PRIVATE/);
	});

	describe("write admission's self-membership check", () => {
		const MISMATCH = 'local shard membership disagrees with replication.shard';
		it('stays clear while this node is listed under exactly its configured shard', async () => {
			const database = await declare([range(0, 5, 0), range(5, 10, 1)]);
			server.nodes = [{ name: 'peer-a', shard: 1 }];
			server.shards = new Map([
				[0, [{ name: server.hostname }]],
				[1, [{ name: 'peer-a' }]],
			]);
			const entry = residencyStatus()[database];
			assert.ok(!entry.errors.includes(MISMATCH), JSON.stringify(entry.errors));
		});

		it('holds when this node is listed under another shard than replication.shard', async () => {
			const database = await declare([range(0, 5, 0), range(5, 10, 1)]);
			server.nodes = [{ name: 'peer-a', shard: 0 }];
			server.shards = new Map([
				[0, [{ name: 'peer-a' }]],
				[1, [{ name: server.hostname }]],
			]);
			const entry = residencyStatus()[database];
			assert.ok(entry.errors.includes(MISMATCH), JSON.stringify(entry.errors));
			assert.equal(entry.blocked, true);
			assert.equal(entry.state, 'held');
		});

		it('holds when its configured shard is mapped but lists no owner', async () => {
			const database = await declare([range(0, 5, 0), range(5, 10, 1)]);
			server.nodes = [{ name: 'peer-a', shard: 1 }];
			server.shards = new Map([[1, [{ name: 'peer-a' }]]]);
			assert.ok(residencyStatus()[database].errors.includes(MISMATCH));
		});

		it('holds when it is listed under its configured shard and another one too', async () => {
			const database = await declare([range(0, 5, 0), range(5, 10, 1)]);
			server.shards = new Map([
				[0, [server.hostname]],
				[1, [{ name: server.hostname }]],
			]);
			assert.ok(residencyStatus()[database].errors.includes(MISMATCH));
		});

		it('stays clear when its configured shard is not in the map and it is listed under none', async () => {
			const database = await declare([range(0, 10, 1)]);
			env.setProperty('replication_shards', [0, 1, 2]);
			env.setProperty('replication_shard', 2);
			server.nodes = [{ name: 'peer-a', shard: 1 }];
			server.shards = new Map([
				[1, [{ name: 'peer-a' }]],
				[2, [{ name: server.hostname }]],
			]);
			assert.ok(!residencyStatus()[database].errors.includes(MISMATCH));
		});

		it('checks shard 0 like any other shard', async () => {
			const database = await declare([range(0, 5, 0), range(5, 10, 1)]);
			env.setProperty('replication_shard', 1);
			server.shards = new Map([
				[0, [{ name: server.hostname }]],
				[1, [{ name: 'peer-a' }]],
			]);
			assert.ok(residencyStatus()[database].errors.includes(MISMATCH));
		});
	});

	it('reports a node in shard 0 as the top-level shard of cluster_status', async () => {
		const Nodes = getHDBNodeTable();
		const name = server.hostname;
		const prior = Nodes.primaryStore.getSync(name);
		try {
			for (const shard of [0, 3]) {
				await Nodes.put(name, { ...prior, name, shard });
				assert.equal((await clusterStatus()).shard, shard);
			}
			await Nodes.put(name, { ...prior, name, shard: undefined });
			assert.ok(!('shard' in (await clusterStatus())), 'a node with no shard reports none');
		} finally {
			if (prior) await Nodes.put(name, prior);
			else await Nodes.delete(name);
		}
	});
});
