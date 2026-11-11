import assert from 'node:assert';
import * as env from '#src/core/utility/environment/environmentManager';
import { redialOnPrivateUrlChange } from '#src/replication/replicator';

describe('redialOnPrivateUrlChange', () => {
	const peer = 'redial-peer';
	const A = 'wss://10.0.0.2:9933';
	const B = 'wss://10.0.0.3:9933';
	const row = (url) => ({ name: peer, private_urls: [{ url, network: 'net1' }] });
	let savedNetwork;
	before(() => {
		savedNetwork = env.get('replication_network');
		env.setProperty('replication_network', 'net1');
	});
	after(() => env.setProperty('replication_network', savedNetwork));

	function connectionOn(privateUrl) {
		return {
			dial: { privateUrl },
			redials: 0,
			redialForPathChange() {
				this.redials++;
			},
		};
	}
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	it('redials a connection that is not on the advertised address', async () => {
		const connection = connectionOn(A);
		redialOnPrivateUrlChange(row(B), peer, [connection]);
		await settle();
		assert.strictEqual(connection.redials, 1);
	});

	it('does not redial a connection already on it', async () => {
		const connection = connectionOn(A);
		redialOnPrivateUrlChange(row(A), peer, [connection]);
		await settle();
		assert.strictEqual(connection.redials, 0);
	});

	it('does not redial for an advertisement a later update took back before the queued redial ran', async () => {
		const connection = connectionOn(A);
		redialOnPrivateUrlChange(row(B), peer, [connection]);
		redialOnPrivateUrlChange(row(A), peer, [connection]);
		await settle();
		assert.strictEqual(connection.redials, 0);
	});
});
