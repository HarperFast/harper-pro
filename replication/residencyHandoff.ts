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

/** True when the local row is a complete (non-INVALIDATED) record at `version` or newer. */
export function localRowSatisfies(entry: LocalEntryState | undefined, version: number): boolean {
	return !!entry && !((entry.metadataFlags ?? 0) & INVALIDATED) && (entry.version ?? -Infinity) >= version;
}

/** An image stands in for a stub only at the stub's own version; a newer stub means a later transition. */
export function imageMatchesRow(image: { version: number } | undefined, entry: LocalEntryState | undefined): boolean {
	return !!image && !!entry && image.version === entry.version;
}

export type CopyRowDisposition = 'row' | 'image' | 'skip';

/**
 * What a base copy may send a peer for a primary-store row. A complete row is sent as today. An
 * INVALIDATED stub is never a complete record: a non-resident peer still gets it (the send path turns it
 * into an `invalidate` entry carrying indexed fields), a resident peer gets the retained image at the
 * stub's version, and without one the row is withheld — the peer keeps what it holds.
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

/**
 * What `GET_RECORD` may answer with. Stub bytes are never an answer; the retained image is one only for a
 * peer the transition's residency names, at the stub's own version. Anything else is a miss, which is
 * what the requester already handles.
 */
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
	await releaseTransitionEntry(table, receipt.recordId, retained.version);
	await clearHandoffReceipts(dbisDB, table.tableId, receipt.recordId);
	return 'released';
}

/**
 * A retained entry is redundant once this node again holds a complete row at that version or newer (a
 * transition back landed). Releases it and returns true; anything else stays retained.
 */
export async function releaseIfLocallyComplete(table: any, retained: TransitionEntry): Promise<boolean> {
	const entry = table.primaryStore.getEntry(retained.recordId);
	if (!localRowSatisfies(entry, retained.version)) return false;
	await releaseTransitionEntry(table, retained.recordId, retained.version);
	await clearHandoffReceipts(table.dbisDB, table.tableId, retained.recordId);
	return true;
}

/**
 * Retained entries a specific peer is still owed, for redelivery when a sending subscription is set up.
 * Bounded by the unreleased set: empty in steady state, and a peer that is not a resident of any of them
 * costs one pass over that set.
 */
export async function transitionsOwedToPeer(
	table: any,
	peerName: string,
	selfName: string,
	residencyOf: (residencyId: number | undefined) => string[] | undefined
): Promise<TransitionEntry[]> {
	const retained = pendingTransitionEntries(table);
	if (!retained) return [];
	const owed: TransitionEntry[] = [];
	for (const entry of retained) {
		if (await releaseIfLocallyComplete(table, entry)) continue;
		const residency = residencyOf(entry.residencyId);
		if (!residency?.includes(peerName)) continue;
		const receipts = handoffReceipts(table.dbisDB, table.tableId, entry.recordId);
		if (peersOwedImage(residency, selfName, receipts, entry.version).includes(peerName)) owed.push(entry);
	}
	return owed;
}

export interface ReceiptRequest {
	tableId: number;
	recordId: any;
	version: number;
	getEntry: (id: any) => LocalEntryState | undefined;
	attempts?: number;
}

export function receiptRequestKey(tableId: number, recordId: any): string {
	return `${tableId}\u0000${typeof recordId}\u0000${String(recordId)}`;
}

/** A request re-checked this many times without its row completing is dropped; the sender's next sweep re-asks. */
export const MAX_RECEIPT_REQUEST_ATTEMPTS = 1000;
export const MAX_PENDING_RECEIPT_REQUESTS = 10000;

/**
 * Answers the requests whose row this node holds complete at the requested version or newer, with every
 * blob the row references durably on disk. A stub or an absent row keeps waiting for a later commit. A
 * row that is a stub at or past the requested version moved away again and can never satisfy the
 * request, so it is dropped, as is a request that has waited out its attempts.
 */
export async function settleReceiptRequests(
	requests: Iterable<ReceiptRequest>,
	blobsComplete: (value: unknown) => Promise<boolean>
): Promise<{ receipts: HandoffReceiptTuple[]; waiting: ReceiptRequest[] }> {
	const receipts: HandoffReceiptTuple[] = [];
	const waiting: ReceiptRequest[] = [];
	for (const request of requests) {
		let entry: LocalEntryState | undefined;
		try {
			entry = request.getEntry(request.recordId);
		} catch {
			entry = undefined;
		}
		if (entry && typeof (entry as any).then === 'function') entry = undefined;
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
				continue;
			}
		} else if (entry && (entry.metadataFlags ?? 0) & INVALIDATED && (entry.version ?? 0) >= request.version) {
			continue;
		}
		request.attempts = (request.attempts ?? 0) + 1;
		if (request.attempts < MAX_RECEIPT_REQUEST_ATTEMPTS) waiting.push(request);
	}
	return { receipts, waiting };
}

export const MAX_RECEIPT_BATCH = 1000;

/** Shape check for an inbound receipt or receipt-request batch; anything else is dropped whole. */
export function decodeHandoffReceipts(data: unknown, maxItems = MAX_RECEIPT_BATCH): HandoffReceiptTuple[] | undefined {
	if (!Array.isArray(data) || data.length > maxItems) return undefined;
	const receipts: HandoffReceiptTuple[] = [];
	for (const item of data) {
		if (!Array.isArray(item) || item.length !== 3) return undefined;
		const [tableId, recordId, version] = item;
		if (!Number.isSafeInteger(tableId) || tableId < 0) return undefined;
		if (typeof version !== 'number' || !Number.isFinite(version) || version <= 0) return undefined;
		if (recordId === undefined || recordId === null) return undefined;
		receipts.push([tableId, recordId, version]);
	}
	return receipts;
}
