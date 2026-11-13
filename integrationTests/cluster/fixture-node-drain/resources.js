import { existsSync, writeFileSync } from 'node:fs';

export class HeldWrite extends Resource {
	static loadAsInstance = false;

	// Stages a write (which reserves its local log key) and holds the request's transaction open until the file
	// `<gate>.release` exists, so it commits after writes that reserved later keys. Signalled through files, not
	// requests: a request to this worker can wait behind the open transaction.
	async post(target, { database, table = 'Drained', id, body, gate }) {
		await (database ? databases[database] : tables)[table].put({ id, body });
		writeFileSync(gate + '.reserved', '');
		while (!existsSync(gate + '.release')) await new Promise((resolve) => setTimeout(resolve, 10));
		return { committed: id };
	}
}

export class LocalEntries extends Resource {
	static loadAsInstance = false;

	get(target) {
		const database = target.get('database');
		const table = (database ? databases[database] : tables)[target.get('table') ?? 'Drained'];
		return Array.from(table.primaryStore.getRange({ start: true, versions: true }), (entry) => ({
			id: entry.key,
			body: entry.value?.body,
			version: entry.version,
		}));
	}
}

export class SeqRows extends Resource {
	static loadAsInstance = false;

	get(target) {
		const database = target.get('database');
		const table = database ? Object.values(databases[database])[0] : tables.Drained;
		const names = table.auditStore.loadLogs().map((log) => log?.name);
		const rows = [];
		for (const { key, value } of table.dbisDB.getRange({
			start: Symbol.for('seq'),
			end: [Symbol.for('seq'), Buffer.from([0xff])],
		})) {
			rows.push({
				route: names[key[1]] ?? key[1],
				nodes: (value?.nodes ?? []).map((node) => ({
					origin: names[node.id] ?? node.id,
					closedFloor: node.closedFloor ?? null,
					originGeneration: node.originGeneration ?? null,
					originLogKey: node.originLogKey ?? null,
				})),
			});
		}
		return rows;
	}
}
