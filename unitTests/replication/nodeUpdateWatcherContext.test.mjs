import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { server } from '#src/core/server/Server';
import { contextStorage } from '#src/core/resources/transaction';
import { _liveSubscriptionCount } from '#src/core/server/liveSubscriptionAuth';
import {
	getHDBNodeTable,
	runNodeUpdateWatcher,
	stopNodeUpdateWatcher,
	subscribeToNodeUpdates,
} from '#src/replication/knownNodes';

const WATCHER = 'node-update-watcher-context-test';
const SCANNED_PEER = 'watcher-context-scanned';
const LIVE_PEER = 'watcher-context-live';

async function waitFor(condition, description, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}`);
		await delay(10);
	}
}
const requestContext = () => ({
	user: { username: 'hdb-nodes-watcher-context-user', role: { permission: { super_user: false } } },
});

function endingIterable() {
	return {
		[Symbol.asyncIterator]() {
			let delivered = false;
			return {
				async next() {
					if (delivered) return { value: undefined, done: true };
					delivered = true;
					return { value: { type: 'put', id: 'peer', value: null }, done: false };
				},
				async return() {
					return { value: undefined, done: true };
				},
			};
		},
	};
}

describe('hdb_nodes watcher started from a request runs outside it (harper-pro#1455)', function () {
	this.timeout(30_000);
	let priorNodes;
	let priorShards;
	beforeEach(() => {
		priorNodes = server.nodes;
		priorShards = server.shards;
	});
	afterEach(() => {
		stopNodeUpdateWatcher(WATCHER);
		server.nodes = priorNodes;
		server.shards = priorShards;
	});

	it('subscribes, resubscribes and processes events with no request context', async () => {
		const stores = [];
		await contextStorage.run(requestContext(), () =>
			runNodeUpdateWatcher(() => {}, {
				key: WATCHER,
				maxRestarts: 2,
				restartDelayMs: 1,
				subscribe: () => {
					stores.push(['subscribe', contextStorage.getStore()]);
					return endingIterable();
				},
				processEvent: () => {
					stores.push(['event', contextStorage.getStore()]);
				},
			})
		);
		assert.deepEqual(stores, [
			['subscribe', undefined],
			['event', undefined],
			['subscribe', undefined],
			['event', undefined],
		]);
	});

	it("does not register the real hdb_nodes subscription under the request's user", async () => {
		const Nodes = getHDBNodeTable();
		const peer = (name) => ({ name, url: `wss://${name}:9933`, replicates: true });
		try {
			await Nodes.put(SCANNED_PEER, peer(SCANNED_PEER));
			const calls = [];
			const before = _liveSubscriptionCount();
			contextStorage.run(requestContext(), () =>
				subscribeToNodeUpdates((node, id) => calls.push({ id, store: contextStorage.getStore() }), WATCHER)
			);
			await delay(100);
			await Nodes.put(LIVE_PEER, peer(LIVE_PEER));
			await waitFor(() => calls.some((call) => call.id === LIVE_PEER), 'the live put to reach the listener');
			assert.equal(_liveSubscriptionCount(), before, 'no live re-authorization entry for an internal watcher');
			for (const id of [SCANNED_PEER, LIVE_PEER]) {
				const call = calls.find((candidate) => candidate.id === id);
				assert.ok(call, `${id} reached the listener`);
				assert.equal(call.store, undefined, `${id} reached the listener outside the request`);
			}
		} finally {
			await Nodes.delete(SCANNED_PEER);
			await Nodes.delete(LIVE_PEER);
		}
	});
});
