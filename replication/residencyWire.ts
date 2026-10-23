import {
	createAuditEntry,
	readAuditEntry,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_PREVIOUS_RESIDENCY_ID,
	HAS_CURRENT_RESIDENCY_SLOT,
	HAS_PREVIOUS_RESIDENCY_SLOT,
} from '../core/resources/auditStore.ts';
import { getResidencyMap, residencyOwners } from '../core/resources/residencyMaps.ts';

export interface SlotReference {
	slot: number;
	mapVersion: number;
	mapDigest: string;
}

export function isResidencyRecord(type: string): boolean {
	return type === 'put' || type === 'patch' || type === 'delete' || type === 'invalidate' || type === 'relocate';
}

/** Connection-only references occupy the upper half; durable legacy IDs use the lower half. */
export class ResidencyWireReferences {
	private nextId = 0x80000000;
	private references = new Map<string, number>();

	reference(table: any, slot: number, capable: boolean, send: (value: unknown, id: number) => void): number {
		const { snapshot } = getResidencyMap(table.databaseName, table.residency.slots);
		const owners = residencyOwners(table.databaseName, slot, table.residency.slots);
		// A fallback list changes when membership changes even though the map itself does not.
		const key = `${snapshot.digest}:${slot}:${capable ? '' : JSON.stringify(owners)}`;
		let id = this.references.get(key);
		if (id !== undefined) return id;
		if (this.nextId > 0xffffffff) throw new Error('Residency wire references exhausted; reconnect');
		id = this.nextId++;
		this.references.set(key, id);
		send(capable ? { slot, mapVersion: snapshot.version, mapDigest: snapshot.digest } : owners, id);
		return id;
	}
}

/** Reframe only the header; copy the original encoded body and its blob transfer tags unchanged. */
export function encodeResidencyWireRecord(record: any, residencyId: number, previousResidencyId?: number): Buffer {
	return createAuditEntry({
		...record,
		previousVersion: null,
		extendedType:
			(record.extendedType &
				~0xff &
				~(
					HAS_CURRENT_RESIDENCY_SLOT |
					HAS_PREVIOUS_RESIDENCY_SLOT |
					HAS_CURRENT_RESIDENCY_ID |
					HAS_PREVIOUS_RESIDENCY_ID
				)) |
			HAS_CURRENT_RESIDENCY_ID |
			(previousResidencyId === undefined ? 0 : HAS_PREVIOUS_RESIDENCY_ID),
		residencyId,
		previousResidencyId,
		encodedRecord: (record.getBinaryValue ? record : readAuditEntry(record.encoded)).getBinaryValue(),
	});
}

export function resolveSlotReference(table: any, id: any, reference: unknown): number {
	if (!reference || typeof reference !== 'object' || Array.isArray(reference))
		throw new Error(`Missing slot reference for ${table.databaseName}.${table.tableName}`);
	const { slot, mapVersion, mapDigest } = reference as SlotReference;
	const { snapshot } = getResidencyMap(table.databaseName, table.residency.slots);
	if (mapVersion !== snapshot.version || mapDigest !== snapshot.digest)
		throw new Error(`Unknown residency map ${mapVersion}/${mapDigest} for ${table.databaseName}`);
	residencyOwners(table.databaseName, slot, table.residency.slots);
	if (!table.residency.byAttribute && table.getResidencySlot(id) !== slot)
		throw new Error(`Peer sent an incorrect key-derived slot for ${table.databaseName}.${table.tableName}`);
	return slot;
}
