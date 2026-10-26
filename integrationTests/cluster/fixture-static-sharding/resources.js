for (const table of [tables.Sharded, tables.OtherSharded])
	table.setResidencyById((id) => Number(id.match(/^(\d+):/)?.[1] ?? 0));
tables.Placed.setResidency((record) => record.homes);

// GET_RECORD resolves before replica storage; the probe must wait across HTTP workers for that storage attempt.
const settledFor = (id) =>
	new Int32Array(tables.Sharded.auditStore.getUserSharedBuffer(`shard-read-settled:${id}`, new ArrayBuffer(4)));
const storeReplica = tables.Sharded._storeReplica;
tables.Sharded._storeReplica = async function (existingEntry, entry) {
	try {
		return await storeReplica.call(this, existingEntry, entry);
	} finally {
		Atomics.add(settledFor(existingEntry.key), 0, 1);
	}
};

export class SettledReads extends Resource {
	get(target) {
		return Atomics.load(settledFor(target.id), 0);
	}
}

export class LocalRows extends Resource {
	get(target) {
		const table = tables[target.get('table')];
		return Array.from(table.primaryStore.getRange({ start: true }), ({ key }) => {
			const entry = table.primaryStore.getEntry(key);
			return {
				id: key,
				record: entry.value,
				metadataFlags: entry.metadataFlags,
				invalidated: Boolean(entry.metadataFlags & 1),
				residencyId: entry.residencyId ?? null,
				residency: entry.residencyId ? table.getResidencyRecord(entry.residencyId) : null,
			};
		});
	}
}
