import {
	createAuditEntry,
	readAuditEntry,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_PREVIOUS_RESIDENCY_ID,
	HAS_CURRENT_RESIDENCY_SLOT,
	HAS_PREVIOUS_RESIDENCY_SLOT,
} from '../core/resources/auditStore.ts';
import { residencyMapExtends, type ResidencyMapSnapshot } from '../core/resources/residencyPolicy.ts';
import { getResidencyMap, residencyOwners } from '../core/resources/residencyMaps.ts';

interface SlotReference {
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
		const owners = capable ? undefined : residencyOwners(table.databaseName, slot, table.residency.slots);
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
export function encodeResidencyWireRecord(record: any, residencyId?: number, previousResidencyId?: number): Buffer {
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
			(residencyId === undefined ? 0 : HAS_CURRENT_RESIDENCY_ID) |
			(previousResidencyId === undefined ? 0 : HAS_PREVIOUS_RESIDENCY_ID),
		residencyId,
		previousResidencyId,
		encodedRecord: (record.getBinaryValue ? record : readAuditEntry(record.encoded)).getBinaryValue(),
	});
}

const compatibleSnapshots = new WeakMap<ResidencyMapSnapshot, { current: ResidencyMapSnapshot; compatible: boolean }>();

export function resolveSlotReference(
	table: any,
	id: any,
	reference: unknown,
	advertised?: ResidencyMapSnapshot
): number {
	if (!reference || typeof reference !== 'object' || Array.isArray(reference))
		throw new Error(`Missing slot reference for ${table.databaseName}.${table.tableName}`);
	const { slot, mapVersion, mapDigest } = reference as SlotReference;
	const { snapshot } = getResidencyMap(table.databaseName, table.residency.slots);
	if (mapVersion !== snapshot.version || mapDigest !== snapshot.digest) {
		if (!advertised || advertised.version !== mapVersion || advertised.digest !== mapDigest)
			throw new Error(`Unknown residency map ${mapVersion}/${mapDigest} for ${table.databaseName}`);
		let agreement = compatibleSnapshots.get(advertised);
		if (agreement?.current !== snapshot) {
			agreement = { current: snapshot, compatible: residencyMapExtends(advertised, snapshot) };
			compatibleSnapshots.set(advertised, agreement);
		}
		if (!agreement.compatible || !Number.isInteger(slot) || slot < 0 || slot >= advertised.slots)
			throw new Error(`Incompatible residency map ${mapVersion}/${mapDigest} for ${table.databaseName}`);
	}
	residencyOwners(table.databaseName, slot, table.residency.slots);
	if (!table.residency.byAttribute && table.getResidencySlot(id) !== slot)
		throw new Error(`Peer sent an incorrect key-derived slot for ${table.databaseName}.${table.tableName}`);
	return slot;
}
