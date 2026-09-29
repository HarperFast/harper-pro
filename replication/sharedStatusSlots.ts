/**
 * Single allocation point for every Float64 slot in the per-(database, peer) replication
 * shared-status buffer (`getReplicationSharedStatus` in `knownNodes.ts`; layout documented in the
 * "Shared status buffers" section of `DESIGN.md`). Every `*_POSITION` constant is assigned here,
 * in this order, from one local counter — so two slots cannot collide by construction, and the
 * only way to find the next free one is to read this file top to bottom.
 *
 * This module has no imports and must stay that way: `knownNodes.ts`, `replicationConnection.ts`
 * and `recordLockTransport.ts` all import from here, and any import back into one of them would
 * make allocation depend on module evaluation order instead of source order.
 *
 * Owning modules import their constants from here and re-export them unchanged, so existing
 * consumers (clusterStatus.ts, subscriptionManager.ts, replicator.ts, unit tests) keep importing
 * from the same paths as before. A new slot must be added here, never hand-numbered in an owning
 * module directly — `unitTests/replication/sharedStatusSlots.test.mjs` scans `replication/*.ts`
 * for a hand-numbered `*_POSITION` export and fails the build if it finds one outside this file.
 */

let cursor = 0;
function allocate(count = 1): number {
	const position = cursor;
	cursor += count;
	return position;
}

// --- replicationConnection.ts: core link status ---
export const CONFIRMATION_STATUS_POSITION = allocate();
export const RECEIVED_VERSION_POSITION = allocate();
export const RECEIVED_TIME_POSITION = allocate();
export const SENDING_TIME_POSITION = allocate();
export const LATENCY_POSITION = allocate();
export const RECEIVING_STATUS_POSITION = allocate();
export const BACK_PRESSURE_RATIO_POSITION = allocate();
// Blob-replication divergence signals (harper-pro#386). A blob save failure on the receive side means
// a record committed but its bytes are not durably stored; these surface that in cluster_status
// (count + recency) rather than leaving it visible only as per-blob error spam in the logs.
export const BLOB_FAILURE_COUNT_POSITION = allocate();
export const LAST_BLOB_FAILURE_TIME_POSITION = allocate();
// W1 (harper-pro#431): authoritative connection-health slots — see "Connection truth" in DESIGN.md.
// Written by the worker thread that owns the outbound (db, peer) subscription; read by the main
// thread as the source of truth for link state rather than the edge-triggered postMessage mirror.
export const CONNECTION_STATE_POSITION = allocate();
export const LAST_LIVENESS_TIME_POSITION = allocate(); // wall-clock ms of last confirmed liveness (pong or received message)
export const LAST_ERROR_CODE_POSITION = allocate(); // close code of the most recent disconnect
export const LAST_ERROR_TIME_POSITION = allocate(); // wall-clock ms of the most recent disconnect

// --- replicationConnection.ts: fire-classification counters (harper-pro#431) ---
// Append-only: the index into this list picks the counter slot pair, so reordering or removing a
// name reassigns existing counters to a different mechanism.
export const FIRE_MECHANISMS = [
	'receive-watchdog',
	'pause-stall',
	'copy-progress',
	'blob-gap',
	'copy-finalize',
	'subscription-setup',
	'wedge-reconcile',
	'receive-stall-net',
] as const;
// Two slots per mechanism (redundant, load-bearing); reserves FIRE_MECHANISMS.length * 2 slots
// starting here so the block's size tracks the mechanism list without a second number to keep in
// sync.
export const FIRE_COUNTER_BASE_POSITION = allocate(FIRE_MECHANISMS.length * 2);

// --- recordLockTransport.ts: record-lock capability & homes agreement (harper-pro#438/#825) ---
export const RECORD_LOCKS_CAPABILITY_POSITION = allocate();
export const RECORD_LOCK_HOMES_AGREEMENT_POSITION = allocate();
export const RECORD_LOCK_LEVEL_POSITION = allocate();

// Total buffer size. 64 gives headroom for the peer-scoped transport (harper-pro#884) and the
// ownership domain (harper-pro#886) with slots to spare, without another growth pass this epic.
export const REPLICATION_SHARED_STATUS_SLOTS = 64;
