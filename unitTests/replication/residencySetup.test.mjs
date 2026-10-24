import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { encode } from 'msgpackr';
import { setHdbBasePath, get, setProperty } from '#src/core/utility/environment/environmentManager';
import { createResidencyMap } from '#src/core/resources/residencyPolicy';
import {
	readResidencyMap,
	installResidencyMap,
	getResidencyMapTable,
	requireConnectedResidencyOwner,
} from '#src/core/resources/residencyMaps';
import { replicateOverWS } from '#src/replication/replicationConnection';
import { server } from '#src/core/server/Server';
import { getReplicationSharedStatus, getHDBNodeTable } from '#src/replication/knownNodes';
import { table } from '#src/core/resources/databases';
import { transaction } from '#src/core/resources/transaction';
import {
	CONNECTION_STATE_POSITION,
	CONNECTION_STATE_CONNECTED,
	LAST_LIVENESS_TIME_POSITION,
} from '#src/replication/sharedStatusSlots';
import { residencyTopologyErrors, recordResidencyMapAgreement } from '#src/replication/residencyTopology';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';

class Socket extends EventEmitter {
	readyState = 1;
	closes = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send() {}
	close(code, reason) {
		this.closes.push({ code, reason });
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.emit('close', code, Buffer.from(reason ?? ''));
	}
	terminate() {
		this.close(1006);
	}
	ping() {}
	pause() {}
	resume() {}
}
const sockets = [];
const turns = async () => {
	for (let n = 0; n < 30; n++) await new Promise(setImmediate);
};
async function connect(database, authorization, options = {}) {
	const socket = new Socket();
	sockets.push(socket);
	replicateOverWS(socket, options, authorization);
	socket.emit(
		'message',
		encode([140, 'slot-setup-peer', database, [], buildLocalCapabilities(90_000, false, true), null])
	);
	await turns();
	assert.deepEqual(socket.closes, [], 'handshake succeeds before the tested frame');
	return socket;
}
async function sendMap(socket, frameDatabase, snapshot) {
	socket.emit('message', encode([145, [], frameDatabase, undefined, [], { snapshot, shardsDigest: null }]));
	for (let n = 0; n < 200 && !socket.closes.length && !readResidencyMap(snapshot.database); n++)
		await new Promise((resolve) => setTimeout(resolve, 5));
}
const snapshot = (database) => createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 0 }], 1);

describe('residency setup authority', function () {
	this.timeout(10_000);
	before(() => setHdbBasePath(process.env.STORAGE_PATH));
	afterEach(() => {
		while (sockets.length) sockets.pop().close(1000);
	});
	for (const [name, authorization, options] of [
		['credential', { username: 'reader', role: { permission: {} } }, {}],
		['false_grant', { name: 'slot-setup-peer', replicates: false }, {}],
		[
			'false_route',
			{ name: 'slot-setup-peer', replicates: true },
			{ routes: [{ hostname: 'slot-setup-peer', replicates: false }] },
		],
		[
			'send_only_route',
			{ name: 'slot-setup-peer', replicates: true },
			{ routes: [{ hostname: 'slot-setup-peer', replicates: { sends: true } }] },
		],
	]) {
		it(`refuses a map from ${name}`, async () => {
			const database = `slot_setup_${name}`;
			const socket = await connect(database, authorization, options);
			await sendMap(socket, database, snapshot(database));
			assert.ok(socket.closes.length, 'unauthorized frame closes the stream');
			assert.equal(readResidencyMap(database), undefined);
		});
		for (const command of [145, 132])
			it(`does not accept a missing-policy blocker from ${name} (command ${command})`, async () => {
				const database = `slot_setup_missing_unauthorized_${name}_${command}`;
				await installResidencyMap(snapshot(database));
				const policy = { slots: 2, byAttribute: false };
				const Records = table({
					database,
					table: 'Rows',
					audit: true,
					residency: policy,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'tag', indexed: true },
					],
				});
				const priorNodes = server.nodes;
				server.nodes = [{ name: 'slot-setup-peer' }];
				try {
					const socket = await connect(database, authorization, options);
					const definition = { table: 'Rows', attributes: Records.attributes, schemaDefined: true };
					const encoder = Records.primaryStore.encoder;
					socket.emit(
						'message',
						encode(
							command === 145
								? [145, [definition], database]
								: [
										132,
										{ ...definition, structures: encoder.structures, typedStructs: encoder.typedStructs },
										Records.tableId,
										'Rows',
									]
						)
					);
					await turns();
					assert.deepEqual(residencyTopologyErrors(database), []);
					assert.deepEqual(Records.residency, policy);
				} finally {
					server.nodes = priorNodes;
				}
			});
	}

	it('binds the snapshot to its database frame', async () => {
		const socket = await connect('slot_setup_frame', { replicates: true });
		await sendMap(socket, 'slot_setup_frame', snapshot('slot_setup_other'));
		assert.ok(socket.closes.length);
		assert.equal(readResidencyMap('slot_setup_other'), undefined);
	});
	it('does not clear a refused map agreement with a snapshot-free retry', async () => {
		const database = 'slot_setup_missing_retry';
		const expected = snapshot(database);
		await installResidencyMap(expected);
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-setup-peer' }];
		try {
			const first = await connect(database, { replicates: true });
			await sendMap(first, database, createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], 1));
			await turns();
			assert.ok(first.closes.length);
			assert.ok(
				residencyTopologyErrors(database).some((error) => error.includes('map agreement')),
				'map failure must remain blocked'
			);
			const retry = await connect(database, { replicates: true });
			retry.emit('message', encode([145, [], database, undefined, [], { shardsDigest: null }]));
			await turns();
			assert.ok(
				residencyTopologyErrors(database).some((error) => error.includes('map agreement')),
				'map failure must remain blocked'
			);
			assert.ok(retry.closes.length, 'an incomplete snapshot cannot establish agreement');
			assert.equal(readResidencyMap(database).digest, expected.digest);
		} finally {
			server.nodes = priorNodes;
		}
	});
	it('ignores shard-list claims from a credential without replication authority', async () => {
		const database = 'slot_setup_untrusted_digest';
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-setup-peer' }];
		try {
			await connect(database, { name: 'slot-setup-peer', replicates: true });
			assert.deepEqual(residencyTopologyErrors(database), []);
			const socket = await connect(database, { username: 'reader', role: { permission: {} } });
			socket.emit(
				'message',
				encode([
					140,
					'slot-setup-peer',
					database,
					[],
					buildLocalCapabilities(90_000, false, true),
					{ shardsDigest: 'forged' },
				])
			);
			await turns();
			assert.deepEqual(residencyTopologyErrors(database), []);
		} finally {
			server.nodes = priorNodes;
		}
	});
	for (const [name, authorization, options] of [
		['false_grant', { name: 'slot-setup-peer', replicates: false }, {}],
		[
			'false_route',
			{ name: 'slot-setup-peer', replicates: true },
			{ routes: [{ hostname: 'slot-setup-peer', replicates: false }] },
		],
	])
		it(`ignores shard claims without receive authority (${name})`, async () => {
			const database = `slot_setup_digest_${name}`;
			const priorNodes = server.nodes;
			server.nodes = [{ name: 'slot-setup-peer' }];
			try {
				await connect(database, { name: 'slot-setup-peer', replicates: true });
				const socket = await connect(database, authorization, options);
				socket.emit(
					'message',
					encode([
						140,
						'slot-setup-peer',
						database,
						[],
						buildLocalCapabilities(90_000, false, true),
						{ shardsDigest: 'forged' },
					])
				);
				await turns();
				assert.deepEqual(residencyTopologyErrors(database), []);
			} finally {
				server.nodes = priorNodes;
			}
		});

	it('binds a promised authenticated identity before accepting the node name', async () => {
		const database = 'slot_setup_promised_identity';
		const socket = new Socket();
		sockets.push(socket);
		replicateOverWS(socket, {}, Promise.resolve({ name: 'authenticated-peer', replicates: true }));
		socket.emit(
			'message',
			encode([
				140,
				'forged-peer',
				database,
				[],
				buildLocalCapabilities(90_000, false, true),
				{ shardsDigest: 'forged' },
			])
		);
		await turns();
		assert.ok(
			socket.closes.some(({ code }) => code === 1008),
			'a promised identity must reject another claimed name'
		);
	});

	it('ignores a delayed authorization result after its socket closes', async () => {
		const database = 'slot_setup_closed_authorization';
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-setup-peer' }];
		let resolve;
		const authorization = new Promise((done) => {
			resolve = done;
		});
		try {
			await connect(database, { name: 'slot-setup-peer', replicates: true });
			const socket = new Socket();
			sockets.push(socket);
			replicateOverWS(socket, {}, authorization);
			socket.emit(
				'message',
				encode([
					140,
					'slot-setup-peer',
					database,
					[],
					buildLocalCapabilities(90_000, false, true),
					{ shardsDigest: 'forged' },
				])
			);
			await turns();
			socket.close(1000);
			resolve({ name: 'slot-setup-peer', replicates: true });
			await turns();
			assert.deepEqual(residencyTopologyErrors(database), []);
		} finally {
			resolve(undefined);
			server.nodes = priorNodes;
		}
	});

	it('does not clear a replacement connection failure after an installation await', async () => {
		const database = 'slot_setup_closed_install';
		const Maps = getResidencyMapTable();
		const original = Maps.getResource;
		let resume, reached;
		const paused = new Promise((resolve) => {
			reached = resolve;
		});
		const gate = new Promise((resolve) => {
			resume = resolve;
		});
		Maps.getResource = async function (...args) {
			const resource = await original.apply(this, args);
			if (args[0] === database) {
				reached();
				await gate;
			}
			return resource;
		};
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-setup-peer' }];
		try {
			const socket = await connect(database, { name: 'slot-setup-peer', replicates: true });
			socket.emit(
				'message',
				encode([145, [], database, undefined, [], { snapshot: snapshot(database), shardsDigest: null }])
			);
			await paused;
			socket.close(1000);
			recordResidencyMapAgreement(database, 'slot-setup-peer', new Error('replacement connection refused its map'));
			resume();
			for (let n = 0; n < 200 && !readResidencyMap(database); n++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			await turns();
			assert.ok(readResidencyMap(database));
			assert.ok(
				residencyTopologyErrors(database).some((error) => error.includes('map agreement')),
				'map failure must remain blocked'
			);
		} finally {
			resume();
			Maps.getResource = original;
			server.nodes = priorNodes;
		}
	});

	it('requires fresh liveness before admitting an attribute move', async () => {
		const database = 'slot_setup_liveness';
		const Records = table({ database, table: 'Rows', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const priorNodes = server.nodes;
		const peer = 'slot-liveness-peer';
		server.nodes = [{ name: peer, replicates: true }];
		try {
			const state = getReplicationSharedStatus(Records.auditStore, database, peer);
			state[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
			state[LAST_LIVENESS_TIME_POSITION] = Date.now() - 3600000;
			assert.throws(() => requireConnectedResidencyOwner(database, [peer]), /connected/);
			state[LAST_LIVENESS_TIME_POSITION] = Date.now();
			assert.doesNotThrow(() => requireConnectedResidencyOwner(database, [peer]));
		} finally {
			server.nodes = priorNodes;
		}
	});
	it('keeps a legacy database handshake working with malformed optional shard configuration', async () => {
		const prior = get('replication_shards');
		setProperty('replication_shards', [0, '1']);
		try {
			await connect('slot_setup_legacy_configuration', { name: 'slot-setup-peer', replicates: true });
		} finally {
			setProperty('replication_shards', prior);
		}
	});
	it('installs an authorized snapshot', async () => {
		const database = 'slot_setup_allowed';
		const expected = snapshot(database);
		const socket = await connect(database, { replicates: true });
		await sendMap(socket, database, expected);
		assert.deepEqual(socket.closes, []);
		assert.deepEqual({ ...readResidencyMap(database) }, expected);
	});
	it('accepts residency metadata for an explicit selective subscription', async () => {
		const database = 'slot_setup_selective';
		const socket = await connect(
			database,
			{ name: 'slot-setup-peer', replicates: true },
			{
				routes: [{ hostname: 'slot-setup-peer', subscriptions: [{ database, table: 'Rows', subscribe: true }] }],
			}
		);
		await sendMap(socket, database, snapshot(database));
		assert.deepEqual(socket.closes, []);
		assert.equal(readResidencyMap(database)?.digest, snapshot(database).digest);
	});
	it('ignores out-of-scope residency metadata on an authorized system stream', async () => {
		const database = 'slot_setup_unsubscribed';
		const socket = await connect(
			'system',
			{ name: 'slot-setup-peer', replicates: true },
			{
				routes: [
					{
						hostname: 'slot-setup-peer',
						replicates: { receivesFrom: [{ target: 'slot-setup-peer', database: 'system' }] },
					},
				],
			}
		);
		socket.emit(
			'message',
			encode([145, [], database, undefined, [], { snapshot: snapshot(database), shardsDigest: null }])
		);
		await turns();
		assert.deepEqual(socket.closes, []);
		assert.equal(readResidencyMap(database), undefined);
	});
	it('resolves and receives owner projections without an outbound write route', async () => {
		const database = 'slot_setup_receive_only';
		const peer = 'slot-receive-owner';
		const priorNodes = server.nodes,
			priorShards = server.shards;
		const Nodes = getHDBNodeTable();
		const self = Nodes.primaryStore.getSync(server.hostname);
		await installResidencyMap(createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], 1));
		const Records = table({
			database,
			table: 'Rows',
			audit: true,
			residency: { slots: 2 },
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag', indexed: true }, { name: 'body' }],
		});
		try {
			await Nodes.put(server.hostname, { ...self, name: server.hostname, replicates: { receives: true } });
			server.nodes = [{ name: peer }];
			server.shards = new Map([[1, [{ name: peer }]]]);
			assert.deepEqual(Records.getRecordResidency({ key: 'remote' }), [peer]);
			const context = {};
			await transaction(context, async () => {
				const row = await Records.getResource('remote', context, { ensureLoaded: false });
				row._writeUpdate('remote', { id: 'remote', tag: 'indexed', body: 'canonical' }, true, {
					isNotification: true,
					version: Date.now(),
					nodeId: 0,
				});
			});
			assert.equal(Records.primaryStore.getEntry('remote')?.value?.tag, 'indexed');
			assert.equal(Records.primaryStore.getEntry('remote')?.value?.body, undefined);
			await assert.rejects(async () => Records.put('local', { id: 'local', tag: 'denied' }), /No replication route/);
		} finally {
			if (self) await Nodes.put(server.hostname, self);
			else await Nodes.delete(server.hostname);
			server.nodes = priorNodes;
			server.shards = priorShards;
		}
	});
	it('does not adopt a peer policy over a local schema that declares none', async () => {
		const database = 'slot_setup_local_schema';
		const map = snapshot(database);
		await installResidencyMap(map);
		const Records = table({
			database,
			table: 'Rows',
			schemaDefined: true,
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-setup-peer' }];
		try {
			const socket = await connect(database, { name: 'slot-setup-peer', replicates: true });
			socket.emit(
				'message',
				encode([
					145,
					[
						{
							table: 'Rows',
							attributes: Records.attributes,
							residency: { slots: 2, slotFrom: '0', byAttribute: false },
							schemaDefined: true,
						},
					],
					database,
					undefined,
					[],
					{ snapshot: map, shardsDigest: null },
				])
			);
			await turns();
			assert.ok(socket.closes.length, 'local schema must explicitly opt into the directive');
			assert.equal(Records.residency, undefined);
			assert.ok(residencyTopologyErrors(database).some((error) => error.includes('policy')));
		} finally {
			server.nodes = priorNodes;
		}
	});

	it('clears a policy disagreement after the conflicting table is dropped on both peers', async () => {
		const database = 'slot_setup_dropped_policy';
		const map = snapshot(database);
		await installResidencyMap(map);
		const Records = table({
			database,
			table: 'Rows',
			audit: true,
			residency: { slots: 2, slotFrom: '0', byAttribute: false },
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-setup-peer' }];
		try {
			const first = await connect(database, { name: 'slot-setup-peer', replicates: true });
			first.emit(
				'message',
				encode([
					145,
					[
						{
							table: 'Rows',
							attributes: Records.attributes,
							residency: { slots: 2, slotFrom: '1', byAttribute: false },
						},
					],
					database,
					undefined,
					[],
					{ snapshot: map, shardsDigest: null },
				])
			);
			await turns();
			assert.ok(residencyTopologyErrors(database).some((error) => error.includes('policy')));
			await Records.dropTable();
			const retry = await connect(database, { name: 'slot-setup-peer', replicates: true });
			await sendMap(retry, database, map);
			await turns();
			assert.deepEqual(residencyTopologyErrors(database), []);
		} finally {
			server.nodes = priorNodes;
		}
	});

	for (const system of [false, true])
		for (const conflict of ['different', 'missing'])
			it(`reports a ${conflict} table-policy conflict on ${system ? 'system' : 'database'} setup and clears it only with matching policy setup`, async () => {
				const database = `slot_setup_policy_conflict_${system}_${conflict}`;
				const map = snapshot(database);
				await installResidencyMap(map);
				const policy = { slots: 2, slotFrom: '0', byAttribute: false };
				const Records = table({
					database,
					table: 'Rows',
					audit: true,
					residency: policy,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'tag', indexed: true },
					],
				});
				const priorNodes = server.nodes;
				server.nodes = [{ name: 'slot-setup-peer' }];
				const frame = (residency) => [
					145,
					[{ table: 'Rows', residency, attributes: Records.attributes }],
					database,
					undefined,
					[],
					{ snapshot: map, shardsDigest: null },
				];
				try {
					const socket = await connect(system ? 'system' : database, { name: 'slot-setup-peer', replicates: true });
					socket.emit('message', encode(frame(conflict === 'missing' ? undefined : { ...policy, slotFrom: '1' })));
					await turns();
					assert.ok(socket.closes.length, 'conflicting policy closes the stream');
					assert.ok(residencyTopologyErrors(database).length, 'the policy conflict blocks placement visibly');
					const retry = await connect(system ? 'system' : database, { name: 'slot-setup-peer', replicates: true });
					await sendMap(retry, database, map);
					await turns();
					assert.ok(residencyTopologyErrors(database).length, 'map agreement alone cannot clear a policy conflict');
					retry.emit('message', encode(frame(policy)));
					await turns();
					assert.deepEqual(residencyTopologyErrors(database), []);
				} finally {
					server.nodes = priorNodes;
				}
			});
});
