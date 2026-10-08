/**
 * Single allocation point for every Float64 slot in the per-(database, peer) replication
 * shared-status buffer (layout in the "Shared status buffers" section of `DESIGN.md`). Must stay
 * dependency-free: `knownNodes.ts`, `replicationConnection.ts` and `recordLockTransport.ts` all
 * import from here, and an import back into one of them would make allocation depend on module
 * evaluation order instead of source order.
 */

let cursor = 0;
function allocate(count = 1): number {
	const position = cursor;
	cursor += count;
	return position;
}

export const CONFIRMATION_STATUS_POSITION = allocate();
export const RECEIVED_VERSION_POSITION = allocate();
export const RECEIVED_TIME_POSITION = allocate();
export const SENDING_TIME_POSITION = allocate();
export const LATENCY_POSITION = allocate();
export const RECEIVING_STATUS_POSITION = allocate();
export const BACK_PRESSURE_RATIO_POSITION = allocate();
export const BLOB_FAILURE_COUNT_POSITION = allocate();
export const LAST_BLOB_FAILURE_TIME_POSITION = allocate();
export const CONNECTION_STATE_POSITION = allocate();
export const LAST_LIVENESS_TIME_POSITION = allocate();
export const LAST_ERROR_CODE_POSITION = allocate();
export const LAST_ERROR_TIME_POSITION = allocate();

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
export const FIRE_COUNTER_BASE_POSITION = allocate(FIRE_MECHANISMS.length * 2);

export const RECORD_LOCKS_CAPABILITY_POSITION = allocate();
export const RECORD_LOCK_HOMES_AGREEMENT_POSITION = allocate();
export const RECORD_LOCK_LEVEL_POSITION = allocate();
// 1 while the peer's current socket advertises `originFloors`: a relay forwards that peer's floor only then.
export const PEER_CERTIFIES_FLOORS_POSITION = allocate();

export const REPLICATION_SHARED_STATUS_SLOTS = 64;
export const ALLOCATED_SLOTS = cursor;
// A multi-slot allocate() (the fire-counter block) can push the total past capacity while its own
// base constant still reads in range on its own — that's the block's start, not its end.
export function assertAllocationFits(allocated: number, capacity: number): void {
	if (allocated > capacity) {
		throw new Error(
			`replication shared-status registry allocated ${allocated} slots but REPLICATION_SHARED_STATUS_SLOTS is ${capacity} — grow the constant`
		);
	}
}
assertAllocationFits(ALLOCATED_SLOTS, REPLICATION_SHARED_STATUS_SLOTS);
