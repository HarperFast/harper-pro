import assert from 'node:assert';
import { createAuditEntry, readAuditEntry } from '#src/core/resources/auditStore';
import { Blob, createBlob, decodeWithBlobCallback } from '#src/core/resources/blob';
import { table } from '#src/core/resources/databases';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import {
	collectAuditRecordBlobsFromBinary,
	encodeWithCopyBlobTransferTags,
	projectIndexedInvalidationRecord,
} from '#src/replication/replicationConnection';

describe('copy blob transfer metadata', () => {
	it('keeps computed response fields out of copy and indexed invalidation payloads', async () => {
		setHdbBasePath(process.env.STORAGE_PATH);
		const ComputedCopy = table({
			database: 'copyComputedMetadata',
			table: 'records',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'source' },
				{
					name: 'derived',
					computed: true,
					computedFromExpression: 'source',
					indexed: true,
				},
			],
		});
		ComputedCopy.setComputedAttribute('derived', (record) => record.source);
		await ComputedCopy.put({ id: 'record', source: 'trusted' });
		const stored = ComputedCopy.primaryStore.getEntry('record');
		const encodedRecord = ComputedCopy.primaryStore.encoder.encode(stored.value);
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
		assert.equal(Object.hasOwn(copied, 'derived'), false);

		const partial = projectIndexedInvalidationRecord(ComputedCopy, stored.value);
		assert.deepEqual(partial, { source: 'trusted' });
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
