import { Resource, databases, tables } from 'harper';

export class PublicPlain extends tables.Plain {
	allowRead() {
		return true;
	}
}

export class PublicOther extends databases.other.Other {
	allowRead() {
		return true;
	}
}

// Reads the local store only, so it never opens a retrieval connection
export class HeldRows extends Resource {
	get(target) {
		const table = target.get('table') === 'Other' ? databases.other.Other : tables.Plain;
		return Array.from(table.primaryStore.getRange({ start: true }), (entry) => ({ id: entry.key }));
	}
}
