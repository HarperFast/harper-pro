/**
 * `unsubscribeFromNode` is dispatched fire-and-forget from every one of its call sites
 * (subscriptionManager.ts 502, 771, 1034, 1583): none awaits it and none attaches a handler. It is
 * also what the removal path relies on to retire the departing connection's claim on the
 * (database, peer) shared status. Both properties have to survive a transport close that throws —
 * otherwise the rejection escapes to the process-wide handler with no node identity, and the
 * departing connection keeps its owner marker and goes on stamping DOWN/1008 into the buffer the
 * removal just cleared, which is the state R2 exists to prevent (harper-pro#431).
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
	function subscribe() {
		const id = ++caseId;
		const request = { url: `wss://a-${id}:9933`, nodes: [{ url: `wss://b-${id}:9933`, name: `b-${id}` }] };
		subscribeToNode({ ...request, database: 'data' });
		expect(created).to.have.lengthOf(1);
		const connection = created[0];
		expect(connection.nodeSubscriptions, 'subscribe() must have set the owner marker').to.not.equal(undefined);
		connection.sharedStatus = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
		return { request: { ...request, database: 'data' }, connection };
	}

	// The real unsubscribe() sets intentionallyUnsubscribed and then closes the socket, so this throws
	// from where a close can actually fail, with the connection already marked.
	function failOnClose(connection) {
		connection.socket = {
			close() {
				throw new Error('socket already destroyed');
			},
		};
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
