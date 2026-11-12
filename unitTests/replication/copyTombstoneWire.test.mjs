import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { decode, encode } from 'msgpackr';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { table } from '#src/core/resources/databases';
import { transaction } from '#src/core/resources/transaction';
import { getIdOfRemoteNode } from '#src/core/resources/nodeIdMapping';
import { getThisNodeName } from '#src/core/server/nodeName';
import { ACTION_32_BIT, createAuditEntry, Decoder, readAuditEntry } from '#src/core/resources/auditStore';
import { FULL_WRITE_HEAD } from '#src/core/resources/Table';
import { buildLocalCapabilities } from '#src/replication/protocolCapabilities';
import {
	boundaryOutranksHead,
	databaseSubscriptions,
	encodeCopyRecordValue,
	replicateOverWS,
} from '#src/replication/replicationConnection';
import { setReplicator } from '#src/replication/replicator';

const SUBSCRIPTION_REQUEST = 129;
const NODE_NAME = 140;
const OPERATION_REQUEST = 136;
const OPERATION_RESPONSE = 137;
const COPY_START = 148;
const COPY_COMPLETE = 149;
const DATABASE = 'copyTombstoneWire';
const PEER = 'copy-tombstone-wire-peer';

class Socket extends EventEmitter {
	readyState = 1;
	sent = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		this.sent.push(data[0] > 127 ? decode(Buffer.from(data)) : Buffer.from(data));
	}
	close(code = 1000, reason = '') {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.emit('close', code, Buffer.from(reason));
	}
	terminate() {
		this.close(1006);
	}
	ping() {}
	pause() {}
	resume() {}
}

async function until(predicate) {
	const deadline = Date.now() + 15_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, 'replication response timed out');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('delete tombstones in a base copy', function () {
	this.timeout(30_000);
	let Records,
		socket,
		boundaryVersion,
		nativeDeleteVersion,
		strongerVersion,
		tieVersion,
		tieOrigins,
		aheadVersion,
		laterBoundaryVersion;

	before(async function () {
		// FULL_WRITE_HEAD and copy-apply are RocksDB-only
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		setHdbBasePath(process.env.STORAGE_PATH);
		Records = table({
			database: DATABASE,
			table: 'Records',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		await Records.put('live', { id: 'live', name: 'live' });
		await Records.put('deleted', { id: 'deleted', name: 'gone' });
		await Records.delete('deleted');
		await Records.publish('published', { message: 'no record' });
		// what a node that itself joined by copy holds: an audit-less tombstone
		const takeCopiedDelete = async (key, version) => {
			const context = { source: {}, sourceApply: true, timestamp: version };
			await transaction(context, async () => {
				const resource = await Records.getResource(key, context, { ensureLoaded: false });
				await resource._writeDelete(key, {
					isNotification: true,
					isCopyApply: true,
					nodeId: getIdOfRemoteNode('copy-tombstone-origin', Records.auditStore),
					version,
				});
			});
		};
		await takeCopiedDelete('copied-deleted', Date.now() - 1000);
		boundaryVersion = Date.now() - 2000;
		await takeCopiedDelete('published-over-delete', boundaryVersion);
		await Records.publish('published-over-delete', { message: 'no record' });
		strongerVersion = Date.now() - 4000;
		await takeCopiedDelete('stronger-boundary', strongerVersion);
		for (const [version, write] of [
			[strongerVersion - 3000, (row, options) => row._writePublish('stronger-boundary', { message: 'm' }, options)],
			[strongerVersion - 200, (row, options) => row._writeDelete('stronger-boundary', options)],
		]) {
			const context = { source: {}, sourceApply: true, timestamp: version };
			await transaction(context, async () => {
				const row = await Records.getResource('stronger-boundary', context, { ensureLoaded: false });
				await write(row, {
					isNotification: true,
					nodeId: getIdOfRemoteNode('copy-tombstone-origin', Records.auditStore),
					version,
				});
			});
		}
		tieVersion = Date.now() - 6000;
		tieOrigins = ['copy-tombstone-tie-a', 'copy-tombstone-tie-z'].map((name) =>
			getIdOfRemoteNode(name, Records.auditStore)
		);
		for (const [version, origin, copy, write] of [
			[tieVersion, tieOrigins[1], true, (row, options) => row._writeDelete('tie-boundary', options)],
			[
				tieVersion - 3000,
				tieOrigins[1],
				false,
				(row, options) => row._writePublish('tie-boundary', { message: 'm' }, options),
			],
			[tieVersion, tieOrigins[0], false, (row, options) => row._writeDelete('tie-boundary', options)],
		]) {
			const context = { source: {}, sourceApply: true, timestamp: version };
			await transaction(context, async () => {
				const row = await Records.getResource('tie-boundary', context, { ensureLoaded: false });
				await write(row, { isNotification: true, isCopyApply: copy, nodeId: origin, version });
			});
		}
		await Records.put('native-covered', { id: 'native-covered', name: 'gone' });
		await Records.delete('native-covered');
		nativeDeleteVersion = Records.primaryStore.getEntry('native-covered').version;
		await Records.publish('native-covered', { message: 'no record' });
		// a delete from an origin whose clock runs ahead of this node's log, under a later local publish
		aheadVersion = Date.now() + 60_000;
		await takeCopiedDelete('ahead-under-publish', aheadVersion);
		await Records.publish('ahead-under-publish', { message: 'no record' });
		// a publish keyed past this node's own log, from such an origin, over an older delete
		laterBoundaryVersion = Date.now() - 3000;
		await takeCopiedDelete('under-later-publish', laterBoundaryVersion);
		const laterPublish = { source: {}, sourceApply: true, timestamp: Date.now() + 60_000 };
		await transaction(laterPublish, async () => {
			const row = await Records.getResource('under-later-publish', laterPublish, { ensureLoaded: false });
			await row._writePublish(
				'under-later-publish',
				{ message: 'm' },
				{
					isNotification: true,
					nodeId: getIdOfRemoteNode('copy-tombstone-origin', Records.auditStore),
					version: laterPublish.timestamp,
				}
			);
		});
		setReplicator(DATABASE, Records, {});
		await until(() => databaseSubscriptions.get(DATABASE)?.auditStore);
		const tombstone = Records.primaryStore.getEntry('deleted');
		assert.equal(tombstone.value, null);
		assert.ok(tombstone.metadataFlags & FULL_WRITE_HEAD, 'premise: a flagged tombstone');
		const published = Records.primaryStore.getEntry('published');
		assert.equal(published.value, null);
		assert.equal(published.metadataFlags & FULL_WRITE_HEAD, 0, 'premise: a publish-only head is unflagged');
		const covered = Records.primaryStore.getEntry('published-over-delete');
		assert.equal(covered.value, null);
		assert.equal(covered.metadataFlags & FULL_WRITE_HEAD, 0, 'premise: a publish clears the flag');
		assert.equal(covered.copiedDeleteBoundary?.version, boundaryVersion, 'premise: the delete outlives the publish');
		assert.ok(covered.version > boundaryVersion);
		const stronger = Records.primaryStore.getEntry('stronger-boundary');
		assert.ok(stronger.metadataFlags & FULL_WRITE_HEAD, 'premise: a flagged tombstone');
		assert.ok(stronger.version < strongerVersion, 'premise: its own version is below the boundary');
		assert.equal(stronger.copiedDeleteBoundary?.version, strongerVersion);
		const tie = Records.primaryStore.getEntry('tie-boundary');
		assert.ok(tie.metadataFlags & FULL_WRITE_HEAD, 'premise: a flagged tombstone');
		assert.equal(tie.version, tieVersion);
		assert.equal(tie.nodeId, tieOrigins[0], 'premise: the head is the lower origin name');
		assert.deepEqual(tie.copiedDeleteBoundary, { version: tieVersion, nodeId: tieOrigins[1] });
		const nativeCovered = Records.primaryStore.getEntry('native-covered');
		assert.equal(nativeCovered.metadataFlags & FULL_WRITE_HEAD, 0);
		assert.deepEqual(nativeCovered.copiedDeleteBoundary, { version: nativeDeleteVersion, nodeId: 0 });
	});

	afterEach(() => socket?.close());

	async function connect(bag) {
		socket = new Socket();
		replicateOverWS(socket, bag ? {} : { database: DATABASE }, { name: PEER, replicates: true });
		if (bag) {
			socket.emit('message', encode([NODE_NAME, PEER, DATABASE, [], bag]));
			await until(() => socket.sent.some((frame) => frame[0] === NODE_NAME));
		}
	}

	async function copiedRecords(unlearned = false, declared = {}, subscriptions = []) {
		socket.emit(
			'message',
			encode([
				SUBSCRIPTION_REQUEST,
				[{ name: PEER, startTime: 0, tables: [], replicateByDefault: true, ...declared }, ...subscriptions],
				[],
			])
		);
		if (unlearned) {
			// no safeCopyAudit either, so the copy first asks for the peer's version
			await until(() => socket.sent.some((frame) => frame[0] === OPERATION_REQUEST));
			const { requestId } = socket.sent.find((frame) => frame[0] === OPERATION_REQUEST)[1];
			socket.emit('message', encode([OPERATION_RESPONSE, { requestId, version: '5.3.0' }]));
		}
		await until(() => socket.sent.some((frame) => frame[0] === COPY_COMPLETE));
		const start = socket.sent.findIndex((frame) => frame[0] === COPY_START);
		const end = socket.sent.findIndex((frame) => frame[0] === COPY_COMPLETE);
		assert.ok(start >= 0 && end > start, 'must exercise the base-copy row walk');
		const records = new Map();
		records.sent = new Map();
		records.anchor = socket.sent[start][1];
		for (const frame of socket.sent.slice(start + 1, end)) {
			if (!Buffer.isBuffer(frame)) continue;
			const frameKey = frame.readDoubleBE(0);
			const decoder = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
			decoder.position = 8;
			while (decoder.position < frame.length) {
				const length = decoder.readInt();
				const offset = decoder.position;
				decoder.position += length;
				if (length === 9 && frame[offset] === 11) continue;
				const entry = readAuditEntry(frame, offset, offset + length);
				if (entry.tableId === Records.tableId)
					records.sent.set(entry.recordId, (records.sent.get(entry.recordId) ?? 0) + 1);
				if (entry.tableId === Records.tableId)
					records.set(entry.recordId, {
						entry,
						frameKey,
						bytes: Buffer.from(frame.subarray(offset, offset + length)),
					});
			}
		}
		return records;
	}

	function nilPutEncoding(key, nodeId) {
		const stored = [...Records.primaryStore.getRange({ versions: true, snapshot: false })].find(
			(entry) => entry.key === key
		);
		return Buffer.from(
			createAuditEntry({
				version: stored.version,
				tableId: Records.tableId,
				recordId: key,
				previousVersion: null,
				nodeId,
				type: 'put',
				encodedRecord: encodeCopyRecordValue(Records.primaryStore, stored.value, () => {}),
				extendedType: stored.metadataFlags & ~0xff & ~FULL_WRITE_HEAD & ~(ACTION_32_BIT << 24),
				residencyId: stored.residencyId,
				previousResidencyId: null,
				expiresAt: stored.expiresAt,
			})
		);
	}

	it('sends a tombstone as a bodyless delete at its version to a peer advertising tombstoneCopy', async () => {
		await connect(buildLocalCapabilities(90_000, false, true));
		const records = await copiedRecords();
		const deleted = records.get('deleted')?.entry;
		assert.equal(deleted?.type, 'delete');
		assert.equal(deleted.version, Records.primaryStore.getEntry('deleted').version);
		assert.equal(deleted.getValue(Records.primaryStore), undefined, 'a delete carries no body');
		assert.equal(deleted.extendedType & FULL_WRITE_HEAD, 0, 'a record-only bit must not reach the audit flags');
		const copiedDeleted = records.get('copied-deleted')?.entry;
		assert.equal(copiedDeleted?.type, 'delete', 'a tombstone this node took from a copy is copied on');
		assert.equal(copiedDeleted.version, Records.primaryStore.getEntry('copied-deleted').version);
		assert.equal(records.get('live')?.entry.type, 'put');
		assert.equal(records.get('published')?.entry.type, 'put', 'a publish-only head is not a delete');
		const covered = records.get('published-over-delete')?.entry;
		assert.equal(covered?.type, 'delete', 'a delete under a later publish is copied as that delete');
		assert.equal(covered.version, boundaryVersion, "at the delete's version, not the publish's");
		assert.equal(covered.nodeId, copiedDeleted.nodeId, "from the delete's origin");
		assert.equal(covered.getValue(Records.primaryStore), undefined);
		assert.equal(records.sent.get('published-over-delete'), 1, 'one entry stands for the key');
		const strongest = records.get('stronger-boundary')?.entry;
		assert.equal(strongest?.type, 'delete');
		assert.equal(strongest.version, strongerVersion, 'the stronger of the head and its retained boundary');
		const tied = records.get('tie-boundary')?.entry;
		assert.equal(tied?.type, 'delete');
		assert.equal(tied.version, tieVersion);
		assert.equal(tied.nodeId, tieOrigins[1], 'at an equal version the higher origin name wins, as in core');
		const native = records.get('native-covered')?.entry;
		assert.equal(native?.type, 'delete', 'a delete this node made, under a later publish, is copied as that delete');
		assert.equal(native.version, nativeDeleteVersion);
		assert.equal(native.nodeId, records.get('live').entry.nodeId, 'from this node');
		assert.equal(records.sent.get('native-covered'), 1);
	});

	it("keys a delete it sends for a publish over it at the delete's own clock", async () => {
		await connect(buildLocalCapabilities(90_000, false, true));
		const records = await copiedRecords();
		// past the anchor, so the receiver logs it and the replay of a delete made during the copy ties with it
		const ahead = records.get('ahead-under-publish');
		assert.ok(aheadVersion > records.anchor, "premise: the delete's version is past the anchor");
		assert.equal(ahead?.entry.type, 'delete');
		assert.equal(ahead.frameKey, aheadVersion);
		const later = records.get('under-later-publish');
		assert.ok(
			Records.primaryStore.getEntry('under-later-publish').localTime > records.anchor,
			'premise: the publish is past the anchor'
		);
		assert.equal(later?.entry.type, 'delete');
		assert.equal(later.frameKey, laterBoundaryVersion, "the delete's clock, not the publish's");
		assert.equal(records.get('published-over-delete').frameKey, boundaryVersion);
	});

	it("selects that delete for this node's subscription at either its own clock or the publish's", async () => {
		const laterHead = Records.primaryStore.getEntry('under-later-publish').localTime;
		const windows = [
			{ startTime: Date.now() },
			{ startTime: laterBoundaryVersion - 1, endTime: laterBoundaryVersion + 1 },
			{ startTime: laterHead - 1, endTime: laterHead + 1 },
		];
		for (const window of windows) {
			await connect(buildLocalCapabilities(90_000, false, true));
			// the peer's start of 0 still makes it a copy
			const records = await copiedRecords(false, {}, [
				{ name: getThisNodeName(), tables: [], replicateByDefault: true, ...window },
			]);
			assert.equal(records.get('published-over-delete'), undefined, 'premise: the window filters copy rows');
			assert.equal(records.get('under-later-publish')?.entry.type, 'delete', JSON.stringify(window));
			socket.close();
		}
	});

	it('logs nothing for a replayed delete that ties with a copy-applied one, so a copy must not apply a live one', async () => {
		const origin = getIdOfRemoteNode('copy-tombstone-origin', Records.auditStore);
		const version = Date.now() - 500;
		const deleteAs = async (key, isCopyApply) => {
			const context = { source: {}, sourceApply: true, timestamp: version };
			await transaction(context, async () => {
				const row = await Records.getResource(key, context, { ensureLoaded: false });
				await row._writeDelete(key, { isNotification: true, isCopyApply, nodeId: origin, version });
			});
		};
		const logged = (key) =>
			[...Records.auditStore.getRange({ start: 0 })].filter(
				(entry) => entry.tableId === Records.tableId && entry.recordId === key && entry.type === 'delete'
			).length;
		await deleteAs('replayed-after-copy', true);
		await deleteAs('replayed-after-copy', false);
		await deleteAs('replayed-after-live', false);
		await deleteAs('replayed-after-live', false);
		await until(() => logged('replayed-after-live') === 1);
		assert.equal(logged('replayed-after-copy'), 0);
	});

	for (const peer of ['a pre-key capability bag', 'unlearned capabilities']) {
		it(`sends a tombstone exactly as before the gate to a peer with ${peer}`, async () => {
			let bag;
			if (peer === 'a pre-key capability bag') {
				bag = { ...buildLocalCapabilities(90_000, false, true) };
				delete bag.tombstoneCopy;
			}
			await connect(bag);
			const records = await copiedRecords(!bag);
			const deleted = records.get('deleted');
			assert.equal(deleted?.entry.type, 'put');
			assert.deepEqual(deleted.bytes, nilPutEncoding('deleted', deleted.entry.nodeId));
			const covered = records.get('published-over-delete');
			assert.equal(covered?.entry.type, 'put');
			assert.deepEqual(covered.bytes, nilPutEncoding('published-over-delete', covered.entry.nodeId));
			const native = records.get('native-covered');
			assert.equal(native?.entry.type, 'put');
			assert.deepEqual(native.bytes, nilPutEncoding('native-covered', native.entry.nodeId));
		});
	}

	it('sends a tombstone as a delete to a peer whose bag is not learned but whose request declares tombstoneCopy', async () => {
		await connect();
		const records = await copiedRecords(true, { tombstoneCopy: 1 });
		const deleted = records.get('deleted')?.entry;
		assert.equal(deleted?.type, 'delete');
		assert.equal(deleted.version, Records.primaryStore.getEntry('deleted').version);
		assert.equal(records.get('published')?.entry.type, 'put', 'a publish-only head is not a delete');
		assert.equal(records.get('published-over-delete')?.entry.type, 'delete');
	});

	for (const tombstoneCopy of [0, '1', true, null]) {
		it(`ignores a request declaring tombstoneCopy: ${JSON.stringify(tombstoneCopy)}`, async () => {
			await connect();
			const records = await copiedRecords(true, { tombstoneCopy });
			const deleted = records.get('deleted');
			assert.equal(deleted?.entry.type, 'put');
			assert.deepEqual(deleted.bytes, nilPutEncoding('deleted', deleted.entry.nodeId));
		});
	}

	it('follows a learned bag without tombstoneCopy over a request declaring it', async () => {
		const bag = { ...buildLocalCapabilities(90_000, false, true) };
		delete bag.tombstoneCopy;
		await connect(bag);
		const records = await copiedRecords(false, { tombstoneCopy: 1 });
		assert.equal(records.get('deleted')?.entry.type, 'put');
	});

	it('orders a retained boundary against a head by version, then origin name', () => {
		const [low, high] = tieOrigins;
		const store = Records.auditStore;
		assert.equal(boundaryOutranksHead(store, { version: 2, nodeId: low }, { version: 1, nodeId: high }), true);
		assert.equal(boundaryOutranksHead(store, { version: 1, nodeId: high }, { version: 2, nodeId: low }), false);
		assert.equal(boundaryOutranksHead(store, { version: 1, nodeId: high }, { version: 1, nodeId: low }), true);
		assert.equal(boundaryOutranksHead(store, { version: 1, nodeId: low }, { version: 1, nodeId: high }), false);
		assert.equal(boundaryOutranksHead(store, { version: 1, nodeId: low }, { version: 1, nodeId: low }), false);
	});
});
