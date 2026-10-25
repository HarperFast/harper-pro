import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { decode, encode } from 'msgpackr';
import * as env from '#src/core/utility/environment/environmentManager';
import { server } from '#src/core/server/Server';
import { DatabaseTransaction } from '#src/core/resources/DatabaseTransaction';
import { transaction } from '#src/core/resources/transaction';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { INVALIDATED } from '#src/core/resources/Table';
import { table } from '#src/core/resources/databases';
import { createAuditEntry, readAuditEntry, Decoder, HAS_BLOBS } from '#src/core/resources/auditStore';
import { createBlob, getFileId, getFilePathForBlob } from '#src/core/resources/blob';
import { writeLockBarrier } from '#src/core/resources/recordLockCoordinator';
import {
	initializeResidencySlots,
	installResidencyMap,
	getResidencyMapTable,
	acquireResidencyMapFence,
	getResidencyConfiguration,
	requireConnectedResidencyOwner,
} from '#src/core/resources/residencyMaps';
import { createResidencyMap } from '#src/core/resources/residencyPolicy';
import { setReplicator } from '#src/replication/replicator';
import {
	databaseSubscriptions,
	encodeCopyRecordValue,
	replicateOverWS,
	PING_TIMEOUT,
} from '#src/replication/replicationConnection';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import { getHDBNodeTable } from '#src/replication/knownNodes';
import { residencyTopologyErrors, registerResidencySender } from '#src/replication/residencyTopology';
import { FrameWriter } from '#src/replication/frameWriter';
import { hasActiveBlobSends } from '#src/replication/blobSendDrain';

class Socket extends EventEmitter {
	readyState = 1;
	sent = [];
	closes = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		this.sent.push(data[0] > 127 ? decode(Buffer.from(data)) : Buffer.from(data));
	}
	close(code = 1000, reason = '') {
		if (this.readyState === 3) return;
		this.closes.push({ code, reason });
		this.readyState = 3;
		this.emit('close', code, Buffer.from(reason));
	}
	terminate() {
		this.close(1006);
	}
	ping() {}
	pause() {
		this.paused = true;
	}
	resume() {}
}
async function until(predicate) {
	const end = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < end, 'replication did not make progress');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
function entries(socket) {
	const records = [];
	for (const frame of socket.sent) {
		if (!Buffer.isBuffer(frame)) continue;
		const decoder = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
		decoder.position = 8;
		while (decoder.position < frame.length) {
			const length = decoder.readInt(),
				start = decoder.position;
			decoder.position += length;
			if (length === 9 && frame[start] === 11) continue;
			records.push(readAuditEntry(frame, start, start + length));
		}
	}
	return records;
}
function recordFrame(Table, type, recordId, value, version, residencyId, overrides = {}) {
	const frame = new FrameWriter();
	frame.writeFloat64(version);
	const entry = Buffer.from(
		createAuditEntry({
			type,
			tableId: Table.tableId,
			recordId,
			version,
			previousVersion: null,
			residencyId,
			extendedType: residencyId ? 512 : undefined,
			nodeId: 0,
			encodedRecord: type === 'lockBarrier' ? encode(value) : Buffer.from(Table.primaryStore.encoder.encode(value)),
			...overrides,
		})
	);
	const start = entry[0] === 66 ? 8 : 0;
	frame.writeInt(entry.length - start);
	frame.writeBytes(entry, start);
	frame.writeInt(9);
	frame.writeInt(11);
	frame.writeFloat64(version);
	return Buffer.from(frame.encodingBuffer.subarray(frame.encodingStart, frame.position));
}

describe('Declarative tables keep control and event traffic independent of placement', function () {
	this.timeout(15_000);
	let oldShards, oldList, oldShard;
	const sockets = [];
	before(() => {
		env.setHdbBasePath(process.env.STORAGE_PATH);
		oldShards = server.shards;
		oldList = env.get('replication_shards');
		oldShard = env.get('replication_shard');
		env.setProperty('replication_shards', [0]);
		env.setProperty('replication_shard', 0);
		server.shards = new Map([
			[0, [{ name: server.hostname }]],
			[1, [{ name: 'slot-control-peer' }]],
		]);
	});
	afterEach(() => {
		while (sockets.length) sockets.pop().close();
	});
	after(() => {
		server.shards = oldShards;
		env.setProperty('replication_shards', oldList);
		env.setProperty('replication_shard', oldShard);
	});
	async function connect(
		byAttribute,
		direction,
		legacy = false,
		capabilities = buildLocalCapabilities(90_000, true, true),
		beforeConnect,
		connection,
		ranges = [{ start: 0, end: 2, shard: 0 }]
	) {
		const database = `slot_control_${direction}_${byAttribute}`;
		await initializeResidencySlots({ database, slots: 2, ranges });
		const Records = table({
			database,
			table: 'Records',
			audit: true,
			residency: legacy ? undefined : { slots: 2, byAttribute, slotFrom: byAttribute ? 'region' : 'id.length % 2' },
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'region', indexed: true }, { name: 'body' }],
		});
		setReplicator(database, Records, {});
		await until(() => databaseSubscriptions.get(database)?.auditStore);
		beforeConnect?.(database);
		const socket = new Socket();
		sockets.push(socket);
		if (connection) connection.socket = socket;
		replicateOverWS(socket, { connection }, { name: 'slot-control-peer', replicates: true });
		socket.emit(
			'message',
			encode([
				140,
				'slot-control-peer',
				database,
				[],
				capabilities,
				{ shardsDigest: getResidencyConfiguration().digest },
			])
		);
		await until(() => socket.sent.some((frame) => frame[0] === 140) || socket.closes.length);
		assert.deepEqual(socket.closes, []);
		return { Records, socket, database };
	}
	it('unwraps an owner record after residency resolution decodes another native entry', async () => {
		const { Records, socket } = await connect(false, 'metadata_decode');
		await Records.put('requested', { id: 'requested', region: 0, body: 'canonical' });
		await Records.put('other', { id: 'other', region: 0, body: 'unrelated' });
		const resolveOwners = Records.getRecordResidency;
		Records.getRecordResidency = function (entry) {
			const owners = resolveOwners.call(this, entry);
			const bytes = Records.primaryStore.getBinary('other');
			Records.primaryStore.decoder.decode(bytes, { valueAsBuffer: true });
			return owners;
		};
		try {
			socket.emit('message', encode([133, 'metadata-decode', Records.tableId, 'requested', Records.tableName]));
			await until(() => socket.sent.some((frame) => frame[0] === 134 && frame[1] === 'metadata-decode'));
			const answer = socket.sent.find((frame) => frame[0] === 134 && frame[1] === 'metadata-decode')[2];
			assert.equal(answer.error, undefined);
			assert.ok(Buffer.isBuffer(answer.value), 'the response carries encoded value bytes, not native metadata');
			assert.equal(Records.primaryStore.decoder.decode(answer.value, { valueOnly: true }).body, 'canonical');
		} finally {
			Records.getRecordResidency = resolveOwners;
		}
	});
	it('holds a canonical frame through repeated owner changes and commits after membership stabilizes', async () => {
		const { Records, socket: initial, database } = await connect(false, 'churn');
		initial.close();
		const version = Date.now() + 1;
		const frame = recordFrame(Records, 'put', 'held', { id: 'held', region: 0, body: 'canonical' }, version, 42);
		const original = DatabaseTransaction.prototype.refuseUnconfirmable;
		let refusals = 0;
		DatabaseTransaction.prototype.refuseUnconfirmable = function (...args) {
			if (!this.sourceApply || !this.writes.some((write) => write?.store?.rootStore.databaseName === database))
				return original.apply(this, args);
			const prior = server.shards;
			server.shards = new Map(prior);
			server.shards.set(0, [...prior.get(0), { name: 'new-owner-during-submit' }]);
			try {
				refusals++;
				return original.apply(this, args);
			} finally {
				server.shards = prior;
			}
		};
		async function deliver() {
			const connection = new EventEmitter();
			connection.nodeSubscriptions = [{ name: 'slot-control-peer', replicateByDefault: true }];
			const { socket } = await connect(false, 'churn', false, undefined, undefined, connection);
			const encoder = Records.primaryStore.encoder;
			socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
			socket.emit(
				'message',
				encode([
					132,
					{
						structures: encoder.structures,
						typedStructs: encoder.typedStructs,
						attributes: Records.attributes,
						residency: Records.residency,
						schemaDefined: true,
					},
					Records.tableId,
					Records.tableName,
				])
			);
			socket.emit('message', encode([130, [server.hostname], 42]));
			socket.emit('message', frame);
			return socket;
		}
		const remoteId = getIdOfRemoteNode('slot-control-peer', Records.auditStore);
		const cursor = () => Records.dbisDB.getSync([Symbol.for('seq'), remoteId])?.seqId;
		const before = cursor();
		try {
			for (let attempt = 0; attempt < 7; attempt++) {
				const socket = await deliver();
				await until(
					() => socket.closes.length || socket.sent.some((message) => message[0] === 144 && message[1] >= version)
				);
				assert.ok(socket.closes.length, `delivery ${attempt + 1} must hold, not skip`);
				assert.equal(cursor(), before, 'a refused canonical frame cannot advance its durable cursor');
				assert.equal(Records.primaryStore.getEntry('held'), undefined);
			}
			assert.ok(refusals >= 7, 'every delivery reaches the native pre-submit owner fence');
		} finally {
			DatabaseTransaction.prototype.refuseUnconfirmable = original;
		}
		const repaired = await deliver();
		await until(() => Records.primaryStore.getEntry('held')?.value?.body === 'canonical');
		await until(() => cursor() === version);
		assert.deepEqual(repaired.closes, []);
	});
	for (const failure of ['busy', 'fork'])
		it(`holds the cursor for ${failure} maps despite subsequent system frames, beyond the poison budget`, async () => {
			const database = `sharded_system_hold_${failure}`;
			await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
			const Maps = getResidencyMapTable();
			const Probe = table({
				database: 'system',
				table: `sharded_hold_probe_${failure}`,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
			});
			setReplicator('system', Maps, {});
			setReplicator('system', Probe, {});
			await until(() => databaseSubscriptions.get('system')?.auditStore);
			const peer = `sharded-map-peer-${failure}`;
			const remoteId = getIdOfRemoteNode(peer, Maps.auditStore);
			const cursor = () => Maps.dbisDB.getSync([Symbol.for('seq'), remoteId])?.seqId;
			const before = cursor();
			const candidate = createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], failure === 'fork' ? 1 : 2);
			const version = Date.now() + 1000;
			const mapFrame = recordFrame(Maps, 'put', database, candidate, version);
			const laterFrame = recordFrame(Probe, 'put', 'later', { id: 'later', body: 'system update' }, version + 1);
			let release = failure === 'busy' ? acquireResidencyMapFence(database, {}) : undefined;
			async function deliver() {
				const connection = new EventEmitter();
				connection.nodeSubscriptions = [{ name: peer, replicateByDefault: true }];
				const socket = new Socket();
				sockets.push(socket);
				connection.socket = socket;
				replicateOverWS(socket, { connection }, { name: peer, replicates: true });
				socket.emit(
					'message',
					encode([
						140,
						peer,
						'system',
						[],
						buildLocalCapabilities(90000, false, false),
						{ shardsDigest: getResidencyConfiguration().digest },
					])
				);
				await until(() => socket.sent.some((frame) => frame[0] === 140) || socket.closes.length);
				assert.deepEqual(socket.closes, [], 'handshake reaches the actual map apply');
				socket.emit('message', encode([141, { [peer]: 0 }, [peer]]));
				for (const Rows of [Maps, Probe])
					socket.emit(
						'message',
						encode([
							132,
							{
								structures: Rows.primaryStore.encoder.structures,
								typedStructs: Rows.primaryStore.encoder.typedStructs,
								attributes: Rows.attributes,
							},
							Rows.tableId,
							Rows.tableName,
						])
					);
				socket.emit('message', mapFrame);
				socket.emit('message', laterFrame);
				return socket;
			}
			try {
				for (let attempt = 0; attempt < 7; attempt++) {
					const socket = await deliver();
					await until(() => socket.closes.length);
					assert.ok(socket.closes.length, `attempt ${attempt + 1} must hold the map`);
					assert.equal(cursor(), before);
				}
			} finally {
				release?.();
				release = undefined;
			}
			if (failure === 'fork')
				await initializeResidencySlots({
					database,
					slots: 2,
					ranges: candidate.ranges,
				});
			const repaired = await deliver();
			await until(() => Probe.primaryStore.getEntry('later')?.value?.body === 'system update');
			await until(() => cursor() === version + 1);
			assert.deepEqual(repaired.closes, []);
			assert.deepEqual(Maps.primaryStore.getSync(database).ranges, candidate.ranges);
		});
	it('preserves an explicitly missing legacy residency list', async () => {
		const { Records, socket } = await connect(false, 'legacy_missing_list', true);
		const frame = recordFrame(Records, 'put', 'legacy-row', { id: 'legacy-row', body: 'complete' }, Date.now(), 42);
		const encoder = Records.primaryStore.encoder;
		socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
		socket.emit(
			'message',
			encode([
				132,
				{
					structures: encoder.structures,
					typedStructs: encoder.typedStructs,
					attributes: Records.attributes,
					schemaDefined: true,
				},
				Records.tableId,
				Records.tableName,
			])
		);
		socket.emit('message', encode([130, undefined, 42]));
		socket.emit('message', frame);
		await until(() => Records.primaryStore.getEntry('legacy-row')?.value || socket.closes.length);
		assert.deepEqual(socket.closes, []);
		assert.equal(Records.primaryStore.getEntry('legacy-row').value.body, 'complete');
	});
	it('refuses a policy-less slot reference before creating unreferenced blob files', async () => {
		const { Records, socket } = await connect(false, 'missing_blob_policy', true);
		const payload = Buffer.alloc(65_536, 73);
		await Records.put('blob-donor', { id: 'blob-donor', body: createBlob(payload) });
		const donor = Records.primaryStore.getEntry('blob-donor');
		assert.ok(donor.metadataFlags & HAS_BLOBS);
		const announced = [];
		const encodedRecord = Buffer.from(
			encodeCopyRecordValue(Records.primaryStore, donor.value, (blob) => announced.push(blob))
		);
		assert.equal(announced.length, 1);
		const blobRoot = dirname(dirname(dirname(getFilePathForBlob(donor.value.body))));
		const files = () =>
			readdirSync(blobRoot, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => `${entry.parentPath}/${entry.name}`)
				.sort();
		const before = files();
		const encoder = Records.primaryStore.encoder;
		socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
		socket.emit(
			'message',
			encode([
				132,
				{
					structures: encoder.structures,
					typedStructs: encoder.typedStructs,
					attributes: Records.attributes,
					schemaDefined: true,
				},
				Records.tableId,
				Records.tableName,
			])
		);
		socket.emit('message', encode([130, { slot: 0, mapVersion: 1, mapDigest: 'untrusted' }, 42]));
		socket.emit(
			'message',
			encode([146, { fileId: getFileId(announced[0]), size: payload.length, finished: true }, payload])
		);
		socket.emit(
			'message',
			recordFrame(Records, 'put', 'refused-blob', undefined, Date.now(), 42, {
				encodedRecord,
				extendedType: HAS_BLOBS | 512,
			})
		);
		await until(() => socket.closes.length);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(Records.primaryStore.getEntry('refused-blob'), undefined);
		assert.deepEqual(files(), before, 'refusal must not mint a blob with no committed record');
		assert.deepEqual(Buffer.from(await donor.value.body.arrayBuffer()), payload);
	});
	for (const fails of [false, true])
		it(`refreshes a delayed blob confirmation only after a successful save (failure=${fails})`, async () => {
			const { Records, socket } = await connect(false, `delayed_blob_ack_${fails}`, true);
			const id = 'delayed-blob';
			const payload = Buffer.alloc(65_536, 83);
			await Records.put(id, { id, body: createBlob(payload) });
			const donor = Records.primaryStore.getEntry(id);
			const announced = [];
			const encodedRecord = Buffer.from(
				encodeCopyRecordValue(Records.primaryStore, donor.value, (blob) => announced.push(blob))
			);
			assert.equal(announced.length, 1);
			const version = Date.now() + 1;
			const encoder = Records.primaryStore.encoder;
			socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
			socket.emit(
				'message',
				encode([
					132,
					{ structures: encoder.structures, typedStructs: encoder.typedStructs, attributes: Records.attributes },
					Records.tableId,
					Records.tableName,
				])
			);
			socket.emit(
				'message',
				recordFrame(Records, 'put', id, undefined, version, undefined, { encodedRecord, extendedType: HAS_BLOBS })
			);
			await until(() => socket.sent.some((frame) => frame[0] === 144));
			assert.equal(Records.primaryStore.getEntry(id)?.version, version, 'the record commits before its blob finishes');
			const confirmations = () => socket.sent.filter((frame) => frame[0] === 144).map((frame) => frame[1]);
			assert.ok(
				confirmations().every((confirmed) => confirmed < version),
				'unfinished bytes cannot be confirmed'
			);
			socket.emit(
				'message',
				encode([
					146,
					{
						fileId: getFileId(announced[0]),
						size: payload.length,
						finished: true,
						...(fails ? { error: 'temporarily unavailable', errorStatus: 503 } : {}),
					},
					fails ? Buffer.alloc(0) : payload,
				])
			);
			if (fails) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.ok(
					confirmations().every((confirmed) => confirmed < version),
					'a failed blob still holds confirmation'
				);
			} else {
				const record = Records.primaryStore.getEntry(id).value;
				assert.deepEqual(Buffer.from(await record.body.arrayBuffer()), payload);
				await until(() => confirmations().includes(version));
			}
			assert.deepEqual(socket.closes, []);
		});
	for (const byAttribute of [false, true])
		for (const stubCapable of [false, true])
			it(`copies declarative stubs safely (attribute=${byAttribute}, stub capability=${stubCapable})`, async () => {
				const capabilities = { ...buildLocalCapabilities(90_000, false, true), residencyStubCopy: stubCapable ? 1 : 0 };
				const { Records, socket } = await connect(byAttribute, `copy_${stubCapable}`, false, capabilities);
				const context = {};
				await transaction(context, async () => {
					const row = await Records.getResource('stub', context, { ensureLoaded: false });
					row._writeInvalidate('stub', { id: 'stub', region: 0 }, { residencySlot: byAttribute ? 0 : undefined });
				});
				assert.ok(Records.primaryStore.getEntry('stub').metadataFlags & INVALIDATED);
				Records.setTTLExpiration(3600);
				await Records.put('full', { id: 'full', region: 0, body: 'canonical' });
				const prior = server.shards;
				server.shards = new Map([[0, [{ name: server.hostname }, { name: 'slot-control-peer' }]]]);
				try {
					socket.emit(
						'message',
						encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
					);
					await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
					assert.deepEqual(socket.closes, []);
					const copied = entries(socket);
					const stub = copied.find((entry) => entry.recordId === 'stub');
					if (stubCapable) assert.equal(stub?.type, 'invalidate');
					else
						assert.notEqual(
							stub?.type,
							'put',
							'a peer without safe invalidations must not receive a partial canonical put'
						);
					const full = copied.find((entry) => entry.recordId === 'full');
					assert.equal(full?.type, 'put');
					assert.equal(full.getValue(Records.primaryStore).body, 'canonical');
					assert.equal(
						full.extendedType & 0x0e000000,
						0,
						'primary metadata action bits must not enter the audit header'
					);
				} finally {
					server.shards = prior;
				}
			});

	it('copies an owner blob and a non-owner replica projection in the same walk', async () => {
		const priorShards = server.shards;
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'third-slot-owner', replicates: true }];
		const priorList = env.get('replication_shards');
		env.setProperty('replication_shards', [0, 1]);
		server.shards = new Map([
			[0, [{ name: server.hostname }, { name: 'slot-control-peer' }]],
			[1, [{ name: 'third-slot-owner' }]],
		]);
		try {
			const { socket, database } = await connect(false, 'mixed_blob_copy', false, undefined, undefined, undefined, [
				{ start: 0, end: 1, shard: 0 },
				{ start: 1, end: 2, shard: 1 },
			]);
			const Blobs = table({
				database,
				table: 'Blobs',
				audit: true,
				replicaExpiration: 3600,
				residency: { slots: 2, slotFrom: 'id.length % 2' },
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag', indexed: true }, { name: 'body' }],
			});
			setReplicator(database, Blobs, {});
			await Blobs.put('a', { id: 'a', tag: 'projected', body: createBlob(Buffer.alloc(32768, 11)) });
			const ownerPayload = Buffer.alloc(32768, 29);
			await Blobs.put('bb', { id: 'bb', tag: 'owned', body: createBlob(ownerPayload), extra: { shape: 'new' } });
			socket.emit(
				'message',
				encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
			);
			await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			await until(() => !hasActiveBlobSends());
			const copied = entries(socket);
			const projection = copied.find((entry) => entry.recordId === 'a');
			assert.equal(projection?.type, 'invalidate');
			assert.equal(projection.getValue(Blobs.primaryStore).tag, 'projected');
			assert.equal(projection.getValue(Blobs.primaryStore).body, undefined);
			const owner = copied.find((entry) => entry.recordId === 'bb');
			assert.equal(owner?.type, 'put');
			const value = owner.getValue(Blobs.primaryStore);
			assert.deepEqual(value.extra, { shape: 'new' });
			const chunks = socket.sent.filter((frame) => frame[0] === 146);
			assert.ok(chunks.length > 0);
			assert.ok(
				chunks.every((frame) => frame[1].fileId === getFileId(value.body)),
				'only the owner body starts a transfer, including audit catch-up'
			);
			const transfer = chunks.filter((frame) => frame[1].transferId === value.body.replicationTransferId);
			assert.ok(transfer.some((frame) => frame[1].finished));
			const bytes = Buffer.concat(transfer.map((frame) => frame[2]));
			assert.deepEqual(transfer[0][1].codec === 'deflate' ? inflateSync(bytes) : bytes, ownerPayload);
		} finally {
			server.shards = priorShards;
			server.nodes = priorNodes;
			env.setProperty('replication_shards', priorList);
		}
	});

	for (const indexed of [false, true])
		for (const owner of [false, true])
			for (const slotsCapable of [false, true])
				it(`copies blob bytes only to owners (indexed=${indexed}, owner=${owner}, slots=${slotsCapable})`, async () => {
					const { socket, database } = await connect(false, `blob_copy_${indexed}_${owner}_${slotsCapable}`, false, {
						...buildLocalCapabilities(90_000, false, true),
						residencySlots: slotsCapable ? 1 : 0,
					});
					const Blobs = table({
						database,
						table: 'Blobs',
						audit: true,
						residency: { slots: 2, slotFrom: '0' },
						attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag', indexed }, { name: 'body' }],
					});
					setReplicator(database, Blobs, {});
					const payload = Buffer.alloc(32768, 73);
					await Blobs.put('blob', { id: 'blob', tag: 'projected', body: createBlob(payload) });
					const prior = server.shards;
					if (owner) server.shards = new Map([[0, [{ name: server.hostname }, { name: 'slot-control-peer' }]]]);
					try {
						socket.emit(
							'message',
							encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
						);
						await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
						assert.deepEqual(socket.closes, []);
						await until(() => !hasActiveBlobSends());
						const chunks = socket.sent.filter((frame) => frame[0] === 146);
						const copied = entries(socket).find((entry) => entry.recordId === 'blob');
						if (owner) {
							assert.equal(copied?.type, 'put');
							const transferId = copied.getValue(Blobs.primaryStore).body.replicationTransferId;
							const transfer = chunks.filter((frame) => frame[1].transferId === transferId);
							assert.ok(transfer.some((frame) => frame[1].finished));
							const bytes = Buffer.concat(transfer.map((frame) => frame[2]));
							assert.deepEqual(transfer[0][1].codec === 'deflate' ? inflateSync(bytes) : bytes, payload);
						} else {
							assert.equal(chunks.length, 0, 'a projection or omitted row must not leave an unclaimed blob transfer');
							if (indexed) {
								assert.equal(copied?.type, 'invalidate');
								assert.equal(copied.getValue(Blobs.primaryStore).tag, 'projected');
								assert.equal(copied.getValue(Blobs.primaryStore).body, undefined);
							} else assert.equal(copied, undefined);
						}
					} finally {
						server.shards = prior;
					}
				});

	for (const closeNewest of [false, true])
		it(`keeps an eligible sending route when overlapping sockets close (newest=${closeNewest})`, async () => {
			const priorNodes = server.nodes;
			server.nodes = [{ name: 'slot-control-peer', replicates: true }];
			try {
				const first = await connect(false, `sender_liveness_${closeNewest}`);
				for (const socket of [first.socket]) {
					socket.emit(
						'message',
						encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
					);
					await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
					assert.deepEqual(socket.closes, []);
				}
				assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
				const state = new BigUint64Array(
					first.Records.auditStore.getUserSharedBuffer(
						['residency-sending', first.database, 'slot-control-peer'],
						new ArrayBuffer(16)
					)
				);
				Atomics.store(
					state,
					1,
					(Atomics.load(state, 1) & 0xffffffff00000000n) | BigInt((Date.now() - PING_TIMEOUT - 1) >>> 0)
				);
				assert.throws(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']), /connected/);
				first.socket.emit('pong');
				assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
				const second = await connect(false, `sender_liveness_${closeNewest}`);
				second.socket.emit(
					'message',
					encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
				);
				await until(() => second.socket.sent.some((frame) => frame[0] === 149) || second.socket.closes.length);
				assert.deepEqual(second.socket.closes, []);
				if (closeNewest) {
					second.socket.close();
					first.socket.emit('pong');
					assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
					first.socket.close();
				} else {
					first.socket.close();
					assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
					second.socket.close();
				}
				assert.throws(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']), /connected/);
			} finally {
				server.nodes = priorNodes;
			}
		});

	it('publishes a replacement sender heartbeat atomically with its generation', async () => {
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-control-peer', replicates: true }];
		let first, replacement;
		const store = Atomics.store;
		try {
			const { Records, database } = await connect(false, 'atomic_sender');
			first = registerResidencySender(Records.auditStore, database, 'slot-control-peer');
			assert.doesNotThrow(() => requireConnectedResidencyOwner(database, ['slot-control-peer']));
			let observed = false;
			// This synchronous scheduler hook lets a reader run at the shared-state publication.
			Atomics.store = (state, index, value) => {
				const result = store(state, index, value);
				if (index === 1 && !observed) {
					observed = true;
					assert.throws(() => requireConnectedResidencyOwner(database, ['slot-control-peer']), /connected/);
				}
				return result;
			};
			replacement = registerResidencySender(
				Records.auditStore,
				database,
				'slot-control-peer',
				Date.now() - PING_TIMEOUT - 1
			);
			assert.equal(observed, true, 'observed the replacement publication');
		} finally {
			Atomics.store = store;
			replacement?.close();
			first?.close();
			server.nodes = priorNodes;
		}
	});

	it('does not replace sender liveness when a superseded setup wait resumes', async () => {
		let resume, subscription;
		const gate = new Promise((resolve) => {
			resume = resolve;
		});
		const connection = new EventEmitter();
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-control-peer', replicates: true }];
		const first = await connect(
			false,
			'superseded_sender',
			false,
			undefined,
			(database) => {
				subscription = databaseSubscriptions.get(database);
				databaseSubscriptions.set(database, gate);
			},
			connection
		);
		try {
			const subscribe = (socket) =>
				socket.emit(
					'message',
					encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
				);
			subscribe(first.socket);
			for (let n = 0; n < 30; n++) await new Promise(setImmediate);
			databaseSubscriptions.set(first.database, subscription);
			const second = await connect(false, 'superseded_sender', false, undefined, undefined, connection);
			subscribe(second.socket);
			await until(() => second.socket.sent.some((frame) => frame[0] === 149) || second.socket.closes.length);
			assert.deepEqual(second.socket.closes, []);
			assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
			resume(subscription);
			for (let n = 0; n < 30; n++) await new Promise(setImmediate);
			first.socket.close();
			assert.doesNotThrow(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']));
			second.socket.close();
			assert.throws(() => requireConnectedResidencyOwner(first.database, ['slot-control-peer']), /connected/);
		} finally {
			resume(subscription);
			databaseSubscriptions.set(first.database, subscription);
			server.nodes = priorNodes;
		}
	});

	it('does not publish a placement failure after a closed subscription wait resumes', async () => {
		let resume, subscription;
		const gate = new Promise((resolve) => {
			resume = resolve;
		});
		const { Records, socket, database } = await connect(true, 'closed_receive', false, undefined, (database) => {
			subscription = databaseSubscriptions.get(database);
			databaseSubscriptions.set(database, gate);
		});
		const priorNodes = server.nodes;
		server.nodes = [{ name: 'slot-control-peer' }];
		try {
			const encoder = Records.primaryStore.encoder;
			socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
			socket.emit(
				'message',
				encode([
					132,
					{
						structures: encoder.structures,
						typedStructs: encoder.typedStructs,
						attributes: Records.attributes,
						schemaDefined: true,
						residency: Records.residency,
					},
					Records.tableId,
					Records.tableName,
				])
			);
			socket.emit(
				'message',
				recordFrame(Records, 'put', 'late', { id: 'late', region: 99, body: 'invalid' }, Date.now())
			);
			await until(() => socket.paused || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			socket.close();
			resume(subscription);
			for (let n = 0; n < 30; n++) await new Promise(setImmediate);
			assert.deepEqual(residencyTopologyErrors(database), [], 'a closed socket cannot block its replacement');
		} finally {
			resume(subscription);
			databaseSubscriptions.set(database, subscription);
			server.nodes = priorNodes;
		}
	});

	it('sends index invalidations to a known peer without a shard', async () => {
		const { Records, socket, database } = await connect(false, 'unsharded');
		socket.emit(
			'message',
			encode([
				140,
				'slot-control-peer',
				database,
				[],
				buildLocalCapabilities(90_000, true, true),
				{ shardsDigest: getResidencyConfiguration().digest, shard: null },
			])
		);
		const Nodes = getHDBNodeTable();
		const name = 'slot-control-peer';
		const previous = Nodes.primaryStore.getSync(name);
		const known = server.shards;
		await Nodes.primaryStore.put(name, { name, url: 'http://127.0.0.1:19001', replicates: true });
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		try {
			socket.emit('message', encode([129, [{ name, startTime: 0, tables: [], replicateByDefault: true }], []]));
			await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
			await Records.put('unsharded-reader', { id: 'unsharded-reader', region: 0, body: 'complete' });
			await until(() => socket.closes.length || entries(socket).some((entry) => entry.recordId === 'unsharded-reader'));
			assert.deepEqual(socket.closes, []);
			assert.equal(entries(socket).find((entry) => entry.recordId === 'unsharded-reader')?.type, 'invalidate');
		} finally {
			if (previous) await Nodes.primaryStore.put(name, previous);
			else await Nodes.primaryStore.remove(name);
			server.shards = known;
		}
	});

	it('uses a legacy unsharded peer self-announcement without trusting tentative rows', async () => {
		const { Records, socket } = await connect(false, 'legacy_unsharded', false, {
			...buildLocalCapabilities(90_000, true, true),
			residencySlots: undefined,
		});
		const Nodes = getHDBNodeTable();
		const name = 'slot-control-peer';
		const previous = Nodes.primaryStore.getSync(name);
		const known = server.shards;
		const context = {};
		await transaction(context, async () => {
			const resource = await Nodes.getResource(name, context);
			resource._writeUpdate(name, { name, url: 'http://127.0.0.1:19001', replicates: true }, true, {
				isNotification: true,
				nodeId: getIdOfRemoteNode(name, Nodes.auditStore),
			});
			await resource.save();
		});
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		try {
			socket.emit('message', encode([129, [{ name, startTime: 0, tables: [], replicateByDefault: true }], []]));
			await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
			await Records.put('unsharded-reader', { id: 'unsharded-reader', region: 0, body: 'complete' });
			await until(() => socket.closes.length || entries(socket).some((entry) => entry.recordId === 'unsharded-reader'));
			assert.deepEqual(socket.closes, []);
			assert.equal(entries(socket).find((entry) => entry.recordId === 'unsharded-reader')?.type, 'invalidate');
		} finally {
			if (previous) await Nodes.primaryStore.put(name, previous);
			else await Nodes.primaryStore.remove(name);
			server.shards = known;
		}
	});

	it('does not treat a tentative url-only peer row as an unsharded reader', async () => {
		const { Records, socket } = await connect(false, 'tentative');
		const Nodes = getHDBNodeTable();
		const name = 'slot-control-peer';
		const previous = Nodes.primaryStore.getSync(name);
		const known = server.shards;
		await Nodes.primaryStore.put(name, { name, url: 'http://127.0.0.1:19001', replicates: true });
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		try {
			socket.emit('message', encode([129, [{ name, startTime: 0, tables: [], replicateByDefault: true }], []]));
			await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
			await Records.put('tentative-owner', { id: 'tentative-owner', region: 0, body: 'complete' });
			await until(() => socket.closes.length || entries(socket).some((entry) => entry.recordId === 'tentative-owner'));
			assert.ok(socket.closes.length, 'a tentative row does not prove non-ownership');
			assert.ok(!entries(socket).some((entry) => entry.recordId === 'tentative-owner'));
		} finally {
			if (previous) await Nodes.primaryStore.put(name, previous);
			else await Nodes.primaryStore.remove(name);
			server.shards = known;
		}
	});

	it('holds record delivery when the receiver shard is not known', async () => {
		const { Records, socket } = await connect(false, 'unknown');
		socket.emit(
			'message',
			encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
		);
		await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
		const known = server.shards;
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		try {
			await Records.put('unknown-owner', { id: 'unknown-owner', region: 0, body: 'complete' });
			await until(() => socket.closes.length || entries(socket).some((entry) => entry.recordId === 'unknown-owner'));
			assert.ok(socket.closes.length, 'unknown membership must hold the stream');
			assert.ok(!entries(socket).some((entry) => entry.recordId === 'unknown-owner'));
		} finally {
			server.shards = known;
		}
	});

	it('sends a newer map before a reference using its version on an active stream', async () => {
		const { Records, socket, database } = await connect(false, 'extension');
		socket.emit(
			'message',
			encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
		);
		await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
		await Records.put('before', { id: 'before', region: 0, body: 'complete' });
		await until(() => entries(socket).some((entry) => entry.recordId === 'before'));
		const from = socket.sent.length;
		const extended = createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 0 }], 2);
		await installResidencyMap(extended);
		await Records.put('after', { id: 'after', region: 0, body: 'complete' });
		await until(() => entries(socket).some((entry) => entry.recordId === 'after') || socket.closes.length);
		assert.deepEqual(socket.closes, []);
		const frames = socket.sent.slice(from);
		const snapshot = frames.findIndex((frame) => frame[0] === 145 && frame[5]?.snapshot?.digest === extended.digest);
		const reference = frames.findIndex((frame) => frame[0] === 130 && frame[1]?.mapDigest === extended.digest);
		assert.ok(snapshot >= 0 && snapshot < reference, 'new snapshot must precede its reference');
	});

	for (const byAttribute of [false, true]) {
		it(`sends control and root-topic events without a record slot (byAttribute=${byAttribute})`, async () => {
			const { Records, socket, database } = await connect(byAttribute, 'send');
			socket.emit(
				'message',
				encode([129, [{ name: 'slot-control-peer', startTime: 0, tables: [], replicateByDefault: true }], []])
			);
			await until(() => socket.sent.some((frame) => frame[0] === 149) || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			await writeLockBarrier(database, Records.tableName, 17);
			await until(() => entries(socket).some((entry) => entry.type === 'lockBarrier') || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			const barrier = entries(socket).find((entry) => entry.type === 'lockBarrier');
			assert.equal(barrier.recordId, null);
			assert.equal(barrier.residencyId, undefined);
			assert.equal(barrier.residencySlot, undefined);
			await Records.publish(null, { event: 'notice' });
			await until(() => entries(socket).some((entry) => entry.type === 'message') || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			const event = entries(socket).find((entry) => entry.type === 'message');
			assert.equal(event.recordId, null);
			assert.equal(event.residencyId, undefined);
			await Records.put('published', { id: 'published', region: 0, body: 'complete' });
			await Records.publish('published', { event: 'record-notice' });
			await until(() => entries(socket).some((entry) => entry.type === 'message' && entry.recordId === 'published'));
			const recordEvent = entries(socket).find((entry) => entry.type === 'message' && entry.recordId === 'published');
			assert.equal(recordEvent.residencySlot, undefined);
			assert.equal(recordEvent.previousResidencySlot, undefined);
			assert.equal(recordEvent.residencyId, undefined);
		});
		it(`receives control traffic before the next record (byAttribute=${byAttribute})`, async () => {
			const { Records, socket } = await connect(byAttribute, 'receive');
			const version = Date.now();
			const frames = [
				recordFrame(Records, 'lockBarrier', null, [1, 18], version),
				recordFrame(Records, 'message', 'notice', { event: 'notice' }, version + 1),
				recordFrame(Records, 'put', 'after-control', { id: 'after-control', region: 0, body: 'complete' }, version + 2),
			];
			const encoder = Records.primaryStore.encoder;
			socket.emit('message', encode([141, { 'slot-control-peer': 0 }, ['slot-control-peer']]));
			socket.emit(
				'message',
				encode([
					132,
					{
						structures: encoder.structures,
						typedStructs: encoder.typedStructs,
						attributes: Records.attributes,
						schemaDefined: true,
						residency: Records.residency,
					},
					Records.tableId,
					Records.tableName,
				])
			);
			for (const frame of frames) socket.emit('message', frame);
			await until(() => Records.primaryStore.getEntry('after-control')?.value || socket.closes.length);
			assert.deepEqual(socket.closes, []);
			assert.equal(Records.primaryStore.getEntry('after-control').value.body, 'complete');
		});
	}
});
