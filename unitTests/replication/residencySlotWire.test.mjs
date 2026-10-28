import assert from 'node:assert';
import { encode } from 'msgpackr';
import {
	createAuditEntry,
	readAuditEntry,
	HAS_CURRENT_RESIDENCY_SLOT,
	HAS_PREVIOUS_RESIDENCY_SLOT,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_PREVIOUS_RESIDENCY_ID,
} from '#src/core/resources/auditStore';
import { encodeResidencyWireRecord } from '#src/replication/residencyWire';

describe('Sharding wire headers', () => {
	for (const residencyId of [undefined, 42]) {
		it(`strips an event's local slot fields without adding placement (legacy ID=${residencyId})`, () => {
			const original = readAuditEntry(
				createAuditEntry({
					tableId: 2,
					nodeId: 3,
					version: Date.now(),
					recordId: 'published',
					type: 'message',
					extendedType: HAS_CURRENT_RESIDENCY_SLOT | (residencyId === undefined ? 0 : HAS_CURRENT_RESIDENCY_ID),
					residencySlot: 0,
					residencyId,
					encodedRecord: encode({ event: 'notice' }),
				})
			);
			const wire = readAuditEntry(encodeResidencyWireRecord(original, residencyId));
			assert.equal(wire.residencySlot, undefined);
			assert.equal(wire.residencyId, residencyId);
			assert.equal(wire.type, 'message');
			assert.equal(Boolean(wire.extendedType & HAS_CURRENT_RESIDENCY_ID), residencyId !== undefined);
			assert.deepEqual(wire.getBinaryValue(), original.getBinaryValue());
		});
	}
	for (const slot of [0, 65535]) {
		it(`replaces native slot ${slot} fields with connection references without changing the body`, () => {
			const body = encode({ id: 'row', body: 'complete', region: slot });
			const stored = createAuditEntry({
				tableId: 2,
				nodeId: 3,
				version: Date.now(),
				recordId: 'row',
				type: 'put',
				extendedType: HAS_CURRENT_RESIDENCY_SLOT | HAS_PREVIOUS_RESIDENCY_SLOT,
				residencySlot: slot,
				previousResidencySlot: 12,
				encodedRecord: body,
			});
			const original = readAuditEntry(stored);
			const wire = readAuditEntry(encodeResidencyWireRecord(original, 0x80000000, 0x80000001));
			assert.equal(wire.extendedType & (HAS_CURRENT_RESIDENCY_SLOT | HAS_PREVIOUS_RESIDENCY_SLOT), 0);
			assert.ok(wire.extendedType & HAS_CURRENT_RESIDENCY_ID);
			assert.ok(wire.extendedType & HAS_PREVIOUS_RESIDENCY_ID);
			assert.equal(wire.residencyId, 0x80000000);
			assert.equal(wire.previousResidencyId, 0x80000001);
			assert.equal(wire.residencySlot, undefined);
			assert.equal(wire.previousResidencySlot, undefined);
			assert.deepEqual(wire.getBinaryValue(), body);
			assert.equal(wire.recordId, original.recordId);
			assert.equal(wire.nodeId, original.nodeId);
			assert.equal(wire.version, original.version);
		});
	}
	it('drops a historical node-list identity when reframing a converted key-derived record', () => {
		const stored = readAuditEntry(
			createAuditEntry({
				tableId: 2,
				nodeId: 3,
				version: Date.now(),
				recordId: 'key1',
				type: 'delete',
				extendedType: HAS_CURRENT_RESIDENCY_ID | HAS_PREVIOUS_RESIDENCY_ID,
				residencyId: 42,
				previousResidencyId: 43,
			})
		);
		const wire = readAuditEntry(encodeResidencyWireRecord(stored, 0x80000000));
		assert.equal(wire.residencyId, 0x80000000);
		assert.equal(wire.previousResidencyId, undefined);
		assert.equal(wire.type, 'delete');
		assert.equal(wire.extendedType & HAS_PREVIOUS_RESIDENCY_ID, 0);
	});
});

describe('Slot reference agreement', function () {
	this.timeout(15_000);
	let Maps, config, server, oldShards, oldList, oldShard, Table;
	before(async () => {
		({ server } = await import('#src/core/server/Server'));
		config = await import('#src/core/utility/environment/environmentManager');
		Maps = await import('#src/core/resources/residencyMaps');
		config.setHdbBasePath(process.env.STORAGE_PATH);
		oldShards = server.shards;
		oldList = config.get('replication_shards');
		oldShard = config.get('replication_shard');
		config.setProperty('replication_shards', [0]);
		config.setProperty('replication_shard', 0);
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
		await Maps.initializeResidencySlots({
			database: 'slot_wire',
			slots: 10,
			ranges: [{ start: 0, end: 10, shard: 0 }],
		});
		Table = { databaseName: 'slot_wire', tableName: 'Records', residency: { slots: 10 }, getResidencySlot: () => 2 };
	});
	after(() => {
		server.shards = oldShards;
		config.setProperty('replication_shards', oldList);
		config.setProperty('replication_shard', oldShard);
	});
	it('refuses invalid attribute slots even when their map identity matches', async () => {
		const { resolveSlotReference } = await import('#src/replication/residencyWire');
		const snapshot = Maps.readResidencyMap('slot_wire');
		const attributeTable = { ...Table, residency: { slots: 10, byAttribute: true } };
		for (const slot of [-1, 10, 0.5, undefined])
			assert.throws(
				() =>
					resolveSlotReference(attributeTable, 'row', {
						slot,
						mapVersion: snapshot.version,
						mapDigest: snapshot.digest,
					}),
				/invalid record sharding slot/
			);
	});

	it('uses descriptors only for capable peers and resolved names for legacy peers', async () => {
		const { ResidencyWireReferences } = await import('#src/replication/residencyWire');
		const refs = new ResidencyWireReferences();
		const sent = [];
		const send = (value, id) => sent.push({ value, id });
		const id = refs.reference(Table, 2, true, send);
		assert.equal(refs.reference(Table, 2, true, send), id);
		assert.equal(sent.length, 1);
		const map = Maps.readResidencyMap('slot_wire');
		assert.deepEqual(sent[0].value, { slot: 2, mapVersion: map.version, mapDigest: map.digest });
		assert.notEqual(refs.reference(Table, 2, false, send), id);
		assert.deepEqual(sent[1].value, [server.hostname]);
	});
	it('accepts an older reference only with its advertised compatible snapshot', async () => {
		const { resolveSlotReference } = await import('#src/replication/residencyWire');
		const old = Maps.readResidencyMap('slot_wire');
		const { createResidencyMap } = await import('#src/core/resources/residencyPolicy');
		await Maps.installResidencyMap(createResidencyMap('slot_wire', 10, old.ranges, old.version + 1));
		const reference = { slot: 2, mapVersion: old.version, mapDigest: old.digest };
		assert.equal(resolveSlotReference(Table, 'key', reference, old), 2);
		assert.throws(() => resolveSlotReference(Table, 'key', reference), /map/);
		assert.throws(() => resolveSlotReference(Table, 'key', { ...reference, mapDigest: 'unadvertised' }, old), /map/);
	});
	it('refuses a missing version, wrong digest, out-of-bounds slot, and a key/slot disagreement', async () => {
		const { resolveSlotReference } = await import('#src/replication/residencyWire');
		const map = Maps.readResidencyMap('slot_wire');
		const valid = { slot: 2, mapVersion: map.version, mapDigest: map.digest };
		assert.equal(resolveSlotReference(Table, 'key', valid), 2);
		for (const reference of [
			{ ...valid, mapVersion: undefined },
			{ ...valid, mapDigest: 'wrong' },
			{ ...valid, slot: 10 },
			{ ...valid, slot: 1 },
		])
			assert.throws(() => resolveSlotReference(Table, 'key', reference), /map|slot/);
	});
});
