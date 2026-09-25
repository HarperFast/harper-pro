/**
 * The origin of a replicated operation settles every peer's result — with the answer, an error, the
 * connection closing, or a deadline — and reports at warn when it is not an answer. The socket and the
 * replication session are fakes, so each case drives exactly the event under test.
 */
import { expect } from 'chai';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { replicateOperation, sendOperationToNode } from '#src/replication/replicator';
import { server } from '#src/core/server/Server';

const require = createRequire(import.meta.url);
const replicationConnection = require('#src/replication/replicationConnection');
const logger = require('#js/core/utility/logging/harper_logger');

const PEER = { name: 'peer-a', url: 'wss://peer-a.example.com:9933' };

class FakeSocket extends EventEmitter {
	closeCalls = 0;
	close() {
		this.closeCalls++;
	}
}

/** `sendOperationToNode` registers its listeners after connecting, so wait for them before opening. */
async function open(socket) {
	while (!socket.listenerCount('open')) await new Promise((resolve) => setImmediate(resolve));
	socket.emit('open');
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
}

const unanswered = () => new Promise(() => {});

// Not the default sandbox: restoring that one replays other files' stale fakes, such as a spy on a fake
// setTimeout, and leaves a dead clock installed for every file after this one.
const sandbox = sinon.createSandbox();

// Mocha runs these without a timeout; a guard that regresses must fail here, not hang the run.
const CASE_TIMEOUT_MS = 5_000;

describe('sendOperationToNode', function () {
	this.timeout(CASE_TIMEOUT_MS);
	let socket;
	let session;

	beforeEach(() => {
		socket = new FakeSocket();
		session = { sendOperation: sandbox.stub() };
		sandbox.stub(replicationConnection, 'createWebSocket').resolves(socket);
		sandbox.stub(replicationConnection, 'replicateOverWS').returns(session);
	});

	afterEach(() => {
		sandbox.restore();
	});

	it("resolves with the peer's answer and closes the connection", async () => {
		session.sendOperation.resolves({ message: 'Successfully deployed: app' });
		const answer = sendOperationToNode(PEER, { operation: 'deploy_component', project: 'app' });
		await open(socket);
		expect(await answer).to.deep.equal({ message: 'Successfully deployed: app' });
		expect(socket.closeCalls).to.equal(1);
	});

	it('rejects when the connection closes before the peer answers', async () => {
		session.sendOperation.returns(unanswered());
		const answer = sendOperationToNode(PEER, { operation: 'deploy_component', project: 'app' });
		await open(socket);
		socket.emit('close', 1006, Buffer.alloc(0));
		const error = await rejection(answer);
		expect(error.message).to.match(/closed \(1006\) before deploy_component was answered/);
	});

	it('keeps an answer read in the same turn as the connection closing', async () => {
		let deliver;
		session.sendOperation.returns(new Promise((resolve) => (deliver = resolve)));
		const answer = sendOperationToNode(PEER, { operation: 'deploy_component', project: 'app' });
		await open(socket);
		deliver({ message: 'Successfully deployed: app' });
		socket.emit('close', 1000, Buffer.alloc(0));
		expect(await answer).to.deep.equal({ message: 'Successfully deployed: app' });
	});

	it('rejects when the connection closes before it opens', async () => {
		const answer = sendOperationToNode(PEER, { operation: 'deploy_component', project: 'app' });
		while (!socket.listenerCount('close')) await new Promise((resolve) => setImmediate(resolve));
		socket.emit('close', 1006, Buffer.alloc(0));
		const error = await rejection(answer);
		expect(error.message).to.match(/closed \(1006\) before deploy_component was answered/);
		expect(session.sendOperation.called).to.equal(false);
	});

	it('rejects when the peer does not answer within timeoutMs, and closes the connection', async () => {
		session.sendOperation.returns(unanswered());
		const answer = sendOperationToNode(PEER, { operation: 'deploy_component', project: 'app' }, { timeoutMs: 20 });
		await open(socket);
		const error = await rejection(answer);
		expect(error.message).to.match(/deploy_component to wss:\/\/peer-a\.example\.com:9933 did not answer within 20ms/);
		expect(socket.closeCalls).to.equal(1);
	});

	// Node fires a timer at once when its delay exceeds 2^31-1ms.
	it('holds a deadline beyond the timer range instead of firing it at once', async () => {
		let deliver;
		session.sendOperation.returns(new Promise((resolve) => (deliver = resolve)));
		const answer = sendOperationToNode(PEER, { operation: 'deploy_component', project: 'app' }, { timeoutMs: 2 ** 40 });
		await open(socket);
		await new Promise((resolve) => setTimeout(resolve, 20));
		deliver({ message: 'Successfully deployed: app' });
		expect(await answer).to.deep.equal({ message: 'Successfully deployed: app' });
	});

	it("never forwards the sender's hdb_user, and leaves the caller's operation untouched", async () => {
		session.sendOperation.resolves({});
		const operation = {
			operation: 'deploy_component',
			project: 'app',
			hdb_user: { username: 'admin', refresh_token: 'a-30-day-credential' },
		};
		const answer = sendOperationToNode(PEER, operation);
		await open(socket);
		await answer;
		const sent = session.sendOperation.firstCall.args[0];
		expect(sent).to.not.have.property('hdb_user');
		expect(sent).to.include({ operation: 'deploy_component', project: 'app' });
		expect(operation.hdb_user.username).to.equal('admin');
		expect(operation).to.not.have.property('requestId');
	});
});

describe('replicateOperation', function () {
	this.timeout(CASE_TIMEOUT_MS);
	let sockets;
	let session;
	let priorNodes;

	beforeEach(() => {
		sockets = [];
		session = { sendOperation: sandbox.stub() };
		sandbox.stub(replicationConnection, 'createWebSocket').callsFake(async () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		});
		sandbox.stub(replicationConnection, 'replicateOverWS').returns(session);
		sandbox.stub(logger, 'warn');
		priorNodes = server.nodes;
		server.nodes = [PEER];
	});

	afterEach(() => {
		server.nodes = priorNodes;
		sandbox.restore();
	});

	async function openAll() {
		while (sockets.length < server.nodes.length) await new Promise((resolve) => setImmediate(resolve));
		await Promise.all(sockets.map(open));
	}

	it('bounds each peer by timeoutMs and reports the peer that did not answer at warn', async () => {
		session.sendOperation.returns(unanswered());
		const onPeerResult = sandbox.stub();
		const response = replicateOperation(
			{ operation: 'deploy_component', project: 'app' },
			{ onPeerResult, timeoutMs: 20 }
		);
		await openAll();
		const { replicated } = await response;
		expect(replicated).to.have.length(1);
		expect(replicated[0]).to.include({ status: 'failed', node: 'peer-a' });
		expect(replicated[0].reason).to.match(/did not answer within 20ms/);
		expect(onPeerResult.calledOnceWith(replicated[0])).to.equal(true);
		expect(replicationConnection.createWebSocket.firstCall.args[1].timeoutMs).to.equal(20);
		expect(logger.warn.calledOnce).to.equal(true);
		const warning = logger.warn.firstCall.args.join(' ');
		expect(warning)
			.to.include('deploy_component')
			.and.to.include('peer-a')
			.and.to.match(/did not answer within 20ms/);
	});

	it('reports a peer whose connection closed before it answered at warn', async () => {
		session.sendOperation.returns(unanswered());
		const response = replicateOperation({ operation: 'deploy_component', project: 'app' });
		await openAll();
		sockets[0].emit('close', 1006, Buffer.alloc(0));
		const { replicated } = await response;
		expect(replicated[0]).to.include({ status: 'failed', node: 'peer-a' });
		expect(replicated[0].reason).to.match(/closed \(1006\) before deploy_component was answered/);
		expect(logger.warn.calledOnce).to.equal(true);
		expect(logger.warn.firstCall.args.join(' ')).to.include('peer-a');
	});

	it('sends no deadline when the caller gives none, and logs nothing for an answer', async () => {
		session.sendOperation.resolves({ message: 'done' });
		const response = replicateOperation({ operation: 'drop_component', project: 'app' });
		await openAll();
		const { replicated } = await response;
		expect(replicated[0]).to.include({ message: 'done', node: 'peer-a' });
		expect(replicationConnection.createWebSocket.firstCall.args[1]).to.not.have.property('timeoutMs');
		expect(logger.warn.called).to.equal(false);
	});
});
