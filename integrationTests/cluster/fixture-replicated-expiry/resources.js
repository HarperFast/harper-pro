// Each request is one transaction, so its two writes replicate as one origin transaction.
export class ExpiringThenPlain extends Resource {
	static loadAsInstance = false;
	async get(target) {
		const id = String(target.id);
		await tables.Exp.put(id, { id });
		await tables.Plain.put(id, { id });
		return { wrote: id };
	}
}

export class PlainThenExpiring extends Resource {
	static loadAsInstance = false;
	async get(target) {
		const id = String(target.id);
		await tables.Plain.put(id, { id });
		await tables.Exp.put(id, { id });
		return { wrote: id };
	}
}
