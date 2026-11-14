import assert from 'node:assert';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import * as env from '#src/core/utility/environment/environmentManager';
import { NodeReplicationConnection } from '#src/replication/replicationConnection';
import { getHDBNodeTable } from '#src/replication/knownNodes';
import { privatePathKey, privatePaths } from '#src/replication/privatePaths';
import { PATH_PRIVATE, PATH_PUBLIC, PATH_PUBLIC_FALLBACK } from '#src/replication/sharedStatusSlots';

async function closedPort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

function waitFor(predicate, what) {
	const deadline = Date.now() + 5000;
	return new Promise((resolve, reject) => {
		const check = () => {
			if (predicate()) resolve();
			else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${what}`));
			else setTimeout(check, 10);
		};
		check();
	});
}

describe('NodeReplicationConnection private dial', () => {
	describe('chooseDial', () => {
		const peer = 'private-dial-peer';
		const row = {
			name: peer,
			url: `wss://${peer}:9933`,
			private_urls: [
				{ url: 'wss://10.0.0.2:9933', network: 'net1' },
				{ url: 'wss://10.1.0.2:9933', network: 'net2' },
			],
		};
		const saved = {};
		// served by the store read chooseDial makes: a real row write leaks into later suites
		before(() => {
			saved.network = env.get('replication_network');
			saved.privateUrls = env.get('replication_privateUrls');
			const store = getHDBNodeTable().primaryStore;
			saved.getSync = store.getSync;
			store.getSync = function (key, ...rest) {
				return key === peer ? row : saved.getSync.call(this, key, ...rest);
			};
		});
		after(() => {
			// setup saves getSync last, and only tests change these
			if (!saved.getSync) return;
			env.setProperty('replication_network', saved.network);
			env.setProperty('replication_privateUrls', saved.privateUrls);
			getHDBNodeTable().primaryStore.getSync = saved.getSync;
		});

		it("dials the peer's private URL on this node's network and keeps the public URL as the key", () => {
			env.setProperty('replication_network', 'net2');
			const connection = new NodeReplicationConnection(`wss://${peer}:9933`, null, 'data', peer);
			assert.deepStrictEqual(connection.chooseDial(), {
				url: 'wss://10.1.0.2:9933',
				path: PATH_PRIVATE,
				privateUrl: 'wss://10.1.0.2:9933',
				pathKey: `${peer} wss://10.1.0.2:9933`,
			});
			assert.strictEqual(connection.url, `wss://${peer}:9933`);
			const options = connection.dialOptions(connection.dial);
			assert.strictEqual(options.servername, peer, "the public dial's SNI");
			assert.strictEqual(options.checkHost, peer, "the public dial's certificate name");
			assert.strictEqual(options.handshakeTimeout, 10_000);
		});

		it('keys and authenticates the private dial by the dialed node on a failover subscription', () => {
			env.setProperty('replication_network', 'net1');
			const connection = new NodeReplicationConnection(`wss://${peer}:9933`, null, 'data', peer);
			// subscribeToNode names the origin served through this peer until the handshake names the peer
			connection.nodeName = 'failover-origin';
			assert.strictEqual(connection.chooseDial().pathKey, `${peer} wss://10.0.0.2:9933`);
			const options = connection.dialOptions(connection.dial);
			assert.strictEqual(options.servername, peer);
			assert.strictEqual(options.checkHost, peer);
			const fallback = { url: `wss://${peer}:9933`, path: PATH_PUBLIC_FALLBACK };
			assert.strictEqual(connection.dialOptions(fallback).serverName, peer, 'the public fallback names the peer too');
			const publicOnly = { url: `wss://${peer}:9933`, path: PATH_PUBLIC };
			assert.strictEqual(
				connection.dialOptions(publicOnly).serverName,
				'failover-origin',
				'unchanged without a private address'
			);
		});

		it('dials the public URL when no network matches, or none is configured', () => {
			env.setProperty('replication_network', 'net3');
			const connection = new NodeReplicationConnection(`wss://${peer}:9933`, null, 'data', peer);
			assert.deepStrictEqual(connection.chooseDial(), { url: `wss://${peer}:9933`, path: PATH_PUBLIC });
			env.setProperty('replication_network', undefined);
			assert.deepStrictEqual(connection.chooseDial(), { url: `wss://${peer}:9933`, path: PATH_PUBLIC });
			assert.deepStrictEqual(connection.dialOptions(connection.dial), { serverName: peer, authorization: undefined });
		});

		it('dials the public URL for a peer with no row', () => {
			env.setProperty('replication_network', 'net1');
			const connection = new NodeReplicationConnection('wss://unknown-peer:9933', null, 'data', 'unknown-peer');
			assert.strictEqual(connection.chooseDial().path, PATH_PUBLIC);
		});
	});

	describe('connect', () => {
		const connections = [];
		const servers = [];
		afterEach(async () => {
			for (const connection of connections.splice(0)) {
				connection.intentionallyUnsubscribed = true;
				privatePaths.forget(connection.dial?.pathKey, connection);
				connection.socket?.terminate();
			}
			for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
		});

		// The real chooseDial only takes wss: private URLs. Each connection gets its own peer name because
		// privatePaths keeps a path's outage after its test ends, and on Linux a later test's server can be
		// handed a port an earlier test already marked down, making it dial the public URL instead.
		let peers = 0;
		function connectionVia(privateUrl, publicUrl) {
			const peer = `fallback-peer-${++peers}`;
			const connection = new NodeReplicationConnection(publicUrl, null, 'data', peer);
			connections.push(connection);
			const pathKey = privatePathKey(privateUrl, peer);
			connection.chooseDial = () => (connection.dial = privatePaths.choose(publicUrl, privateUrl, pathKey, connection));
			const retries = [];
			connection.setReconnectTimer = (callback) => {
				retries.push(callback);
				return { unref() {} };
			};
			return { connection, pathKey, retries };
		}

		async function server(onConnection) {
			const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
			servers.push(wss);
			wss.on('connection', onConnection);
			await new Promise((resolve) => wss.once('listening', resolve));
			return `ws://127.0.0.1:${wss.address().port}`;
		}

		it('a refused private dial marks the path down; the retry dials the public URL', async () => {
			const privateUrl = `ws://127.0.0.1:${await closedPort()}`;
			const publicUrl = `ws://127.0.0.1:${await closedPort()}`;
			const { connection, pathKey, retries } = connectionVia(privateUrl, publicUrl);

			await connection.connect();
			assert.strictEqual(connection.socket.dial.path, PATH_PRIVATE);
			await waitFor(() => retries.length === 1, 'the retry after the refused private dial');
			assert.ok(connection.isWaitingFor(pathKey), 'still waiting on the outage before its retry runs');
			assert.strictEqual(connection.promoteToPrivatePath(pathKey), false, 'not a canary while its retry is pending');
			assert.strictEqual(privatePaths.choose(publicUrl, privateUrl, pathKey, connection).path, PATH_PUBLIC_FALLBACK);

			retries[0]();
			await waitFor(() => connection.socket?.dial?.path === PATH_PUBLIC_FALLBACK, 'the public dial');
			assert.strictEqual(connection.socket.url.replace(/\/$/, ''), publicUrl);
			await waitFor(() => retries.length === 2, 'the retry after the refused public dial');
		});

		// ws refuses a URL with a fragment before any socket exists, as a missing certificate would
		const localFailureUrl = 'ws://127.0.0.1:1/#local-failure';

		it('a local failure creating the socket for a private dial does not start an outage when the public dial needs the same certificate', async () => {
			const publicUrl = `wss://127.0.0.1:${await closedPort()}`;
			const { connection, pathKey, retries } = connectionVia(localFailureUrl, publicUrl);
			await connection.connect();
			await waitFor(() => retries.length === 1, 'the retry after the failed socket creation');
			assert.strictEqual(privatePaths.choose(publicUrl, localFailureUrl, pathKey, connection).path, PATH_PRIVATE);
		});

		it('a local failure creating the socket for a private dial fails over to a public ws: URL, which needs no certificate', async () => {
			const publicUrl = `ws://127.0.0.1:${await closedPort()}`;
			const { connection, pathKey, retries } = connectionVia(localFailureUrl, publicUrl);
			await connection.connect();
			await waitFor(() => retries.length === 1, 'the retry after the failed socket creation');
			assert.strictEqual(
				privatePaths.choose(publicUrl, localFailureUrl, pathKey, connection).path,
				PATH_PUBLIC_FALLBACK
			);
		});

		it('a peer that closes after the WebSocket opens, before identifying, is a private failure', async () => {
			const privateUrl = await server((ws) => ws.close(1008, 'Unauthorized'));
			const publicUrl = `ws://127.0.0.1:${await closedPort()}`;
			const { connection, pathKey, retries } = connectionVia(privateUrl, publicUrl);
			await connection.connect();
			await waitFor(() => retries.length === 1, 'the retry after the 1008 close');
			assert.strictEqual(privatePaths.choose(publicUrl, privateUrl, pathKey, connection).path, PATH_PUBLIC_FALLBACK);
		});

		it('a private socket whose peer never identifies is closed at the deadline and fails over', async () => {
			const privateUrl = await server(() => {});
			const publicUrl = `ws://127.0.0.1:${await closedPort()}`;
			const { connection, pathKey, retries } = connectionVia(privateUrl, publicUrl);
			connection.privateIdentifyTimeoutMs = 200;
			await connection.connect();
			// a socket that never emits close: the deadline must not wait on one
			const { socket } = connection;
			const terminate = socket.terminate;
			socket.terminate = () => {};
			try {
				await waitFor(() => retries.length === 1, 'the retry after the identification deadline');
			} finally {
				socket.terminate = terminate;
				socket.terminate();
			}
			assert.strictEqual(privatePaths.choose(publicUrl, privateUrl, pathKey, connection).path, PATH_PUBLIC_FALLBACK);
		});

		it('a redial for an address change before the peer identifies does not mark the old address down', async () => {
			const privateUrl = await server(() => {});
			const publicUrl = `ws://127.0.0.1:${await closedPort()}`;
			const { connection, pathKey, retries } = connectionVia(privateUrl, publicUrl);
			await connection.connect();
			await waitFor(() => connection.socket?.readyState === 1, 'the private socket to open');
			connection.redialForPathChange();
			assert.strictEqual(retries.length, 1, 'the redial is scheduled');
			assert.strictEqual(privatePaths.choose(publicUrl, privateUrl, pathKey, connection).path, PATH_PRIVATE);
		});

		it('a redial for a path change waits only the reconnect floor, however many failures came before', () => {
			const { connection, retries } = connectionVia('ws://127.0.0.1:1', 'ws://127.0.0.1:2');
			const delays = [];
			connection.setReconnectTimer = (callback, delay) => {
				retries.push(callback);
				delays.push(delay);
				return { unref() {} };
			};
			connection.random = () => 0.99;
			for (let i = 0; i < 8; i++) {
				connection.scheduleReconnect();
				connection.reconnectScheduled = false;
			}
			assert.ok(delays.at(-1) > 20_000, `failures escalate the backoff (${delays.at(-1)} ms)`);
			connection.redialForPathChange();
			assert.ok(delays.at(-1) < 1_000, `the planned redial is not delayed by them (${delays.at(-1)} ms)`);
		});

		it('an unsubscribe during the private dial does not mark the path down', async () => {
			const privateUrl = `ws://127.0.0.1:${await closedPort()}`;
			const publicUrl = `ws://127.0.0.1:${await closedPort()}`;
			const { connection, pathKey } = connectionVia(privateUrl, publicUrl);
			await connection.connect();
			connection.unsubscribe();
			await waitFor(() => connection.isFinished, 'the close');
			assert.strictEqual(privatePaths.choose(publicUrl, privateUrl, pathKey, connection).path, PATH_PRIVATE);
		});

		it('only a private socket whose peer was never identified counts as a private failure', () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			const privateUrl = 'wss://10.4.0.2:9933';
			const pathKey = privatePathKey(privateUrl, 'peer');
			const dial = { url: privateUrl, path: PATH_PRIVATE, privateUrl, pathKey };
			connection.noteUnidentifiedSocketEnded({ dial, peerIdentified: true }, 'closed');
			assert.strictEqual(privatePaths.choose('wss://peer:9933', privateUrl, pathKey, connection).path, PATH_PRIVATE);
			connection.noteUnidentifiedSocketEnded({ dial: { url: 'wss://peer:9933', path: PATH_PUBLIC } }, 'closed');
			assert.strictEqual(privatePaths.choose('wss://peer:9933', privateUrl, pathKey, connection).path, PATH_PRIVATE);
			connection.noteUnidentifiedSocketEnded({ dial }, '1008 after open');
			assert.strictEqual(
				privatePaths.choose('wss://peer:9933', privateUrl, pathKey, connection).path,
				PATH_PUBLIC_FALLBACK
			);
		});

		it('a public fallback socket that ends before its peer identifies resets the outage probe backoff', () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			const privateUrl = 'wss://10.4.0.2:9933';
			const pathKey = privatePathKey(privateUrl, 'peer');
			const dial = { url: 'wss://peer:9933', path: PATH_PUBLIC_FALLBACK, privateUrl, pathKey };
			const reset = [];
			const original = privatePaths.publicDialFailed;
			privatePaths.publicDialFailed = (key) => reset.push(key);
			try {
				connection.noteUnidentifiedSocketEnded({ dial, peerIdentified: true }, 'closed');
				connection.noteUnidentifiedSocketEnded({ dial, privateFailureNoted: true }, 'redialed for a path change');
				connection.noteUnidentifiedSocketEnded({ dial: { url: 'wss://peer:9933', path: PATH_PUBLIC } }, 'closed');
				assert.deepStrictEqual(reset, [], 'an identified, planned or private-free socket says nothing about the peer');
				const socket = { dial };
				connection.noteUnidentifiedSocketEnded(socket, 'ECONNREFUSED');
				connection.noteUnidentifiedSocketEnded(socket, 'closed after the error');
				assert.deepStrictEqual(reset, [pathKey], 'once per socket');
			} finally {
				privatePaths.publicDialFailed = original;
			}
		});

		it('a read waiting on a failed private dial is served by the public redial', async () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			let rejectPrivate;
			const privateAttempt = new Promise((_, reject) => (rejectPrivate = reject));
			connection.onPrivateNetwork = true;
			connection.dial = { url: 'wss://10.7.0.2:9933', path: PATH_PRIVATE, privateUrl: 'wss://10.7.0.2:9933' };
			connection.session = privateAttempt;
			const read = connection.getRecord({ id: 1 });
			connection.sessionsAbandonedForPath.add(privateAttempt);
			connection.session = Promise.resolve({ getRecord: () => 'from the public socket' });
			rejectPrivate(new Error('connect ECONNREFUSED'));
			assert.strictEqual(await read, 'from the public socket');
		});

		it("a read waiting on a session redialed for a peer's new private address is served by the redial", async () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			let rejectCurrent;
			const current = new Promise((_, reject) => (rejectCurrent = reject));
			// the peer has not advertised one yet; this node is on a private network
			connection.onPrivateNetwork = true;
			connection.dial = { url: 'wss://peer:9933', path: PATH_PUBLIC };
			connection.session = current;
			const read = connection.getRecord({ id: 1 });
			connection.forceReconnect = () => {
				connection.session = Promise.resolve({ getRecord: () => 'from the redial' });
			};
			connection.redialForPathChange();
			rejectCurrent(new Error('superseded by forceReconnect'));
			assert.strictEqual(await read, 'from the redial');
		});

		it("a private socket's late close marks its own attempt, not the session that replaced it", () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			const privateUrl = 'wss://10.6.0.2:9933';
			const dial = { url: privateUrl, path: PATH_PRIVATE, privateUrl, pathKey: privatePathKey(privateUrl, 'peer') };
			const privateAttempt = Promise.resolve();
			connection.session = Promise.resolve();
			connection.noteUnidentifiedSocketEnded({ dial, attemptSession: privateAttempt }, 'closed');
			assert.ok(connection.sessionsAbandonedForPath.has(privateAttempt));
		});

		it('a read sent on a private socket that ended before identification is served by the public redial', async () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			let failRead;
			const privateAttempt = Promise.resolve({ getRecord: () => new Promise((_, reject) => (failRead = reject)) });
			connection.onPrivateNetwork = true;
			connection.dial = { url: 'wss://10.7.0.2:9933', path: PATH_PRIVATE, privateUrl: 'wss://10.7.0.2:9933' };
			connection.session = privateAttempt;
			const read = connection.getRecord({ id: 1 });
			await new Promise((resolve) => setImmediate(resolve));
			connection.sessionsAbandonedForPath.add(privateAttempt);
			connection.session = Promise.resolve({ getRecord: () => 'from the public socket' });
			failRead(new Error('closed: Unauthorized'));
			assert.strictEqual(await read, 'from the public socket');
		});

		it('a read in flight on the public fallback when the connection moves back to private is retried there', async () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			const key = privatePathKey('wss://10.8.0.2:9933', 'peer');
			connection.dial = {
				url: 'wss://peer:9933',
				path: PATH_PUBLIC_FALLBACK,
				privateUrl: 'wss://10.8.0.2:9933',
				pathKey: key,
			};
			connection.onPrivateNetwork = true;
			let failRead;
			const publicSession = Promise.resolve({ getRecord: () => new Promise((_, reject) => (failRead = reject)) });
			connection.session = publicSession;
			const read = connection.getRecord({ id: 1 });
			await new Promise((resolve) => setImmediate(resolve));
			connection.forceReconnect = () => {
				connection.session = Promise.resolve({ getRecord: () => 'from the private socket' });
			};
			assert.strictEqual(connection.promoteToPrivatePath(key), true);
			assert.ok(connection.sessionsAbandonedForPath.has(publicSession));
			failRead(new Error('socket retired'));
			assert.strictEqual(await read, 'from the private socket');
		});

		it('a node on no private network keeps the plain read', async () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			let rejectAttempt;
			const attempt = new Promise((_, reject) => (rejectAttempt = reject));
			connection.session = attempt;
			const read = connection.getRecord({ id: 1 });
			connection.sessionsAbandonedForPath.add(attempt);
			connection.session = Promise.resolve({ getRecord: () => 'unexpected' });
			rejectAttempt(new Error('connect ECONNREFUSED'));
			await assert.rejects(read, /ECONNREFUSED/);
		});

		it('a read waiting on a failed public dial still fails', async () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			let rejectAttempt;
			connection.session = new Promise((_, reject) => (rejectAttempt = reject));
			const read = connection.getRecord({ id: 1 });
			connection.session = Promise.resolve({ getRecord: () => 'unexpected' });
			rejectAttempt(new Error('connect ECONNREFUSED'));
			await assert.rejects(read, /ECONNREFUSED/);
		});

		it('promotion redials only a connection that will redial onto that private path', () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			let forced = 0;
			connection.forceReconnect = () => forced++;
			const key = privatePathKey('wss://10.5.0.2:9933', 'peer');
			connection.dial = { url: 'wss://peer:9933', path: PATH_PUBLIC };
			assert.strictEqual(connection.promoteToPrivatePath(key), false);
			connection.dial = {
				url: 'wss://peer:9933',
				path: PATH_PUBLIC_FALLBACK,
				privateUrl: 'wss://10.5.0.3:9933',
				pathKey: privatePathKey('wss://10.5.0.3:9933', 'peer'),
			};
			assert.strictEqual(connection.promoteToPrivatePath(key), false);
			connection.dial = {
				url: 'wss://10.5.0.2:9933',
				path: PATH_PRIVATE,
				privateUrl: 'wss://10.5.0.2:9933',
				pathKey: key,
			};
			assert.ok(connection.isWaitingFor(key));
			assert.strictEqual(connection.promoteToPrivatePath(key), false, 'not on the fallback yet');
			connection.dial = {
				url: 'wss://peer:9933',
				path: PATH_PUBLIC_FALLBACK,
				privateUrl: 'wss://10.5.0.2:9933',
				pathKey: key,
			};
			connection.reconnectScheduled = true;
			assert.strictEqual(connection.promoteToPrivatePath(key), false, 'a pending redial is not a promotion');
			connection.reconnectScheduled = false;
			assert.strictEqual(connection.promoteToPrivatePath(key), true);
			assert.strictEqual(forced, 1);
			connection.intentionallyUnsubscribed = true;
			assert.strictEqual(connection.promoteToPrivatePath(key), false);
		});
	});
});
