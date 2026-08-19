import assert from 'node:assert';
import { allBlobsAreComplete } from '#src/replication/blobRepair';

describe('allBlobsAreComplete', () => {
	it('awaits every completeness result before deciding the repair succeeded', async () => {
		const blobs = [{ complete: true }, { complete: false }];
		let checked = 0;
		const result = await allBlobsAreComplete(blobs, async (blob) => {
			await Promise.resolve();
			checked++;
			return blob.complete;
		});

		assert.equal(checked, blobs.length);
		assert.equal(result, false);
	});

	it('does not report success when no blobs were found', async () => {
		assert.equal(await allBlobsAreComplete([], async () => true), false);
	});
});
