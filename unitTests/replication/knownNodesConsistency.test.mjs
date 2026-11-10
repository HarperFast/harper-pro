import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { server } from '#src/core/server/Server';
import { getThisNodeName } from '#src/core/server/nodeName';
import { getHDBNodeTable, runNodeUpdateWatcher, stopNodeUpdateWatcher } from '#src/replication/knownNodes';
import { ensureNode } from '#src/replication/subscriptionManager';

const WATCHER = 'known-nodes-consistency-test';

async function waitFor(condition, description, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}`);
		await delay(10);
	}
}

function freshScan() {
	const self = getThisNodeName();
	const peers = [];
	const shards = new Map();
	for (const { key, value } of getHDBNodeTable().primaryStore.getRange({})) {
		if (!value) continue;
		if (key !== self) peers.push(key);
		if (value.shard != undefined) shards.set(value.shard, [...(shards.get(value.shard) ?? []), key].sort());
	}
	return { peers: peers.sort(), shards };
}

function assertMatchesFreshScan(step) {
	const expected = freshScan();
	assert.deepEqual(
		server.nodes.map((node) => node.name).sort(),
		expected.peers,
		`${step}: server.nodes equals the scanned peers`
	);
	const shards = new Map(
		[...server.shards].map(([shard, members]) => [shard, members.map((node) => node.name).sort()])
	);
	assert.deepEqual(shards, expected.shards, `${step}: server.shards equals the scanned shard owners`);
}

function asyncIterable(events) {
	return {
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				async next() {
					return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true };
				},
				async return() {
					return { value: undefined, done: true };
				},
			};
		},
	};
}

describe('hdb_nodes membership follows a fresh scan after every event', function () {
	this.timeout(30_000);
	const names = ['consistency-a', 'consistency-b', 'consistency-c'];
	let priorNodes;
	let priorShards;
	beforeEach(async () => {
		priorNodes = server.nodes;
		priorShards = server.shards;
		for (const name of names) await getHDBNodeTable().delete(name);
	});
	afterEach(async () => {
		stopNodeUpdateWatcher(WATCHER);
		for (const name of names) await getHDBNodeTable().delete(name);
		server.nodes = priorNodes;
		server.shards = priorShards;
	});

	it('keeps a patched peer with its new values, and matches the scan across put, patch and delete', async () => {
		const Nodes = getHDBNodeTable();
		const calls = [];
		const seen = (id, predicate = () => true) => calls.some((call) => call.id === id && predicate(call.node));
		runNodeUpdateWatcher((node, id) => calls.push({ node, id }), { key: WATCHER });
		await delay(100);

		await Nodes.put('consistency-a', {
			name: 'consistency-a',
			url: 'wss://consistency-a:9933',
			shard: 0,
			replicates: true,
		});
		await Nodes.put('consistency-b', {
			name: 'consistency-b',
			url: 'wss://consistency-b:9933',
			shard: 1,
			replicates: true,
		});
		await waitFor(() => seen('consistency-a') && seen('consistency-b'), 'both peers to reach the listener');
		assertMatchesFreshScan('after two puts');

		calls.length = 0;
		await ensureNode('consistency-a', { shard: 1, revoked_certificates: ['dead01'] });
		await waitFor(() => seen('consistency-a', (node) => node?.shard === 1), 'the patched peer to reach the listener');
		const patched = server.nodes.find((node) => node.name === 'consistency-a');
		assert.equal(patched?.shard, 1, 'the patched peer stays in server.nodes with its new shard');
		assert.deepEqual(patched.revoked_certificates, ['dead01']);
		assert.equal(patched.url, 'wss://consistency-a:9933', 'unpatched fields survive');
		assert.ok(
			calls.every((call) => call.node?.url === 'wss://consistency-a:9933' && call.node.replicates === true),
			'the listener gets the full record with its routing fields unchanged, never a removal'
		);
		assertMatchesFreshScan('after a patch');

		calls.length = 0;
		await Nodes.delete('consistency-b');
		await waitFor(() => seen('consistency-b', (node) => node == null), 'the removal to reach the listener');
		assertMatchesFreshScan('after a delete');
	});

	it('derives the row from storage whatever the event carries', async () => {
		const Nodes = getHDBNodeTable();
		await Nodes.put('consistency-a', {
			name: 'consistency-a',
			url: 'wss://consistency-a:9933',
			shard: 1,
			replicates: true,
		});
		await Nodes.put('consistency-b', {
			name: 'consistency-b',
			url: 'wss://consistency-b:9933',
			shard: 0,
			replicates: true,
		});
		await Nodes.put('consistency-c', { name: 'consistency-c', url: 'wss://consistency-c:9933', replicates: true });
		const calls = [];
		const listener = (node, id) => calls.push({ node, id });
		await runNodeUpdateWatcher(listener, {
			key: WATCHER,
			maxRestarts: 1,
			subscribe: async () => asyncIterable([{ type: 'put', id: 'consistency-c', value: null }]),
		});
		assert.ok(
			calls.some((call) => call.id === 'consistency-c' && call.node?.url === 'wss://consistency-c:9933'),
			'a put with no decodable value takes the stored record'
		);

		await Nodes.delete('consistency-b');
		calls.length = 0;
		await runNodeUpdateWatcher(listener, {
			key: WATCHER,
			maxRestarts: 1,
			subscribe: async () =>
				asyncIterable([
					{ type: 'patch', id: 'consistency-a', value: { shard: 1 } },
					{ type: 'delete', id: 'consistency-c', value: null, version: 1 },
				]),
		});
		const peerA = calls.find((call) => call.id === 'consistency-a')?.node;
		assert.equal(peerA?.url, 'wss://consistency-a:9933', 'a patch event delivers the full stored record');
		assert.equal(server.nodes.find((node) => node.name === 'consistency-a')?.shard, 1, 'the patched peer is kept');
		assert.ok(
			calls.some((call) => call.id === 'consistency-b' && call.node == null),
			'a row that left the scan without its own delete event reaches the listener as a removal'
		);
		assert.ok(
			calls.some((call) => call.id === 'consistency-c' && call.node == null) &&
				!server.nodes.some((node) => node.name === 'consistency-c'),
			'a delete event removes its row even when the scan still shows it'
		);

		calls.length = 0;
		await Nodes.delete('consistency-a');
		await runNodeUpdateWatcher(listener, {
			key: WATCHER,
			maxRestarts: 1,
			subscribe: async () => asyncIterable([{ type: 'put', id: 'consistency-a', value: null }]),
		});
		assert.ok(
			!server.nodes.some((node) => node.name === 'consistency-a'),
			'a valueless put for a deleted row does not revive it'
		);
		assert.ok(!calls.some((call) => call.id === 'consistency-a' && call.node != null));
		assertMatchesFreshScan('after a valueless put for a deleted row');
	});

	it('a queued put older than the committed delete does not revive the peer', async () => {
		const Nodes = getHDBNodeTable();
		const record = { name: 'consistency-a', url: 'wss://consistency-a:9933', shard: 0, replicates: true };
		await Nodes.put('consistency-a', record);
		const [{ version: putVersion }] = Array.from(
			Nodes.primaryStore.getRange({ start: 'consistency-a', end: 'consistency-a\uffff', versions: true })
		);
		await Nodes.delete('consistency-a');
		const calls = [];
		await runNodeUpdateWatcher((node, id) => calls.push({ node, id }), {
			key: WATCHER,
			maxRestarts: 1,
			subscribe: async () => asyncIterable([{ type: 'put', id: 'consistency-a', value: record, version: putVersion }]),
		});
		assert.ok(!server.nodes.some((node) => node.name === 'consistency-a'));
		assert.ok(!calls.some((call) => call.id === 'consistency-a' && call.node != null));
		assertMatchesFreshScan('after a stale put');
	});

	it('tells a listener that threw of the rows it missed on the next event', async () => {
		const Nodes = getHDBNodeTable();
		await Nodes.put('consistency-a', { name: 'consistency-a', url: 'wss://consistency-a:9933', replicates: true });
		await Nodes.put('consistency-b', { name: 'consistency-b', url: 'wss://consistency-b:9933', replicates: true });
		const told = [];
		let failOnce = true;
		const listener = (node, id) => {
			if (id === 'consistency-a' && failOnce) {
				failOnce = false;
				throw new Error('listener failure');
			}
			told.push(id);
		};
		await runNodeUpdateWatcher(listener, {
			key: WATCHER,
			maxRestarts: 1,
			subscribe: async () =>
				asyncIterable([
					{ type: 'put', id: 'consistency-b', value: null },
					{ type: 'put', id: 'consistency-b', value: null },
				]),
		});
		assert.ok(told.includes('consistency-a'), 'the row the listener threw on is delivered again');
		assert.ok(told.includes('consistency-b'));

		told.length = 0;
		failOnce = true;
		await runNodeUpdateWatcher(listener, {
			key: WATCHER,
			maxRestarts: 1,
			subscribe: async () =>
				asyncIterable([
					{ type: 'put', id: 'consistency-a', value: null },
					{ type: 'put', id: 'consistency-b', value: null },
				]),
		});
		assert.ok(told.includes('consistency-a'), 'an update to a known row that threw is delivered again');

		told.length = 0;
		const alwaysThrowsOnA = (node, id) => {
			if (id === 'consistency-a') throw new Error('listener failure');
			told.push(id);
		};
		await runNodeUpdateWatcher(alwaysThrowsOnA, {
			key: WATCHER,
			maxRestarts: 1,
			subscribe: async () => asyncIterable([{ type: 'put', id: 'consistency-b', value: null }]),
		});
		assert.ok(told.includes('consistency-b'), 'a row that always throws does not hold up the rows after it');
	});

	it('takes the stored row over a queued event for the same version', async () => {
		const Nodes = getHDBNodeTable();
		await Nodes.put('consistency-a', {
			name: 'consistency-a',
			url: 'wss://consistency-a:9933',
			shard: 0,
			replicates: true,
		});
		const [{ version }] = Array.from(
			Nodes.primaryStore.getRange({ start: 'consistency-a', end: 'consistency-a\uffff', versions: true })
		);
		const run = (events) =>
			runNodeUpdateWatcher(() => {}, { key: WATCHER, maxRestarts: 1, subscribe: async () => asyncIterable(events) });
		const shardOfA = () => server.nodes.find((node) => node.name === 'consistency-a')?.shard;

		await run([{ type: 'put', id: 'consistency-a', value: { name: 'consistency-a', shard: 9 }, version }]);
		assert.equal(shardOfA(), 0, 'at an equal version the stored record wins');
	});
});
