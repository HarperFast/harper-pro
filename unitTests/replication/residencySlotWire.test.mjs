import assert from 'node:assert';
import { encode } from 'msgpackr';
import {
	createAuditEntry,
	readAuditEntry,
	HAS_CURRENT_RESIDENCY_SLOT,
	HAS_PREVIOUS_RESIDENCY_SLOT,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_PREVIOUS_RESIDENCY_ID,
	HAS_EXPIRATION_EXTENDED_TYPE,
	HAS_ORIGINATING_OPERATION,
	HAS_ADDITIONAL_AUDIT_REFS,
} from '#src/core/resources/auditStore';
import { createWireAuditEntry, encodeResidencyWireRecord } from '#src/replication/residencyWire';

class PrivateEntry {
	#entry;
	constructor(entry) {
		this.#entry = entry;
		for (const key of [
			'type',
			'tableId',
			'nodeId',
			'version',
			'previousVersion',
			'extendedType',
			'residencyId',
			'previousResidencyId',
			'residencySlot',
			'previousResidencySlot',
			'expiresAt',
			'originatingOperation',
			'previousAdditionalAuditRefs',
		])
			this[key] = entry[key];
	}
	get recordId() {
		return this.#entry.recordId;
	}
	get user() {
		return this.#entry.user;
	}
	get encoded() {
		return this.#entry.encoded;
	}
	getBinaryValue() {
		return this.#entry.getBinaryValue();
	}
}

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
	describe('an entry whose accessors and methods are prototype members over #private state', () => {
		const stored = (overrides = {}) =>
			readAuditEntry(
				createAuditEntry({
					tableId: 2,
					nodeId: 3,
					version: Date.now(),
					recordId: 'author-key',
					user: 'author',
					type: 'put',
					extendedType: HAS_CURRENT_RESIDENCY_SLOT | HAS_PREVIOUS_RESIDENCY_SLOT,
					residencySlot: 5,
					previousResidencySlot: 6,
					encodedRecord: encode({ id: 'author-key' }),
					...overrides,
				})
			);
		it('reframes to the same bytes as an entry carrying them as own properties', () => {
			const entry = stored();
			const expected = encodeResidencyWireRecord(entry, 0x80000000, 0x80000001);
			const wire = encodeResidencyWireRecord(new PrivateEntry(entry), 0x80000000, 0x80000001);
			assert.deepEqual(wire, expected);
			const reread = readAuditEntry(wire);
			assert.equal(reread.recordId, 'author-key');
			assert.equal(reread.user, 'author');
			assert.deepEqual(reread.getBinaryValue(), entry.getBinaryValue());
		});
		it('builds the invalidation header with its key, writer and version', () => {
			const entry = stored();
			const header = {
				tableId: entry.tableId,
				nodeId: entry.nodeId,
				type: 'invalidate',
				extendedType: HAS_CURRENT_RESIDENCY_ID,
				residencyId: 42,
				previousResidencyId: undefined,
				encodedRecord: encode({ id: 'author-key' }),
			};
			const wire = createWireAuditEntry(new PrivateEntry(entry), header);
			assert.deepEqual(wire, createWireAuditEntry(entry, header));
			const reread = readAuditEntry(wire);
			assert.equal(reread.type, 'invalidate');
			assert.equal(reread.recordId, 'author-key');
			assert.equal(reread.user, 'author');
			assert.equal(reread.version, entry.version);
			assert.equal(reread.residencyId, 42);
		});
	});
	describe('header field parity with core', () => {
		// A member of a decoded entry that is not listed here arrived with a core bump: decide how the wire
		// handles it, then list it.
		const known = [
			'type',
			'tableId',
			'nodeId',
			'version',
			'residencyId',
			'previousResidencyId',
			'residencySlot',
			'previousResidencySlot',
			'expiresAt',
			'originatingOperation',
			'previousAdditionalAuditRefs',
			'previousVersion',
			'extendedType',
			'logName',
			'txnLogKey',
			'endTxn',
			'structureVersion',
			'encoded',
			'size',
			'recordId',
			'user',
			'getValue',
			'getBinaryValue',
			'getBinaryRecordId',
		];
		const memberNames = (entry) => {
			const names = new Set();
			for (let object = entry; object && object !== Object.prototype; object = Object.getPrototypeOf(object))
				for (const name of Object.getOwnPropertyNames(object)) if (name !== 'constructor') names.add(name);
			return [...names];
		};
		const unhandled = (entry) => memberNames(entry).filter((name) => !known.includes(name));
		const everyField = () =>
			readAuditEntry(
				createAuditEntry({
					tableId: 2,
					nodeId: 3,
					version: 1_800_000_000_123.5,
					recordId: 'parity-key',
					user: 'parity-user',
					type: 'put',
					previousVersion: 2 ** 40,
					extendedType:
						HAS_CURRENT_RESIDENCY_SLOT |
						HAS_PREVIOUS_RESIDENCY_SLOT |
						HAS_CURRENT_RESIDENCY_ID |
						HAS_PREVIOUS_RESIDENCY_ID |
						HAS_EXPIRATION_EXTENDED_TYPE |
						HAS_ORIGINATING_OPERATION |
						HAS_ADDITIONAL_AUDIT_REFS,
					residencyId: 9,
					previousResidencyId: 8,
					residencySlot: 5,
					previousResidencySlot: 6,
					expiresAt: 1_900_000_000_000,
					originatingOperation: 'insert',
					previousAdditionalAuditRefs: [{ version: 1_700_000_000_000, nodeId: 4 }],
					encodedRecord: encode({ id: 'parity-key', body: 'parity' }),
				})
			);
		it('round-trips every header field through a reframe, except those it changes on purpose', () => {
			const entry = everyField();
			const wire = readAuditEntry(encodeResidencyWireRecord(entry, 0x80000000, 0x80000001));
			for (const field of ['type', 'tableId', 'nodeId', 'version', 'recordId', 'user'])
				assert.equal(wire[field], entry[field], field);
			assert.equal(wire.expiresAt, entry.expiresAt);
			assert.equal(wire.originatingOperation, entry.originatingOperation);
			assert.deepEqual(wire.previousAdditionalAuditRefs, entry.previousAdditionalAuditRefs);
			assert.deepEqual(wire.getBinaryValue(), entry.getBinaryValue());
			assert.equal(wire.residencyId, 0x80000000);
			assert.equal(wire.previousResidencyId, 0x80000001);
			assert.equal(wire.residencySlot, undefined);
			assert.equal(wire.previousResidencySlot, undefined);
			assert.equal(wire.previousVersion, undefined);
			assert.equal(wire.extendedType & (HAS_CURRENT_RESIDENCY_SLOT | HAS_PREVIOUS_RESIDENCY_SLOT), 0);
		});
		it('round-trips every header field through an invalidation header', () => {
			const entry = everyField();
			const wire = readAuditEntry(
				createWireAuditEntry(entry, {
					tableId: entry.tableId,
					nodeId: entry.nodeId,
					type: 'invalidate',
					extendedType: HAS_CURRENT_RESIDENCY_ID | HAS_PREVIOUS_RESIDENCY_ID,
					residencyId: 9,
					previousResidencyId: 8,
					encodedRecord: encode({ id: 'parity-key' }),
				})
			);
			for (const field of ['tableId', 'nodeId', 'version', 'recordId', 'user'])
				assert.equal(wire[field], entry[field], field);
			assert.equal(wire.residencyId, 9);
			assert.equal(wire.previousResidencyId, 8);
			assert.equal(wire.type, 'invalidate');
		});
		it('names every field and accessor an entry exposes, so a new one needs a wire decision', () => {
			assert.deepEqual(
				unhandled(everyField()),
				[],
				'decide whether the wire header carries these, then list them here'
			);
		});
		it('reports an accessor or method added to the entry itself or to a prototype', () => {
			const entry = everyField();
			const descriptors = Object.getOwnPropertyDescriptors(entry);
			const inheritedAccessor = Object.create(
				Object.create(Object.getPrototypeOf(entry), { addedLater: { get: () => 1 } }),
				descriptors
			);
			const ownAccessor = Object.create(Object.getPrototypeOf(entry), {
				...descriptors,
				addedLater: { get: () => 1 },
			});
			const inheritedMethod = Object.create(
				Object.create(Object.getPrototypeOf(entry), { addedMethod: { value() {} } }),
				descriptors
			);
			assert.deepEqual(unhandled(inheritedAccessor), ['addedLater']);
			assert.deepEqual(unhandled(ownAccessor), ['addedLater']);
			assert.deepEqual(unhandled(inheritedMethod), ['addedMethod']);
		});
	});
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
