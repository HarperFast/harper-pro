import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import { setHdbBasePath, get, setProperty } from '#src/core/utility/environment/environmentManager';
import { createResidencyMap } from '#src/core/resources/residencyPolicy';
import {
	readResidencyMap,
	installResidencyMap,
	getResidencyMapTable,
	requireConnectedResidencyOwner,
} from '#src/core/resources/residencyMaps';
import { replicateOverWS, NodeReplicationConnection } from '#src/replication/replicationConnection';
import { server } from '#src/core/server/Server';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { shardingSourceAgreement, publishShardingCertificate } from '#src/replication/shardingRecovery';
import { getReplicationSharedStatus, getHDBNodeTable } from '#src/replication/knownNodes';
import { databases, table } from '#src/core/resources/databases';
import { REPLICATION_APPLY } from '#src/core/resources/databaseLiveGuard';
import { transaction } from '#src/core/resources/transaction';
import {
	CONNECTION_STATE_POSITION,
	CONNECTION_STATE_CONNECTED,
	LAST_LIVENESS_TIME_POSITION,
} from '#src/replication/sharedStatusSlots';
import {
	residencyTopologyErrors,
	recordResidencyMapAgreement,
	recordResidencyConfiguration,
	recordResidencyPolicyAgreement,
	recordShardingRecoveryCapability,
	residencyConfigurationDigest,
} from '#src/replication/residencyTopology';
import { buildLocalCapabilities, resolvePeerCapabilities } from '#src/replication/protocolCapabilities';

class Socket extends EventEmitter {
	readyState = 1;
	closes = [];
	sent = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		if (data[0] > 127) this.sent.push(decode(data));
	}
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
async function connect(database, authorization, options = {}, announced = 'slot-setup-peer') {
	const socket = new Socket();
	sockets.push(socket);
	replicateOverWS(socket, options, authorization);
	socket.emit('message', encode([140, announced, database, [], buildLocalCapabilities(90_000, false, true), null]));
	await processed(socket);
	assert.deepEqual(socket.closes, [], 'handshake succeeds before the tested frame');
	return socket;
}
async function sendMap(socket, frameDatabase, snapshot) {
	socket.emit('message', encode([145, [], frameDatabase, undefined, [], { snapshot, shardsDigest: null }]));
	for (let n = 0; n < 200 && !socket.closes.length && !readResidencyMap(snapshot.database); n++)
		await new Promise((resolve) => setTimeout(resolve, 5));
}
const snapshot = (database) => createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 0 }], 1);
let barrierSequence = 0;
async function processed(socket, allowClose = false) {
	const request = `setup-processing-barrier-${barrierSequence++}`;
	socket.emit('message', encode([133, request, 0, 'absent', 'MissingTable']));
	const deadline = Date.now() + 5000;
	while (!socket.sent.some((frame) => frame[0] === 134 && frame[1] === request)) {
		if (allowClose && socket.closes.length) return;
		assert.equal(socket.closes.length, 0, 'stream closed before processing the following request');
		assert.ok(Date.now() < deadline, 'setup frame did not finish');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('sharding setup authority', function () {
	this.timeout(10_000);
	before(() => setHdbBasePath(process.env.STORAGE_PATH));
	afterEach(() => {
		while (sockets.length) sockets.pop().close(1000);
	});

	it('keeps the recovery hold independent of map/config agreement and requires bound identity to change it', () => {
		const previousNodes = server.nodes;
		const peer = 'recovery-capability-peer';
		try {
			server.nodes = [{ name: peer }];
			const current = resolvePeerCapabilities({ shardingRecovery: 2 });
			const old = resolvePeerCapabilities({});
			recordShardingRecoveryCapability(peer, current, true);
			const warm = residencyTopologyErrors('data');
			recordShardingRecoveryCapability(peer, old, false);
			assert.equal(residencyTopologyErrors('data'), warm);
			recordShardingRecoveryCapability(peer, old, true);
			assert.ok(residencyTopologyErrors('data').some((error) => error.includes('recovery admission')));
			assert.deepEqual(
				residencyTopologyErrors('data', false),
				[],
				'recovery capability holds sharded origination without fencing legacy tables'
			);
			recordResidencyConfiguration(peer, residencyConfigurationDigest());
			recordResidencyMapAgreement('data', peer);
			recordResidencyPolicyAgreement('data', peer);
			recordShardingRecoveryCapability(peer, current, false);
			assert.ok(residencyTopologyErrors('data').some((error) => error.includes('recovery admission')));
			assert.equal(getHDBNodeTable().dbisDB.getSync([Symbol.for('sharding-peer-recovery'), peer]), false);
			server.nodes = [];
			assert.deepEqual(residencyTopologyErrors('data'), []);
			server.nodes = [{ name: peer }];
			assert.ok(residencyTopologyErrors('data').some((error) => error.includes('recovery admission')));
			recordShardingRecoveryCapability(peer, current, true);
			assert.deepEqual(residencyTopologyErrors('data'), []);
			assert.equal(getHDBNodeTable().dbisDB.getSync([Symbol.for('sharding-peer-recovery'), peer]), true);
		} finally {
			server.nodes = previousNodes;
		}
	});
	it('heals a peer disagreement after local repair without another peer handshake', () => {
		const nodes = server.nodes;
		const shards = get('replication_shards');
		const shard = get('replication_shard');
		try {
			server.nodes = [{ name: 'repair-peer' }];
			setProperty('replication_shard', 0);
			setProperty('replication_shards', [0, 1]);
			const digest = residencyConfigurationDigest();
			recordResidencyConfiguration('repair-peer', digest);
			assert.deepEqual(residencyTopologyErrors(), []);
			setProperty('replication_shards', [0, 2]);
			assert.equal(residencyTopologyErrors().length, 1);
			recordResidencyConfiguration('repair-peer', digest);
			setProperty('replication_shards', [0, 1]);
			assert.deepEqual(residencyTopologyErrors(), []);
			const cached = residencyTopologyErrors();
			assert.equal(residencyTopologyErrors(), cached, 'healthy verdict reuses the cached result');
		} finally {
			server.nodes = nodes;
			setProperty('replication_shards', shards);
			setProperty('replication_shard', shard);
		}
	});
	for (const [name, authorization, options] of [
		['credential', { username: 'reader', role: { permission: {} } }, {}],
		['false_grant', { name: 'slot-setup-peer', replicates: false }, {}],
		['receive_only_grant', { name: 'slot-setup-peer', replicates: { receives: true } }, {}],
		['receive_from_grant', { name: 'slot-setup-peer', replicates: { receivesFrom: ['*'] } }, {}],
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
					await processed(socket, true);
					assert.deepEqual(residencyTopologyErrors(database), []);
					assert.deepEqual(Records.residency, policy);
				} finally {
					server.nodes = priorNodes;
				}
			});
	}

	for (const [name, grant] of [
		['sends', { sends: true }],
		['sends_to', { sendsTo: [{ target: server.hostname }] }],
	])
		it(`accepts a map under the peer ${name} grant`, async () => {
			const database = `slot_setup_grant_${name}`;
			const socket = await connect(database, { name: 'slot-setup-peer', replicates: grant });
			await sendMap(socket, database, snapshot(database));
			assert.deepEqual(socket.closes, []);
			assert.equal(readResidencyMap(database)?.digest, snapshot(database).digest);
		});

	it('does not raise a sharded origin’s direct resume past a co-owner’s observed maximum', async () => {
		const database = 'slot_setup_direct_resume';
		const priorShard = get('replication_shard');
		const priorNodes = server.nodes;
		const peer = 'slot-setup-peer';
		try {
			setProperty('replication_shard', 0);
			server.nodes = [
				{ name: peer, shard: 0, replicates: true },
				{ name: 'complete-co-owner', shard: 0, replicates: true },
			];
			await getHDBNodeTable().put(peer, { name: peer, shard: 0, replicates: true });
			await installResidencyMap(snapshot(database));
			const Rows = table({
				database,
				table: 'Rows',
				audit: true,
				residency: { slots: 2 },
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			const originId = getIdOfRemoteNode(peer, Rows.auditStore);
			const relayId = getIdOfRemoteNode('complete-co-owner', Rows.auditStore);
			const relayStatus = getReplicationSharedStatus(Rows.auditStore, database, 'complete-co-owner');
			relayStatus[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
			publishShardingCertificate(relayStatus, 0, shardingSourceAgreement(database));
			const direct = Date.now() - 1000;
			await Rows.dbisDB.put([Symbol.for('seq'), originId], { seqId: direct, nodes: [] });
			await Rows.dbisDB.put([Symbol.for('seq'), relayId], {
				seqId: direct + 500,
				nodes: [{ id: originId, lastTxnTime: direct + 500, originLogKey: direct + 500 }],
			});
			const connection = new NodeReplicationConnection(`wss://${peer}`, undefined, database, peer);
			connection.nodeSubscriptions = [{ name: peer, url: `wss://${peer}`, replicates: true, replicateByDefault: true }];
			const socket = new Socket();
			sockets.push(socket);
			connection.socket = socket;
			replicateOverWS(socket, { connection }, { name: peer, replicates: true });
			socket.emit(
				'message',
				encode([
					140,
					peer,
					database,
					[],
					buildLocalCapabilities(90_000, false, true),
					{
						shard: 0,
						shardingCertificate: shardingSourceAgreement(database),
						shardsDigest: residencyConfigurationDigest(),
					},
				])
			);
			await processed(socket);
			const request = socket.sent.find((frame) => frame[0] === 129);
			assert.ok(request, 'the authenticated peer receives a subscription');
			assert.equal(request[1][0].startTime, direct);
			connection.emit('exclusion-origins-updated', ['unavailable-origin']);
			connection.emit('exclusion-origins-updated', []);
			const include = socket.sent.find(
				(frame) => frame[0] === 147 && frame[1].includeNodes?.includes('unavailable-origin')
			);
			assert.ok(include, 'the existing co-owner stream includes the unavailable origin');
			assert.equal(
				socket.sent.filter((frame) => frame[0] === 129).length,
				1,
				'failover does not replace the primary subscription'
			);
			connection.emit('exclusion-origins-updated', ['unavailable-origin']);
			assert.ok(
				socket.sent.at(-1)[1].excludeNodes.includes('unavailable-origin'),
				'direct recovery restores exclusion'
			);
		} finally {
			server.nodes = priorNodes;
			setProperty('replication_shard', priorShard);
			await getHDBNodeTable().delete(peer);
		}
	});
	it('authenticates the dialed failover peer independently of the subscribed origin', async () => {
		const database = 'slot_setup_failover';
		const connection = new NodeReplicationConnection(
			'wss://slot-setup-peer:9933',
			undefined,
			database,
			'slot-setup-peer'
		);
		connection.nodeName = 'unavailable-origin';
		connection.nodeSubscriptions = [{ name: 'unavailable-origin' }];
		const socket = await connect(
			database,
			{ replicates: true },
			{ connection, routes: [{ hostname: 'slot-setup-peer', replicates: true }] }
		);
		await sendMap(socket, database, snapshot(database));
		assert.deepEqual(socket.closes, []);
		assert.equal(readResidencyMap(database)?.digest, snapshot(database).digest);
	});
	for (const route of ['127.0.0.2', 'slot-setup-peer:9933']) {
		it(`preserves an unbound outbound legacy peer name through route ${route}`, async () => {
			const database = `slot_setup_legacy_route_${route.includes(':') ? 'port' : 'ip'}`;
			const connection = new NodeReplicationConnection(`wss://${route}`, undefined, database, route);
			connection.nodeSubscriptions = [{ name: route, url: `wss://${route}`, configRouteReplicates: true }];
			const socket = await connect(database, { replicates: true }, { connection });
			assert.equal(connection.nodeName, 'slot-setup-peer', 'legacy resume state keeps the announced identity');
			await processed(socket);
			await sendMap(socket, database, snapshot(database));
			assert.ok(socket.closes.length, 'an unbound legacy identity cannot declare residency');
			assert.equal(readResidencyMap(database), undefined);
		});
		it(`binds outbound route ${route} through an explicit canonical node record`, async () => {
			const database = `slot_setup_bound_route_${route.includes(':') ? 'port' : 'ip'}`;
			const priorNodes = server.nodes;
			server.nodes = [{ name: 'slot-setup-peer', url: `wss://${route}`, replicates: true }];
			try {
				const connection = new NodeReplicationConnection(`wss://${route}`, undefined, database, route);
				connection.nodeSubscriptions = [{ name: route, url: `wss://${route}`, configRouteReplicates: true }];
				const socket = await connect(database, { replicates: true }, { connection });
				assert.equal(connection.nodeName, 'slot-setup-peer');
				await sendMap(socket, database, snapshot(database));
				assert.deepEqual(socket.closes, []);
				assert.equal(readResidencyMap(database)?.digest, snapshot(database).digest);
			} finally {
				server.nodes = priorNodes;
			}
		});
	}

	for (const route of ['127.0.0.2', '127.0.0.2:9933'])
		for (const subscriptions of [false, true])
			it(`keeps matching discovery address ${route} unbound for sharding (subscriptions=${subscriptions})`, async () => {
				const database = `slot_setup_matching_discovery_${route.includes(':') ? 'port' : 'ip'}_${subscriptions}`;
				const connection = new NodeReplicationConnection(`wss://${route}`, undefined, database, route);
				if (subscriptions)
					connection.nodeSubscriptions = [{ name: route, url: `wss://${route}`, configRouteReplicates: true }];
				const socket = await connect(database, { replicates: true }, { connection }, route);
				await sendMap(socket, database, snapshot(database));
				await processed(socket, true);
				assert.ok(socket.closes.length, 'matching an unconfigured discovery address does not grant schema authority');
				assert.equal(readResidencyMap(database), undefined);
			});

	for (const route of ['127.0.0.2', '127.0.0.2:9933'])
		for (const subscriptions of [false, true])
			it(`binds matching address ${route} when an explicit node record exists (subscriptions=${subscriptions})`, async () => {
				const database = `slot_setup_explicit_matching_${route.includes(':') ? 'port' : 'ip'}_${subscriptions}`;
				const priorNodes = server.nodes;
				server.nodes = [{ name: route, url: `wss://${route}`, replicates: true }];
				try {
					const connection = new NodeReplicationConnection(`wss://${route}`, undefined, database, route);
					if (subscriptions)
						connection.nodeSubscriptions = [{ name: route, url: `wss://${route}`, configRouteReplicates: true }];
					const socket = await connect(database, { replicates: true }, { connection }, route);
					await sendMap(socket, database, snapshot(database));
					await processed(socket);
					assert.deepEqual(socket.closes, []);
					assert.equal(readResidencyMap(database)?.digest, snapshot(database).digest);
				} finally {
					server.nodes = priorNodes;
				}
			});

	it('refuses an address alias shared by different configured nodes', async () => {
		const socket = new Socket();
		sockets.push(socket);
		replicateOverWS(
			socket,
			{
				routes: [
					{ hostname: 'slot-setup-peer', url: 'wss://127.0.0.2:9933', replicates: true },
					{ hostname: 'other-peer', url: 'wss://127.0.0.2:9934', replicates: true },
				],
			},
			{ name: '127.0.0.2', replicates: true }
		);
		socket.emit(
			'message',
			encode([140, 'slot-setup-peer', 'slot_setup_ambiguous', [], buildLocalCapabilities(90_000, false, true)])
		);
		await turns();
		assert.ok(
			socket.closes.some(({ code }) => code === 1008),
			'an ambiguous authenticated host must not select a canonical peer'
		);
	});
	it('refuses outbound discovery claiming an unrelated known node', async () => {
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-setup-peer', url: 'wss://127.0.0.99:9933', replicates: true }];
		try {
			const connection = new NodeReplicationConnection(
				'wss://127.0.0.2:9933',
				undefined,
				'slot_discovery',
				'127.0.0.2'
			);
			connection.nodeSubscriptions = [{ name: '127.0.0.2', url: 'wss://127.0.0.2:9933', configRouteReplicates: true }];
			const socket = new Socket();
			sockets.push(socket);
			connection.socket = socket;
			replicateOverWS(socket, { connection }, { replicates: true });
			socket.emit(
				'message',
				encode([140, 'slot-setup-peer', 'slot_discovery', [], buildLocalCapabilities(90_000, false, true)])
			);
			await turns();
			assert.ok(socket.closes.some(({ code }) => code === 1008));
		} finally {
			server.nodes = priorNodes;
		}
	});

	it('binds the snapshot to its database frame', async () => {
		const socket = await connect('slot_setup_frame', { name: 'slot-setup-peer', replicates: true });
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
			const first = await connect(database, { name: 'slot-setup-peer', replicates: true });
			await sendMap(first, database, createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], 1));
			await turns();
			assert.ok(first.closes.length);
			assert.ok(
				residencyTopologyErrors(database).some((error) => error.includes('map agreement')),
				'map failure must remain blocked'
			);
			const retry = await connect(database, { name: 'slot-setup-peer', replicates: true });
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
			await processed(socket, true);
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
				await processed(socket, true);
				assert.deepEqual(residencyTopologyErrors(database), []);
			} finally {
				server.nodes = priorNodes;
			}
		});

	for (const [kind, address, url] of [
		['ipv4', '127.0.0.2', 'wss://127.0.0.2:9933'],
		['hostname', 'peer-address.invalid', 'wss://peer-address.invalid:9933'],
		['ipv6', '2001:db8:0:0:0:0:0:2', 'wss://[2001:db8::2]:9933'],
	])
		it(`binds an authenticated ${kind} through the configured route to its canonical node`, async () => {
			const database = `slot_setup_alias_${kind}`;
			const previousNodes = server.nodes;
			server.nodes = [{ name: 'slot-setup-peer' }];
			try {
				const socket = await connect(
					database,
					{ name: address, replicates: true },
					{
						routes: [{ hostname: 'slot-setup-peer', url, replicates: true }],
					}
				);
				await sendMap(socket, database, snapshot(database));
				assert.deepEqual(socket.closes, []);
				assert.equal(readResidencyMap(database)?.digest, snapshot(database).digest);
				assert.deepEqual(residencyTopologyErrors(database), []);
			} finally {
				server.nodes = previousNodes;
			}
		});

	it('rejects an alias claim that is another known node', async () => {
		const previousNodes = server.nodes;
		server.nodes = [{ name: 'authenticated-peer' }, { name: 'forged-peer' }];
		try {
			const socket = new Socket();
			sockets.push(socket);
			replicateOverWS(socket, {}, { name: 'authenticated-peer', url: 'wss://forged-peer:9933', replicates: true });
			socket.emit(
				'message',
				encode([140, 'forged-peer', 'slot_setup_alias_forgery', [], buildLocalCapabilities(90_000, false, true)])
			);
			await turns();
			assert.ok(socket.closes.some(({ code }) => code === 1008));
		} finally {
			server.nodes = previousNodes;
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
			await processed(socket, true);
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
			assert.throws(
				() => requireConnectedResidencyOwner(database, [peer]),
				/connected/,
				'connection truth alone is not a received message'
			);
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
		const socket = await connect(database, { name: 'slot-setup-peer', replicates: true });
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
		await processed(socket);
		assert.deepEqual(socket.closes, []);
		assert.equal(readResidencyMap(database), undefined);
	});
	it('ignores an out-of-scope older schema over a local declarative table on the system stream', async () => {
		const database = 'slot_setup_unsubscribed_legacy';
		await installResidencyMap(snapshot(database));
		const Records = table({
			database,
			table: 'Rows',
			audit: true,
			residency: { slots: 2 },
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
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
			encode([
				145,
				[
					{ table: 'Rows', attributes: Records.attributes, schemaDefined: true },
					{ table: 'LegacyRows', attributes: [{ name: 'id', isPrimaryKey: true }], schemaDefined: true },
				],
				database,
			])
		);
		await processed(socket);
		assert.deepEqual(socket.closes, []);
		assert.deepEqual(Records.residency, { slots: 2, byAttribute: false });
		assert.ok(databases[database].LegacyRows, 'legacy discovery in a mixed frame still runs');
		assert.deepEqual(residencyTopologyErrors(database), []);
		socket.emit('message', encode([145, [], database, undefined, [{ table: 'Rows', droppedTime: Date.now() + 1000 }]]));
		await processed(socket);
		assert.equal(
			databases[database].Rows,
			Records,
			'a marker-only frame cannot drop an out-of-scope declarative table'
		);
	});
	it('keeps legacy schema discovery on an unbound system stream', async () => {
		const database = 'slot_setup_unbound_legacy';
		await installResidencyMap(snapshot(database));
		const Records = table({
			database,
			table: 'Rows',
			audit: true,
			residency: { slots: 2 },
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const socket = await connect('system', { username: 'discovery', replicates: true });
		socket.emit(
			'message',
			encode([
				145,
				[
					{ table: 'Rows', attributes: Records.attributes, schemaDefined: true },
					{ table: 'LegacyRows', attributes: [{ name: 'id', isPrimaryKey: true }], schemaDefined: true },
				],
				database,
			])
		);
		await processed(socket);
		assert.deepEqual(socket.closes, []);
		assert.deepEqual(Records.residency, { slots: 2, byAttribute: false });
		assert.ok(databases[database].LegacyRows, 'legacy discovery in a mixed frame still runs');
		assert.deepEqual(residencyTopologyErrors(database), []);
		socket.emit('message', encode([145, [], database, undefined, [{ table: 'Rows', droppedTime: Date.now() + 1000 }]]));
		await processed(socket);
		assert.equal(
			databases[database].Rows,
			Records,
			'a marker-only frame cannot drop an out-of-scope declarative table'
		);
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
			const context = { sourceApply: true, [REPLICATION_APPLY]: true };
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
			await processed(retry);
			assert.deepEqual(residencyTopologyErrors(database), []);
		} finally {
			server.nodes = priorNodes;
		}
	});

	for (const [localSlot, remoteSlot] of [
		[0, 1],
		[1, 0],
	])
		it(`carries the explicit expression in setup and refuses disagreement ${localSlot} -> ${remoteSlot}`, async () => {
			const database = `sharded_expression_agreement_${localSlot}`;
			const map = snapshot(database);
			await installResidencyMap(map);
			const expression = (slot) => `region === 'asia' ? ${slot} : ${1 - slot}`;
			const policy = { slots: 2, by: 'region', byAttribute: true, slotFrom: expression(localSlot) };
			const Records = table({
				database,
				table: 'Rows',
				audit: true,
				residency: policy,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'region', type: 'String', indexed: true },
				],
			});
			const priorNodes = server.nodes;
			server.nodes = [{ name: 'slot-setup-peer' }];
			try {
				const socket = await connect(database, { name: 'slot-setup-peer', replicates: true });
				const advertised = socket.sent
					.find((frame) => frame[0] === 140)[3]
					.find((definition) => definition.table === 'Rows');
				assert.deepEqual(advertised.residency, policy, 'setup carries both by and the exact expression');
				socket.emit(
					'message',
					encode([
						145,
						[
							{
								table: 'Rows',
								residency: { ...policy, slotFrom: expression(remoteSlot) },
								attributes: Records.attributes,
							},
						],
						database,
						undefined,
						[],
						{ snapshot: map, shardsDigest: null },
					])
				);
				await processed(socket, true);
				assert.ok(socket.closes.length, 'expression disagreement closes the stream before applying records');
				assert.ok(residencyTopologyErrors(database).some((error) => error.includes('policy')));
				assert.deepEqual(Records.residency, policy);
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
					await processed(retry);
					assert.ok(residencyTopologyErrors(database).length, 'map agreement alone cannot clear a policy conflict');
					retry.emit('message', encode(frame(policy)));
					await processed(retry);
					assert.deepEqual(residencyTopologyErrors(database), []);
				} finally {
					server.nodes = priorNodes;
				}
			});
});
