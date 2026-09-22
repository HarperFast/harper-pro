/**
 * Spec for the child run in unitTests/unitTestSetup.test.mjs. It has to open a real database:
 * RocksTransactionLogStore registers the shutdown listener under test only when the data layer
 * loads, and the root is only at risk while something holds files under it.
 */

import { createBlob } from '#src/core/resources/blob';
import { table } from '#src/core/resources/databases';
import { setHdbBasePath } from '#src/core/utility/environment/environmentManager';

describe('a database opened under the unit-test root', () => {
	it('accepts a write', async () => {
		setHdbBasePath(process.env.STORAGE_PATH);
		const Records = table({
			database: 'rootLifecycle',
			table: 'records',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
		await Records.put({ id: 'record-0', blob: createBlob(Buffer.alloc(20000, 3)) });
		process.stdout.write(`TEST_ROOT=${process.env.STORAGE_PATH}\n`);
	});
});
