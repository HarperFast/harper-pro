import { unpack } from 'msgpackr';

const COPY_DROP = Symbol.for('cloneCopyDrop');
const REMOTE_NODE_IDS = Symbol.for('remote-ids');

type DbisStore = {
	getSync(key: any): unknown;
	put(key: any, value: unknown): unknown;
	putSync(key: any, value: unknown): unknown;
	removeSync(key: any): unknown;
	transactionSync<T>(callback: () => T): T;
};

export type CloneCopyDrop = {
	copyStartTime: number;
	table: string;
	reason: string;
	detectedAt: number;
	count: number;
	finalizedAt?: number;
	repairAnchor?: number;
	repairStartedAt?: number;
};

export type CloneIncompleteStatus =
	| {
			state: 'pending' | 'repairing' | 'incomplete';
			table: string;
			reason: string;
			detectedAt: number;
			count: number;
			copyStartTime: number;
			finalizedAt?: number;
			repairAnchor?: number;
	  }
	| { state: 'unknown'; reason: 'invalid-marker' | 'unreadable-marker' };

function markerKey(sourceNodeId: number) {
	return [COPY_DROP, sourceNodeId];
}

function validatedMarker(value: unknown): CloneCopyDrop | undefined {
	if (value === undefined) return undefined;
	if (
		!value ||
		typeof value !== 'object' ||
		!Number.isFinite((value as CloneCopyDrop).copyStartTime) ||
		typeof (value as CloneCopyDrop).table !== 'string' ||
		typeof (value as CloneCopyDrop).reason !== 'string' ||
		!Number.isFinite((value as CloneCopyDrop).detectedAt) ||
		!Number.isInteger((value as CloneCopyDrop).count) ||
		(value as CloneCopyDrop).count < 1 ||
		((value as CloneCopyDrop).finalizedAt !== undefined && !Number.isFinite((value as CloneCopyDrop).finalizedAt)) ||
		((value as CloneCopyDrop).repairAnchor !== undefined && !Number.isFinite((value as CloneCopyDrop).repairAnchor)) ||
		((value as CloneCopyDrop).repairStartedAt !== undefined &&
			!Number.isFinite((value as CloneCopyDrop).repairStartedAt))
	)
		throw new Error('invalid durable clone-copy drop marker');
	return value as CloneCopyDrop;
}

function readMarker(dbisDB: DbisStore, sourceNodeId: number): CloneCopyDrop | undefined {
	return validatedMarker(dbisDB.getSync(markerKey(sourceNodeId)));
}

export function beginCloneCopyIntegrityPass(
	dbisDB: DbisStore,
	sourceNodeId: number,
	copyStartTime: number,
	now = Date.now()
): { dropCount: number } {
	const marker = readMarker(dbisDB, sourceNodeId);
	if (!marker) return { dropCount: 0 };
	if (marker.copyStartTime === copyStartTime) return { dropCount: marker.count };
	if (marker.repairAnchor !== copyStartTime) {
		dbisDB.putSync(markerKey(sourceNodeId), {
			...marker,
			repairAnchor: copyStartTime,
			repairStartedAt: now,
		});
	}
	return { dropCount: 0 };
}

export async function recordCloneCopyDrop(
	dbisDB: DbisStore,
	sourceNodeId: number,
	copyStartTime: number,
	table: string,
	reason: string,
	now = Date.now()
): Promise<CloneCopyDrop> {
	const existing = readMarker(dbisDB, sourceNodeId);
	if (existing?.copyStartTime === copyStartTime) return existing;
	const marker: CloneCopyDrop = {
		copyStartTime,
		table: table.slice(0, 256),
		reason: reason.slice(0, 256),
		detectedAt: now,
		count: 1,
	};
	await dbisDB.put(markerKey(sourceNodeId), marker);
	return marker;
}

export function finishCloneCopyIntegrityPass(
	dbisDB: DbisStore,
	sourceNodeId: number,
	copyStartTime: number,
	dropCount: number,
	now = Date.now()
): 'finalized' | 'repaired' | 'unchanged' {
	const marker = readMarker(dbisDB, sourceNodeId);
	if (dropCount > 0) {
		if (!marker || marker.copyStartTime !== copyStartTime)
			throw new Error('clone-copy drop marker does not match the copy pass being finalized');
		const finalized: CloneCopyDrop = {
			copyStartTime: marker.copyStartTime,
			table: marker.table,
			reason: marker.reason,
			detectedAt: marker.detectedAt,
			count: Math.max(marker.count, dropCount),
			finalizedAt: now,
		};
		dbisDB.putSync(markerKey(sourceNodeId), finalized);
		return 'finalized';
	}
	if (marker?.repairAnchor === copyStartTime) {
		dbisDB.removeSync(markerKey(sourceNodeId));
		return 'repaired';
	}
	return 'unchanged';
}

export function finishCloneCopyMetadata(
	dbisDB: DbisStore,
	sourceNodeId: number,
	copyStartTime: number,
	dropCount: number,
	cloneAttempt?: string,
	now = Date.now()
): 'finalized' | 'repaired' | 'unchanged' {
	return dbisDB.transactionSync(() => {
		const disposition = finishCloneCopyIntegrityPass(dbisDB, sourceNodeId, copyStartTime, dropCount, now);
		if (cloneAttempt)
			dbisDB.putSync([Symbol.for('cloneCopyComplete'), sourceNodeId], {
				cloneAttempt,
				copyStartTime,
			});
		dbisDB.removeSync([Symbol.for('copyCursor'), sourceNodeId]);
		return disposition;
	});
}

export function cloneIncompleteStatus(
	dbisDB: Pick<DbisStore, 'getSync'> | undefined,
	sourceNodeId: number | undefined
): CloneIncompleteStatus | undefined {
	if (!dbisDB || sourceNodeId === undefined) return undefined;
	let marker: CloneCopyDrop | undefined;
	try {
		marker = validatedMarker(dbisDB.getSync(markerKey(sourceNodeId)));
	} catch (error) {
		const invalid = error instanceof Error && error.message === 'invalid durable clone-copy drop marker';
		return {
			state: 'unknown',
			reason: invalid ? 'invalid-marker' : 'unreadable-marker',
		};
	}
	if (!marker) return undefined;
	return {
		state:
			marker.repairAnchor !== undefined ? 'repairing' : marker.finalizedAt !== undefined ? 'incomplete' : 'pending',
		table: marker.table,
		reason: marker.reason,
		detectedAt: marker.detectedAt,
		count: marker.count,
		copyStartTime: marker.copyStartTime,
		finalizedAt: marker.finalizedAt,
		repairAnchor: marker.repairAnchor,
	};
}

export function readRemoteNodeId(auditStore: any, remoteNodeName: string): number | undefined {
	try {
		const encoded = auditStore?.getBinary?.(REMOTE_NODE_IDS);
		const nodeId = encoded && unpack(encoded)?.remoteNameToId?.[remoteNodeName];
		return Number.isInteger(nodeId) && nodeId >= 0 ? nodeId : undefined;
	} catch {
		return undefined;
	}
}
