/**
 * Coverage for `blobFileMissingOrIncompleteAsync`, the async prefilter in front of the identity-tie
 * in-place blob repair (harper-pro#699). With blob compression on (harper#2443) a node that dies
 * mid-write leaves a deflate body whose header is finalized but whose bytes are short, and the
 * header alone cannot tell (it records the uncompressed length), so the probe must inflate to
 * classify — otherwise the repair declines exactly the damage compression makes common.
 */
import assert from 'node:assert';
import { readFileSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createBlob, getFilePathForBlob } from '#src/core/resources/blob';
import { table } from '#src/core/resources/databases';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';
import { blobFileMissingOrIncompleteAsync } from '#src/replication/replicationConnection';

describe('blobFileMissingOrIncompleteAsync (in-place repair prefilter)', () => {
	let Records;
	let nextId = 0;
	before(() => {
		setHdbBasePath(process.env.STORAGE_PATH);
		Records = table({
			database: 'blobDamageProbe',
			table: 'records',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
	});

	async function storedBlob(payload, options) {
		const id = `record-${nextId++}`;
		await Records.put({ id, blob: createBlob(payload, options) });
		const { blob } = await Records.get(id);
		return { blob, filePath: getFilePathForBlob(blob) };
	}

	it('classifies a compressed body by whether it inflates to its header size', async () => {
		const payload = Buffer.from('compressed damage probe '.repeat(2000));
		const { blob, filePath } = await storedBlob(payload, { compress: true });
		const intact = readFileSync(filePath);
		assert.equal(intact[1], 1, 'precondition: stored deflated');
		assert.equal(await blobFileMissingOrIncompleteAsync(blob), false, 'intact compressed body is healthy');

		truncateSync(filePath, intact.length - 1);
		assert.equal(await blobFileMissingOrIncompleteAsync(blob), true, 'torn compressed body is damaged');

		writeFileSync(filePath, intact);
		assert.equal(await blobFileMissingOrIncompleteAsync(blob), false, 'restored body is healthy again');
	});

	it('classifies an uncompressed body by length, and a missing file as damaged', async () => {
		const { blob, filePath } = await storedBlob(Buffer.alloc(20000, 3));
		assert.equal(readFileSync(filePath)[1], 0, 'precondition: stored uncompressed');
		assert.equal(await blobFileMissingOrIncompleteAsync(blob), false);
		truncateSync(filePath, 20000);
		assert.equal(await blobFileMissingOrIncompleteAsync(blob), true);
		unlinkSync(filePath);
		assert.equal(await blobFileMissingOrIncompleteAsync(blob), true);
	});

	it('has no answer for a blob that is not a stored file', async () => {
		assert.equal(
			await blobFileMissingOrIncompleteAsync(await createBlob(Readable.from([Buffer.alloc(16)]))),
			undefined
		);
		assert.equal(await blobFileMissingOrIncompleteAsync(new Blob(['inline'])), undefined);
	});
});
