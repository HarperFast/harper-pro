/**
 * `unsubscribeFromNode` is dispatched fire-and-forget from every one of its call sites in
 * `subscriptionManager.ts`: none awaits it and none attaches a handler. It is also what the removal
 * path relies on to retire the departing connection's claim on the (database, peer) shared status.
 * Both properties have to survive a transport close that throws — otherwise the rejection escapes to
 * the process-wide handler with no node identity, and the departing connection keeps its owner
 * marker and goes on stamping DOWN/1008 into the buffer the removal just cleared, which is the state
 * R2 exists to prevent (harper-pro#431).
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { subscribeToNode, unsubscribeFromNode } from '#src/replication/replicator';
import { NodeReplicationConnection } from '#src/replication/replicationConnection';
import { REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/knownNodes';

let caseId = 0;

describe('unsubscribeFromNode teardown', () => {
	let created;

	beforeEach(() => {
		created = [];
		// getSubscriptionConnection caches the connection and then calls connect(), so stubbing connect
		// seeds the module's connection cache exactly the way production seeds it, without a socket.
		sinon.stub(NodeReplicationConnection.prototype, 'connect').callsFake(function () {
			created.push(this);
			return Promise.resolve();
		});
	});

	afterEach(() => sinon.restore());

	// The cache is module-scoped, so each case gets its own key rather than inheriting another's teardown.
	// Passing an existing id puts a second database on the same key, which is how the real cache nests them.
	function subscribe(database = 'data', id = ++caseId) {
		const before = created.length;
		const request = { url: `wss://a-${id}:9933`, nodes: [{ url: `wss://b-${id}:9933`, name: `b-${id}` }], database };
		subscribeToNode(request);
		expect(created).to.have.lengthOf(before + 1);
		const connection = created[before];
		expect(connection.nodeSubscriptions, 'subscribe() must have set the owner marker').to.not.equal(undefined);
		connection.sharedStatus = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
		return { id, request, connection };
	}

	// The real unsubscribe() sets intentionallyUnsubscribed and then closes the socket, so this throws from
	// where a close can actually fail, with the connection already marked. The counter is what distinguishes
	// "the cache entry is gone" from "the entry is still there and inert".
	function failOnClose(connection) {
		const closes = { count: 0 };
		connection.socket = {
			close() {
				closes.count++;
				throw new Error('socket already destroyed');
			},
		};
		return closes;
	}

	it('contains a close that throws instead of leaving an unhandled rejection', async () => {
		const { request, connection } = subscribe();
		failOnClose(connection);
		const rejections = [];
		const onUnhandled = (reason) => rejections.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			unsubscribeFromNode({ ...request, clearStatus: true }); // deliberately not awaited — that is the call sites' shape
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
		expect(rejections).to.deep.equal([]);
		expect(connection.intentionallyUnsubscribed).to.equal(true);
	});

	it('retires the owner marker on the removal path even when the close throws', async () => {
		const { request, connection } = subscribe();
		failOnClose(connection);
		await unsubscribeFromNode({ ...request, clearStatus: true });
		expect(connection.nodeSubscriptions).to.equal(undefined);
		expect(connection.sharedStatus).to.equal(undefined);
	});

	it('retires the cache entry even when the close throws, so a repeat cannot reach the socket again', async () => {
		const { request, connection } = subscribe();
		const closes = failOnClose(connection);
		await unsubscribeFromNode({ ...request, clearStatus: true });
		await unsubscribeFromNode({ ...request, clearStatus: true });
		expect(closes.count).to.equal(1);
	});

	it('retires only the database it was given', async () => {
		const first = subscribe('data');
		const second = subscribe('other', first.id);
		failOnClose(first.connection);
		await unsubscribeFromNode({ ...first.request, clearStatus: true });
		expect(first.connection.nodeSubscriptions).to.equal(undefined);
		expect(second.connection.nodeSubscriptions).to.not.equal(undefined);
		// Still cached, so its own unsubscribe still reaches its socket.
		const closes = failOnClose(second.connection);
		await unsubscribeFromNode({ ...second.request, clearStatus: true });
		expect(closes.count).to.equal(1);
	});

	it('keeps the owner marker off the removal path, so that close still records DOWN', async () => {
		const { request, connection } = subscribe();
		await unsubscribeFromNode(request);
		expect(connection.nodeSubscriptions).to.not.equal(undefined);
		expect(connection.sharedStatus).to.not.equal(undefined);
	});

	it('is a no-op for a connection that was never cached', async () => {
		await unsubscribeFromNode({ url: 'wss://absent:9933', nodes: [{ url: 'wss://absent:9933' }], database: 'data' });
	});
});
