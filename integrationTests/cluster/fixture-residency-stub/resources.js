/**
 * Fixture for residencyStubGuard.test.mjs (HarperFast/harper#2257).
 *
 * `Homed` lives on whichever node `home` names, so every other node holds an INVALIDATED index-only stub
 * of the record. `HomedProbe` reports one node's raw local state for a record: the stub bit, the version
 * and the stored value.
 */

const INVALIDATED = 1;

tables.Homed.setResidency((record) => (record.home ? [record.home] : undefined));

export class HomedProbe extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const id = String(target.id);
		// getEntry can return a MaybePromise (a RocksDB cache miss resolves asynchronously); unawaited, the
		// Promise itself is truthy and reads as a present, non-invalidated row with a null version/value.
		const entry = await tables.Homed.primaryStore.getEntry(id);
		return {
			id,
			present: Boolean(entry),
			invalidated: Boolean(entry && entry.metadataFlags & INVALIDATED),
			version: entry?.version ?? null,
			value: entry?.value ?? null,
		};
	}
}
