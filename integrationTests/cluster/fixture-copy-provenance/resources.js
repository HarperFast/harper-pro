const FULL_WRITE_HEAD = 0x40000;

export class RelayState extends Resource {
	static loadAsInstance = false;

	get(target) {
		target.checkPermission = false;
		const entry = tables.Relayed.primaryStore.getEntry(String(target.id));
		return {
			present: Boolean(entry?.value),
			version: entry?.version ?? null,
			certified: Boolean(entry?.metadataFlags & FULL_WRITE_HEAD),
			value: entry?.value ?? null,
		};
	}

	// What applying a base-copy frame past the replay boundary does: an audited put of the source row's body,
	// filed in the origin's log. The origin is whoever wrote `seed`, as this node knows it.
	async post(target, { copyPut, seed, version }) {
		const Relayed = tables.Relayed;
		const nodeId = Relayed.primaryStore.getEntry(seed)?.nodeId;
		if (!nodeId) throw new Error(`${seed} has not arrived from its origin`);
		const context = { source: {}, sourceApply: true, timestamp: version };
		await transaction(context, async () => {
			const resource = await Relayed.getResource(copyPut.id, context, { ensureLoaded: false });
			resource._writeUpdate(copyPut.id, copyPut, true, { isNotification: true, copyFrame: true, nodeId, version });
		});
		return { nodeId };
	}

	// A write older than the copied put, made at its origin.
	async put(target, { id, version }) {
		const context = { timestamp: version };
		await transaction(context, async () => {
			const resource = await tables.Relayed.getResource(id, context, { ensureLoaded: false });
			resource._writeUpdate(id, { count: { __op__: 'add', value: 1 } }, false, { isNotification: true });
		});
		return { written: true };
	}
}
