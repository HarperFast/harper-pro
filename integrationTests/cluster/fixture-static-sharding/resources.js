for (const table of [tables.Sharded, tables.OtherSharded])
	table.setResidencyById((id) => Number(id.match(/^(\d+):/)?.[1] ?? 0));
tables.Placed.setResidency((record) => record.homes);

export class LocalRows extends Resource {
	get(target) {
		const table = tables[target.get('table')];
		return Array.from(table.primaryStore.getRange({ start: true }), ({ key, value }) => ({ id: key, record: value }));
	}
}
