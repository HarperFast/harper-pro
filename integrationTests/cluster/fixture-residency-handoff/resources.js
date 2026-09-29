/**
 * Fixture for residencyHandoff.test.mjs (HarperFast/harper#2257).
 *
 * `Homed` lives on whichever node `home` names, so an ordinary patch of `home` is a record-based
 * residency transition: the writer keeps an INVALIDATED index-only stub and the named node must end
 * up with the complete record. `HomedProbe` reports one node's raw local state for a record — the stub
 * bit, the version, the stored value — and the transition images core still retains for the table.
 */

const INVALIDATED = 1;

tables.Homed.setResidency((record) => (record.home ? [record.home] : undefined));

export class HomedProbe extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const id = String(target.id);
		const table = tables.Homed;
		const entry = table.primaryStore.getEntry(id);
		const pending = [];
		const pendingImages = table.pendingTransitionImages?.();
		if (pendingImages) {
			for (const image of pendingImages) {
				pending.push({ id: String(image.id), version: image.version });
			}
		}
		return {
			id,
			present: Boolean(entry),
			invalidated: Boolean(entry && entry.metadataFlags & INVALIDATED),
			version: entry?.version ?? null,
			value: entry?.value ?? null,
			pending: pending.filter((image) => image.id === id),
			pendingCount: pending.length,
			pendingSupported: pendingImages !== undefined,
		};
	}
}
