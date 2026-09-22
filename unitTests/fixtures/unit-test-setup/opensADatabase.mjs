/**
 * Spec for the child run in unitTests/unitTestSetup.test.mjs. The test root is only at risk while a
 * database holds files open under it, so this opens one and writes through it; without that the
 * parent's assertions would pass against a harness that never loads the data layer at all.
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
