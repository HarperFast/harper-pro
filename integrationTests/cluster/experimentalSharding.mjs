import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const { Transaction } = createRequire(import.meta.url)('@harperfast/rocksdb-js');
export const attributeSlotsAvailable = typeof Transaction.prototype.usesAbortMarkers === 'function';
export const attributeSlotsSkip = attributeSlotsAvailable ? false : 'requires native abort markers; harper-pro#1178';
export async function prepareSlotFixture(component, { keyOnly = false } = {}) {
	if (attributeSlotsAvailable && !keyOnly) return;
	const path = join(component, 'schema.graphql');
	const schema = await readFile(path, 'utf8');
	await writeFile(
		path,
		schema.replace(keyOnly ? /@sharded\([^\n]*\)/g : /@sharded\([^)]*\bby:[^)]*\)/g, '@sharded(slots: 10)')
	);
}
