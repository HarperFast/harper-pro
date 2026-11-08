/**
 * How a NodeReplicationConnection picks and falls back from a peer's private address (harper-pro#1292).
 * The dials go to closed local ports, so every attempt is refused before the WebSocket opens.
 */

import assert from 'node:assert';
import { createServer } from 'node:net';
import * as env from '#src/core/utility/environment/environmentManager';
import { NodeReplicationConnection } from '#src/replication/replicationConnection';
import { getHDBNodeTable } from '#src/replication/knownNodes';
import { privatePaths } from '#src/replication/privatePaths';
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
		// the row is served by the store read chooseDial makes, so other suites never see it in hdb_nodes
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
			});
			assert.strictEqual(connection.url, `wss://${peer}:9933`);
			const options = connection.dialOptions(connection.dial);
			assert.strictEqual(options.servername, peer, "the public dial's SNI");
			assert.strictEqual(options.checkHost, peer, "the public dial's certificate name");
			assert.strictEqual(options.handshakeTimeout, 10_000);
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
		afterEach(() => {
			for (const connection of connections.splice(0)) {
				connection.intentionallyUnsubscribed = true;
				privatePaths.forget(connection.privatePathWaitingOn, connection);
				connection.socket?.terminate();
			}
		});

		it('a refused private dial marks the address down; the retry dials the public URL', async () => {
			const privateUrl = `ws://127.0.0.1:${await closedPort()}`;
			const publicUrl = `ws://127.0.0.1:${await closedPort()}`;
			const connection = new NodeReplicationConnection(publicUrl, null, 'data', 'fallback-peer');
			connections.push(connection);
			connection.chooseDial = () => (connection.dial = privatePaths.choose(publicUrl, privateUrl, connection));
			const retries = [];
			connection.setReconnectTimer = (callback) => {
				retries.push(callback);
				return { unref() {} };
			};

			await connection.connect();
			assert.strictEqual(connection.socket.dial.path, PATH_PRIVATE);
			await waitFor(() => retries.length === 1, 'the retry after the refused private dial');
			assert.strictEqual(connection.privatePathWaitingOn, privateUrl);
			assert.strictEqual(privatePaths.choose(publicUrl, privateUrl, connection).path, PATH_PUBLIC_FALLBACK);

			retries[0]();
			await waitFor(() => connection.socket?.dial?.path === PATH_PUBLIC_FALLBACK, 'the public dial');
			assert.strictEqual(connection.socket.url.replace(/\/$/, ''), publicUrl);
			await waitFor(() => retries.length === 2, 'the retry after the refused public dial');
			assert.strictEqual(connection.privatePathWaitingOn, privateUrl, 'a public failure is not a private one');
		});

		it('an unsubscribe during the private dial does not mark the address down', async () => {
			const privateUrl = `ws://127.0.0.1:${await closedPort()}`;
			const publicUrl = `ws://127.0.0.1:${await closedPort()}`;
			const connection = new NodeReplicationConnection(publicUrl, null, 'data', 'fallback-peer');
			connections.push(connection);
			connection.chooseDial = () => (connection.dial = privatePaths.choose(publicUrl, privateUrl, connection));
			await connection.connect();
			connection.unsubscribe();
			await waitFor(() => connection.isFinished, 'the close');
			assert.strictEqual(connection.privatePathWaitingOn, undefined);
			assert.strictEqual(privatePaths.choose(publicUrl, privateUrl, connection).path, PATH_PRIVATE);
		});

		it('only a private socket whose peer was never identified counts as a private failure', () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			const privateUrl = 'wss://10.4.0.2:9933';
			const dial = { url: privateUrl, path: PATH_PRIVATE, privateUrl };
			connection.notePrivateSocketEnded({ dial, peerIdentified: true }, 'closed');
			assert.strictEqual(privatePaths.choose('wss://peer:9933', privateUrl, connection).path, PATH_PRIVATE);
			connection.notePrivateSocketEnded({ dial: { url: 'wss://peer:9933', path: PATH_PUBLIC } }, 'closed');
			assert.strictEqual(connection.privatePathWaitingOn, undefined);
			connection.notePrivateSocketEnded({ dial }, '1008 after open');
			assert.strictEqual(privatePaths.choose('wss://peer:9933', privateUrl, connection).path, PATH_PUBLIC_FALLBACK);
		});

		it('promotion redials only a connection on the public fallback of that address', () => {
			const connection = new NodeReplicationConnection('wss://peer:9933', null, 'data', 'peer');
			connections.push(connection);
			let forced = 0;
			connection.forceReconnect = () => forced++;
			connection.dial = { url: 'wss://peer:9933', path: PATH_PUBLIC };
			assert.strictEqual(connection.promoteToPrivatePath('wss://10.5.0.2:9933'), false);
			connection.dial = { url: 'wss://peer:9933', path: PATH_PUBLIC_FALLBACK, privateUrl: 'wss://10.5.0.3:9933' };
			assert.strictEqual(connection.promoteToPrivatePath('wss://10.5.0.2:9933'), false);
			connection.dial.privateUrl = 'wss://10.5.0.2:9933';
			assert.strictEqual(connection.promoteToPrivatePath('wss://10.5.0.2:9933'), true);
			assert.strictEqual(forced, 1);
			connection.intentionallyUnsubscribed = true;
			assert.strictEqual(connection.promoteToPrivatePath('wss://10.5.0.2:9933'), false);
		});
	});
});
