/**
 * Record-based residency transitions (HarperFast/harper#2257): the Pro half.
 *
 * When a record-based `setResidency(fn)` write excludes the writing node, core keeps only an
 * INVALIDATED index-only stub and retains the complete post-write image until the new residents hold
 * it. Where core keeps that image and how its audit entry is shaped is the companion core PR's contract
 * and is still being settled, so this module is the ONLY place replication touches it: three optional
 * accessors (`getTransitionImage` on an audit record, `pendingTransitionEntries` / `pendingTransitionEntry`
 * and `releaseTransitionEntry` on a table). A core without them reads as "unsupported" and every caller
 * falls back to today's behavior. What Pro owns outright is here too: which peers must hold the image
 * before it may be released, and the durable per-peer receipts that prove it.
 */
import { INVALIDATED } from '../core/resources/Table.ts';

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
}

/**
 * The complete post-write image core retains for a residency-transition write, decoded; undefined for
 * an ordinary entry or a core without the companion change. The one accessor the forward path consults.
 */
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

/**
 * Exact transition identity: an image stands in for a stub only at the stub's own version. A newer stub
 * (a later transition to somewhere else) must never be served through an older image.
 */
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

// Receipts live in the database's own `dbisDB` so a receipt taken on one thread, or before a restart,
// counts on every thread afterwards. Key: [marker, tableId, recordId, peerName] -> version.
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

/** A sender's request for a receipt, as carried on the wire: the same tuple shape as the receipt. */
export interface ReceiptRequest {
	tableId: number;
	recordId: any;
	version: number;
	getEntry: (id: any) => LocalEntryState | undefined;
}

/**
 * Answers the requests whose row this node now holds complete at the requested version or newer, and
 * returns the rest to keep waiting for a later commit. A request is never answered from the row's
 * absence or from a stub, and never dropped: an image core did not promote stays owed until the sender's
 * next redelivery, which re-requests it.
 */
export function settleReceiptRequests(requests: ReceiptRequest[]): {
	receipts: HandoffReceiptTuple[];
	waiting: ReceiptRequest[];
} {
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
		if (localRowSatisfies(entry, request.version)) receipts.push([request.tableId, request.recordId, entry!.version!]);
		else waiting.push(request);
	}
	return { receipts, waiting };
}

/** Shape check for an inbound receipt or receipt-request batch; anything else is dropped whole. */
export function decodeHandoffReceipts(data: unknown): HandoffReceiptTuple[] | undefined {
	if (!Array.isArray(data)) return undefined;
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
