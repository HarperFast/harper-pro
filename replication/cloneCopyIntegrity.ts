const COPY_DROP = Symbol.for('cloneCopyDrop');

type CloneMetadataStore = {
	getSync(key: any): unknown;
	putSync(key: any, value: unknown): unknown;
	removeSync(key: any): unknown;
};

type DbisStore = {
	getSync(key: any): unknown;
	put(key: any, value: unknown): unknown;
	putSync(key: any, value: unknown): unknown;
	removeSync(key: any): unknown;
	transactionSync<T>(callback: (transaction?: CloneMetadataStore) => T): T;
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

function markerKey(sourceName: string) {
	return [COPY_DROP, sourceName];
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

function readMarker(dbisDB: Pick<CloneMetadataStore, 'getSync'>, sourceName: string): CloneCopyDrop | undefined {
	return validatedMarker(dbisDB.getSync(markerKey(sourceName)));
}

export function beginCloneCopyIntegrityPass(
	dbisDB: DbisStore,
	sourceName: string,
	copyStartTime: number,
	now = Date.now()
): { dropCount: number; preserveUnknown?: true } {
	let marker: CloneCopyDrop | undefined;
	try {
		marker = readMarker(dbisDB, sourceName);
	} catch {
		return { dropCount: 0, preserveUnknown: true };
	}
	if (!marker) return { dropCount: 0 };
	if (marker.copyStartTime === copyStartTime) return { dropCount: marker.count };
	if (marker.repairAnchor !== copyStartTime) {
		dbisDB.putSync(markerKey(sourceName), {
			...marker,
			repairAnchor: copyStartTime,
			repairStartedAt: now,
		});
	}
	return { dropCount: 0 };
}

export async function recordCloneCopyDrop(
	dbisDB: DbisStore,
	sourceName: string,
	copyStartTime: number,
	table: string,
	reason: string,
	now = Date.now()
): Promise<CloneCopyDrop> {
	let existing: CloneCopyDrop | undefined;
	try {
		existing = readMarker(dbisDB, sourceName);
	} catch {
		// A real drop gives us authoritative replacement evidence for an unreadable old marker.
	}
	if (existing?.copyStartTime === copyStartTime) {
		const updated = { ...existing, count: existing.count + 1 };
		await dbisDB.put(markerKey(sourceName), updated);
		return updated;
	}
	const marker: CloneCopyDrop = {
		copyStartTime,
		table: table.slice(0, 256),
		reason: reason.slice(0, 256),
		detectedAt: now,
		count: 1,
	};
	// If this is a failed repair, keep the prior terminal verdict visible until this pass finalizes.
	if (existing?.repairAnchor === copyStartTime && existing.finalizedAt !== undefined)
		marker.finalizedAt = existing.finalizedAt;
	await dbisDB.put(markerKey(sourceName), marker);
	return marker;
}

export function finishCloneCopyIntegrityPass(
	dbisDB: CloneMetadataStore,
	sourceName: string,
	copyStartTime: number,
	dropCount: number,
	now = Date.now(),
	preserveUnknown = false
): 'finalized' | 'repaired' | 'unchanged' {
	if (preserveUnknown && dropCount === 0) return 'unchanged';
	const marker = readMarker(dbisDB, sourceName);
	if (dropCount > 0 || marker?.copyStartTime === copyStartTime) {
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
		dbisDB.putSync(markerKey(sourceName), finalized);
		return 'finalized';
	}
	if (marker?.repairAnchor === copyStartTime) {
		dbisDB.removeSync(markerKey(sourceName));
		return 'repaired';
	}
	return 'unchanged';
}

export function finishCloneCopyMetadata(
	dbisDB: DbisStore,
	sourceName: string,
	sourceNodeId: number | undefined,
	copyStartTime: number,
	dropCount: number,
	cloneAttempt?: string,
	now = Date.now(),
	preserveUnknown = false
): 'finalized' | 'repaired' | 'unchanged' {
	return dbisDB.transactionSync((transaction) => {
		const metadataStore = transaction ?? dbisDB;
		const disposition = finishCloneCopyIntegrityPass(
			metadataStore,
			sourceName,
			copyStartTime,
			dropCount,
			now,
			preserveUnknown
		);
		if (cloneAttempt && sourceNodeId !== undefined)
			metadataStore.putSync([Symbol.for('cloneCopyComplete'), sourceNodeId], {
				cloneAttempt,
				copyStartTime,
			});
		if (sourceNodeId !== undefined) metadataStore.removeSync([Symbol.for('copyCursor'), sourceNodeId]);
		return disposition;
	});
}

export function cloneIncompleteStatus(
	dbisDB: Pick<CloneMetadataStore, 'getSync'> | undefined,
	sourceName: string | undefined
): CloneIncompleteStatus | undefined {
	if (!dbisDB || !sourceName) return undefined;
	let marker: CloneCopyDrop | undefined;
	try {
		marker = validatedMarker(dbisDB.getSync(markerKey(sourceName)));
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
