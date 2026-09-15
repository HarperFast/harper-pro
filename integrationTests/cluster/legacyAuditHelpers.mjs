import assert from 'node:assert';
import { join } from 'node:path';
import { open } from 'lmdb';

export async function assertLegacyAuditHasNoEcho(stoppedNode, sourceKeys) {
	const db = open({ path: join(stoppedNode.dataRootDir, 'database/data.mdb'), readOnly: true });
	try {
		const audit = db.openDB({ name: '__txns__', encoding: 'binary', keyEncoding: 'binary' });
		const values = Array.from(audit.getRange(), (entry) => Buffer.from(entry.value));
		for (const id of sourceKeys) {
			const key = Buffer.from(id);
			const encodedKey = Buffer.concat([Buffer.from([key.length]), key]);
			assert.strictEqual(
				values.filter((value) => value.includes(encodedKey)).length,
				1,
				`duplicate legacy audit entry for ${id}`
			);
		}
	} finally {
		await db.close();
	}
}
