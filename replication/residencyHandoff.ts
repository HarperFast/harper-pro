/**
 * Record-based residency transitions (HarperFast/harper#2257): the Pro half.
 *
 * Core keeps the complete post-write image of a write that moved a record off this node; this module is
 * the only place replication reaches it, through optional accessors a core without the companion change
 * simply lacks. Pro decides which peers must hold the image before it may be released and keeps the
 * per-peer receipts that prove it.
 */
import { INVALIDATED } from '../core/resources/Table.ts';
import { HAS_BLOBS } from '../core/resources/auditStore.ts';
import { writeKeyId } from '../core/resources/DatabaseTransaction.ts';

/** A retained transition entry: the audit record core keeps reachable until every resident holds it. */
export interface TransitionEntry {
	recordId: any;
	tableId: number;
	version: number;
	txnLogKey?: number;
	residencyId?: number;
	previousResidencyId?: number;
	nodeId?: number;
	user?: any;
	expiresAt?: number;
	extendedType?: number;
	encoded?: Uint8Array;
	type?: string;
	getValue?: (store: any, fullRecord?: boolean, auditTime?: number) => any;
	getTransitionImage?: (store: any) => any;
}

/** One receipt as carried on the wire: `[tableId, recordId, version]`, in the SENDER's table-id space. */
export type HandoffReceiptTuple = [number, any, number];

export interface LocalEntryState {
	version?: number;
	metadataFlags?: number;
	value?: unknown;
	residencyId?: number;
}

/** Core's retained complete image for a residency-transition write; undefined for any other entry. */
export function transitionImageValue(auditRecord: TransitionEntry, primaryStore: any): any {
	return auditRecord.getTransitionImage?.(primaryStore);
}

export function coreRetainsTransitionImages(table: any): boolean {
	return typeof table?.pendingTransitionEntries === 'function';
}

/** Every retained transition entry for the table (unreleased), or undefined when core has no such index. */
export function pendingTransitionEntries(table: any): Iterable<TransitionEntry> | undefined {
	return table?.pendingTransitionEntries?.();
}

/** The retained transition entry for one record, or undefined (released, never existed, or unsupported). */
export function pendingTransitionEntry(table: any, id: any): TransitionEntry | undefined {
	return table?.pendingTransitionEntry?.(id);
}

/** Drop the retained entry when its version is at or below `version`. No-op on an unsupported core. */
export function releaseTransitionEntry(table: any, id: any, version: number): Promise<void> | void {
	return table?.releaseTransitionEntry?.(id, version);
}

async function releaseAndClearReceipts(table: any, recordId: any, version: number): Promise<void> {
	await releaseTransitionEntry(table, recordId, version);
	await clearHandoffReceipts(table.dbisDB, table.tableId, recordId);
}

export function localRowSatisfies(entry: LocalEntryState | undefined, version: number): boolean {
	return !!entry && !((entry.metadataFlags ?? 0) & INVALIDATED) && (entry.version ?? -Infinity) >= version;
}

/**
 * `getEntry` can return a MaybePromise (a RocksDB cache miss resolves asynchronously); a throw or a
 * rejection reads as "no entry", the same as a genuine miss — every caller here already treats absence
 * as the safe direction (never release, still treat as owed).
 */
async function resolveLocalEntry(
	getEntry: (id: any) => any,
	id: any,
	onError?: (error: unknown) => void
): Promise<LocalEntryState | undefined> {
	let entry: LocalEntryState | undefined;
	try {
		entry = getEntry(id);
	} catch (error) {
		onError?.(error);
		return undefined;
	}
	if (entry && typeof (entry as any).then === 'function') {
		try {
			entry = await (entry as any);
		} catch (error) {
			onError?.(error);
			return undefined;
		}
	}
	return entry;
}

/** An image stands in for a stub only at the stub's own version; a newer stub means a later transition. */
export function imageMatchesRow(image: { version: number } | undefined, entry: LocalEntryState | undefined): boolean {
	return !!image && !!entry && image.version === entry.version;
}

export type CopyRowDisposition = 'row' | 'image' | 'skip';

/**
 * What a base copy may send for a primary-store row. A stub still goes to a non-resident peer because
 * the send path turns it into an `invalidate` entry; a resident peer would store it as a complete row.
 */
export function copyRowDisposition(
	entry: LocalEntryState,
	peerIsResident: boolean,
	image: { version: number } | undefined
): CopyRowDisposition {
	if (!((entry.metadataFlags ?? 0) & INVALIDATED)) return 'row';
	if (!peerIsResident) return 'row';
	return imageMatchesRow(image, entry) ? 'image' : 'skip';
}

export type FetchDisposition = 'row' | 'image' | 'miss';

/** What `GET_RECORD` may answer with; a miss is what the requester already handles. */
export function fetchDisposition(
	entry: LocalEntryState | undefined,
	image: { version: number; residencyId?: number } | undefined,
	peerName: string | undefined,
	residencyOf: (residencyId: number | undefined) => string[] | undefined
): FetchDisposition {
	if (!entry) return 'miss';
	if (!((entry.metadataFlags ?? 0) & INVALIDATED)) return 'row';
	if (!imageMatchesRow(image, entry)) return 'miss';
	const residency = residencyOf(image!.residencyId);
	return peerName !== undefined && residency?.includes(peerName) ? 'image' : 'miss';
}

/**
 * Release needs a receipt at or above the transition version from EVERY other node the transition's
 * residency names. A residency naming nobody else (or nobody known) never releases: the image is that
 * record's only complete copy, and pinning it is the visible, recoverable outcome.
 */
export function handoffReleasable(
	residency: readonly string[] | undefined,
	selfName: string,
	receipts: ReadonlyMap<string, number>,
	version: number
): boolean {
	if (!residency) return false;
	let required = 0;
	for (const node of residency) {
		if (node === selfName) continue;
		required++;
		if (!((receipts.get(node) ?? -Infinity) >= version)) return false;
	}
	return required > 0;
}

/** Residents the transition still owes an image to: named by its residency, no receipt at its version yet. */
export function peersOwedImage(
	residency: readonly string[] | undefined,
	selfName: string,
	receipts: ReadonlyMap<string, number>,
	version: number
): string[] {
	if (!residency) return [];
	return residency.filter((node) => node !== selfName && !((receipts.get(node) ?? -Infinity) >= version));
}

// [marker, tableId, recordId, peerName] -> version, in the database's dbisDB so every thread and a
// restarted origin see the same receipts. The Symbol prefix sorts below `false`, where core's catalog
// scans start.
const HANDOFF_RECEIPT = Symbol.for('residencyHandoffReceipt');
const KEY_END = '￿';

export async function recordHandoffReceipt(
	dbisDB: any,
	tableId: number,
	recordId: any,
	peerName: string,
	version: number
): Promise<void> {
	const key = [HANDOFF_RECEIPT, tableId, recordId, peerName];
	const existing = dbisDB.getSync(key);
	if (typeof existing === 'number' && existing >= version) return;
	await dbisDB.put(key, version);
}

export function handoffReceipts(dbisDB: any, tableId: number, recordId: any): Map<string, number> {
	const receipts = new Map<string, number>();
	for (const { key, value } of dbisDB.getRange({
		start: [HANDOFF_RECEIPT, tableId, recordId],
		end: [HANDOFF_RECEIPT, tableId, recordId, KEY_END],
	})) {
		if (Array.isArray(key) && typeof key[3] === 'string' && typeof value === 'number') receipts.set(key[3], value);
	}
	return receipts;
}

export async function clearHandoffReceipts(dbisDB: any, tableId: number, recordId: any): Promise<void> {
	const keys: any[] = [];
	for (const { key } of dbisDB.getRange({
		start: [HANDOFF_RECEIPT, tableId, recordId],
		end: [HANDOFF_RECEIPT, tableId, recordId, KEY_END],
	})) {
		keys.push(key);
	}
	for (const key of keys) await dbisDB.remove(key);
}

export type ReceiptOutcome = 'released' | 'recorded' | 'ignored';

/**
 * A peer's receipt for (table, record, version). Ignored when nothing is retained for the record or the
 * receipt predates the retained transition; otherwise recorded, and the entry released once every other
 * resident has one. Core lookups are the caller's to guard: a throw here means nothing was released.
 */
export async function applyHandoffReceipt(
	table: any,
	peerName: string,
	receipt: { recordId: any; version: number },
	selfName: string,
	residencyOf: (residencyId: number | undefined) => string[] | undefined
): Promise<ReceiptOutcome> {
	const retained = pendingTransitionEntry(table, receipt.recordId);
	if (!retained || receipt.version < retained.version) return 'ignored';
	const dbisDB = table.dbisDB;
	await recordHandoffReceipt(dbisDB, table.tableId, receipt.recordId, peerName, receipt.version);
	const receipts = handoffReceipts(dbisDB, table.tableId, receipt.recordId);
	if (!handoffReleasable(residencyOf(retained.residencyId), selfName, receipts, retained.version)) return 'recorded';
	await releaseAndClearReceipts(table, receipt.recordId, retained.version);
	return 'released';
}

/**
 * Retained entries a specific peer is still owed, for redelivery when a sending subscription is set up.
 * Bounded by the unreleased set: empty in steady state, and a peer that is not a resident of any of them
 * costs one pass over that set. A retained entry is redundant once this node again holds a complete row
 * at that version or newer (a transition back landed) and releases immediately. A newer STUB releases
 * nothing: a non-resident's patch over a stub advances the version without anyone holding a complete
 * row, so the image may still be the only complete copy. An entry whose record has since moved to a
 * residency that no longer names the peer stays retained (nothing proves a complete copy exists
 * elsewhere) but is not owed to that peer any more; `superseded` counts those. A newer row that still
 * names the peer keeps the entry owed: if that row is a stub, this image is what lets the peer's core
 * complete it.
 */
export async function transitionsOwedToPeer(
	table: any,
	peerName: string,
	selfName: string,
	residencyOf: (residencyId: number | undefined) => string[] | undefined,
	onRowReadError?: (recordId: any, error: unknown) => void
): Promise<{ owed: TransitionEntry[]; superseded: number }> {
	const retained = pendingTransitionEntries(table);
	if (!retained) return { owed: [], superseded: 0 };
	const owed: TransitionEntry[] = [];
	let superseded = 0;
	// releasing mutates core's set, so never iterate it live
	for (const entry of Array.from(retained)) {
		const row = await resolveLocalEntry(
			(id) => table.primaryStore.getEntry(id),
			entry.recordId,
			(error) => onRowReadError?.(entry.recordId, error)
		);
		if (localRowSatisfies(row, entry.version)) {
			await releaseAndClearReceipts(table, entry.recordId, entry.version);
			continue;
		}
		// checked ahead of the superseded case below: a residency move after every resident already
		// receipted (e.g. a crash between the last receipt and the release it triggers) must not strand it
		const residency = residencyOf(entry.residencyId);
		const receipts = handoffReceipts(table.dbisDB, table.tableId, entry.recordId);
		if (handoffReleasable(residency, selfName, receipts, entry.version)) {
			await releaseAndClearReceipts(table, entry.recordId, entry.version);
			continue;
		}
		if (row && (row.version ?? -Infinity) > entry.version && !residencyOf(row.residencyId)?.includes(peerName)) {
			superseded++;
			continue;
		}
		if (!residency?.includes(peerName)) continue;
		if (peersOwedImage(residency, selfName, receipts, entry.version).includes(peerName)) owed.push(entry);
	}
	return { owed, superseded };
}

export interface ReceiptRequest {
	tableId: number;
	recordId: any;
	version: number;
	getEntry: (id: any) => LocalEntryState | undefined;
	expiresAt: number;
}

export function receiptRequestKey(tableId: number, recordId: any): string {
	// writeKeyId, not String()/JSON.stringify: it's the SAME ordered-binary encoding the storage engines
	// use for this id's identity (core/resources/DatabaseTransaction.ts), so it's already injective,
	// bounded, and BigInt-correct for exactly this purpose -- reusing it beats reinventing a parallel
	// encoder that has to rediscover the same edge cases (and, tried once here, didn't: a depth-capped
	// hand-rolled encoder collided on two different values past the cap).
	return `${tableId}\u0000${writeKeyId(recordId)}`;
}

/** A request unanswered this long is dropped; the sender's next sweep re-asks. */
export const RECEIPT_REQUEST_TTL_MS = 10 * 60_000;
export const MAX_PENDING_RECEIPT_REQUESTS = 10000;

/**
 * Answers the requests whose row this node holds complete at the requested version or newer, with every
 * blob the row references durably on disk. `settled` holds every request that leaves the queue: answered
 * or expired. A stub at any version keeps waiting: it is the unpromoted row that the image, once it
 * arrives, lets core resequence into a complete one.
 */
export async function settleReceiptRequests(
	requests: Iterable<ReceiptRequest>,
	blobsComplete: (value: unknown) => Promise<boolean>,
	now = Date.now()
): Promise<{ receipts: HandoffReceiptTuple[]; settled: ReceiptRequest[]; waiting: ReceiptRequest[] }> {
	const receipts: HandoffReceiptTuple[] = [];
	const settled: ReceiptRequest[] = [];
	const waiting: ReceiptRequest[] = [];
	for (const request of requests) {
		const entry = await resolveLocalEntry(request.getEntry, request.recordId);
		if (localRowSatisfies(entry, request.version)) {
			let durable = true;
			if ((entry!.metadataFlags ?? 0) & HAS_BLOBS) {
				try {
					durable = await blobsComplete(entry!.value);
				} catch {
					durable = false;
				}
			}
			if (durable) {
				receipts.push([request.tableId, request.recordId, entry!.version!]);
				settled.push(request);
				continue;
			}
		}
		if (now >= request.expiresAt) settled.push(request);
		else waiting.push(request);
	}
	return { receipts, settled, waiting };
}

/** Outbound batches must respect the same bound the receiver enforces on inbound ones. */
export function chunkReceipts<T>(items: T[], size = MAX_RECEIPT_BATCH): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

export const MAX_RECEIPT_BATCH = 1000;

const isScalarIdPart = (part: unknown): boolean =>
	part === null || typeof part === 'number' || typeof part === 'string' || typeof part === 'bigint';

/**
 * core's own `Id` contract is a scalar or a flat array of scalars (ResourceInterface.ts's `Id` type,
 * plus BigInt -- see DatabaseTransaction.ts's writeKeyId comment), and that type allows a bare `null`
 * top-level id too -- but a receipt/request for "no record" is meaningless here, so null/undefined stay
 * rejected at the top level same as before, while null is still a valid ELEMENT of a compound id.
 * Rejecting anything else here, before it reaches writeKeyId/receiptRequestKey, keeps a peer from
 * spending our CPU on nested/deep shapes core was never going to accept as a record id in the first place.
 */
const isValidReceiptId = (recordId: unknown): boolean => {
	if (recordId === undefined || recordId === null) return false;
	if (typeof recordId === 'number' || typeof recordId === 'string' || typeof recordId === 'bigint') return true;
	return Array.isArray(recordId) && recordId.every(isScalarIdPart);
};

/** Shape check for an inbound receipt or receipt-request batch; anything else is dropped whole. */
export function decodeHandoffReceipts(data: unknown, maxItems = MAX_RECEIPT_BATCH): HandoffReceiptTuple[] | undefined {
	if (!Array.isArray(data) || data.length > maxItems) return undefined;
	const receipts: HandoffReceiptTuple[] = [];
	for (const item of data) {
		if (!Array.isArray(item) || item.length !== 3) return undefined;
		const [tableId, recordId, version] = item;
		if (!Number.isSafeInteger(tableId) || tableId < 0) return undefined;
		if (typeof version !== 'number' || !Number.isFinite(version) || version <= 0) return undefined;
		if (!isValidReceiptId(recordId)) return undefined;
		receipts.push([tableId, recordId, version]);
	}
	return receipts;
}
