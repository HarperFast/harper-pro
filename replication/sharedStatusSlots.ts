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
	'send-log-break',
] as const;
export const FIRE_COUNTER_BASE_POSITION = allocate(FIRE_MECHANISMS.length * 2);

export const RECORD_LOCKS_CAPABILITY_POSITION = allocate();
export const RECORD_LOCK_HOMES_DIGEST_POSITION = allocate();
export const RECORD_LOCK_LEVEL_POSITION = allocate();
// 1 while the peer's current socket advertises `originFloors`: a relay forwards that peer's floor only then.
export const PEER_CERTIFIES_FLOORS_POSITION = allocate();
// `Date.now()` of this (database, peer)'s last send-log-break reconnect, read by every worker so an
// accepted session that redials onto another worker cannot skip the floor.
export const LAST_SEND_LOG_BREAK_RECONNECT_TIME_POSITION = allocate();
export const SHARDING_CERTIFICATE_GENERATION_POSITION = allocate();
export const SHARDING_CERTIFICATE_POSITION = allocate(4);
export const SHARDING_PEER_SHARD_POSITION = allocate();
export const SHARDING_WAIT_POSITION = allocate();
// copyStall.ts; since and retry-at are epoch ms
export const STUCK_COPY_STATE_POSITION = allocate();
export const STUCK_COPY_REASON_POSITION = allocate();
export const STUCK_COPY_COUNT_POSITION = allocate();
export const STUCK_COPY_SINCE_POSITION = allocate();
export const STUCK_COPY_RETRY_AT_POSITION = allocate();
// The address the current outbound subscription socket dialed (privatePaths.ts PATH_*); 0 before any handshake.
export const CONNECTION_PATH_POSITION = allocate();
// Written only by the connection sending this node's own log to the peer. The peer's `confirmationMarkers` support:
// 0 unknown (no sending socket yet), 1 unsupported, 2 supported; and the highest marker it has acknowledged.
export const PEER_CONFIRMATION_MARKERS_POSITION = allocate();
export const ACKED_CONFIRMATION_MARKER_POSITION = allocate();
export const CONFIRMATION_MARKERS_UNKNOWN = 0;
export const CONFIRMATION_MARKERS_UNSUPPORTED = 1;
export const CONFIRMATION_MARKERS_SUPPORTED = 2;
export const RECORD_LOCK_HOMES_DIGEST_CHANGES_POSITION = allocate();

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

// The digest record's change word, one Int32: writers in flight in the low byte, a change count above it.
export const HOMES_DIGEST_WRITER = 1;
export const HOMES_DIGEST_CHANGE = 1 << 8;
export const HOMES_DIGEST_WRITERS = HOMES_DIGEST_CHANGE - 1;

export function homesDigestChangeWords(status: Float64Array): Int32Array {
	return new Int32Array(status.buffer, status.byteOffset, status.length * 2);
}

/**
 * Zeroes every slot but the digest change word, whose count moves on instead: threads cache the digest
 * against it (`peerHomesDigestReader`), so a count set back could match a cache taken before the reset.
 */
export function resetReplicationSharedStatus(status: Float64Array): boolean {
	// Object.is: a digest prefix can read as -0 through the Float64 view.
	if (status.every((slot, position) => position === RECORD_LOCK_HOMES_DIGEST_CHANGES_POSITION || Object.is(slot, 0)))
		return false;
	const words = homesDigestChangeWords(status);
	const changeWord = RECORD_LOCK_HOMES_DIGEST_CHANGES_POSITION * 2;
	// In flight like a writer, so no reader trusts a cached digest while the reset runs.
	Atomics.add(words, changeWord, HOMES_DIGEST_WRITER);
	let cleared = false;
	for (let position = 0; position < status.length; position++) {
		if (
			position === RECORD_LOCK_HOMES_DIGEST_CHANGES_POSITION ||
			position === RECORD_LOCK_HOMES_DIGEST_POSITION ||
			status[position] === 0
		)
			continue;
		status[position] = 0;
		cleared = true;
	}
	// After the capability slot, so homeMap() refuses during the reset, and a publish before this exchange is cleared.
	const record = new BigInt64Array(status.buffer, status.byteOffset, status.length);
	if (Atomics.exchange(record, RECORD_LOCK_HOMES_DIGEST_POSITION, 0n) !== 0n) cleared = true;
	Atomics.add(words, changeWord, (cleared ? HOMES_DIGEST_CHANGE : 0) - HOMES_DIGEST_WRITER);
	return cleared;
}

export const CONNECTION_STATE_CONNECTED = 2;

export const PATH_PUBLIC = 1;
export const PATH_PRIVATE = 2;
// The peer advertises a private URL on this node's network, but it is down on the dialing thread.
export const PATH_PUBLIC_FALLBACK = 3;
