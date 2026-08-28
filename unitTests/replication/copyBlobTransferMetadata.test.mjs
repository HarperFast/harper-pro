import assert from 'node:assert';
import { createAuditEntry, readAuditEntry } from '#src/core/resources/auditStore';
import { storedFieldsOnly } from '#src/core/resources/RecordEncoder';
import { Blob, createBlob, decodeWithBlobCallback } from '#src/core/resources/blob';
import { table, tables } from '#src/core/resources/databases';
import { loadGQLSchema } from '#src/core/resources/graphql';
import { transaction } from '#src/core/resources/transaction';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import {
	collectAuditRecordBlobsFromBinary,
	encodeWithCopyBlobTransferTags,
	encodeCopyRecordValue,
	getResidencyProjectionRecord,
	isResolverOwnedIndexedName,
} from '#src/replication/replicationConnection';

describe('copy blob transfer metadata', () => {
	it('resolver output never enters copy payloads, and legacy contamination cannot outrank the resolver', async () => {
		setHdbBasePath(process.env.STORAGE_PATH);
		await loadGQLSchema(`
			type ComputedCopyMetadata @table {
				id: ID @primaryKey
				source: String
				derived: String @computed(from: "source") @indexed
			}
		`);
		const ComputedCopy = tables.ComputedCopyMetadata;
		const encoder = ComputedCopy.primaryStore.encoder;
		await ComputedCopy.put({ id: 'record', source: 'before' });
		const stored = ComputedCopy.primaryStore.getEntry('record');

		// Non-vacuity: the sender's projection is load-bearing on this path, not decorative.
		const unprojected = encoder.decode(Buffer.from(encoder.encode(stored.value)));
		assert.equal(unprojected.derived, 'before', 'premise: an unprojected re-encode carries the computed value');

		// The production sender path itself: projection wired into the copy-row encode.
		const copyBlobs = [];
		const encodedRecord = Buffer.from(
			encodeCopyRecordValue(ComputedCopy.primaryStore, stored.value, (blob) => copyBlobs.push(blob))
		);
		const auditRecord = readAuditEntry(
			Buffer.from(
				createAuditEntry({
					type: 'put',
					tableId: ComputedCopy.tableId,
					recordId: 'record',
					version: stored.version,
					nodeId: 0,
					encodedRecord,
				})
			)
		);
		const copied = auditRecord.getValue(ComputedCopy.primaryStore);
		assert.equal(copied.derived, undefined, 'the projected copy payload must not carry the computed value');
		assert.equal(copied.source, 'before');

		const legacyEncodedRecord = Buffer.from(encoder.encode({ id: 'legacy', source: 'trusted', derived: 'forged' }));
		assert(
			legacyEncodedRecord.includes(Buffer.from('forged')),
			'premise: affected-sender bytes carry the forged value'
		);
		const legacyAuditRecord = readAuditEntry(
			Buffer.from(
				createAuditEntry({
					type: 'put',
					tableId: ComputedCopy.tableId,
					recordId: 'legacy',
					version: stored.version + 1,
					nodeId: 0,
					encodedRecord: legacyEncodedRecord,
				})
			)
		);
		const legacyCopy = legacyAuditRecord.getValue(ComputedCopy.primaryStore);
		const receiveContext = {};
		await transaction(receiveContext, async () => {
			// the replication apply path writes under the replay marker, which skips public-path validation
			receiveContext.transaction.isReplay = true;
			const options = { isNotification: true, ensureLoaded: false, async: true };
			const resource = await ComputedCopy.getResource('legacy', receiveContext, options);
			resource._writeUpdate('legacy', legacyCopy, true, options);
		});
		const legacyStored = ComputedCopy.primaryStore.getEntry('legacy').value;
		assert.equal(
			Object.hasOwn(legacyStored, 'derived'),
			false,
			'the receiver write must project the forged value away'
		);
		assert.equal(legacyStored.derived, 'trusted', 'the resolver must be authoritative');

		assert.equal(isResolverOwnedIndexedName(ComputedCopy, 'derived'), true);
		assert.equal(isResolverOwnedIndexedName(ComputedCopy, 'source'), false);
		assert.equal(isResolverOwnedIndexedName({ primaryStore: { encoder: {} } }, 'derived'), false);
		let partialRecord = null;
		for (const name in ComputedCopy.indices) {
			if (isResolverOwnedIndexedName(ComputedCopy, name)) continue;
			partialRecord ??= {};
			partialRecord[name] = getResidencyProjectionRecord(auditRecord, ComputedCopy.primaryStore)[name];
		}
		assert.equal(partialRecord, null, 'a computed-only index set produces no residency partial');

		// A patch audit entry whose record no longer exists (deleted/expired before a lagging peer's
		// send loop reached it) must yield undefined — the caller's no-record break — not a throw that
		// closes the subscription before its cursor advances and replays the same entry forever.
		const goneAuditRecord = readAuditEntry(
			Buffer.from(
				createAuditEntry({
					type: 'patch',
					tableId: ComputedCopy.tableId,
					recordId: 'never-existed',
					version: stored.version + 5,
					nodeId: 0,
					encodedRecord: Buffer.from(encoder.encode({ source: 'orphaned-patch' })),
				})
			)
		);
		assert.equal(getResidencyProjectionRecord(goneAuditRecord, ComputedCopy.primaryStore), undefined);

		const fullRecord = auditRecord.getValue(ComputedCopy.primaryStore, true);
		const projectionArgs = [];
		const projectionAuditRecord = {
			version: 123,
			recordId: 'record',
			getValue: (...args) => {
				projectionArgs.push(args);
				return fullRecord;
			},
		};
		assert.strictEqual(getResidencyProjectionRecord(projectionAuditRecord, ComputedCopy.primaryStore), fullRecord);
		assert.deepEqual(projectionArgs, [[ComputedCopy.primaryStore, true, 123]]);
		const patchAuditRecord = readAuditEntry(
			Buffer.from(
				createAuditEntry({
					type: 'patch',
					tableId: ComputedCopy.tableId,
					recordId: 'record',
					version: stored.version,
					nodeId: 0,
					encodedRecord: Buffer.from(encoder.encode({ source: 'patch-only' })),
				})
			)
		);
		assert.equal(patchAuditRecord.getValue(ComputedCopy.primaryStore, true), undefined);
		const reconstructedPatch = getResidencyProjectionRecord(patchAuditRecord, ComputedCopy.primaryStore);
		assert.equal(reconstructedPatch.id, 'record');
		assert.equal(reconstructedPatch.source, 'before');
	});

	it('clears temporary tags after an encoding failure and never reuses their ids', () => {
		const blob = new Blob(['payload']);
		let failedTransferId;
		assert.throws(
			() =>
				encodeWithCopyBlobTransferTags(
					{ first: blob, second: blob },
					() => {
						failedTransferId = blob.replicationTransferId;
						assert.equal(typeof failedTransferId, 'number');
						throw new Error('encode failed');
					},
					() => 'file-id'
				),
			/encode failed/
		);
		assert.equal(Object.hasOwn(blob, 'replicationTransferId'), false);

		let nextTransferId;
		encodeWithCopyBlobTransferTags(
			{ blob },
			() => {
				nextTransferId = blob.replicationTransferId;
				return Buffer.alloc(0);
			},
			() => 'file-id'
		);
		assert(nextTransferId > failedTransferId);
		assert.equal(Object.hasOwn(blob, 'replicationTransferId'), false);
	});

	it('clears temporary tags when blob enumeration fails', () => {
		const firstBlob = new Blob(['first']);
		const secondBlob = new Blob(['second']);
		let visited = 0;
		assert.throws(
			() =>
				encodeWithCopyBlobTransferTags(
					{ firstBlob, secondBlob },
					() => Buffer.alloc(0),
					() => {
						if (++visited === 2) throw new Error('enumeration failed');
						return 'file-id';
					}
				),
			/enumeration failed/
		);
		assert.equal(Object.hasOwn(firstBlob, 'replicationTransferId'), false);
		assert.equal(Object.hasOwn(secondBlob, 'replicationTransferId'), false);
	});

	it('enumerates from independent binary bytes without touching the memoized audit value', () => {
		const binaryValue = Buffer.from([1, 2, 3]);
		let getValueCalls = 0;
		let decodeCalls = 0;
		const auditRecord = {
			getBinaryValue: () => binaryValue,
			getValue: () => {
				getValueCalls++;
				return { blob: 'memoized' };
			},
		};
		const tableDecoder = {
			decoder: {
				decode(value, options) {
					decodeCalls++;
					assert.equal(value, binaryValue);
					assert.deepEqual(options, { noMetadata: true });
				},
			},
		};

		assert.deepEqual(collectAuditRecordBlobsFromBinary(auditRecord, tableDecoder), []);
		assert.equal(decodeCalls, 1);
		assert.equal(getValueCalls, 0);
		assert.deepEqual(auditRecord.getValue(), { blob: 'memoized' });
	});

	it('enumerates a real blob extension without poisoning a later value decode', async () => {
		setHdbBasePath(process.env.STORAGE_PATH);
		const CopyBlobTransfer = table({
			database: 'copyBlobTransferMetadata',
			table: 'records',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
				{ name: 'inlineBlob', type: 'Blob' },
			],
		});
		await CopyBlobTransfer.put({
			id: 'record',
			blob: createBlob(Buffer.alloc(9000, 1)),
			inlineBlob: createBlob(Buffer.from('inline')),
		});
		const storedEntry = CopyBlobTransfer.primaryStore.getEntry('record');
		let sentTransferId;
		const encodedRecord = encodeWithCopyBlobTransferTags(storedEntry.value, () => {
			let encoded;
			decodeWithBlobCallback(
				() => {
					encoded = CopyBlobTransfer.primaryStore.encoder.encode(storedEntry.value);
				},
				(blob) => {
					sentTransferId = blob.replicationTransferId;
				}
			);
			return encoded;
		});
		const auditRecord = readAuditEntry(
			Buffer.from(
				createAuditEntry({
					type: 'put',
					tableId: CopyBlobTransfer.tableId,
					recordId: 'record',
					version: storedEntry.version,
					nodeId: 0,
					encodedRecord,
				})
			)
		);

		const blobs = collectAuditRecordBlobsFromBinary(
			auditRecord,
			CopyBlobTransfer.primaryStore,
			CopyBlobTransfer.primaryStore.rootStore
		);
		assert.equal(blobs.length, 1);
		assert.equal(blobs[0].replicationTransferId, sentTransferId);
		assert.equal(Object.hasOwn(blobs[0], 'replicationTransferId'), true);
		const decodedValue = auditRecord.getValue(CopyBlobTransfer.primaryStore);
		assert(decodedValue.blob instanceof Blob);
		assert(decodedValue.inlineBlob instanceof Blob);
	});
});
