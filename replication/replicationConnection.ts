import type { Logger } from '../core/utility/logging/logger.ts';
import { createHash, type Hash } from 'node:crypto';
import { toBufferKey } from 'ordered-binary';
import {
	getDatabases,
	databases,
	table as ensureTable,
	onUpdatedTable,
	onRemovedDB,
} from '../core/resources/databases.ts';
import {
	createAuditEntry,
	Decoder,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_PREVIOUS_RESIDENCY_ID,
	REMOTE_SEQUENCE_UPDATE,
	HAS_BLOBS,
	AuditRecord,
	readAuditEntry,
	ACTION_32_BIT,
	auditRetention,
	LOCAL_ONLY,
} from '../core/resources/auditStore.ts';
import {
	exportIdMapping,
	getIdOfRemoteNode,
	remoteToLocalNodeId,
	getThisNodeId,
} from '../core/resources/nodeIdMapping.ts';
import { whenNextTransaction } from '../core/resources/transactionBroadcast.ts';
import {
	replicationCertificateAuthorities,
	forEachReplicatedDatabase,
	enabledDatabases,
	urlToNodeName,
} from './replicator.ts';
import { redactOperationForLog } from './logRedaction.ts';
import { CopyCursorWatermark } from './copyCursorWatermark.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import { registerBlobSend, noteBlobSendProgress, endBlobSend, isDrainingBlobSends } from './blobSendDrain.ts';
import {
	PARK_WARN_MS,
	WARN_THROTTLE_MS,
	createThrottleState,
	decideThrottledWarn,
	type ThrottleState,
} from './blobSendWarnThrottle.ts';
import {
	HAS_STRUCTURE_UPDATE,
	isMissingStructureError,
	lastMetadata,
	lastValueEncoding,
	METADATA,
	storedFieldsOnly,
} from '../core/resources/RecordEncoder.ts';
import { decode, encode, Packr } from 'msgpackr';
import { createStructon } from 'structon';
import { WebSocket } from 'ws';
import { threadId } from 'worker_threads';
import harperLogger from '../core/utility/logging/harper_logger.js';
const { forComponent, errorToString } = harperLogger;
import { disconnectedFromNode, connectedToNode, ensureNode } from './subscriptionManager.ts';
import { materializeOperationResponse } from './materializeOperationResponse.ts';
import { EventEmitter } from 'events';
import { createTLSSelector } from '../core/security/keys.js';
import * as tls from 'node:tls';
import {
	getHDBNodeTable,
	getNodeURL,
	getReplicationSharedStatus,
	getExcludedTablesForRouteEntries,
	getConfigRouteReplicates,
	routeEntriesIncludePeer,
	resolveNodeForSendAuth,
	isGenuineNodeDeletion,
	SEND_AUTH_UNCHANGED,
} from './knownNodes.ts';
import * as process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { open as openFile } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import { isIP } from 'node:net';
import { recordAction } from '../core/resources/analytics/write.ts';
import {
	createBlob,
	decodeBlobsWithWrites,
	decodeFromDatabase,
	decodeWithBlobCallback,
	deleteBlob,
	saveBlob,
	getFileId,
	findBlobsInObject,
	getFilePathForBlob,
	blobHeaderIndicatesIncomplete,
	repairBlobFile,
	holdBlobFile,
	registerBlobReceiveInFlight,
	unregisterBlobReceiveInFlight,
	BLOB_UNAVAILABLE_STATUS,
} from '../core/resources/blob.ts';
import { PassThrough } from 'node:stream';
import { getLastVersion } from 'lmdb';
import { FrameWriter } from './frameWriter.ts';
import { cloneAttemptSource } from '../cloneNode/cloneAttempt.ts';
const logger = forComponent('replication').conditional as Logger;

// msgpackr v2 removed the built-in `randomAccessStructure` option; that random-access
// struct support now lives in the `structon` package (the same wrapper core's
// RecordEncoder uses). Replication decoders must be structon-wrapped so they install
// the `_readStruct` hook and can decode typed-struct records — without it, struct
// marker bytes (0x20–0x3f) decode as plain integers and the decode aborts with
// "Data read, but end of buffer not reached".
const StructonPackr = createStructon(Packr);

// these are the codes we use for the different commands
const SUBSCRIPTION_REQUEST = 129;
const NODE_NAME = 140;
const NODE_NAME_TO_ID_MAP = 141;
const DISCONNECT = 142;
const RESIDENCY_LIST = 130;
const TABLE_FIXED_STRUCTURE = 132;
const GET_RECORD = 133; // request a specific record
const GET_RECORD_RESPONSE = 134; // request a specific record
export const OPERATION_REQUEST = 136;
const OPERATION_RESPONSE = 137;
const SEQUENCE_ID_UPDATE = 143;
const COMMITTED_UPDATE = 144;
const DB_SCHEMA = 145;
const BLOB_CHUNK = 146;
const SUBSCRIPTION_UPDATE = 147;
const COPY_START = 148; // leader -> follower: a bulk table copy is starting; carries copyStartTime + copy-order version
const COPY_COMPLETE = 149; // leader -> follower: the bulk table copy finished; follower clears its resume cursor
const SUBSCRIPTION_SETUP_ACK_CAPABILITY = 1;
// Identifies the table ordering the leader copies in (see orderTablesForCopy). The resume skip-loop
// trusts that every table before the cursor's currentTable was already copied — only true if the
// resume runs under the SAME order that built the cursor. Bump this whenever orderTablesForCopy
// changes so a leader resuming a cursor stamped with a different (or absent) version recopies from
// scratch instead of silently skipping tables the old order had not yet reached (#421).
const COPY_ORDER_VERSION = 1;
export const CONFIRMATION_STATUS_POSITION = 0;
export const RECEIVED_VERSION_POSITION = 1;
export const RECEIVED_TIME_POSITION = 2;
export const SENDING_TIME_POSITION = 3;
export const LATENCY_POSITION = 4;
export const RECEIVING_STATUS_POSITION = 5;
export const BACK_PRESSURE_RATIO_POSITION = 6;
// Blob-replication divergence signals (harper-pro#386). A blob save failure on the receive side means
// a record committed but its bytes are not durably stored — the resume cursor holds (see `hasBlobGap`)
// and, on a sustained failing link, the peer can silently diverge to the point of unrecoverable loss.
// These slots surface that divergence in cluster_status so it is observable (count + recency) rather
// than visible only as per-blob error spam in the logs.
export const BLOB_FAILURE_COUNT_POSITION = 7; // cumulative count of blob save failures for this peer/db
export const LAST_BLOB_FAILURE_TIME_POSITION = 8; // wall-clock time (ms) of the most recent blob failure
// Per-connection blob save failures before we log one escalation line (above the per-blob errors). A
// handful of failures on one connection indicates a persistently failing link, not a one-off blip.
const SUSTAINED_BLOB_FAILURE_THRESHOLD = 5;
export const RECEIVING_STATUS_WAITING = 0;
export const RECEIVING_STATUS_RECEIVING = 1;
// W1 (harper-pro#431): authoritative connection-health slots, written by the worker thread that owns the
// outbound (db, peer) subscription socket and read by the main thread as the source of truth for link
// state — rather than relying solely on the edge-triggered worker→main postMessage mirror, which desyncs
// when a terminal state is reached without a 'close' (open-but-idle wedge, #289/#233). State is paired with
// a liveness timestamp so a worker that died/wedged without writing DOWN cannot leave a stale CONNECTED.
export const CONNECTION_STATE_POSITION = 9;
export const LAST_LIVENESS_TIME_POSITION = 10; // wall-clock ms of last confirmed liveness (pong or received message)
export const LAST_ERROR_CODE_POSITION = 11; // close code of the most recent disconnect
export const LAST_ERROR_TIME_POSITION = 12; // wall-clock ms of the most recent disconnect
export const CONNECTION_STATE_DOWN = 0;
export const CONNECTION_STATE_CONNECTED = 2;
// LIVENESS_STALE_MS is defined below, after PING_TIMEOUT, so it can be derived from the configured
// keepalive window rather than a fixed default.
export type ConnectionTruth = {
	connected: boolean;
	state: number;
	lastLiveness: number;
	errorCode?: number;
	errorTime?: number;
};
// Pure derivation of connection truth from a status buffer, separated from the buffer fetch so it can be
// unit-tested without a live auditStore. `connected` requires the CONNECTED state AND fresh liveness, so a
// worker that died/wedged without writing DOWN reads as not-connected once its liveness goes stale.
export function deriveConnectionTruth(status: Float64Array, now: number = Date.now()): ConnectionTruth {
	const state = status[CONNECTION_STATE_POSITION];
	const lastLiveness = status[LAST_LIVENESS_TIME_POSITION];
	const connected = state === CONNECTION_STATE_CONNECTED && lastLiveness > 0 && now - lastLiveness < LIVENESS_STALE_MS;
	return {
		connected,
		state,
		lastLiveness,
		errorCode: status[LAST_ERROR_CODE_POSITION] || undefined,
		errorTime: status[LAST_ERROR_TIME_POSITION] || undefined,
	};
}
// Read the authoritative connection truth for an outbound (db, peer) subscription from shared memory.
export function readConnectionTruth(
	auditStore: any,
	databaseName: string,
	nodeName: string,
	now: number = Date.now()
): ConnectionTruth | undefined {
	if (!auditStore || !databaseName || !nodeName) return;
	return deriveConnectionTruth(getReplicationSharedStatus(auditStore, databaseName, nodeName), now);
}
// W1 (harper-pro#431): the connection-truth slots (CONNECTION_STATE / LAST_LIVENESS / LAST_ERROR)
// describe the OUTBOUND SUBSCRIPTION for a (db, peer) and are read by the main-thread reconcile as the
// source of truth for that entry. The shared buffer is keyed ONLY by (db, peer), so an inbound server
// connection or a cache-miss retrieval connection to the same peer resolves the same buffer — and would
// otherwise stamp these slots for a link the truth is not about, masking a dead subscription (the
// reconcile up-corrects it to connected) or spuriously downing a healthy one. Only the connection that
// owns the subscription may write them, checked inline below as `connection?.nodeSubscriptions !==
// undefined`: it's the reliable marker, set by subscribe() and never cleared, and never set on a
// retrieval connection (it only connect()s) or an inbound connection (no options.connection at all).
// Checked at write time, not via the open-time `isSubscriptionConnection` snapshot, so it holds
// regardless of subscribe()/open ordering.
// W1 T1 (harper-pro#431): one-line truth snapshot appended to every watchdog / reconcile-net fire log,
// so the watchdog-demotion soak can grep fires and see what the authoritative connection truth said at
// that moment. A fire while truth reads connected with fresh liveness is an invariant-violation
// candidate (the watchdog saw something truth did not); a fire while truth already reads down means the
// truth-driven recovery path had — or should have — taken over. Pure formatter so it is unit-testable
// and never throws into a recovery path.
export function formatTruthSnapshot(truth: ConnectionTruth | undefined, now: number = Date.now()): string {
	if (!truth) return 'truth=unavailable';
	const liveness = truth.lastLiveness > 0 ? `${Math.round((now - truth.lastLiveness) / 1000)}s ago` : 'never';
	const closeCode = truth.errorCode ? `, lastCloseCode: ${truth.errorCode}` : '';
	return `truth={connected: ${truth.connected}, state: ${truth.state}, liveness: ${liveness}${closeCode}}`;
}

/**
 * Read a millisecond timeout from config, falling back to `defaultMs` for anything that isn't a positive
 * number. An operator-supplied non-numeric value would otherwise reach a timer as `NaN`, and a `NaN`
 * timeout fails SILENTLY in both directions: `setTimeout` coerces it to ~0 (the bound fires immediately)
 * while every `elapsed >= threshold` watchdog comparison against it is false (the watchdog never fires at
 * all). Same defensive shape as COPY_CHECKPOINT_MAX_INTERVAL_MS's floor below.
 *
 * Exported for unit coverage (unitTests/replication/resolveDatabaseStores.test.mjs).
 */
export function positiveMsOr(value: unknown, defaultMs: number): number {
	const ms = Number(value);
	return ms > 0 ? ms : defaultMs;
}

/**
 * Read a non-negative integer setting, falling back to `defaultValue` for anything else (unset, empty,
 * non-numeric, negative, Infinity); fractions floor. Unlike `positiveMsOr`, an explicit 0 is kept: for
 * the blob-gap escalation bounds it is the documented disable, and `Infinity` must not pass as a bound
 * that silently never trips.
 */
export function nonNegativeIntegerOr(value: unknown, defaultValue: number): number {
	if (typeof value !== 'number' && typeof value !== 'string') return defaultValue;
	if (typeof value === 'string' && value.trim() === '') return defaultValue;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

/**
 * Coerce the configured inbound-queue budget. Nothing non-numeric may reach the gate: a NaN disables
 * neither ceiling but fails every comparison, so every frame would pause AND every settle resume —
 * `ws.pause()`/`ws.resume()`, four watchdog handoffs and a blob-stream walk per frame, silently, on
 * the receive hot path. An explicit 0 is the documented disable; anything else is floored at one
 * socket read chunk, below which the budget cannot hold even a single frame.
 */
export function receiveQueueBudget(value: unknown, defaultBytes = 33554432): number {
	if (value == null || value === '') return defaultBytes;
	const bytes = Number(value);
	if (!Number.isFinite(bytes) || bytes < 0) return defaultBytes;
	if (bytes === 0) return 0;
	return Math.max(SOCKET_READ_CHUNK_BYTES, Math.floor(bytes));
}

const MAX_PAYLOAD = env.get('replication_maxPayload') ?? 100_000_000;
// Flush a bulk-copy batch once it approaches the payload cap, so a run of large rows can't assemble a
// single oversized frame (harper-pro#711) that would throw and wedge the copy with no operator escape
// (existing rows can't be split). Leaves headroom for the in-progress record; a single row above this
// still relies on raising replication_maxPayload.
const COPY_FLUSH_BYTES = Math.floor(MAX_PAYLOAD * 0.9);

// Pure oversized-frame predicate, extracted so it is unit-testable (the frameWriter/copyFlushPacer
// pattern, harper-pro#440). A frame at exactly the cap is allowed; only a strictly larger one is rejected.
export function exceedsMaxPayload(messageSize: number, maxPayload: number = MAX_PAYLOAD): boolean {
	return messageSize > maxPayload;
}
// Throttle the oversized-send error: it closes and reconnects the leg, so it would otherwise re-log on
// every reconnect cycle. Module-level so the throttle survives across the per-cycle connection instances.
const oversizedSendWarnThrottle = createThrottleState();
// When receiving a replication message, we apply per-record backpressure to keep a single
// large batch from synchronously decoding thousands of records and ballooning the worker
// heap past its limit. If the local replicator queue grows beyond this threshold we pause
// the WS connection and wait for it to drain before continuing the decode loop.
const RECEIVE_EVENT_HIGH_WATER_MARK = env.get('replication_receiveEventHighWaterMark') ?? 100;
// Even when the consumer keeps up (queue below the high-water mark), a single large inbound message
// would otherwise decode thousands of records in one synchronous turn — pegging the worker, blocking
// replication ping responses, and tripping core's "JavaScript execution has taken too long" monitor
// (MAX_EVENT_DELAY_TIME = 3 s). Yield the event loop at least this often (ms) while decoding so the
// worker stays responsive during a bulk copy/clone.
const RECEIVE_YIELD_INTERVAL = env.get('replication_receiveYieldInterval') ?? 100;
// A queued frame is usually a subarray of the socket read chunk it arrived in, so it pins the whole
// chunk, not its own length. Both the frame ceiling and the honest retention bound are stated in these
// units rather than in frame lengths.
const SOCKET_READ_CHUNK_BYTES = 65536;
// Ceiling (bytes) on inbound frames accepted but not yet processed: `ws.on('message')` chains each
// frame onto `messageProcessing`, whose links retain the frame bodies, so a receive loop slower than
// the peer grows that chain at the inbound line rate (harper-pro#659). RECEIVE_EVENT_HIGH_WATER_MARK
// bounds a later stage — decoded records awaiting apply — and cannot bound this one. 0 disables.
// The bound is PER CONNECTION: this budget plus the one frame that crosses it, and that frame is
// itself bounded only by the accepting side's `maxPayload` (replicator.ts), not by this. A worker
// holding many (peer, database) links admits that much per link.
const RECEIVE_QUEUE_HIGH_WATER_MARK = receiveQueueBudget(env.get(CONFIG_PARAMS.REPLICATION_RECEIVEQUEUEHIGHWATERMARK));
// During a bulk clone copy the leader flushes a checkpoint transaction every this many records so the
// follower commits incrementally and persists a resume cursor. On reconnect the copy resumes from that
// cursor instead of restarting from zero. Larger = less overhead but coarser resume granularity.
const COPY_CHECKPOINT_RECORDS = env.get('replication_copyCheckpointRecords') ?? 1000;
// How long the receive path waits for this database's local subscription queue to be registered before
// giving up on the connection. Inbound records can only be delivered to the resolved queue, and the
// registration normally lands within milliseconds of the connection (harper-pro#622), so this bound only
// covers the pathological case: a database we subscribed to that never gets registered locally at all
// (e.g. a non-`data` database the peer streams but whose schema we drop because it does not exist here).
// Waiting unbounded there would silently wedge the serialized message chain with no watchdog to catch it
// — the receive watchdog keeps being reset by the very frames we are not processing — so we close instead
// and let reconnect backoff retry, which costs one log line per attempt rather than one per message.
const SUBSCRIPTION_RESOLVE_TIMEOUT = positiveMsOr(env.get('replication_subscriptionResolveTimeout'), 60000);
// Bounded cross-reconnect escalation for a source blob that keeps answering 503 (harper-pro#432): once one
// delivery has held the resume cursor for this many reconnect cycles, or this long since its first hold,
// the receiver skips it like a permanent source failure (see createBlobGapEscalationBudget). 0 disables
// that bound; both 0 restores the unbounded pre-#432 hold.
const BLOB_GAP_ESCALATION_CYCLES = nonNegativeIntegerOr(env.get(CONFIG_PARAMS.REPLICATION_BLOBGAPESCALATIONCYCLES), 10);
const BLOB_GAP_ESCALATION_MS = nonNegativeIntegerOr(env.get(CONFIG_PARAMS.REPLICATION_BLOBGAPESCALATIONMS), 1_800_000);
const BLOB_GAP_ESCALATION_ENABLED = BLOB_GAP_ESCALATION_CYCLES > 0 || BLOB_GAP_ESCALATION_MS > 0;
// Distinct held deliveries one connection's budget tracks; beyond it, holds without an exhausted entry to
// displace stay untracked (held) until one exhausts.
export const BLOB_GAP_BUDGET_MAX_TRACKED = 10_000;
const SEND_SUBSCRIPTION_RESOLVE_TIMEOUT = positiveMsOr(
	process.env.HARPER_TEST_SEND_SUBSCRIPTION_RESOLVE_TIMEOUT_MS,
	SUBSCRIPTION_RESOLVE_TIMEOUT
);

// Wall-clock ceiling on the gap between socket flushes / event-loop yields during a bulk copy.
// Reading a large cold table out of RocksDB dominates copy cost (decompress + decode), so a purely
// count-based checkpoint can let a single batch run longer than the receive watchdog window with no
// non-ping bytes on the wire: the sender's own idle-ping check then self-terminates and the follower's
// receive watchdog also fires, churning the connection ~once a window for hours. Flushing + yielding at
// least this often keeps real bytes moving and the ping timer alive. Stays comfortably under
// RECEIVE_SILENCE_THRESHOLD_MS (the watchdog timeout). Floored at 1ms: a non-positive misconfig would
// make the pacer fire on every record (a setImmediate yield per row), throttling the copy to a crawl —
// the very pathology this bounds — so clamp rather than trust the operator-supplied value.
const COPY_CHECKPOINT_MAX_INTERVAL_MS = Math.max(env.get('replication_copyCheckpointMaxIntervalMs') ?? 5000, 1);

// Leading-duplicate fast-skip (PR B, stacks on the #368 clamp work). On resume the leader re-streams
// from the follower's resume cursor, so the first records of a resumed stream are records this follower
// already applied. Each such record otherwise flows into core Table.ts's apply loop and triggers the
// per-record CRDT resequencing walk (`auditStore.get` scans) only to be dropped as a duplicate. When this
// is enabled, the receive path recognizes a *provably-already-applied* leading duplicate and skips
// dispatching it, avoiding the audit-walk cost during catch-up. This is a pure optimization: it only ever
// suppresses dispatch of a record the apply loop would itself have dropped as an identity tie. Disable
// (set false) to fall back to dispatching everything to the apply loop. See LeadingDuplicateSkip below.
const LEADING_DUP_SKIP_ENABLED = env.get(CONFIG_PARAMS.REPLICATION_LEADINGDUPLICATESKIP) ?? true;
// Distinctive log substring tests grep for to confirm the fast-skip path engaged. Keep stable.
export const LEADING_DUP_SKIP_LOG = 'leading-duplicate fast-skip';
// Process-wide counter of records suppressed by the fast-skip, for in-process tests/observability.
export let leadingDuplicateSkipCount = 0;

/**
 * Decide whether an incremental replication start must be upgraded to a bounded base copy because
 * the requested start predates the transaction-log history the sender still retains. Audit-log
 * retention is time-based (auditRetention purges whole files by mtime), so a peer behind by more
 * than the retention window can no longer be caught up incrementally — the entries it needs were
 * purged. Serving it incremental replay instead would either silently skip the purged entries
 * (data loss) or replay an unbounded history (the heap-unbounded path that OOMs, harper#1114).
 * Returning true routes the peer through the existing base-copy path (startTime = 0). See harper-pro#277.
 *
 * The retention floor is max(oldestRetainedTime, retentionCutoffTime): the oldest actually-retained
 * entry catches purges more aggressive than nominal retention (cleanup runs with a dynamic divisor),
 * while the cutoff catches a fully-purged/idle log whose data still lives in the primary store but
 * has no surviving audit entry to compare against.
 *
 * @param requestedStartTime peer's requested incremental start (epoch ms); 0 already means base copy
 * @param oldestRetainedTime timestamp of the oldest retained audit entry, or undefined if none retained
 * @param retentionCutoffTime Date.now() - auditRetention, the nominal time-based purge floor
 */
export function shouldForceBaseCopyForRetention(
	requestedStartTime: number,
	oldestRetainedTime: number | undefined,
	retentionCutoffTime: number
): boolean {
	// 0 means a base copy was already requested; guard against non-positive/NaN starts too.
	if (!(requestedStartTime > 0)) return false;
	return requestedStartTime < Math.max(oldestRetainedTime ?? 0, retentionCutoffTime);
}

export function hostnameFromNodeUrl(url: unknown): string | undefined {
	if (typeof url !== 'string') return undefined;
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

/**
 * Is this indexed attribute's value owned by a resolver (`@computed`/`@relationship`)? Resolver
 * output is never replicated (HarperFast/harper#2359): a residency partial carries stored indexed
 * fields only, and a non-resident peer that lacks the stored inputs simply does not index the
 * resolved attribute. The core durable projection enforces the same rule on the receiving side.
 */
export function isResolverOwnedIndexedName(table: any, name: string): boolean {
	return table.primaryStore?.encoder?.resolvedAttributeNames?.has(name) === true;
}

export function getResidencyProjectionRecord(auditRecord: any, primaryStore: any) {
	// The third argument reconstructs the record AT the audit timestamp, so a partial (patch) entry
	// yields the merged record rather than an undefined body. That reconstruction reads the current
	// entry with no null guard in core, and this runs inside the synchronous send loop: a record
	// deleted/expired before a lagging peer reaches this entry would otherwise throw, close the
	// subscription BEFORE startTime advances, and replay the same entry on reconnect — a permanent
	// stall. No current entry -> undefined, which the caller's existing no-record break handles.
	if (!primaryStore.getEntry(auditRecord.recordId)) return undefined;
	// reconstruct at the entry's log position, the domain the audit chain is walked in; the synthetic
	// copy-walk record has no log key and carries a full record anyway
	return auditRecord.getValue(primaryStore, true, auditRecord.txnLogKey);
}

/**
 * Encodes a full-copy row's value with resolver-owned names projected out: the copied row is a
 * materialized record whose response toJSON the encoder would otherwise consult, and this path does
 * not pass through recordUpdater's projection. Exported so the wiring itself is unit-testable.
 */
export function encodeCopyRecordValue(primaryStore: any, value: any, onBlob: (blob: Blob) => void) {
	decodeWithBlobCallback(() => primaryStore.encoder.encode(storedFieldsOnly(primaryStore.encoder, value)), onBlob);
	return lastValueEncoding!;
}

/**
 * Should a base copy withhold the records the requesting peer itself originated? Only while this node is
 * being cloned FROM that peer — see the base-copy section of replication/DESIGN.md for the legacy-v4
 * wedge this avoids, why the filter is per record, and what it knowingly does not cover. Every input is
 * matched conservatively: an unrecognized peer, or no clone in flight, copies in full.
 */
export function shouldWithholdPeerOwnRecords({
	cloneSource,
	peerNames,
	peerIsOurLeader,
}: {
	cloneSource: string | undefined;
	peerNames: (string | undefined)[];
	peerIsOurLeader: boolean;
}): boolean {
	return !!cloneSource && peerIsOurLeader && peerNames.includes(cloneSource);
}

export const tableUpdateListeners = new Map();
// This a map of the database name to the subscription object, for the subscriptions from our tables to the replication module
// when we receive messages from other nodes, we then forward them on to as a notification on these subscriptions
export const databaseSubscriptions = new Map();
const DEBUG_MODE = true;
// when we skip messages (usually because we aren't the originating node), we still need to occassionally send a sequence update
// so that catchup occurs more quickly
const SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY = 300;
// The amount time to await after a commit before sending out a committed update (and aggregating all updates).
// We want it be fairly quick so we can let the sending node know that we have received and committed the update.
// (but still allow for batching so we aren't sending out a message for every update under load)
const COMMITTED_UPDATE_DELAY = 2;
const PING_INTERVAL = env.get(CONFIG_PARAMS.REPLICATION_PINGINTERVAL) ?? 30000;
// Time (ms) without any socket activity before a connection is treated as dead.
const PING_TIMEOUT = env.get(CONFIG_PARAMS.REPLICATION_PINGTIMEOUT) ?? PING_INTERVAL * 2;
// During an initial base copy of a large table the *sender* can be stuck in writableNeedDrain
// backpressure for a long stretch, so no socket bytes reach the receiver for well over PING_TIMEOUT
// (default 60s) even though the copy is healthy and will resume. Timing the receiver out on that gap
// reconnects → resumes the same checkpoint → stalls again, starving the copy (harper-pro#460). So while
// inCopyMode the byte-level idle watchdog uses this higher copy-phase threshold instead of PING_TIMEOUT;
// the copy-progress watchdog (#453) still catches a genuinely frozen copy on its own clock.
const COPY_TIMEOUT = env.get(CONFIG_PARAMS.REPLICATION_COPYTIMEOUT) ?? 300000;
// Zero-progress bound on the base-copy FINALIZATION window (COPY_COMPLETE → copy actually finished); see
// createCopyFinalizeWatchdog for why that window has no other guard. Deliberately shares
// `replication.copyTimeout` rather than adding a knob: both answer "how long may a copy sit still before
// we stop believing in it", and the final copy-cursor flush of a large base copy is the slowest step
// either has to tolerate. The env override exists only so the regression test does not have to wait it out.
const TEST_COPY_FINALIZE_TIMEOUT_MS = Number(process.env.HARPER_TEST_COPY_FINALIZE_TIMEOUT_MS);
const COPY_FINALIZE_TIMEOUT = positiveMsOr(TEST_COPY_FINALIZE_TIMEOUT_MS, COPY_TIMEOUT);
// Consecutive copy-durability-flush timeouts per database. A fixed bound cannot tell a flush that will
// never settle from one that is merely slower than we guessed, and rejecting the slow one pins the node in
// a permanent copy-retry loop it can never escape. Each timeout therefore doubles the next attempt's bound
// (capped) so a legitimately slow flush outgrows the bound within a retry or two, while one that never
// settles keeps failing loudly instead of blocking the apply loop forever.
const copyFlushTimeoutsByDatabase = new Map<string, number>();
const COPY_FLUSH_BOUND_MAX_DOUBLINGS = 3;
// Native flushes we have stopped waiting on but that are still running. Capped rather than serialized: a
// retry must be able to start a real flush (chaining behind a stalled one can never make the newly rewritten
// copy rows durable, and if the first never settles the chain never runs), but a permanently stalled store
// must not accumulate one queued flush per retry forever.
const copyFlushOutstandingByDatabase = new Map<string, number>();
const MAX_OUTSTANDING_COPY_FLUSHES = 3;
// Ceiling on the whole finalization window, as a multiple of the (escalating) threshold, past which no
// progress signal may keep deferring the watchdog.
const COPY_FINALIZE_DEADLINE_MULTIPLE = 4;
// W1 (harper-pro#431): safety net behind the explicit DOWN write — a link whose last liveness is older
// than this reads as down even if still marked CONNECTED, so a worker that died/wedged without writing
// DOWN can't pin a stale CONNECTED. Derived from the configured keepalive (not a fixed default) so a
// raised replication.pingInterval/pingTimeout doesn't falsely mark a healthy idle link down before its
// next ping; floored at 120s for the default 30s/60s case. A backpressure pause refreshes liveness in
// sendPing so a legitimate local stall is exempt, matching shouldTerminateIdlePing's pauseReasons guard.
export const LIVENESS_STALE_MS = Math.max(120_000, PING_TIMEOUT * 2);
// On RocksDB a peer resumes from a position in the origin's transaction log, so a received frame's
// log key is a valid resume-cursor value. On LMDB the receiver's own audit keys are local times it
// assigns itself, unrelated to the sender's, so the cursor there must stay on the sender's audit
// sequence id. Mirrors core databases.ts.
const STORAGE_IS_ROCKSDB = (process.env.HARPER_STORAGE_ENGINE || env.get(CONFIG_PARAMS.STORAGE_ENGINE)) !== 'lmdb';
// A replication frame's leading float64 is the origin's log key for every record in it. It reaches
// `RocksTransaction.setTimestamp`, the durable resume cursor and the status watermark, so a corrupt or
// hostile peer's value must never get that far: the same bound core caps source-reported versions at.
const MAX_DATE_TIMESTAMP = 8.64e15;
export function isValidFrameTxnLogKey(value: unknown): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DATE_TIMESTAMP;
}
// The receive-side watchdog fires after this much silence on a replication WS. Both client and
// server arm it: the client also runs an active 30s sendPing tick that should normally catch a
// silent peer first, but if that tick is missed (event-loop stall, ws.terminate() not propagating
// to 'close', etc.) this timer-based watchdog is the belt-and-suspenders that forces the
// reconnect — see harper-pro#233.
const RECEIVE_SILENCE_THRESHOLD_MS = PING_TIMEOUT;
// Application-level setup must complete after the transport handshake. A live ping/pong socket is not
// proof that the peer got past its send-authorization/database-subscription awaits and entered the replay
// loop (harper-pro#642). Keep this strictly behind both sequential sender subscription-resolution bounds
// so the sender gets first chance to identify the exact gate and close/retry, with the receiver-side
// watchdog as the independent net. The extra ping interval prevents equal-deadline timer races.
const TEST_SUBSCRIPTION_SETUP_TIMEOUT_MS = Number(process.env.HARPER_TEST_SUBSCRIPTION_SETUP_TIMEOUT_MS);
const SUBSCRIPTION_SETUP_TIMEOUT_MS = positiveMsOr(
	TEST_SUBSCRIPTION_SETUP_TIMEOUT_MS,
	Math.max(PING_TIMEOUT * 2, SUBSCRIPTION_RESOLVE_TIMEOUT * 2 + PING_INTERVAL)
);
const SEND_SUBSCRIPTION_SETUP_BUDGET_MS = SEND_SUBSCRIPTION_RESOLVE_TIMEOUT * 2 + PING_INTERVAL;
// While the receive socket is paused for back-pressure the byte-silence watchdog above is stopped —
// `ws.pause()` freezes `bytesRead`, so it can no longer tell a healthy back-pressure pause from a peer
// that died mid-pause — and the active sendPing is exempt while `pauseReasons > 0`. That left a paused
// leg with NO liveness check, so a base copy stalled at ~100% back-pressure whose peer restarted could
// wedge `connected:false` forever (harper-pro#466, the deferred third recovery layer of PR #467). The
// pause-stall watchdog (createPauseStallWatchdog) covers that window instead, keyed on local consumer
// progress. This is how long the consumer must make ZERO progress while paused before we conclude the
// pause can never self-clear and force a reconnect.
//
// Threshold sizing (cross-model review): the only consumer-progress signals that advance WHILE paused are
// whole-batch commits (onCommit) and blob-stream drains — there is no sub-operation hook without a core
// change. So a single legitimately-slow local operation (a huge transaction applying/committing, or a slow
// blob write) that produces no commit/drain for the whole window would trip a false positive. We make that
// vanishingly unlikely by defaulting to TWICE the longest single-operation duration the system already
// tolerates (`blobTimeout` — the bound after which a stalled blob stream is itself destroyed), floored at
// `PING_TIMEOUT * 2`. A false positive here is in any case benign-not-lossy: forceReconnect re-streams from
// the durable resume cursor (re-applying only not-yet-committed work, idempotently), so the worst case is
// connection churn on an already-pathologically-slow leg, never data loss. A finer-grained drain-progress
// hook from core's IterableEventQueue would let us tighten this — tracked as a follow-up. Override with
// `replication_pauseStallTimeout` for clusters with extreme single-transaction sizes.
//
// Floored at SUBSCRIPTION_RESOLVE_TIMEOUT so an operator who lowers the override can't make this watchdog
// fire during a legitimate subscription-resolve wait (which pauses intake with zero consumer progress by
// construction — see awaitPendingSubscription). That would only churn the connection, not lose data, but
// the two bounds are ordered by intent, so enforce it rather than document it. positiveMsOr guards the
// whole expression, not each input: a NaN from ANY of the three config reads would leave this watchdog
// permanently disarmed (every `elapsed >= NaN` is false), so nothing non-numeric may escape here.
const PAUSE_STALL_THRESHOLD_MS = Math.max(
	positiveMsOr(
		env.get('replication_pauseStallTimeout'),
		Math.max(PING_TIMEOUT * 2, positiveMsOr(env.get(CONFIG_PARAMS.REPLICATION_BLOBTIMEOUT), 900000) * 2)
	),
	SUBSCRIPTION_RESOLVE_TIMEOUT
);

// Grace the dynamic send-authorization watch gives a present-but-undecodable hdb_nodes row before it
// fails closed. Sized well past the seconds-scale self-heal the #352/#1163 misread window takes (the
// base-copy resync re-encodes the row against local structures), so a decode blip never de-authorizes
// a healthy peer, while still bounding how long a revocation carried by an undecodable write can go
// unenforced. Only reached on a genuine decode failure — a decodable row is evaluated on the first probe.
const SEND_AUTH_REPROBE_INTERVAL_MS = 500;
const SEND_AUTH_REPROBE_ATTEMPTS = 60;

/**
 * Decide whether the dynamic send-authorization watch (the per-subscriber `getHDBNodeTable().subscribe`
 * loop in the SUBSCRIPTION_REQUEST handler) should close a replication connection in response to one
 * hdb_nodes change event.
 *
 * Evaluates the authoritative hdb_nodes row, not the event payload: a whole-table `reload` marker
 * (system-DB base copy — every joining/cloning node emits one) is delivered to every subscriber with no
 * value, a `patch` carries only the patched fields, and a decode blip yields a nullish value. Treating
 * any of those as de-authorization closed every live connection with a spurious 1008 mid-cluster-
 * formation.
 *
 * A genuine tombstone is the one case the event decides, not the row read: a point read can be served
 * from a snapshot that predates the delete commit (harper#1163), which would hand back the
 * still-authorizing row and leave a removed peer receiving.
 *
 * A present-but-undecodable row carries no verdict. Neither answer is safe on its own — closing lets a
 * decode blip knock a healthy peer offline (harper#1163 / harper-pro#352, which heals within seconds),
 * and continuing forever would let a revocation carried by that same undecodable write never take
 * effect. So re-probe for a bounded grace period, then fail closed.
 *
 * The reprobe loop awaits between checks, so the connection can close while it's suspended; `isClosed`
 * is re-checked before acting on a stale resolution so a decode blip that outlives the connection
 * doesn't trigger a redundant close/warn.
 *
 * Returns true iff the connection should be closed as no longer authorized; false means no action —
 * either the peer is still authorized, or the connection already closed while this resolution was
 * pending. `resolve`/`sleep` are injected so this stays unit-testable without a live store or real timers.
 */
export async function shouldCloseSendAuthWatch(
	event: { type: string },
	name: string,
	databaseName: string,
	deps: {
		isClosed: () => boolean;
		onReprobeTimeout?: () => void;
		resolve?: (name: string) => any;
		sleep?: () => Promise<void>;
		reprobeAttempts?: number;
	}
): Promise<boolean> {
	const resolve = deps.resolve ?? resolveNodeForSendAuth;
	const sleep = deps.sleep ?? (() => new Promise<void>((r) => setTimeout(r, SEND_AUTH_REPROBE_INTERVAL_MS).unref()));
	const reprobeAttempts = deps.reprobeAttempts ?? SEND_AUTH_REPROBE_ATTEMPTS;

	let node = isGenuineNodeDeletion(event.type) ? undefined : resolve(name);
	for (let attempt = 0; node === SEND_AUTH_UNCHANGED && attempt < reprobeAttempts && !deps.isClosed(); attempt++) {
		await sleep();
		node = resolve(name);
	}
	if (node === SEND_AUTH_UNCHANGED) {
		if (deps.isClosed()) return false;
		deps.onReprobeTimeout?.();
		node = undefined;
	}
	if (deps.isClosed()) return false;
	return !(
		node?.replicates === true ||
		node?.replicates?.receives ||
		// routeEntriesIncludePeer (not a strict source+database match): a self-record entry may omit
		// `database` (a wildcard for all databases — what a full-replication neighbor's directional
		// self-record advertises), and absent source means any peer. A strict `sub.database ===
		// databaseName` here would reject a full-replication neighbor's per-database subscription once
		// this node is opted-in to directional routing, silently stopping replication and
		// reconnect-churning. (PR #572 review — Chris Barber.)
		routeEntriesIncludePeer(node?.replicates?.receivesFrom, getThisNodeName(), databaseName)
	);
}

/**
 * Decide whether an idle replication connection should be terminated as dead.
 *
 * Liveness is measured from the last observed socket byte movement (in either direction), not from a
 * single ping interval. A bulk transfer — notably the initial clone copy of a large table — makes
 * slow but real progress: the sender's socket buffer drains in bursts as the peer consumes, so bytes
 * keep moving within the timeout window even while it is otherwise stalled. A genuinely dead or
 * unreachable peer moves no bytes at all, so it still trips the timeout. We deliberately do NOT exempt
 * the sender's `isPausedForBackPressure` drain-wait here: if the peer dies after we have filled our
 * socket buffer, the drain event never fires, and exempting it would hang the connection forever.
 *
 * The one exemption is `pauseReasons > 0`: the receiver has intentionally stopped reading to drain its
 * own queue. That stall is local and self-clearing (it does not depend on the peer), so it is never a
 * death signal; the caller keeps liveness fresh while paused and resumes normal detection afterward.
 */
export function shouldTerminateIdlePing(idleMs: number, pingTimeout: number, pauseReasons: number): boolean {
	return pauseReasons === 0 && idleMs >= pingTimeout;
}

/**
 * Keyed on `options.url`, which the dialing side supplies: without a keepalive nothing is written
 * while the peer works, and the receive watchdog kills the socket mid-operation.
 */
export function shouldRunKeepalive(options?: { url?: string }): boolean {
	return Boolean(options?.url);
}

/** `ws.ping()` throws while CONNECTING, so a session created before 'open' defers its first ping. */
export function keepaliveArmsOnOpen(readyState: number): boolean {
	return readyState === WebSocket.CONNECTING;
}

/**
 * Handle an error that escaped `onWSMessage` (the inbound handler in `replicateOverWS`).
 *
 * Historically this was logged and swallowed. That silently dropped the rest of the failed frame
 * while later frames kept applying and confirming ever-higher sequence ids — a permanent,
 * undetected `[error, head]` gap on the receiver (epic harper-pro#430 Theme B; workstream
 * harper-pro#440). Recovery instead rides the established transient-close path:
 *
 *   1. `markInboundClosed` FIRST — frames already queued behind this one on the
 *      `messageProcessing` chain must not apply (they would commit past the hole), and after
 *      `ws.close()` the peer can still deliver frames until the close handshake completes.
 *   2. `close(1011)` (internal error — distinct from the 1008 policy closes) WITHOUT the
 *      `intentional` flag, so `NodeReplicationConnection`'s normal retry path reconnects with
 *      backoff and resumes from the last durable cursor, re-streaming everything past it.
 *      Records applied before the error redeliver idempotently (version dedup).
 *
 * A deterministic error (e.g. a genuinely undecodable frame) becomes a visible, backed-off
 * reconnect loop instead of silent loss; bounding that with an escalation budget is W2
 * (harper-pro#432) territory.
 *
 * Coverage: FRAME-level errors (header/command decode, audit-entry structure, unexpected rejections
 * from awaited handler work) reach the outer catch directly. A per-record VALUE decode failure is
 * caught first by the inner catch around `decodeBlobsWithWrites` — which logs the decoder's structures
 * and the offending bytes for diagnosis, then RE-THROWS (only when the table decoder resolved) so it
 * rides this same close path instead of skip-and-logging while the resume cursor advances past the
 * hole. That closes the #1163/#1453 structure-fork silent-gap class: the reconnect rebuilds the table
 * decoder from the peer's re-sent structures, healing the fork on resume. An unknown tableId (decoder
 * unresolved — a transient schema-propagation case, not a fork) stays skip-and-log.
 *
 * Exported for unit tests (`closeOnInboundMessageError.test.mjs`); the production caller is the
 * catch in `onWSMessage`.
 */
export function closeOnInboundMessageError(
	error: unknown,
	deps: {
		connectionId: string | number;
		logger?: { error?: (...args: unknown[]) => void };
		markInboundClosed: () => void;
		close: (code: number, reason: string) => void;
	}
): void {
	deps.markInboundClosed();
	// The log must never prevent the close — this handler is the last line of defense, so the
	// logger access is fully guarded rather than trusted.
	deps.logger?.error?.(
		deps.connectionId,
		'Error handling incoming replication message; closing so replication resumes from the last durable cursor',
		error
	);
	deps.close(1011, 'Error handling incoming replication message');
}

/**
 * The close-vs-skip decision for a per-record value-decode failure inside `onWSMessage`'s inner
 * catch (around `decodeBlobsWithWrites`): a resolved `tableDecoder` means the offending bytes are a
 * real record whose structures forked from the sender's (#1163/#1453), so the caller latches the
 * error to re-throw onto `closeOnInboundMessageError`'s close-and-reconnect path instead of skipping
 * past it — see the inline comment at the call site for the full reasoning. An unresolved decoder
 * (unknown tableId) is transient schema propagation, not a fork, and still skips.
 *
 * Exported for unit tests (`closeOnInboundMessageError.test.mjs`); the production caller is the
 * inner value-decode catch in `onWSMessage`.
 */
export function shouldCloseOnRecordDecodeFailure(tableDecoder: unknown): boolean {
	return !!tableDecoder;
}

/**
 * Decide whether the empty-subscription delayed close inside `replicateOverWS`'s `scheduleClose` should
 * be classified as INTENTIONAL/finished (mark `isFinished`/`intentionallyUnsubscribed`, emit `'finished'`,
 * remove the connection from the worker map, never reconnect) vs a transient close that falls through to
 * `NodeReplicationConnection`'s normal retry path so it self-heals.
 *
 * The close fires when the WIRE subscription went 0-length and the peer has been idle for
 * `DELAY_CLOSE_TIME`. The wire subscription is a 1:1 map of `connection.nodeSubscriptions` (it is built by
 * `.map()`-ing it), so at this point that array is itself empty — keying the decision on
 * `connection.nodeSubscriptions` would be a no-op: it is empty in BOTH the genuine-unsubscribe and the
 * spurious-empty cases (a later repopulating `subscribe()` would have cleared `delayedClose` before this
 * timer fired). The two — and only two — code paths that drive an empty `subscribe([])` are:
 *   - replicator.assignReplicationSource on DATABASE REMOVAL (`subscribe([], false)` then delete from the
 *     connection map) — the local database is gone. Genuinely terminal → finish.
 *   - subscribeToNode's `nodes.filter(shouldReplicateFromNode)` collapsing to `[]` while the database is
 *     still present — e.g. the harper-pro#470 self-record gate misread emptied the filter for a
 *     STILL-desired peer. Finishing THAT close strands the still-wanted peer at `connected:false` with no
 *     reconnect (the observed permanent wedge on a 4-node preprod cluster). Must stay retryable.
 *
 * So the real discriminator is durable state, NOT `connection.nodeSubscriptions`: the genuine-terminal
 * path is exactly "the local database for this connection is gone". `databasePresent` is read at close
 * time from `getDatabases()` so the predicate stays pure and unit-testable. (The genuine user-unsubscribe
 * path, `unsubscribe()`, sets `intentionallyUnsubscribed` directly and closes the socket itself — it never
 * reaches this delayed close, so it is unaffected.)
 */
export function shouldFinishEmptySubscriptionClose(databasePresent: boolean): boolean {
	return !databasePresent;
}

/**
 * Decide whether an in-flight blob stream has genuinely stalled and should be destroyed by the
 * `blobsTimer` sweep. The clock (`lastChunk`) advances every time a chunk is processed, so a healthy
 * transfer never trips this. The subtlety — and the bug this guards (harper-pro#368, the
 * soak-rolling-restarts trigger) — is that the receiver pauses its OWN socket reads under back-pressure
 * (commit backlog / consumer queue / blob-write drain). While paused no chunks are processed, so
 * `lastChunk` freezes even though the transfer is fine; counting that paused interval against
 * `blobTimeout` spuriously destroys the stream, which surfaces downstream as a swallowed "Blob save
 * failed" and replication record loss. The fix keeps the predicate purely about elapsed (non-paused)
 * time: callers refresh `lastChunk` on resume (see `refreshBlobStreamsOnResume`) so paused time never
 * accumulates here. A genuinely stuck local blob write still trips it — its stream is not paused, so its
 * clock keeps advancing.
 *
 * Exported as a pure predicate so the accounting can be unit-tested deterministically (mirrors
 * `shouldTerminateIdlePing`); production callers go through the `blobsTimer` in `replicateOverWS`.
 */
export function isBlobStreamTimedOut(lastChunk: number, blobTimeout: number, now: number): boolean {
	return lastChunk + blobTimeout < now;
}

/**
 * Race a backpressure `drain` wait against the connection going away, so a mid-flush peer disconnect
 * always lets the waiter settle instead of parking forever on a `drain` that will never fire.
 *
 * `sendBlobs` awaits this whenever `ws._socket.writableNeedDrain` is true (both the mid-loop wait and
 * the terminal-frame flush wait have this exact shape). Without racing `close`/`error`, a peer that
 * closes the connection while backpressured leaves the await unsettled, so `sendBlobs`'s `finally`
 * never runs: `endBlobSend` is skipped and the drain token leaks in `blobSendDrain`'s module-global
 * `activeSends` for the rest of the worker's life (harper-pro#529 review, cb1kenobi). Listening on both
 * the raw socket (`drain`/`close`/`error`) and the WebSocket wrapper (`close`) covers a close that
 * surfaces on either emitter; all listeners are removed once one fires, so nothing is left registered
 * after the promise settles.
 *
 * Exported so the race itself is unit-testable with plain EventEmitters standing in for the socket/ws.
 */
export function waitForDrainOrSocketEnd(socket: EventEmitter, ws: EventEmitter): Promise<void> {
	return new Promise<void>((resolve) => {
		const done = () => {
			socket.off('drain', done);
			socket.off('close', done);
			socket.off('error', done);
			ws.off('close', done);
			resolve();
		};
		socket.once('drain', done);
		socket.once('close', done);
		socket.once('error', done);
		ws.once('close', done);
	});
}

/**
 * Credit the back-pressure pause back to every in-flight blob stream at the moment the receiver resumes
 * (the point where the pause-reason refcount drops to zero). Because reads are suspended while paused,
 * these streams processed no chunks during the pause and their `lastChunk` would otherwise make
 * `isBlobStreamTimedOut` fire on the next sweep even though the transfer is healthy. Shifting `lastChunk`
 * forward by EXACTLY `pausedMs` (not resetting to `now`) discounts only the paused interval while
 * preserving any genuine pre-pause idle time — so repeated pause/resume churn can't keep a truly stuck
 * stream alive forever (a reset-to-now would). See harper-pro#368 — this is the spurious-timeout trigger
 * of the soak-rolling-restarts record loss.
 *
 * Exported so the resume accounting can be unit-tested in isolation; production callers go through
 * `removePauseReason` in `replicateOverWS`. `blobsInFlight` values are the stream objects.
 */
export function refreshBlobStreamsOnResume(blobsInFlight: Map<any, { lastChunk?: number }>, pausedMs: number): void {
	if (!(pausedMs > 0)) return;
	for (const stream of blobsInFlight.values()) {
		if (stream.lastChunk !== undefined) stream.lastChunk += pausedMs;
	}
}

/**
 * Byte-and-frame budget for the inbound frame queue (`ws.on('message')` → `messageProcessing`).
 *
 * Pure bookkeeping so the policy is unit-testable: `admit` returns true when the caller should pause
 * the socket, `settle` returns true when it should resume; the caller owns the pause reasons.
 *
 * Pausing here is deadlock-free, unlike the BLOB_CHUNK back-pressure pause, because it waits only on
 * frames already accepted: nothing in the receive loop awaits a FUTURE frame — blob saves are
 * fire-and-forget via `outstandingBlobsToFinish` (the `await Promise.all(...)` that did create a
 * circular wait was removed in #426), the apply-queue wait drains from the apply loop, and the blob
 * drain wait is satisfied by `saveBlob` consuming what it already holds. So a pause taken here lifts.
 *
 * Both ceilings are load-bearing: bytes alone leave many small frames unbounded, and each pins the
 * read chunk it slices rather than its own length. The frame ceiling is derived from the byte budget
 * in read-chunk units, so one knob moves both and the worst case lands at the budget.
 */
export function createReceiveQueueGate(highWaterMark: number): {
	admit(byteLength: number): boolean;
	settle(byteLength: number): boolean;
	readonly queuedBytes: number;
	readonly queuedFrames: number;
	readonly paused: boolean;
	readonly peakQueuedBytes: number;
	readonly peakQueuedFrames: number;
	readonly maxFrames: number;
	readonly pauses: number;
} {
	// Defensive: production goes through receiveQueueBudget, but this is exported, and a non-finite
	// budget here fails every comparison — every frame would pause and every settle resume. Route junk
	// through the same coercion the config path uses, so there is one definition of the policy and junk
	// lands on the default with the bound still active rather than restoring the unbounded queue.
	highWaterMark = receiveQueueBudget(highWaterMark);
	const lowWaterMark = Math.max(1, Math.floor(highWaterMark / 2));
	// In read-chunk units, so `maxFrames * SOCKET_READ_CHUNK_BYTES <= highWaterMark`: the worst case,
	// every queued frame pinning a whole chunk, lands at the byte budget instead of a multiple of it.
	// No floor above 1 — a floor would decouple the two ceilings below `64 * SOCKET_READ_CHUNK_BYTES`
	// and silently restore that multiple. The budget's own floor keeps this >= 1.
	const maxFrames = Math.max(1, Math.floor(highWaterMark / SOCKET_READ_CHUNK_BYTES));
	const lowWaterFrames = Math.max(1, Math.floor(maxFrames / 2));
	let queuedBytes = 0;
	let queuedFrames = 0;
	let paused = false;
	let peakQueuedBytes = 0;
	let peakQueuedFrames = 0;
	let pauses = 0;
	return {
		admit(byteLength: number): boolean {
			queuedBytes += byteLength;
			queuedFrames++;
			if (queuedBytes > peakQueuedBytes) peakQueuedBytes = queuedBytes;
			if (queuedFrames > peakQueuedFrames) peakQueuedFrames = queuedFrames;
			// A frame larger than the whole budget is still accepted (it already arrived) and still
			// pauses: the queue drains to zero and resumes, so it costs one pause cycle, never a wedge.
			if (paused || highWaterMark <= 0) return false;
			if (queuedBytes <= highWaterMark && queuedFrames <= maxFrames) return false;
			paused = true;
			pauses++;
			return true;
		},
		settle(byteLength: number): boolean {
			queuedBytes -= byteLength;
			queuedFrames--;
			if (!paused || queuedBytes > lowWaterMark || queuedFrames > lowWaterFrames) return false;
			paused = false;
			return true;
		},
		get queuedBytes() {
			return queuedBytes;
		},
		get queuedFrames() {
			return queuedFrames;
		},
		get paused() {
			return paused;
		},
		get peakQueuedBytes() {
			return peakQueuedBytes;
		},
		get peakQueuedFrames() {
			return peakQueuedFrames;
		},
		get maxFrames() {
			return maxFrames;
		},
		get pauses() {
			return pauses;
		},
	};
}

/**
 * Abort each still-receiving blob when the replication connection closes, rather than leaving the
 * half-written stream for core's source-idle watchdog to reap `blobTimeout` (REPLICATION_BLOBTIMEOUT,
 * up to 15 min) later. A worker restart on the sender — routine in the deploy_component lifecycle —
 * closes the WS mid-blob; without this the receiver holds the stream until that watchdog fires, only
 * then stamping a PENDING stub, so the diverged blob lingers for the whole timeout before the reconnect
 * can re-request it. Destroying with a plain Error is classified TRANSIENT by `receiveBlobs`'s `.catch`
 * (not `sourceBlobUnavailable`, not a permanent source error), which sets `hasBlobGap` → the resume
 * cursor clamps at the last durable transaction → the reconnect re-streams the blob promptly. Each
 * abort's `.finally` in `receiveBlobs` unregisters its in-flight marker, so `onAbort` (the sweep's
 * explicit unregister) is redundant but harmless and keeps parity with the `blobsTimer` sweep.
 *
 * A COMPLETED-but-unconnected stream (`writableEnded`, its chunks arrived ahead of its record) is
 * skipped: its bytes are fully buffered and an in-flight message handler that was paused when the close
 * fired can still attach to it via `receiveBlobs` and save it — destroying it would discard received
 * data and force an unnecessary re-request. Left in the map, it is either attached during teardown or
 * discarded with the connection's `blobsInFlight` on reconnect (re-streamed from the resume cursor).
 *
 * That stream's core-level receive-in-flight marker (`registerBlobReceiveInFlight`, taken by the chunk
 * handler when the stream was created) is released here too, via `onAbort`, even though the stream
 * itself is preserved. If its record never arrives, nothing else ever releases that marker: `blobsTimer`
 * is already cleared above, and `receiveBlobs`'s `.finally` — the normal release site — never runs for a
 * stream it never touched. Left unreleased, `isBlobReceiveInFlight` for this fileId would stay true for
 * the process lifetime, permanently 503-ing reads of that blob (harper-pro#527 review). This trades a
 * brief window — an in-flight handler on THIS closing connection could still attach and save the stream
 * after its marker is gone — for closing a leak that otherwise never heals; that window is bounded to
 * this one connection's already-queued work, and `unregisterBlobReceiveInFlight` is idempotent (guarded
 * on absent state), so `receiveBlobs`'s own later release for the same stream, if it does still run, is a
 * safe no-op rather than a double-release.
 *
 * Exported so the teardown can be unit-tested in isolation; the production caller is the ws `'close'`
 * handler in `replicateOverWS`. Deleting the current entry mid-iteration is safe for a Map.
 */
export function abortInFlightBlobsOnClose(
	blobsInFlight: Map<string, { destroy?: (error: Error) => void; writableEnded?: boolean; fileId?: string }>,
	remoteNodeName: string,
	onAbort?: (blobId: string, stream: { fileId?: string }) => void
): number {
	let aborted = 0;
	for (const [blobId, stream] of blobsInFlight) {
		if (stream.writableEnded) {
			// Fully received, waiting for its record — preserve its bytes, but release its marker (see above).
			onAbort?.(blobId, stream);
			continue;
		}
		blobsInFlight.delete(blobId);
		onAbort?.(blobId, stream);
		stream.destroy?.(createReplicationConnectionClosedError(remoteNodeName, blobId));
		aborted++;
	}
	return aborted;
}

function createReplicationConnectionClosedError(remoteNodeName: string, blobId: string) {
	const error = new Error(
		`Replication connection to ${remoteNodeName || 'unknown'} closed before blob ${blobId} finished; will re-request on reconnect`
	) as Error & { replicationConnectionClosed?: boolean };
	error.replicationConnectionClosed = true;
	return error;
}

export function abortLateBlobReceiveAfterClose(
	connectionClosed: boolean,
	stream: { writableEnded?: boolean; destroyed?: boolean; destroy: (error: Error) => void },
	remoteNodeName: string,
	blobId: string
): boolean {
	if (!connectionClosed || stream.writableEnded || stream.destroyed) return false;
	stream.destroy(createReplicationConnectionClosedError(remoteNodeName, blobId));
	return true;
}

/**
 * Whether a blob-save rejection came from {@link abortInFlightBlobsOnClose} — i.e. the replication
 * connection closed mid-blob (e.g. a peer worker restart in the deploy_component lifecycle). This is a
 * TRANSIENT, self-healing interruption: `receiveBlobs` clamps the resume cursor and the reconnect
 * re-requests the blob, so it should NOT be logged as an error or counted as a divergence
 * (cluster_status.blobReplicationFailures) — that would spam logs and inflate the metric on every deploy.
 */
export function isReplicationConnectionClosedError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { replicationConnectionClosed?: boolean }).replicationConnectionClosed === true
	);
}

/** Keeps separate copy transfers of a reused file id from sharing receive state. */
export function getBlobTransferKey(fileId: unknown, transferId: number | undefined): string {
	return transferId === undefined ? `file:${fileId}` : `transfer:${transferId}`;
}

let nextCopyBlobTransferId = 1;
const BLOB_HEADER_SIZE = 8;
const UNCOMPRESSED_BLOB_TYPE = 0;
const UNKNOWN_BLOB_SIZE = 0xffffffffffff;

/** Core's blob codec only carries own enumerable metadata, so scope the temporary tag to one synchronous encode. */
export function encodeWithCopyBlobTransferTags(
	value: unknown,
	encodeRecord: () => Buffer,
	fileIdForBlob: (blob: Blob) => unknown = getFileId
): Buffer {
	const taggedBlobs: Array<{
		blob: Blob & { replicationTransferId?: number };
		transferId: number;
		previousTransferId: number | undefined;
		hadTransferId: boolean;
	}> = [];
	const transferIdByBlob = new WeakMap<Blob, number>();
	try {
		findBlobsInObject(value, (blob) => {
			if (!fileIdForBlob(blob)) return;
			let transferId = transferIdByBlob.get(blob);
			if (transferId !== undefined) return;
			transferId = nextCopyBlobTransferId++;
			transferIdByBlob.set(blob, transferId);
			const taggedBlob = blob as Blob & { replicationTransferId?: number };
			taggedBlobs.push({
				blob: taggedBlob,
				transferId,
				previousTransferId: taggedBlob.replicationTransferId,
				hadTransferId: Object.hasOwn(taggedBlob, 'replicationTransferId'),
			});
			taggedBlob.replicationTransferId = transferId;
		});
		return encodeRecord();
	} finally {
		for (const { blob, transferId, previousTransferId, hadTransferId } of taggedBlobs) {
			if (blob.replicationTransferId !== transferId) continue;
			if (hadTransferId) blob.replicationTransferId = previousTransferId;
			else delete blob.replicationTransferId;
		}
	}
}

export function collectAuditRecordBlobsFromBinary(
	auditRecord: { getBinaryValue?: () => Buffer },
	tableDecoder: { decoder: { decode: (value: Buffer, options: { noMetadata: boolean }) => unknown } },
	rootStore?: any
): Blob[] {
	if (!auditRecord.getBinaryValue) throw new TypeError('Copy audit record does not expose its binary value');
	const blobs: Blob[] = [];
	decodeWithBlobCallback(
		() => {
			tableDecoder.decoder.decode(auditRecord.getBinaryValue(), { noMetadata: true });
		},
		(blob) => {
			blobs.push(blob);
		},
		rootStore
	);
	return blobs;
}

export function isCompleteBlobHeader(header: Uint8Array, fileSize: number): boolean {
	if (header.byteLength < BLOB_HEADER_SIZE || fileSize < BLOB_HEADER_SIZE) return false;
	const value = new DataView(header.buffer, header.byteOffset, BLOB_HEADER_SIZE).getBigUint64(0);
	const type = Number(value >> 48n);
	const contentSize = Number(value & 0xffffffffffffn);
	if (contentSize === UNKNOWN_BLOB_SIZE) return false;
	// Compressed bodies cannot be proven complete from file bytes; core verifies the writer lock instead.
	if (type !== UNCOMPRESSED_BLOB_TYPE) return false;
	return fileSize === BLOB_HEADER_SIZE + contentSize;
}

async function hasDurableBlobHeader(blob: Blob): Promise<boolean> {
	const path = getFilePathForBlob(blob as any);
	if (!path) return false;
	let file: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		file = await openFile(path, 'r');
		const header = Buffer.allocUnsafe(BLOB_HEADER_SIZE);
		const { size } = await file.stat();
		const { bytesRead } = await file.read(header, 0, BLOB_HEADER_SIZE, 0);
		return bytesRead === BLOB_HEADER_SIZE && isCompleteBlobHeader(header, size);
	} catch {
		return false;
	} finally {
		if (file) await file.close().catch(() => {});
	}
}

/** Whether every file-backed blob reachable from a stored record is durably finalized on disk. */
async function storedBlobsAreComplete(value: unknown): Promise<boolean> {
	if (value == null) return false;
	const blobs: Blob[] = [];
	findBlobsInObject(value, (blob: Blob) => {
		if (getFileId(blob)) blobs.push(blob);
	});
	// The header claimed blobs but none was reachable (e.g. one living only in a patch chain): we
	// cannot prove the local copy is whole, so it must not tie.
	if (blobs.length === 0) return false;
	for (const blob of blobs) if (!(await hasDurableBlobHeader(blob))) return false;
	return true;
}

/**
 * Whether an incoming record is a provably-already-applied identity tie with the one stored locally:
 * same version AND same origin node — the condition core's `precedesExistingVersion` early-matches as a
 * tie — and, for a blob-carrying record, every one of the STORED record's file-backed blobs durably finalized on
 * disk (the incoming duplicate's own blobs are still in flight, so they prove nothing). Anything
 * ambiguous returns false and the record flows to the apply loop.
 *
 * A finalized header, not mere file presence: a PENDING/truncated stub must NOT take this fast-skip path. Its
 * recovery remains owned by the normal apply/backfill paths, and this optimization must not preempt
 * either one by treating an incomplete local value as durable.
 */
export async function isDurableIdentityTie(
	existing: { version?: number; nodeId?: number; value?: unknown } | undefined,
	incomingVersion: number,
	sourceNodeId: number | undefined,
	hasBlobs: boolean,
	verifyBlobs: (value: unknown) => Promise<boolean> = storedBlobsAreComplete
): Promise<boolean> {
	if (sourceNodeId === undefined) return false;
	if (!existing) return false;
	if (existing.version !== incomingVersion) return false;
	if ((existing.nodeId ?? 0) !== sourceNodeId) return false;
	if (!hasBlobs) return true;
	try {
		return await verifyBlobs(existing.value);
	} catch {
		return false;
	}
}

/**
 * Record a blob-replication divergence (a receive-side blob save failure) in the per-peer shared status
 * so cluster_status can surface it. Bumps the cumulative failure count and stamps the most-recent
 * failure time, returning the new cumulative count. A blob failure means a record committed without its
 * bytes being durable — the resume cursor holds (`hasBlobGap`) and a sustained failing link can silently
 * diverge toward unrecoverable loss (harper-pro#386). Surfacing it as a metric makes that observable
 * instead of leaving it as per-blob error spam an operator would not notice.
 *
 * Exported as a pure helper so the accounting is unit-testable (mirrors `isBlobStreamTimedOut`); the
 * production caller is the blob-save `.catch` in `receiveBlobs`. `now` is injected for determinism.
 */
export function recordBlobReplicationFailure(sharedStatus: Float64Array | undefined, now: number): number {
	if (!sharedStatus) return 0;
	// Bump the count BEFORE stamping the time: the writes aren't atomic as a pair, so a concurrent
	// reader should at worst see a fresh count with a slightly-stale time (count is the divergence
	// signal), never a fresh time alongside a stale/zero count.
	const count = ++sharedStatus[BLOB_FAILURE_COUNT_POSITION];
	sharedStatus[LAST_BLOB_FAILURE_TIME_POSITION] = now;
	return count;
}

/**
 * Decide whether a blob-save failure is the point at which we emit the one-per-connection sustained-
 * divergence escalation log: the connection-local failure count has reached the threshold and we have
 * not logged yet. Pure (the latch lives at the call site) so the threshold/latch logic is unit-testable.
 */
export function shouldLogSustainedBlobDivergence(
	failureCount: number,
	threshold: number,
	alreadyLogged: boolean
): boolean {
	return failureCount >= threshold && !alreadyLogged;
}

// Test-only fault injection for the harper-pro#420 regression test. When HARPER_TEST_REPLICATION_WEDGE_DB
// names a database, the FIRST receive (subscription) connection for it is forced into the open-but-idle
// wedge: the socket is paused (no frames arrive, so nothing re-arms the watchdog) and its terminate/close
// are neutralized so no 'close' event ever fires. The caller also freezes the watchdog's observed byte
// count for this connection — `socket.bytesRead` counts OS-buffered bytes (incl. pong frames) even while
// paused, so without freezing it the watchdog would keep seeing "activity" and never trip. Together these
// reproduce the field condition where recovery cannot come from the close handler and must come from
// forceReconnect's close-independent reconnect — so the test stays wedged on the pre-#420 bare-terminate()
// code and only recovers with the fix. One-shot per worker thread, so the reconnect's fresh socket
// recovers normally. Never arms in production: the env var is set only by the regression test.
let replicationWedgeForTestArmed = false;
export function armReplicationWedgeForTest(connection: any, ws: WebSocket, databaseName?: string): boolean {
	// Guard the env var first: an unset var is undefined, and `undefined !== undefined` is false, so a
	// connection with an undefined databaseName would otherwise arm the wedge in production.
	if (!process.env.HARPER_TEST_REPLICATION_WEDGE_DB) return false;
	if (!connection || replicationWedgeForTestArmed || process.env.HARPER_TEST_REPLICATION_WEDGE_DB !== databaseName)
		return false;
	replicationWedgeForTestArmed = true;
	logger.warn?.(`[test] forcing open-but-idle replication wedge for db "${databaseName}" (harper-pro#420)`);
	ws.terminate = () => {};
	ws.close = () => {};
	ws._socket?.pause();
	return true; // tell the watchdog to treat this connection's byte count as frozen
}

// Test-only fault injection for the stale-watchdog-fire regression test. When
// HARPER_TEST_LEAK_CONNECTION_AFTER_COPY_START_DB names a database, the FIRST receive connection for it
// is turned into a leaked instance right after COPY_START: terminate/close are neutralized (no 'close'
// ever fires, so closeConnection never retires this instance's watchdogs) and the socket is paused (no
// further frames). The caller also flips the byte watchdog's frozen-bytes flag so it reaps the leg at
// copyTimeout, exactly the production shape: a silent leg born, reaped at the copy timeout, leaving a
// live armed copy-progress timer behind. One-shot per worker thread, so the reconnect's fresh socket
// completes the copy normally. Never arms in production: the env var is set only by the regression test.
let leakConnectionForTestArmed = false;
export function maybeLeakConnectionAfterCopyStartForTest(
	connection: any,
	ws: WebSocket,
	databaseName?: string
): boolean {
	if (!process.env.HARPER_TEST_LEAK_CONNECTION_AFTER_COPY_START_DB) return false;
	if (
		!connection ||
		leakConnectionForTestArmed ||
		process.env.HARPER_TEST_LEAK_CONNECTION_AFTER_COPY_START_DB !== databaseName
	)
		return false;
	leakConnectionForTestArmed = true;
	logger.warn?.(`[test] leaking replication connection after COPY_START for db "${databaseName}"`);
	ws.terminate = () => {};
	ws.close = () => {};
	ws._socket?.pause();
	return true;
}

// Test-only fault injection for harper-pro#453. When HARPER_TEST_COPY_STALL_ONCE_DB names a database,
// the FIRST outbound base copy for it is stalled mid-flight: right after COPY_START the send loop awaits
// a promise that never resolves, so no further copy frames (and no COPY_COMPLETE) are sent — but the
// independent sendPing timer keeps the socket ping-alive. This reproduces the field wedge where the
// receiver settles connected:true / "Receiving" with the copy frozen: keepalive pings keep its byte-level
// receive watchdog from firing and the connected:false wedge-reconcile passes it by, so only the
// copy-progress watchdog recovers it. One-shot per process, so the post-reconnect copy completes normally.
// Never arms in production: the env var is set only by the regression test.
let copyStallForTestArmed = false;
export function maybeStallCopyForTest(databaseName?: string): Promise<void> | undefined {
	if (!process.env.HARPER_TEST_COPY_STALL_ONCE_DB) return undefined;
	if (copyStallForTestArmed || process.env.HARPER_TEST_COPY_STALL_ONCE_DB !== databaseName) return undefined;
	copyStallForTestArmed = true;
	logger.warn?.(`[test] stalling outbound base copy mid-flight for db "${databaseName}" (harper-pro#453)`);
	return new Promise<void>(() => {}); // never resolves; the sendPing timer keeps pings flowing
}

// Test-only fault injection for the copy-progress false-fire repro: when HARPER_TEST_COPY_COMMIT_DELAY_ONCE_DB
// names a database, the FIRST copy-batch commit for it is delayed by HARPER_TEST_COPY_COMMIT_DELAY_MS (default
// 4000) at the top of onCommit. outstandingCommits stays elevated for the delay, so the commit-backlog
// back-pressure pause stays open that long — simulating a receiver whose apply is slow but progressing.
// One-shot per process so the copy converges promptly once the pause window has been exercised.
// Never arms in production: the env vars are set only by the regression test.
let copyCommitDelayForTestArmed = false;
export function maybeDelayCopyCommitForTest(databaseName?: string): Promise<void> | undefined {
	if (!process.env.HARPER_TEST_COPY_COMMIT_DELAY_ONCE_DB) return undefined;
	if (copyCommitDelayForTestArmed || process.env.HARPER_TEST_COPY_COMMIT_DELAY_ONCE_DB !== databaseName)
		return undefined;
	copyCommitDelayForTestArmed = true;
	const ms = Number(process.env.HARPER_TEST_COPY_COMMIT_DELAY_MS) || 4000;
	logger.warn?.(`[test] delaying first base-copy commit by ${ms}ms for db "${databaseName}"`);
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

// Test-only fault injection for the copy-finalization watchdog. When HARPER_TEST_COPY_FINALIZE_STALL_ONCE_DB
// names a database, the FIRST copy-cursor flush for it never settles on the RECEIVER: the copy's onCommit
// awaits it forever, so `maybeFinishCopy` never runs and the node parks in copy mode permanently — the wedge
// shape, but with the event loop still alive so a JS watchdog can act on it. One-shot per process, so the
// copy after the forced reconnect finalizes normally.
let copyFinalizeStallForTestArmed = false;
export function maybeStallCopyFinalizeForTest(databaseName?: string): Promise<never> | undefined {
	if (!process.env.HARPER_TEST_COPY_FINALIZE_STALL_ONCE_DB) return;
	if (copyFinalizeStallForTestArmed || process.env.HARPER_TEST_COPY_FINALIZE_STALL_ONCE_DB !== databaseName) return;
	copyFinalizeStallForTestArmed = true;
	logger.warn?.(`[test] stalling copy finalization flush for db "${databaseName}"`);
	return new Promise<never>(() => {});
}

// Test-only fault injection for harper-pro#642: one-shot per process, so a receiver watchdog reconnect
// reaches the normal setup path. Never arms in production — only the regression test sets the env var.
let subscriptionSetupStallForTestArmed = false;
export function maybeStallSubscriptionSetupForTest(databaseName?: string): Promise<never> | undefined {
	if (!process.env.HARPER_TEST_SUBSCRIPTION_SETUP_STALL_ONCE_DB) return;
	if (subscriptionSetupStallForTestArmed || process.env.HARPER_TEST_SUBSCRIPTION_SETUP_STALL_ONCE_DB !== databaseName)
		return;
	subscriptionSetupStallForTestArmed = true;
	logger.warn?.(`[test] stalling subscription setup before DB_SCHEMA for db "${databaseName}" (harper-pro#642)`);
	return new Promise<never>(() => {});
}

// Test-only fault injection for harper-pro#537 symptom characterization. When
// HARPER_TEST_INJECT_COPY_CURSOR_JSON is set on the RECEIVER node, the subscription handshake
// overrides the copyCursor with the JSON-parsed value — as if a prior interrupted copy had left a
// poisoned resume cursor in the __dbis__ store. This lets integration tests demonstrate the
// cursor-trust behavior (leader resumes at afterKey, skipping all earlier rows) without filesystem
// manipulation or a real interrupted copy. One-shot via env-clear so the post-test reconnect uses the
// real (absent) cursor.  Never arms in production: the env var is set only by the regression test.
export function maybeInjectCopyCursorForTest(existingCursor: any, databaseName?: string): any {
	if (!process.env.HARPER_TEST_INJECT_COPY_CURSOR_JSON) return existingCursor;
	if (existingCursor) return existingCursor; // never override a real cursor
	let injected: any;
	try {
		injected = JSON.parse(process.env.HARPER_TEST_INJECT_COPY_CURSOR_JSON);
	} catch {
		return existingCursor;
	}
	// Only fire for the named db (the JSON encodes { db, cursor }), so a two-database node doesn't
	// inject on the wrong database leg.
	if (injected.db && injected.db !== databaseName) return existingCursor;
	process.env.HARPER_TEST_INJECT_COPY_CURSOR_JSON = ''; // one-shot: clear so reconnect uses real cursor
	logger.warn?.(
		`[test] injecting synthetic copyCursor for cursor-trust characterization (harper-pro#537), db ${databaseName}`
	);
	return injected.cursor;
}

// Test-only fault injection for the harper-pro#537/#545 decode-drop recovery test. When
// HARPER_TEST_DECODE_FAIL_RECORD_PREFIX is set on the RECEIVER, the value decode for any record whose
// id starts with that prefix throws the field's torn-value error, driving the classify-skip catch
// below without needing a genuinely corrupt blob on the sender. This reproduces the wedge trigger
// (#521 closed-and-resumed on exactly this throw, looping forever) so the test can assert #545 skips
// it and keeps the leg alive. Never arms in production: the env var is set only by the regression test.
//
// The prefix is read ONCE at module load, not per record: the hook is called on the per-record
// receive-apply hot path, and a `process.env` read there is a native getter on every record. These
// test env vars are set before the Harper process starts, so a load-time read is both correct and
// free — the unset (production) path is a single cached-undefined check.
const DECODE_FAIL_RECORD_PREFIX_FOR_TEST = process.env.HARPER_TEST_DECODE_FAIL_RECORD_PREFIX;
export function maybeInjectDecodeFailureForTest(recordId: unknown): void {
	if (
		DECODE_FAIL_RECORD_PREFIX_FOR_TEST &&
		typeof recordId === 'string' &&
		recordId.startsWith(DECODE_FAIL_RECORD_PREFIX_FOR_TEST)
	) {
		throw new Error('Unexpected end of MessagePack data (test-injected, harper-pro#537)');
	}
}

// Test-only override for a source that resolved to NO resume cursor. Unarmed (production) it returns
// undefined and the caller requests a full copy (harper-pro#428). When HARPER_TEST_DISABLE_CURSORLESS_FULL_COPY=1
// is set on the RECEIVER it returns the pre-#428 start for a non-leader source — `now - 60s`, which silently
// skips whatever backlog the source holds that is older than a minute — so
// integrationTests/cluster/relayedOriginResumeGap.test.mjs can prove its convergence assertion catches that
// loss. Read per call: it runs once per subscription build.
export function maybeLegacyCursorlessResumeStartForTest(
	isLeader: boolean | undefined,
	now: number = Date.now()
): number | undefined {
	if (isLeader || process.env.HARPER_TEST_DISABLE_CURSORLESS_FULL_COPY !== '1') return undefined;
	return now - 60000;
}

/**
 * Mark an error as a *source-reported* blob unavailability: the sender told us (via a BLOB_CHUNK
 * `error` marker) that it cannot provide this blob — classically `ENOENT` because the blob was
 * evicted/expired at the origin. Set on the error the receive loop destroys the blob stream with, so
 * the blob-save `.catch` in `receiveBlobs` can tell it apart from a local/transient save fault.
 */
export function markSourceBlobUnavailable(error: Error, escalation?: BlobGapEscalation): Error {
	(error as { sourceBlobUnavailable?: boolean }).sourceBlobUnavailable = true;
	if (escalation) (error as { blobGapEscalation?: BlobGapEscalation }).blobGapEscalation = escalation;
	return error;
}

/** The escalation that reclassified this held delivery as unrecoverable, if the budget did (harper-pro#432). */
export function getBlobGapEscalation(error: unknown): BlobGapEscalation | undefined {
	return typeof error === 'object' && error !== null
		? (error as { blobGapEscalation?: BlobGapEscalation }).blobGapEscalation
		: undefined;
}

/**
 * Stamp the origin's forwarded read status on the destroy error. The frame handler cannot know whether
 * a delivery will hold the cursor (a peer can send error frames for file ids no record references), so
 * the save `.catch` — which does — is what budgets a 503 hold (harper-pro#432).
 */
export function markSourceBlobStatus(error: Error, status: unknown): Error {
	if (typeof status === 'number') (error as { sourceBlobStatus?: number }).sourceBlobStatus = status;
	return error;
}

/**
 * A source-reported 503 (transiently unavailable at the origin: a PENDING placeholder or read timeout)
 * — the one transient class the escalation budget bounds. Local save faults and code-less older senders
 * keep holding indefinitely.
 */
export function isBudgetedSourceBlobError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { sourceBlobStatus?: number }).sourceBlobStatus === BLOB_UNAVAILABLE_STATUS
	);
}

/**
 * Whether a blob-save failure is unrecoverable *at the source* (see `markSourceBlobUnavailable`).
 * Such a blob cannot be re-streamed — a reconnect reproduces the identical error — so the receiver
 * advances the resume cursor past it (recorded loudly) rather than holding `hasBlobGap` forever and
 * wedging the whole connection. Local/transient save faults (disk full, mid-stream timeout) are NOT
 * this and still hold so a reconnect can re-save them. See harper-pro#403; the diverged record is
 * left for proactive blob backfill (harper-pro#388). Pure so the classification is unit-testable.
 */
export function isUnrecoverableSourceBlobError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { sourceBlobUnavailable?: boolean }).sourceBlobUnavailable === true
	);
}

/**
 * Whether a sender-forwarded blob read-error denotes a PERMANENT failure at the origin — re-streaming on
 * reconnect reproduces the identical error, so the receiver may advance the resume cursor past it rather
 * than holding `hasBlobGap` forever and wedging the whole connection (harper-pro#403/#429). Two signals,
 * either of which marks permanent:
 *
 *   - `errorCode === 'ENOENT'` — the classic case: the blob was evicted/expired at the origin. Kept for
 *     pre-#1425 senders, whose read paths reject with the raw fs error (it carries `.code`).
 *   - `errorStatus` 404 or 500 — the HTTP-style status core PR harper#1425 attaches to `BlobReadError`.
 *     404 = the file is cleanly gone; 500 = confidently corrupt/incomplete (a self-consistent truncation,
 *     or an incomplete read after the writer finished — harper-pro#429). Both are unrecoverable.
 *
 * 503 (write-in-progress / read-timeout) is TRANSIENT and deliberately excluded, as are transient fs
 * faults (`EIO`, `EMFILE`) and a missing code/status (older sender that forwards neither) — all return
 * false so the receiver HOLDS the gap and a reconnect retries, never silently skipping a recoverable blob.
 *
 * NB once harper#1425 lands, core wraps even ENOENT into a code-less `BlobReadError(404)`, so the
 * `errorStatus` arm is what preserves the #405 advance-past for a missing source blob — not just the new
 * #429 incomplete case. The `errorCode` arm remains for senders still running pre-#1425 core.
 */
export function isPermanentSourceBlobErrorCode(errorCode: unknown, errorStatus?: unknown): boolean {
	return errorCode === 'ENOENT' || errorStatus === 404 || errorStatus === 500;
}

// Escalating waits for re-reading a source blob whose read failed with a 503 before forwarding the
// error to the receiver. The dominant 503 is a PENDING placeholder left by a concurrent replication
// receive (harper-pro#481) — a rolling population that heals within seconds at this node — while a
// forwarded 503 latches the receiver's blob gap and pins its resume cursor until a reconnect (#683).
// A few short in-place retries are far cheaper than that whole-link cost.
export const BLOB_SEND_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

/**
 * Whether a failed source blob read is worth retrying in place before forwarding the error to the
 * receiver: 503 means transiently unavailable at this node (pending replication receive, or a read
 * mid-write) — unlike the permanent classes above (ENOENT/404/500) or a local fs fault, both of which
 * should be forwarded immediately (#683).
 */
export function isRetriableSourceBlobReadError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { statusCode?: number }).statusCode === 503;
}

/**
 * Whether `sendBlobs` should retry a failed source blob read in place instead of forwarding the
 * error frame (#683): only a 503-class fault, only while the receiver holds no partial state
 * (nothing sent yet), never on a closed connection or one draining for worker shutdown (the peer
 * re-requests on reconnect, #527), and only within the bounded delay schedule.
 */
export function shouldRetrySourceBlobRead(state: {
	error: unknown;
	sentAnyChunk: boolean;
	wsClosed: boolean;
	draining: boolean;
	attempt: number;
}): boolean {
	return (
		!state.sentAnyChunk &&
		!state.wsClosed &&
		!state.draining &&
		state.attempt < BLOB_SEND_RETRY_DELAYS_MS.length &&
		isRetriableSourceBlobReadError(state.error)
	);
}

export type BlobGapEscalation = { cycles: number; heldMs: number; cohort?: boolean };
export type BlobGapEscalationBudget = ReturnType<typeof createBlobGapEscalationBudget>;

/**
 * One held delivery's identity across re-streams. Valid record ids use the same ordered-binary bytes
 * as the primary stores, then the whole tuple is hashed so no delimiter can alias two deliveries and
 * no user-controlled id remains retained on the long-lived connection. Invalid ids take a total,
 * non-throwing fallback because this runs inside the blob-save settlement chain.
 */
export function blobGapDeliveryKey(fileId: unknown, recordId: unknown, tableName?: string): string {
	const hash = createHash('sha256');
	updateBlobGapKeyHash(hash, safeBlobGapKeyText(fileId));
	updateBlobGapKeyHash(hash, tableName ?? '');
	try {
		updateBlobGapKeyHash(hash, toBufferKey(recordId as any));
	} catch {
		updateBlobGapKeyHash(hash, `invalid:${typeof recordId}`);
	}
	return hash.digest('base64url');
}

function updateBlobGapKeyHash(hash: Hash, part: string | Uint8Array): void {
	const length = typeof part === 'string' ? Buffer.byteLength(part) : part.byteLength;
	hash.update(`${length}:`).update(part);
}

function safeBlobGapKeyText(value: unknown): string {
	if (typeof value === 'string') return value;
	try {
		return `${typeof value}:${String(value)}`;
	} catch {
		return typeof value;
	}
}

// Active socket generations (ones that held a delivery or settled a tracked one) a delivery may go unseen
// before its entry is dropped. The #683 timer reconnects precisely to re-stream every held delivery, so
// one that two such generations did not re-hold has healed, been skipped past, or been superseded by a
// new source file id — it will never be charged again and would otherwise occupy the budget for the
// process lifetime. Sockets that die before settling anything (a peer in a restart loop, a copy the
// watchdogs keep terminating) do not count, so an unstable link cannot reset a held delivery's clock.
const BLOB_GAP_RETIRE_AFTER_GENERATIONS = 2;

/**
 * Cross-reconnect escalation budget for held source-blob gaps (harper-pro#432; policy in
 * replication/DESIGN.md item 8). Lives on the persistent `NodeReplicationConnection`; charges one cycle
 * per socket generation per delivery. Invariants the wiring relies on: exhaustion is STICKY until a
 * successful save of that delivery (forgetting it lets two deliveries with offset phases leapfrog
 * forever); a charge or resolve from a generation older than the newest begun is ignored (a retired
 * socket's late settlements must not touch the live budget); live progress is never dropped for room,
 * and every hold has a terminal bound even at capacity — the oldest exhausted entry not re-held this
 * generation makes room, and a hold that still cannot be tracked is charged against one shared cohort
 * entry with the same bounds (it conflates its members, which is why `maxTracked` is generous; without
 * it, `maxTracked + 1` persistent gaps could rotate forever with no gap-free generation). Entries unseen
 * for BLOB_GAP_RETIRE_AFTER_GENERATIONS active socket generations are retired.
 */
export function createBlobGapEscalationBudget(opts: {
	maxCycles: number;
	maxHoldMs: number;
	maxTracked?: number;
	now?: () => number;
	generation?: number;
	onCapacity?: (tracked: number) => void;
}) {
	const maxTracked = opts.maxTracked ?? BLOB_GAP_BUDGET_MAX_TRACKED;
	const now = opts.now ?? (() => performance.now());
	type Entry = { firstHeldAt: number; cycles: number; lastGeneration: number; lastEpoch: number; exhausted: boolean };
	const held = new Map<string, Entry>();
	let cohort: Entry | undefined;
	let currentGeneration = opts.generation ?? 0;
	let capacityWarnedGeneration = -1;
	// Activity epochs: one per socket generation that held a delivery or settled a tracked one. Unrelated
	// successful saves do not count — a socket that dies after saving other blobs but before reaching the
	// held delivery must not look like a generation that could have re-held it.
	let activeEpoch = 0;
	let activeGeneration = -1;
	const noteActivity = (generation: number) => {
		if (generation !== activeGeneration) {
			activeGeneration = generation;
			activeEpoch++;
		}
	};
	const isStale = (generation: number) => {
		if (generation < currentGeneration) return true;
		currentGeneration = generation;
		return false;
	};
	const newEntry = (at: number): Entry => ({
		firstHeldAt: at,
		cycles: 0,
		lastGeneration: -1,
		lastEpoch: activeEpoch,
		exhausted: false,
	});
	const advance = (entry: Entry, generation: number, at: number): BlobGapEscalation | undefined => {
		entry.lastEpoch = activeEpoch;
		if (entry.lastGeneration !== generation) {
			entry.cycles++;
			entry.lastGeneration = generation;
		}
		const heldMs = at - entry.firstHeldAt;
		if (!entry.exhausted) {
			entry.exhausted =
				(opts.maxCycles > 0 && entry.cycles >= opts.maxCycles) || (opts.maxHoldMs > 0 && heldMs >= opts.maxHoldMs);
		}
		return entry.exhausted ? { cycles: entry.cycles, heldMs } : undefined;
	};
	// Oldest exhausted entry this socket has not re-held (Map iteration is insertion order): its record
	// was skipped past, so dropping it touches no live progress; a re-held one keeps its stickiness.
	const evictExhausted = (generation: number): boolean => {
		for (const [key, entry] of held) {
			if (entry.exhausted && entry.lastGeneration < generation) {
				held.delete(key);
				return true;
			}
		}
		return false;
	};
	return {
		beginGeneration(generation: number): void {
			if (generation <= currentGeneration) return;
			currentGeneration = generation;
			const silentSince = activeEpoch - BLOB_GAP_RETIRE_AFTER_GENERATIONS;
			for (const [key, entry] of held) {
				if (entry.lastEpoch <= silentSince) held.delete(key);
			}
			if (cohort && cohort.lastEpoch <= silentSince) cohort = undefined;
		},
		/**
		 * `key` is holding the cursor in socket `generation`; returns the escalation to apply once its budget
		 * is exhausted, else undefined (keep holding).
		 */
		charge(key: string, generation: number): BlobGapEscalation | undefined {
			if (isStale(generation)) return undefined;
			noteActivity(generation);
			const at = now();
			let entry = held.get(key);
			if (!entry) {
				if (held.size >= maxTracked && !evictExhausted(generation)) {
					if (capacityWarnedGeneration !== generation) {
						capacityWarnedGeneration = generation;
						try {
							opts.onCapacity?.(held.size);
						} catch {}
					}
					cohort ??= newEntry(at);
					const escalation = advance(cohort, generation, at);
					return escalation && { ...escalation, cohort: true };
				}
				entry = newEntry(at);
				held.set(key, entry);
			}
			return advance(entry, generation, at);
		},
		/** `key` is settled (saved, or skipped past for good); a later hold of it starts a fresh budget. */
		resolve(key: string, generation: number): void {
			if (held.size === 0 || isStale(generation)) return;
			if (held.delete(key)) noteActivity(generation);
		},
		get size(): number {
			return held.size;
		},
	};
}

// A module-level factory so the budget, which outlives every socket, retains only these two strings and
// not the allocating socket's whole replicateOverWS scope.
function blobGapCapacityWarning(peer: string, database: string): (tracked: number) => void {
	return (tracked) =>
		logger.warn?.(
			`Blob-gap escalation budget for ${peer} (db: "${database}") is tracking ${tracked} held deliveries, its capacity; ` +
				`further held deliveries share one capacity budget until a tracked one settles (harper-pro#432)`
		);
}

export function describeBlobGapEscalation(
	escalation: BlobGapEscalation,
	limits: { maxCycles: number; maxHoldMs: number }
): string {
	return (
		`blob-gap escalation budget exhausted after ${escalation.cycles} reconnect cycle(s) holding it for ${Math.round(escalation.heldMs)}ms ` +
		`(limits: ${limits.maxCycles || 'no'} cycles / ${limits.maxHoldMs || 'no'} ms` +
		(escalation.cohort
			? '; charged against the shared capacity budget, the connection tracks its maximum of held deliveries'
			: '') +
		')'
	);
}

/**
 * For an incoming record that is a provable identity-tie DUPLICATE of the locally stored record
 * (same version AND same source node — the exact condition core's apply loop uses to drop it),
 * return the stored record's file-backed blobs positionally, with `undefined` at positions whose
 * file is healthy and the existing Blob at positions whose file is missing/incomplete. The
 * receive path streams the re-delivered bytes INTO those existing fileIds (core
 * `repairBlobFile`), healing the dangling reference the tie-skip would otherwise preserve forever
 * (harper-pro#699 — a transiently-failed save leaves a PENDING stub, harper-pro#481, and the
 * re-stream otherwise lands under a fresh fileId the record never references). Returns null when
 * this record is not a tie, has no stored counterpart, or has no damaged blob — the caller then
 * uses the normal fresh-save path. A tie guarantees content identity, so bytes-for-bytes overwrite
 * of the existing file is sound; positional pairing is sound for the same reason (identical
 * structure). MaybePromise reads are awaited because resumed spans are commonly cold. Never
 * throws: any read/decode surprise returns null (normal path, no repair).
 */
export async function collectBlobRepairTargets(
	tableDecoder: any,
	id: any,
	incomingVersion: number,
	sourceNodeId: number | undefined,
	blobFileDamaged: (blob: any) => Promise<boolean | undefined> | boolean | undefined,
	declines?: Record<string, number>,
	preloadedEntry?: any
): Promise<any[] | null> {
	const decline = (reason: string) => {
		if (declines) declines[reason] = (declines[reason] ?? 0) + 1;
		return null;
	};
	try {
		if (sourceNodeId === undefined) return decline('no-source-node');
		let existing = preloadedEntry;
		if (existing === undefined) {
			existing = tableDecoder?.getEntry?.(id);
			if (existing && typeof existing.then === 'function') existing = await existing;
		}
		if (!existing) return decline('no-stored-entry');
		if (existing.version !== incomingVersion) return decline('version-mismatch');
		if ((existing.nodeId ?? 0) !== sourceNodeId) return decline('node-mismatch');
		const blobs: any[] = [];
		findBlobsInObject(existing.value, (blob: any) => {
			blobs.push(blob);
		});
		// Single-blob rows only: with one stored blob the incoming record's (single) blob stream is
		// unambiguously its counterpart. Multi-blob rows would require pairing the stored blobs to the
		// incoming decode callbacks positionally — an unverified cross-traversal ordering assumption
		// where a mismatch writes one field's bytes into another field's file — so they are left to
		// backfill (harper-pro#388). The field population is single-blob rows.
		if (blobs.length !== 1) return decline(blobs.length === 0 ? 'no-file-blobs' : 'multi-blob');
		const damaged = await blobFileDamaged(blobs[0]);
		return damaged === true ? [blobs[0]] : decline(damaged === false ? 'healthy' : 'not-probeable');
	} catch {
		return decline('error');
	}
}

/**
 * Async damage probe for repair-candidate blobs: same header semantics as core's sync classifier
 * (shared `blobHeaderIndicatesIncomplete`), but on fs promises so the per-duplicate probes of a
 * resumed copy never block the receive worker's event loop. `undefined` = not a probeable file
 * blob. Lock/in-flight consultation is deliberately absent here — `repairBlobFile` re-checks
 * synchronously (including the :blob lock) immediately before writing.
 */
export async function blobFileMissingOrIncompleteAsync(blob: any): Promise<boolean | undefined> {
	try {
		const filePath = getFilePathForBlob(blob);
		if (!filePath) return undefined;
		let handle;
		try {
			handle = await fsPromises.open(filePath, 'r');
		} catch (error) {
			return (error as { code?: string })?.code === 'ENOENT' ? true : undefined;
		}
		try {
			const size = (await handle.stat()).size;
			if (size < 8) return true;
			const header = Buffer.allocUnsafe(8);
			if ((await handle.read(header, 0, 8, 0)).bytesRead < 8) return true;
			return blobHeaderIndicatesIncomplete(header, size);
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/**
 * Whether a `replicateOverWS` closure no longer owns its (peer, db) link (#683). `wsClosed` alone
 * is NOT sufficient: `forceReconnect`'s teardown of the old socket is best-effort and may never
 * fire 'close' (the #420 open-but-idle wedge), while the replacement installs a new `socket` on
 * the shared connection object — so ownership is socket identity, the same test the close handler
 * uses. An inbound connection (no `connection` object) degrades to `wsClosed`.
 */
export function isConnectionSuperseded(
	wsClosed: boolean,
	connection: { socket?: unknown } | null | undefined,
	ws: unknown
): boolean {
	return wsClosed || (connection != null && connection.socket !== ws);
}

/**
 * Repeating reconnect timer for a held blob gap (#683). `hasBlobGap` latches on the first transient
 * blob-save failure and nothing in the connection's lifetime clears it — only a reconnect (fresh
 * connection state) re-streams the gapped blob, whose source-side fault typically heals within
 * seconds. A gapped connection keeps flowing frames and answering pings, so no byte/frame watchdog
 * ever notices it; without this timer the durable cursors stay pinned until an UNRELATED reconnect
 * happens along (observed 3.7h in the field), and each such reconnect resumes a whole-table base
 * copy. Armed at the first latch; fires `onGapHeld` after each `timeoutMs` the connection remains
 * up, re-arming itself — `forceReconnect()` can be a no-op (a retry already scheduled and later
 * abandoned), and a one-shot fire landing there would leave the wedge unbounded again. `stop()`
 * cancels on connection close.
 */
export function createBlobGapReconnectTimer(opts: { timeoutMs: number; onGapHeld: () => void }): {
	arm: () => void;
	stop: () => void;
	isArmed: () => boolean;
} {
	let timer: NodeJS.Timeout | undefined;
	const arm = () => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			arm();
			// A throw from the callback in a bare timer would crash the worker — and, re-armed, repeat
			// the crash every cycle. The callback logs before acting, so swallowing loses no signal.
			try {
				opts.onGapHeld();
			} catch {}
		}, opts.timeoutMs);
		timer.unref?.();
	};
	return {
		arm,
		stop() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
		isArmed: () => timer !== undefined,
	};
}

/**
 * Create the PassThrough that receives a blob's bytes on the way to its file store. It carries a no-op
 * `'error'` listener from creation so that destroying it with an error — most importantly the blobsTimer
 * sweep tearing down a blob whose save never wired up, leaving the stream orphaned in `blobsInFlight`
 * after an app/source error (harper-pro#1337) — cannot promote a stream `'error'` into a process-level
 * uncaughtException. saveBlob's pipeline still observes and reports real errors via its completion
 * callback; this listener only suppresses the unhandled-error crash, never the handling.
 */
export function createBlobReceiveStream(idleTimeoutMs?: number): PassThrough {
	const stream = new PassThrough();
	stream.on('error', () => {});
	// Arm core's source-idle watchdog (harper#1444) on this receive source: a sender that stops mid-blob
	// without a closing/error BLOB_CHUNK would otherwise leave writeBlobWithStream's pipeline waiting
	// forever, pinning the per-database apply consumer at lastReceivedStatus="Receiving". The watchdog is
	// off in core by default — bounding a source's liveness is the owning caller's job — so the replication
	// receiver, which knows its source is a network-fed PassThrough that can wedge, opts in here.
	if (idleTimeoutMs && idleTimeoutMs > 0)
		(stream as { blobStreamIdleTimeoutMs?: number }).blobStreamIdleTimeoutMs = idleTimeoutMs;
	return stream;
}

/**
 * On reconnect the follower reads its persisted copy-resume cursor (`{copyStartTime, currentTable,
 * afterKey}` under `dbisDB[Symbol.for('copyCursor'), nodeId]`) and forwards it to the leader so the
 * bulk copy can resume mid-stream. If the cursor on disk is malformed — specifically `currentTable`
 * missing or nullish (harper-pro#321) — the leader's resume check falls into the warn-and-recopy
 * branch on every reconnect: the cluster never converges, and COPY_COMPLETE never arrives to clear
 * the cursor while the loop is active.
 *
 * Recovery: detect the bad cursor and remove it from disk so the next subscription request goes out
 * as a clean full-copy request instead of forwarding the malformed value. Returns the cursor
 * unchanged when well-formed; returns `undefined` after a side-effecting `remove` when malformed.
 *
 * Exported so the predicate + side effect can be exercised in isolation by
 * `unitTests/replication/discardMalformedCopyCursor.test.mjs`; production callers go through
 * `replicateOverWS`.
 */
export function discardMalformedCopyCursor(
	copyCursor: DbisCursor | undefined,
	dbisDB: DbisStore | undefined,
	nodeId: any,
	warn?: () => void
): DbisCursor | undefined {
	// copyCursor is DbisCursor | undefined (not any) so the #485 invariant reaches this path too: passing a
	// raw dbisDB.get() result (a MaybePromise on a RocksDB cache miss) is a tsc error here, not a Promise that
	// reads as malformed and gets remove()d from disk — i.e. a spurious full-recopy on reconnect (#321).
	if (!copyCursor || copyCursor.currentTable) return copyCursor;
	warn?.();
	if (nodeId !== undefined) dbisDB?.remove?.([Symbol.for('copyCursor'), nodeId]);
	return undefined;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * A per-source resume cursor as stored in the `__dbis__` store under `[Symbol.for('seq'|'copyCursor'), id]`:
 * a `seq` row (`{ seqId, nodes, lastTxnTime }`) or a `copyCursor` row (`{ copyStartTime, currentTable, … }`).
 * All fields optional because the two shapes share one keyspace; consumers read the subset they expect.
 */
type DbisCursor = {
	seqId?: number;
	nodes?: any[];
	lastTxnTime?: number;
	copyStartTime?: number;
	currentTable?: string;
	afterKey?: any;
	copyOrder?: number;
	cloneAttempt?: string;
};

/**
 * Typed view of the raw `__dbis__` store for the resume-cursor read path. `get()` is honestly a
 * `MaybePromise` (RocksDB returns a Promise on a block-cache miss), so any *synchronous* consumption of
 * `get()` — `store.get(k)?.seqId`, truthiness, spread — is a compile error: use `getSync()` (forces the
 * inline read) or `await`. Everything else (`put`/`remove`/`getRange`/…) falls through the index signature,
 * so there is no broad retype / blast radius. This makes the #484 fix a compile-time invariant: see
 * readDbisCursorSync below. (harper-pro#485; mirrors the `NodeStore` typing in knownNodes.ts / #477.)
 */
export type DbisStore = {
	get(key: any): MaybePromise<DbisCursor | undefined>;
	getSync(key: any): DbisCursor | undefined;
	[key: string]: any;
};

/**
 * Synchronous point-read of a per-source replication resume cursor (`seq` or `copyCursor`) from the raw
 * __dbis__ store.
 *
 * getSync (not get): __dbis__ is RocksDB, whose get() is a MaybePromise — it returns the value when the
 * key is in the block cache / memtable, but a *Promise* on a cache miss that needs a disk read. The
 * subscription handshake runs right after a restart/upgrade, exactly when the cursor key is cold. An
 * un-awaited get() there returns a Promise: for a `seq` row `Promise?.seqId` is undefined, so startTime
 * collapses to 1 and the handshake treats a node with a valid persisted cursor as having no resume point
 * — forcing an unnecessary FULL COPY. This is worse the larger the system database, since more block-cache
 * pressure makes the seq key likelier to be evicted (the field signature: large-system-DB nodes full-copy
 * on upgrade while small ones resume incrementally). For a `copyCursor` row the Promise reads as a
 * malformed/absent cursor and an interrupted-copy resume point is dropped. getSync forces the inline read
 * regardless of cache state, mirroring the writer (core Table.ts updateRecordedSequenceId, nodeIdMapping.ts).
 *
 * Exported for unit coverage (unitTests/replication/readDbisCursorSync.test.mjs); production callers go
 * through `replicateOverWS`.
 */
export function readDbisCursorSync(
	dbisDB: DbisStore | undefined,
	kind: 'seq' | 'copyCursor' | 'cloneCopyComplete',
	id: any
): DbisCursor | undefined {
	// getSync is load-bearing here: reverting it to get() would return a MaybePromise that no longer
	// satisfies the DbisCursor | undefined return type — a tsc error, not a silent full-copy regression.
	return dbisDB?.getSync([Symbol.for(kind), id]);
}

export function matchesCloneCopyCompletion(marker: DbisCursor | undefined, cloneAttempt: string | undefined): boolean {
	return (
		typeof cloneAttempt === 'string' &&
		marker?.cloneAttempt === cloneAttempt &&
		typeof marker.copyStartTime === 'number' &&
		Number.isFinite(marker.copyStartTime)
	);
}

/**
 * A database's local subscription: either the resolved `IterableEventQueue` that `Replicator.subscribe()`
 * registers, or the still-unresolved placeholder Promise a connection is handed before that registration
 * happens (see createPendingDatabaseSubscription).
 */
export type DatabaseSubscription = {
	then?: unknown; // present only on the unresolved placeholder
	retired?: boolean; // a placeholder given up on by a bounded wait — never usable, always re-derive
	auditStore?: any;
	dbisDB?: DbisStore;
	[key: string]: any;
};

/**
 * The audit + `__dbis__` stores for a database, resolved without requiring its local subscription to
 * have been registered yet. Both stores are per-DATABASE (`rootStore.auditStore` / `rootStore.dbisDb`,
 * surfaced on every table of the database); the subscription queue is only a carrier that
 * `Replicator.subscribe()` copies them onto from the first table that registers.
 *
 * That distinction is load-bearing. Until the registration happens, a connection's subscription is an
 * unresolved placeholder Promise whose `auditStore`/`dbisDB` are `undefined`. Reading them off it made
 * "this thread has not registered the subscription yet" indistinguishable from "this source has no
 * resume cursor": `nodeId` came back undefined, no `seq` cursor resolved, `startTime` collapsed to 1
 * and the handshake requested a FULL DATABASE COPY while a current cursor sat on disk — on every
 * restart, for every database that lost the race (harper-pro#622). Same failure shape as the
 * MaybePromise read in readDbisCursorSync above, a different source of `undefined`.
 *
 * Returns empty stores only when the database has no local tables at all — an empty node bootstrapping
 * from its leader, which is the case a full copy genuinely exists for.
 *
 * Exported for unit coverage (unitTests/replication/resolveDatabaseStores.test.mjs).
 */
export function resolveDatabaseStores(
	subscription: DatabaseSubscription | undefined,
	tables: Record<string, any> | undefined
): { auditStore?: any; dbisDB?: DbisStore } {
	// Never read the stores off an unresolved placeholder; it carries neither.
	const resolved = subscription?.then ? undefined : subscription;
	let auditStore = resolved?.auditStore;
	let dbisDB = resolved?.dbisDB;
	if (!auditStore || !dbisDB) {
		for (const tableName in tables) {
			const table = tables[tableName];
			auditStore ??= table?.auditStore;
			dbisDB ??= table?.dbisDB;
			if (auditStore && dbisDB) break;
		}
	}
	return { auditStore, dbisDB };
}

const SETUP_TIMED_OUT = Symbol('setup timed out');

async function awaitWithTimeoutOutcome<T>(
	value: T | PromiseLike<T> | undefined,
	timeout: number
): Promise<T | undefined | typeof SETUP_TIMED_OUT> {
	if (!value || typeof (value as any).then !== 'function') return value as T | undefined;
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			value,
			new Promise<typeof SETUP_TIMED_OUT>((resolve) => {
				timer = setTimeout(() => resolve(SETUP_TIMED_OUT), timeout);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function awaitWithTimeout<T>(
	value: T | PromiseLike<T> | undefined,
	timeout: number
): Promise<T | undefined> {
	const outcome = await awaitWithTimeoutOutcome(value, timeout);
	return outcome === SETUP_TIMED_OUT ? undefined : outcome;
}

/**
 * Resolve the two sender-side gates that precede DB_SCHEMA/replay, reporting the exact gate that failed
 * to settle. Rejections intentionally propagate to the existing subscription-handler catch; only timeout
 * is converted to `undefined` so the caller can close and retry without losing the durable cursor.
 */
export async function resolveSendSubscriptionSetup<TAuthorization, TDatabase>(
	authorizationSubscription: TAuthorization | PromiseLike<TAuthorization> | undefined,
	databaseSubscription: TDatabase | PromiseLike<TDatabase> | undefined,
	timeout: number,
	onFailure: (gate: 'authorization' | 'database', reason: 'timeout' | 'unavailable') => void
): Promise<TDatabase | undefined> {
	if (authorizationSubscription) {
		const resolvedAuthorizationSubscription = await awaitWithTimeoutOutcome(authorizationSubscription, timeout);
		if (resolvedAuthorizationSubscription === SETUP_TIMED_OUT || !resolvedAuthorizationSubscription) {
			onFailure('authorization', resolvedAuthorizationSubscription === SETUP_TIMED_OUT ? 'timeout' : 'unavailable');
			return;
		}
	}
	const resolvedDatabaseSubscription = await awaitWithTimeoutOutcome(databaseSubscription, timeout);
	if (resolvedDatabaseSubscription === SETUP_TIMED_OUT || !resolvedDatabaseSubscription) {
		onFailure('database', resolvedDatabaseSubscription === SETUP_TIMED_OUT ? 'timeout' : 'unavailable');
		return;
	}
	return resolvedDatabaseSubscription;
}

/**
 * Await a database subscription that may still be the pending placeholder, bounded by `timeout` ms.
 * Resolves to the registered `IterableEventQueue`, or to `undefined` if the registration did not land in
 * time. A subscription that is already resolved (or absent) is returned as-is without yielding.
 *
 * `backpressure` (the receive path's `addPauseReason`/`removePauseReason`) is applied around the wait and
 * ONLY around a wait that actually happens. It is load-bearing rather than defensive: the receive path
 * awaits this from inside the serialized `messageProcessing` chain, but blocking that chain does not stop
 * `ws.on('message')` from appending closures that each retain a whole inbound `body` — so without pausing
 * the socket, a peer mid-copy queues a full timeout's worth of large frames and exhausts the worker heap
 * before the timeout can close the connection. Paired in a `finally` so the pause is balanced on every
 * outcome, including a rejection.
 */
export async function awaitPendingSubscription(
	subscription: DatabaseSubscription | undefined,
	timeout: number,
	backpressure?: { pause: () => void; resume: () => void }
): Promise<DatabaseSubscription | undefined> {
	if (!subscription?.then) return subscription;
	backpressure?.pause();
	try {
		return await awaitWithTimeout(subscription, timeout);
	} finally {
		backpressure?.resume();
	}
}

export function isSubscriptionSetupProgressFrame(
	command: number | undefined,
	requestedDatabase: string | undefined,
	frameDatabase: string | undefined,
	requestId: number | undefined,
	frameRequestId: number | undefined
): boolean {
	return (
		command === DB_SCHEMA &&
		requestId !== undefined &&
		frameDatabase === requestedDatabase &&
		frameRequestId === requestId
	);
}

export function resolveSubscriptionSetupCapability(
	capabilities: any,
	localTimeoutMs: number,
	usePeerBudget = true
): { supported: boolean; timeoutMs: number } {
	const supported = capabilities?.subscriptionSetupAck >= SUBSCRIPTION_SETUP_ACK_CAPABILITY;
	const peerSetupBudgetMs = capabilities?.subscriptionSetupBudgetMs;
	const maxPeerSetupBudgetMs = Math.max(localTimeoutMs * 4, 10 * 60_000);
	return {
		supported,
		timeoutMs:
			usePeerBudget && supported && Number.isFinite(peerSetupBudgetMs) && peerSetupBudgetMs > 0
				? Math.max(localTimeoutMs, Math.min(peerSetupBudgetMs, maxPeerSetupBudgetMs))
				: localTimeoutMs,
	};
}

export function createSubscriptionSetupWatchdog(opts: { timeoutMs: number | (() => number); onTimeout: () => void }): {
	arm: () => void;
	complete: () => void;
	pause: () => void;
	resume: () => void;
	stop: () => void;
} {
	let timer: NodeJS.Timeout | undefined;
	let pending = false;
	let pauseDepth = 0;
	// Remaining budget (ms) for the current pending window, consumed as time elapses. Only `arm()`
	// resets it to a full window (a superseding request); `pause()`/`resume()` preserve whatever was
	// left, so a link with recurring, short back-pressure pauses can't keep re-granting a full window
	// forever and never trip this independent recovery net.
	let remainingMs = 0;
	let scheduledAt = 0;
	const clearTimer = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
	const fire = () => {
		timer = undefined;
		pending = false;
		opts.onTimeout();
	};
	const schedule = () => {
		clearTimer();
		if (!pending || pauseDepth > 0) return;
		scheduledAt = performance.now(); // monotonic — immune to wall-clock adjustments
		timer = setTimeout(fire, remainingMs).unref();
	};
	return {
		arm() {
			pending = true;
			remainingMs = typeof opts.timeoutMs === 'function' ? opts.timeoutMs() : opts.timeoutMs;
			schedule();
		},
		complete() {
			pending = false;
			clearTimer();
		},
		pause() {
			if (pauseDepth++ > 0) return;
			if (pending && timer) remainingMs = Math.max(0, remainingMs - (performance.now() - scheduledAt));
			clearTimer();
		},
		resume() {
			if (pauseDepth === 0 || --pauseDepth > 0) return;
			schedule();
		},
		stop() {
			pending = false;
			clearTimer();
		},
	};
}

/**
 * Create (and register) the placeholder used for a database whose local subscription queue does not
 * exist yet: `Replicator.subscribe()` runs when the first table of the database is set up on this
 * thread, which can happen after a replication connection is accepted or an outbound subscription is
 * requested. It resolves to the real `IterableEventQueue` when `Replicator.subscribe()` calls `.ready`.
 *
 * Consumers must treat a subscription with a `.then` as unresolved and never read `send`/`auditStore`/
 * `dbisDB` off it — see resolveDatabaseStores and harper-pro#622.
 */
export function createPendingDatabaseSubscription(
	databaseName: string,
	subscriptions: Map<string, any> = databaseSubscriptions
): DatabaseSubscription {
	let ready: (subscription: any) => void;
	const pending: DatabaseSubscription = new Promise((resolve) => (ready = resolve)) as any;
	pending.ready = ready;
	// Register in the same map the resolver reads, so Replicator.subscribe() finds and resolves this one.
	subscriptions.set(databaseName, pending);
	return pending;
}

export function activeDatabaseSubscription(subscription?: DatabaseSubscription): DatabaseSubscription | undefined {
	return subscription?.retired ? undefined : subscription;
}

export function subscriptionForConnection(
	cached: DatabaseSubscription | undefined,
	databaseName: string,
	subscriptions: Map<string, any>
): DatabaseSubscription {
	return activeDatabaseSubscription(cached) ?? subscriptionForDatabase(databaseName, subscriptions);
}

export function subscriptionForDatabase(databaseName: string, subscriptions: Map<string, any>): DatabaseSubscription {
	return (
		activeDatabaseSubscription(subscriptions.get(databaseName)) ??
		createPendingDatabaseSubscription(databaseName, subscriptions)
	);
}

/**
 * Settle and unregister a database-subscription placeholder that is still pending, returning whether it
 * did so.
 *
 * A placeholder resolves only when `Replicator.subscribe()` runs for the first table of the database on
 * this thread. When that never happens — classically because this node does not host the database — the
 * promise is unsettleable, and it stays reachable from `dbSubscriptions` for the life of the database.
 * A bounded waiter that closes and lets the peer retry would then attach a fresh reaction (retaining that
 * connection's setup state) to the same retained promise on every attempt, so a permanent mismatch would
 * grow waiters without bound. Settling releases every accumulated waiter — they see `undefined` and take
 * their existing no-subscription path — and unregistering lets the next request start from a fresh
 * placeholder that a late `Replicator.subscribe()` can still resolve.
 *
 * A placeholder already superseded in the map is left alone: the real subscription is authoritative.
 *
 * The `retired` mark is what makes this safe to do to a shared object. Outbound connections cache the
 * subscription they were constructed with and seed every reconnect from it, and sibling connections for
 * the same database cache the SAME placeholder — so without the mark, a socket would re-seed itself with
 * a placeholder that now resolves to `undefined`, close immediately, and never converge even once
 * `Replicator.subscribe()` registers the real queue. Every consumer must treat a retired placeholder as
 * absent and re-derive from the map.
 */
export function expirePendingDatabaseSubscription(
	databaseName: string,
	subscription: DatabaseSubscription | undefined,
	subscriptions: Map<string, any>
): boolean {
	if (!subscription?.then || typeof subscription.ready !== 'function') return false;
	if (subscriptions.get(databaseName) !== subscription) return false;
	subscriptions.delete(databaseName);
	subscription.retired = true;
	subscription.ready(undefined);
	return true;
}

// Small control-plane tables whose convergence gates cluster operations: hdb_deployment gates
// deploy_component (awaitDeploymentRow), hdb_nodes gates membership. Copying them first keeps a
// large, high-churn, largely node-local table (notably hdb_analytics, which by insertion order sorts
// ahead of them) from gating control-plane convergence during a base copy (#421). Listed order is
// the copy order within this group.
export const COPY_PRIORITY_TABLES = ['hdb_deployment', 'hdb_nodes'];
// High-volume tables copied last so they can never gate the tables above. hdb_analytics is ~node-local
// telemetry that can reach millions of rows; it must not sit ahead of control-plane tables in the copy.
export const COPY_DEPRIORITIZED_TABLES = ['hdb_analytics'];
// System tables whose subscribers drive cluster machinery off the audit `aftercommit` stream and so
// must be re-read after a copyApply base copy (whose snapshot rows carry no per-row audit events): a
// whole-table "reload" marker is emitted for each once the system-DB copy is durable. hdb_nodes feeds
// peer discovery / outbound subscriptions, hdb_certificate feeds CA install. (harper-pro#489)
export const SYSTEM_RELOAD_TABLES = ['hdb_nodes', 'hdb_certificate'];

/**
 * Order a database's table names for a base copy: COPY_PRIORITY_TABLES first (in listed order), then
 * everything else in its original (insertion) order, then COPY_DEPRIORITIZED_TABLES last. Only the
 * `system` database contains these names, so user databases are returned in unchanged insertion order.
 *
 * The ordering is a pure function of the table-name set, so it is identical on every run for a given
 * set — which the resume skip-loop relies on (it skips tables "before" the cursor's currentTable). A
 * resume that runs under a DIFFERENT order than the one that built the cursor is unsafe; that cross-
 * version case is guarded by COPY_ORDER_VERSION at the loop, not here. Bump COPY_ORDER_VERSION if this
 * ordering changes.
 *
 * Exported for `unitTests/replication/orderTablesForCopy.test.mjs`; production calls it inline below.
 */
export function orderTablesForCopy(tableNames: string[]): string[] {
	const rankOf = (name: string): number => {
		const priority = COPY_PRIORITY_TABLES.indexOf(name);
		if (priority !== -1) return priority; // 0..(P-1): copied first, in listed order
		const deprioritized = COPY_DEPRIORITIZED_TABLES.indexOf(name);
		// P+1+i for deprioritized so they all rank after every "middle" table (which share rank P).
		if (deprioritized !== -1) return COPY_PRIORITY_TABLES.length + 1 + deprioritized;
		return COPY_PRIORITY_TABLES.length; // everything else, keeping insertion order via the index tiebreak
	};
	return (
		tableNames
			// rank computed once per table here, not inside the comparator (which would re-scan per compare).
			.map((name, index) => ({ name, index, rank: rankOf(name) }))
			// Stable sort: equal ranks keep insertion order, so the result is deterministic for a given set.
			.sort((a, b) => a.rank - b.rank || a.index - b.index)
			.map((entry) => entry.name)
	);
}

/**
 * Whether a leader may trust a resume cursor's skip-loop: true only when the cursor was built under the
 * SAME copy order the leader uses now (orderTablesForCopy / COPY_ORDER_VERSION). A cursor from a
 * pre-versioning leader carries no `copyOrder` — both an absent field and an explicit `undefined` decode
 * to `undefined` here, which is (correctly) incompatible with any real version, forcing a full recopy
 * rather than a skip that could omit tables the old order had not yet reached. Exported for
 * `unitTests/replication/orderTablesForCopy.test.mjs`. (#421)
 */
export function isCopyResumeOrderCompatible(copyOrder: number | undefined, orderVersion: number): boolean {
	return copyOrder === orderVersion;
}

// Metric fired when a received replication record can't be decoded because its shared structure is
// genuinely absent on this node. Mirrors core RecordEncoder's `MISSING_STRUCTURE_METRIC` (that const
// is not exported; kept in sync by name) so the copy/audit-apply drop is surfaced through the same
// `decode-missing-structure` counter as the local-read drop. (harper#1163)
export const DECODE_MISSING_STRUCTURE_METRIC = 'decode-missing-structure';

// Every dropped/held record is counted, so a stuck-but-retrying node can't look identical to a healthy
// one and a silent skip can't masquerade as "caught up" (harper-pro#537 review). `decode-drop`: record
// skipped and the cursor advanced (any decode failure that is not the missing-structure class above).
// `decode-hold`: record retained, connection closed to resync, cursor NOT advanced (unknown table id).
export const DECODE_DROP_METRIC = 'decode-drop';
export const DECODE_HOLD_METRIC = 'decode-hold';

/**
 * Classify a decode error thrown while applying a received copy/audit record, choosing how loudly to
 * surface the skip. (harper-pro#537)
 *
 * Both verdicts SKIP the record and let the resume cursor advance — a decode error reaching this
 * catch is treated as permanent. Transient conditions are already handled upstream (blob-gap `hold`,
 * apply-queue backpressure), and every known source of a decode failure has been root-caused, so one
 * that still reaches here is almost certainly unrecoverable old-version/corrupt data that no re-copy
 * can heal (re-fetching re-ships the same undecodable bytes). Holding the leg would only wedge it, so
 * we drop the record and keep the copy moving; the verdicts differ only in observability:
 *
 * - `skip-missing-structure`: the record references a shared structure genuinely absent on this node
 *   (`isMissingStructureError` — structon/msgpackr already reloaded structures from durable storage
 *   and retried before throwing; harper#1163). Surfaced through the same `decode-missing-structure`
 *   metric core's local-read path fires, so it is alertable rather than laundered as emptiness.
 * - `skip`: any other decode failure — unexpected post-root-cause, so it is logged loudly at error
 *   level for investigation.
 *
 * Exported so the policy can be exercised in isolation by
 * `unitTests/replication/classifyReplicationDecodeError.test.mjs`.
 */
export function classifyReplicationDecodeError(error: unknown): 'skip-missing-structure' | 'skip' {
	return isMissingStructureError(error) ? 'skip-missing-structure' : 'skip';
}

/**
 * Whether a copy-complete "reload" marker should be emitted for a table (harper-pro#495).
 *
 * A reload marker re-drives a table's live subscribers to re-read their scope, recovering rows that a
 * copyApply base copy wrote as audit-less snapshots (invisible to the live-notify path). It only needs
 * to fire for a table that actually received such a snapshot row:
 *  - System DB: a fixed cluster-machinery list (`SYSTEM_RELOAD_TABLES`) that must always re-drive its
 *    subscribers (peer discovery / CA install), so `isSystem` short-circuits to true.
 *  - User DB: only tables present in `copiedTables` — the set of tables that received an audit-less
 *    copy-apply row in this pass. An empty, non-replicated, or fully-audited table copied nothing
 *    invisible, so emitting for it would be wasted work (cb1kenobi review, PR #507).
 *
 * A table without a `writeReloadMarker` method (nothing to signal) never emits. Exported for
 * `unitTests/replication/shouldEmitCopyReloadMarker.test.mjs`; production calls it inline in
 * `emitCopyReloadMarkers`.
 */
export function shouldEmitCopyReloadMarker(
	isSystem: boolean,
	tableName: string,
	table: { writeReloadMarker?: unknown } | undefined,
	copiedTables: Set<string>
): boolean {
	if (typeof table?.writeReloadMarker !== 'function') return false;
	if (isSystem) return true;
	return copiedTables.has(tableName);
}

/**
 * Build the "newest lastTxnTime per source node" map from the dbisDB `seq` entries, tolerating a
 * `seq` row that fails to decode.
 *
 * Each entry's `value` is decoded lazily by the store iterator. During a rolling upgrade a `seq`
 * row can be encoded against a structure shape this node decodes differently; the decode then
 * yields `null` (logged as "Error decoding record: Data read, but end of buffer not reached"; see
 * harper-pro#352). The bare `entry.value.nodes` deref previously threw on that `null`, escaping
 * `sendSubscriptionRequestUpdate` — so the inbound subscription handshake never completed (1006
 * reconnect storm) and the node received nothing while still reporting a connected socket. This is
 * the subscription-setup sibling of the cert-auth fallback #352 already landed for `hdb_nodes`.
 *
 * Skipping an undecodable entry is safe: `lastTxnTimes` only ever RAISES a resume start point as an
 * optimization, so a missing entry falls back to the persisted `seqId` cursor and re-overlaps a
 * little (replication dedupes incoming records) — it never advances past unseen data. Skipping also
 * breaks the self-sustaining wedge: once the handshake completes the node resumes, and the next
 * cursor write rewrites the `seq` row against the current structures, healing it.
 *
 * Exported so the decode-tolerance can be exercised in isolation by
 * `unitTests/replication/collectLastTxnTimes.test.mjs`; production callers go through
 * `sendSubscriptionRequestUpdate` in `replicateOverWS`.
 */
export function collectLastTxnTimes(seqEntries: Iterable<{ value: any }>): Map<any, number> {
	const lastTxnTimes = new Map();
	for (const entry of seqEntries) {
		let value: any;
		try {
			value = entry.value;
		} catch {
			// A `seq` row that throws on value access (rather than decoding to null) is the same
			// undecodable case — skip it instead of failing the whole subscription request.
			continue;
		}
		// `value` is null for the observed undecodable row; require a real array before iterating so a
		// partially-decoded row with a non-array `nodes` can't throw out of the loop either.
		const nodes = value?.nodes;
		if (!Array.isArray(nodes)) continue;
		for (const node of nodes) {
			// Guard each element too: a partially-decoded row can yield null/non-object entries or a
			// non-numeric lastTxnTime, which would throw out of the loop (defeating the crash-tolerance) or
			// pollute the map with a nullish key. Only fold in well-formed entries.
			if (node && typeof node === 'object' && typeof node.lastTxnTime === 'number' && node.id != null) {
				if (node.lastTxnTime > (lastTxnTimes.get(node.id) ?? 0)) lastTxnTimes.set(node.id, node.lastTxnTime);
			}
		}
	}
	return lastTxnTimes;
}

/**
 * Receive-side silence watchdog. Arm with `reset()` whenever incoming activity is observed
 * (peer ping, pong, message). If `intervalMs` elapses with the underlying socket's `bytesRead`
 * unchanged, `onSilence` is invoked exactly once.
 *
 * Only `bytesRead` is checked — `bytesWritten` reflects our own outbound traffic (pings, blob
 * sends) and is not proof that the peer is alive. Including it would let our own keepalive
 * pings suppress the watchdog in the exact missed-sendPing scenario this is meant to recover.
 *
 * Callers should suspend the watchdog (via `stop()`) when the underlying WS is intentionally
 * paused for backpressure: `bytesRead` is frozen by design while paused and would otherwise
 * cause a spurious termination of a healthy connection.
 *
 * Exported so the timer logic can be exercised in isolation by `unitTests/replication/
 * receiveWatchdog.test.mjs` — production callers go through `replicateOverWS`.
 */
export function createReceiveWatchdog(opts: {
	// A function lets the threshold change per-arm without rebuilding the watchdog — used so the byte
	// watchdog can widen the window to COPY_TIMEOUT while inCopyMode and fall back to PING_TIMEOUT after
	// (harper-pro#460). A plain number is still accepted for the fixed-threshold callers.
	intervalMs: number | (() => number);
	getBytesRead: () => number;
	onSilence: () => void;
}): { reset: () => void; stop: () => void } {
	let timer: NodeJS.Timeout | undefined;
	let bytesReadAtArm = 0;
	let lastResetAt = 0;
	const resolveIntervalMs = () => (typeof opts.intervalMs === 'function' ? opts.intervalMs() : opts.intervalMs);
	// Coalesce rapid reset() calls (e.g. message frames arriving thousands of times per second
	// during a large copy) so we do not churn setTimeout/clearTimeout per frame. Granularity loss
	// is small relative to intervalMs — at worst the watchdog fires this much earlier or later.
	const throttleMs = Math.min(1000, Math.max(100, resolveIntervalMs() / 30));
	function check() {
		const current = opts.getBytesRead();
		if (current === bytesReadAtArm) {
			timer = undefined;
			opts.onSilence();
			return;
		}
		// Bytes advanced since the last arm — but the activity may have been swallowed by the
		// reset() throttle, so we cannot rely on an external caller to re-arm us. Re-arm from
		// the new baseline; otherwise a throttled-reset-then-silence sequence would leave the
		// watchdog permanently inactive (see PR #234 review).
		bytesReadAtArm = current;
		lastResetAt = Date.now();
		timer = setTimeout(check, resolveIntervalMs()).unref();
	}
	return {
		reset() {
			const now = Date.now();
			if (timer && now - lastResetAt < throttleMs) return;
			lastResetAt = now;
			if (timer) clearTimeout(timer);
			bytesReadAtArm = opts.getBytesRead();
			timer = setTimeout(check, resolveIntervalMs()).unref();
		},
		stop() {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}

/**
 * Wall-clock pacer for the bulk-copy send loop. The copy normally flushes to the socket on a
 * record-count checkpoint, but reading a large cold table dominates copy cost, so a single
 * count-batch can exceed the receive watchdog window with no bytes on the wire — and the LOCAL_ONLY
 * skip path bypasses the per-record flush+yield entirely. Either starves the watchdog into killing
 * the connection mid-copy. This bounds the wall-clock gap between flushes/yields: `due(now)` reports
 * whether at least `intervalMs` has elapsed since the last one, and callers `mark(now)` after each
 * flush or yield (whether triggered by this pacer or the count checkpoint) so the window restarts.
 * Clock is injected via `now` arguments so the cadence is unit-testable.
 */
export function createCopyFlushPacer(
	intervalMs: number,
	initialNow: number
): { due: (now: number) => boolean; mark: (now: number) => void } {
	let lastFlushAt = initialNow;
	return {
		due: (now: number) => now - lastFlushAt >= intervalMs,
		mark: (now: number) => {
			lastFlushAt = now;
		},
	};
}

/**
 * Liveness watchdog for the BACK-PRESSURE-PAUSED state, the companion to `createReceiveWatchdog`.
 *
 * While the receive socket is paused (`pauseReasons > 0`) the byte-silence watchdog is stopped:
 * `ws.pause()` freezes `bytesRead`, so it can no longer distinguish a healthy back-pressure pause
 * (the receiver intentionally not reading while it drains its own queue) from a peer that died
 * mid-pause. The active sendPing is exempt for the same reason. That left a paused leg with NO
 * recovery driver, so a base copy stalled at ~100% back-pressure whose peer restarted could wedge
 * `connected:false` forever — the receive-watchdog `forceReconnect` path (harper-pro#420/#424) was
 * removed for exactly the stall it exists to catch. See harper-pro#466 / PR #467.
 *
 * This watchdog runs ONLY while paused (armed by `reset()` on pause, `stop()`ed on resume) and keys
 * off a monotonic local consumer-progress counter instead of socket `bytesRead`. That counter
 * advances on signals that survive `ws.pause()` — the apply loop committing already-queued records,
 * and in-flight blob streams draining to disk — so a pause that is legitimately making progress
 * re-arms every window and never fires. Only a pause with ZERO consumer progress for the full
 * `thresholdMs` (the consumer can never drain it, so it will never self-clear) trips `onStall`.
 *
 * Implemented on top of `createReceiveWatchdog` so the throttled stall-timer is defined and unit
 * tested in one place; this wrapper only swaps the activity source (`bytesRead` → progress counter)
 * and the threshold. Like its byte-silence sibling it self-re-arms when progress is observed, so the
 * caller need not `reset()` on every tick — it only arms on pause and stops on resume. Detection
 * latency is therefore between `thresholdMs` and `2 × thresholdMs` (progress can arrive just after an
 * arm), which is fine for an otherwise-permanent wedge and keeps the hot commit path untouched.
 *
 * Exported so the pause-stall behavior can be exercised in isolation by
 * `unitTests/replication/pauseStallWatchdog.test.mjs`.
 */
export function createPauseStallWatchdog(opts: {
	thresholdMs: number;
	getProgress: () => number;
	onStall: () => void;
}): { reset: () => void; stop: () => void } {
	return createReceiveWatchdog({
		intervalMs: opts.thresholdMs,
		getBytesRead: opts.getProgress,
		onSilence: opts.onStall,
	});
}

/**
 * Reject with `timeoutError` if `work` has not settled within `timeoutMs`, leaving the original promise to
 * settle (or not) on its own. For awaits whose caller has a defined failure path but no defined behavior
 * for "never returns". The error is supplied rather than built here so the caller can distinguish its own
 * timeout from a genuine failure of `work` by identity.
 */
export function rejectIfUnsettled<T>(work: Promise<T>, timeoutMs: number, timeoutError: Error): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		work,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(timeoutError), timeoutMs);
			timer.unref?.();
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * Liveness watchdog for the base-copy FINALIZATION window — COPY_COMPLETE until the copy actually
 * finishes (commits drained, blobs durable, copy cursor flushed, copy mode exited). Until that completes
 * the received-version watermark stays suppressed, so the node can never reach Available.
 *
 * Every other guard is off for precisely this window, which is why it needs its own:
 *   - `copyProgressWatchdog` is `stop()`ed at COPY_COMPLETE and returns early on `copyCompleteReceived`
 *     (there are no more copy frames to count — #453).
 *   - `receiveWatchdog` is widened to COPY_TIMEOUT while `inCopyMode` (#460) and the sender has nothing
 *     left to send, so byte silence here is expected rather than evidence of a stall.
 *   - `subscriptionSetupWatchdog` is paused for the duration of the copy.
 *
 * Keyed on finalization progress rather than wall clock, so a large-but-progressing drain re-arms every
 * window; only ZERO progress for the full threshold fires. Built on `createReceiveWatchdog` for the
 * shared throttled timer, so it self-re-arms on progress and detects between 1x and 2x `thresholdMs`.
 *
 * Reach: this covers stalls that leave the event loop alive. It cannot recover one wedged inside a
 * blocking native call (rocksdb-js#755's WriteBufferManager stall parked the worker in a futex, where no
 * JS timer can fire) — that belongs to the binding, and was fixed in rocksdb-js 2.7.1.
 *
 * Exported for `unitTests/replication/copyFinalizeWatchdog.test.mjs`.
 */
export function createCopyFinalizeWatchdog(opts: {
	thresholdMs: number | (() => number);
	getProgress: () => number;
	onStall: () => void;
}): { reset: () => void; stop: () => void } {
	return createReceiveWatchdog({
		intervalMs: opts.thresholdMs,
		getBytesRead: opts.getProgress,
		onSilence: opts.onStall,
	});
}
let secureContexts: Map<string, tls.SecureContext>;
/**
 * Handles reconnection, and requesting catch-up
 */

type NodeSubscription = {
	name: string;
	replicateByDefault: boolean;
	tables: string[];
	startTime: number;
	endTime: number;
	excluded?: string[];
};

let replicationSecureContext: tls.SecureContext & { caCount?: number; derivedFromContext?: tls.SecureContext };

/**
 * Build the trusted-CA list for a replication TLS connection: the replication CA set (root CAs plus
 * every peer's hdb_nodes.ca, kept current by monitorNodeCAs) combined with the secure context's own
 * CAs. `nodeCA` explicitly adds a specific peer's CA — used for replicated operations
 * (replicateOperation → sendOperationToNode), which run on the main thread. monitorNodeCAs populates
 * replicationCertificateAuthorities only on the replication worker threads, so on the main thread that
 * set holds just the root CAs — it never contains peer CAs, hence the explicit per-peer CA here.
 */
export function mergeReplicationCAs(availableCAs?: Iterable<string>, nodeCA?: string): string[] {
	const cas = [...replicationCertificateAuthorities, ...(availableCAs ?? [])];
	if (nodeCA) cas.push(nodeCA);
	return cas;
}

export async function createWebSocket(
	url: string,
	options: { authorization?: string; rejectUnauthorized?: boolean; serverName?: string; nodeCA?: string }
) {
	const { authorization, rejectUnauthorized, nodeCA } = options || {};

	const node_name = getThisNodeName();
	let secureContext;
	if (url == null) {
		throw new TypeError(`Invalid URL: Expected a string URL for node "${node_name}" but received ${url}`);
	}
	if (url.includes('wss://')) {
		if (!secureContexts) {
			const SNICallback = createTLSSelector('replication');
			const secureTarget = {
				secureContexts: null,
			};
			await SNICallback.initialize(secureTarget);
			secureContexts = secureTarget.secureContexts;
		}
		secureContext = secureContexts.get(node_name);
		if (secureContext) {
			logger.debug?.(
				'Creating web socket for URL',
				url,
				'with certificate named:',
				secureContext.name,
				'is_self_signed',
				secureContext.is_self_signed
			);
		}
		if (!secureContext && rejectUnauthorized !== false) {
			throw new Error(
				'Unable to find a valid certificate to use for replication to connect to ' +
					url +
					' available:' +
					Array.from(secureContexts.keys())
			);
		}
	}
	const headers: Record<string, string> = {};
	if (authorization) {
		headers.Authorization = authorization;
	}
	const wsOptions = {
		headers,
		localAddress: node_name?.startsWith('127.0') ? node_name : undefined, // this is to make sure we use the correct network interface when doing our local loopback testing
		servername: isIP(options?.serverName) ? undefined : options?.serverName, // use the node name for the SNI negotiation (as long as it is not an IP)
		noDelay: true, // we want to send the data immediately
		// we set this very high (2x times the v22 default) because it performs better
		highWaterMark: 128 * 1024,
		// Match the server's accept cap (replicator.ts) so the configurable send guard (replication_maxPayload)
		// is the binding limit on client-initiated legs too. Otherwise ws defaults to 100 MiB here, just under
		// the 100 MB send default, and raising replication_maxPayload to clear a wedge would hit a silent 1009.
		maxPayload: 10 * 1024 * 1024 * 1024,
		rejectUnauthorized: rejectUnauthorized !== false,
		secureContext: undefined,
	};
	if (secureContext) {
		if (nodeCA) {
			// Replicated operations (replicateOperation → sendOperationToNode) run on the main thread.
			// monitorNodeCAs populates replicationCertificateAuthorities only on the replication worker
			// threads, so on the main thread it holds just the root CAs and never the peers' CAs. Trust
			// this peer's specific CA (its hdb_nodes.ca) explicitly — the same per-node CA the worker
			// subscription path trusts. Built fresh rather than reusing replicationSecureContext: the CA is
			// per-target and this is a cold path (deploy/cert/add_node), not the hot subscription path.
			wsOptions.secureContext = tls.createSecureContext({
				...secureContext.options,
				ca: mergeReplicationCAs(secureContext.options.availableCAs?.values(), nodeCA),
			});
		} else {
			// check to see if our cached secure context is still valid
			if (
				replicationSecureContext?.caCount !== replicationCertificateAuthorities.size ||
				replicationSecureContext?.derivedFromContext !== secureContext
			) {
				// create a secure context and cache by the number of replication CAs (if that changes, we need to create a new secure context)
				replicationSecureContext = tls.createSecureContext({
					...secureContext.options,
					ca: mergeReplicationCAs(secureContext.options.availableCAs?.values()), // add CA if secure context had one
				});
				replicationSecureContext.caCount = replicationCertificateAuthorities.size;
				replicationSecureContext.derivedFromContext = secureContext;
			}
			wsOptions.secureContext = replicationSecureContext;
		}
	}
	return new WebSocket(url, 'harperdb-replication-v1', wsOptions);
}

const INITIAL_RETRY_TIME = 500;
/**
 * This represents a persistent connection to a node for replication, which handles
 * sockets that may be disconnected and reconnected
 */
export class NodeReplicationConnection extends EventEmitter {
	socket: WebSocket;
	startTime: number;
	retryTime = INITIAL_RETRY_TIME;
	retries = 0;
	isConnected = true; // we start out assuming we will be connected
	isFinished = false;
	// Set when this connection should never reconnect: user-driven unsubscribe(), or the
	// empty-subscription delayed close inside replicateOverWS. Distinct from `isFinished`,
	// which is the post-close terminal marker. Anything else (protocol errors, peer
	// DISCONNECT, etc.) leaves this false so the close handler schedules a retry.
	intentionallyUnsubscribed = false;
	// Set while a reconnect has already been scheduled (by forceReconnect or the close handler) so the
	// two paths never both arm a connect() for the same drop — see forceReconnect / harper-pro#420.
	reconnectScheduled = false;
	nodeSubscriptions?: NodeSubscription[];
	latency = 0;
	replicateTablesByDefault: boolean;
	session: any; // this is a promise that resolves to the session object, which is the object that handles the replication
	// The one live replicateOverWS instance bound to `this.socket`, kept as a direct handle (not just the
	// `session` promise, which resetSession() replaces on every reconnect) so any path that replaces the
	// socket can retire the instance it supersedes synchronously. Cleared by retireSession().
	liveSession?: any;
	sessionResolve: Function;
	sessionReject: Function;
	url: string;
	subscription: any;
	databaseName: string;
	nodeName?: string;
	authorization?: string;
	tentativeNode?: any;
	// Shared-memory connection-health buffer for this outbound (db, peer) link, stashed by replicateOverWS
	// once resolved so close()/forceReconnect() can record DOWN/error without re-resolving auditStore (W1).
	sharedStatus?: Float64Array;
	// Cross-reconnect escalation budget for held source-blob gaps (harper-pro#432), allocated by the first
	// budgeted hold. `blobGapGeneration` numbers this connection's replicateOverWS instances so a retired
	// socket's late blob settlements cannot charge or resolve the live one's budget.
	blobGapBudget?: BlobGapEscalationBudget;
	blobGapGeneration = 0;
	constructor(url: string, subscription: any, databaseName: string, nodeName?: string, authorization?: string) {
		super();
		this.url = url;
		this.subscription = subscription;
		this.databaseName = databaseName;
		this.authorization = authorization;
		this.nodeName = this.nodeName ?? urlToNodeName(url);
	}

	async connect() {
		if (this.intentionallyUnsubscribed) return;
		if (!this.session) this.resetSession();
		// TODO: Need to do this specifically for each node
		try {
			this.socket = await createWebSocket(this.url, {
				serverName: this.nodeName,
				authorization: this.authorization,
			});
		} catch (error) {
			// createWebSocket can reject before any socket exists or any open/error/close listener is
			// attached — e.g. no valid replication certificate yet, or SNICallback.initialize() failing
			// while a freshly-restarted peer rebuilds its TLS secure contexts. This connect() is invoked
			// from setTimeout(() => this.connect()) in the close handler / forceReconnect with no .catch(),
			// so without rescheduling here the rejection escapes as an unhandled rejection and the only
			// pending retry vanishes: no socket, no timer, connected:false forever (harper-pro#466). Funnel
			// it into the same backoff retry path the close handler uses so the connection self-heals once
			// the peer's certs settle. scheduleReconnect re-arms reconnectScheduled, so the close-handler
			// early-return invariant still holds and there is always a pending retry.
			if (++this.retries % 20 === 1)
				logger.warn?.(
					`Failed to create web socket to ${this.url} (db: "${this.databaseName}"), retrying: ${error.message}`
				);
			this.scheduleReconnect();
			return;
		}
		// The socket this connection owns has just been replaced, so the session bound to the previous one
		// is superseded by definition: retire it here rather than relying on that socket's 'close', which
		// for an open-but-idle/paused wedge may arrive late or never. Without this, the old instance's
		// keepalive (still refreshing shared liveness), sweep/back-pressure intervals, subscriptions,
		// pending requests, and watchdog timers survive — one leaked instance per reconnect cycle.
		// retireInstance is idempotent, so the real close doing this later is a no-op.
		this.retireSession('socket replaced by reconnect');
		// A forceReconnect-scheduled reconnect is now realized — stop suppressing the close handler's own
		// retry. Clearing this only after this.socket is reassigned (rather than in the scheduling timer)
		// keeps a late close from the superseded socket from arming a second connect() during the
		// createWebSocket await window. Only on the success path: a createWebSocket rejection takes the
		// catch above, which leaves reconnectScheduled true for its own pending retry. See harper-pro#420.
		this.reconnectScheduled = false;
		// Capture this attempt's socket so its close handler can tell whether it is still the live socket:
		// forceReconnect can schedule a fresh connect() that replaces this.socket before this socket's
		// (possibly delayed) terminate() finally fires close. See the close handler / harper-pro#420.
		const socket = this.socket;

		let session;
		logger.debug?.(`Connecting to ${this.url}, db: ${this.databaseName}, process ${process.pid}`);
		this.socket.on('open', () => {
			this.socket._socket.unref();
			// in normal startup, just use info, but adjust log level to warn if we were previously disconnected, because there was a warn message on the disconnect and we want to keep symmetry
			logger[this.isConnected ? 'info' : 'warn']?.(`Connected to ${this.url}, db: ${this.databaseName}`);
			// Reset backoff on first successful SEND (onFrameSent), not here on open: a leg that reopens and
			// immediately fails to send (an oversized frame throws and closes it) must keep escalating toward
			// the 30 s cap instead of hot-looping at 500 ms and accumulating native TLS state (harper-pro#339).
			// if we have already connected, we need to send a reconnected event
			if (this.nodeSubscriptions) {
				connectedToNode({
					name: this.nodeName,
					database: this.databaseName,
					url: this.url,
				});
			}
			this.isConnected = true;
			try {
				session = replicateOverWS(
					this.socket,
					{
						database: this.databaseName,
						subscription: this.subscription,
						url: this.url,
						connection: this,
						isSubscriptionConnection: this.nodeSubscriptions !== undefined,
					},
					{ replicates: true } // pre-authorized, but should only make publish: true if we are allowing reverse subscriptions
				);
				// Only the instance on the current socket is live. If this open raced a replacement, the
				// instance is born superseded: retire it immediately rather than leave it running, and do
				// not resolve — `sessionResolve` now belongs to the replacement attempt's promise, so
				// handing it this dead session would serve requests over a retired instance.
				if (this.socket !== socket) {
					session.retire?.('superseded before open');
					return;
				}
				this.liveSession = session;
				this.sessionResolve(session);
			} catch (error) {
				// replicateOverWS does a fair amount of synchronous setup (setDatabase, audit
				// store wiring, ping bookkeeping) and any of it can throw — most worryingly,
				// audit decoder corruption surfaced via setDatabase or the immediate getRange.
				// Without this guard the throw escapes the WS 'open' listener as an
				// uncaughtException, the socket stays open, sessionResolve is never called, no
				// 'close' fires, and the retry timer in the close handler never gets scheduled —
				// leaving the (peer, db) pair stuck with `connected: false` on main but no further
				// activity until a process restart. Terminating the socket forces the close
				// handler to run, which now retries.
				logger.error?.(
					`Error setting up replication session to ${this.url} (db: "${this.databaseName}"), terminating to retry`,
					error
				);
				this.sessionReject(error);
				this.socket.terminate();
			}
		});
		this.socket.on('error', (error) => {
			if (error.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
				logger.warn?.(
					`Can not connect to ${this.url}, this server does not have a certificate authority for the certificate provided by ${this.url}`
				);
				error.isHandled = true;
			} else if (error.code !== 'ECONNREFUSED') {
				if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
					logger.error?.(
						`Can not connect to ${this.url}, the certificate provided by ${this.url} is not trusted, this node needs to be added to the cluster, or a certificate authority needs to be added`
					);
				else logger.error?.(`Error in connection to ${this.url} due to ${error.message}`);
			}
			this.sessionReject(error);
		});
		this.socket.on('close', (code, reasonBuffer) => {
			// Ignore a late close from a socket we have already replaced — forceReconnect may have scheduled
			// a fresh connect() that swapped in a new this.socket before this superseded socket's terminate()
			// finally propagated its close. Acting on it would wrongly tear down the live connection (mark it
			// disconnected, drop its subscription listener, reset its session). See harper-pro#420.
			if (this.socket !== socket) return;
			// This socket's own close listener (retireInstance) has already torn the instance down.
			if (this.liveSession === session) this.liveSession = undefined;
			// Only treat the close as terminal when something explicitly marked it as a deliberate
			// teardown (user unsubscribe or the empty-subscription delayed close). Protocol-level
			// closes — peer DISCONNECT, unauthorized after open, node-name-mismatch, invalid
			// sequence id, etc. — used to also set `isFinished` via replicateOverWS's close()
			// helper, which left the connection silently dead and required hdb_nodes churn to
			// recover. Those now fall through to the retry path below.
			const intentional = this.intentionallyUnsubscribed;
			if (this.isConnected) {
				if (this.nodeSubscriptions) {
					disconnectedFromNode({
						name: this.nodeName,
						database: this.databaseName,
						url: this.url,
						finished: intentional,
					});
				}
				this.isConnected = false;
				// Record the disconnect in shared memory so the main thread sees the link is down even if the
				// disconnect message is never processed (W1 / harper-pro#431). The reconcile staleness net
				// covers the case where even this doesn't run (worker died).
				if (this.sharedStatus && this.nodeSubscriptions !== undefined) {
					this.sharedStatus[CONNECTION_STATE_POSITION] = CONNECTION_STATE_DOWN;
					this.sharedStatus[LAST_ERROR_CODE_POSITION] = code ?? 0;
					this.sharedStatus[LAST_ERROR_TIME_POSITION] = Date.now();
				}
			}
			this.removeAllListeners('subscriptions-updated');

			if (intentional) {
				this.isFinished = true;
				session?.end();
				this.emit('finished');
				return;
			}
			if (++this.retries % 20 === 1) {
				const reason = reasonBuffer?.toString();
				logger.warn?.(
					`${session ? 'Disconnected from' : 'Failed to connect to'} ${this.url} (db: "${this.databaseName}"), due to ${
						reason ? '"' + reason + '" ' : ''
					}(code: ${code})`
				);
			}
			session = null;
			// forceReconnect (receive-watchdog path) may have already scheduled the reconnect before
			// this close fired — don't arm a second connect() for the same drop.
			if (this.reconnectScheduled) return;
			this.scheduleReconnect();
		});
	}
	// Arm exactly one backoff retry of connect() and mark reconnectScheduled so the close handler's
	// early-return and forceReconnect's guard don't double-arm a second connect() for the same drop.
	// connect()'s success path clears reconnectScheduled once the new socket is installed; a
	// createWebSocket rejection routes back through here, keeping the flag true with a fresh pending
	// retry. Shared by the close handler, forceReconnect, and the connect()-reject path (harper-pro#466).
	scheduleReconnect() {
		this.reconnectScheduled = true;
		this.resetSession();
		setTimeout(() => {
			this.connect();
		}, this.retryTime).unref();
		// Double the interval each retry, capped at 30 s. The previous ~0.4%/retry
		// growth took >1000 retries to reach any meaningful delay, so rapid
		// reconnects to a dead peer (symphony accepts the TLS handshake then drops
		// it) would still accumulate unreleased native TLS state faster than V8 can
		// GC under CPU-saturated bulk-write conditions, leading to OOM (#339).
		// Doubling reaches 30 s in ~6 retries (~62 s total) and resets on success.
		this.retryTime = Math.min(this.retryTime << 1, 30_000);
	}
	// Called by replicateOverWS after a frame is actually sent: real progress, so it is safe to reset the
	// backoff. Gated on a non-zero retries so the healthy hot path (already reset) does nothing.
	onFrameSent() {
		if (this.retries !== 0 || this.retryTime !== INITIAL_RETRY_TIME) {
			this.retries = 0;
			this.retryTime = INITIAL_RETRY_TIME;
		}
	}
	// Retire the live replicateOverWS instance: the single enforcement point for "at most one live session
	// per connection". Every path that supersedes a session (socket replaced in connect(), forceReconnect)
	// calls this; the socket's own 'close' does the same teardown through retireInstance, which is
	// idempotent, so whichever happens first wins and the other is a no-op.
	retireSession(reason: string) {
		const session = this.liveSession;
		this.liveSession = undefined;
		try {
			session?.retire?.(reason);
		} catch (error) {
			// Teardown must never abort the recovery it is part of: forceReconnect still has a reconnect to
			// schedule after this, and connect() a fresh socket to finish wiring up.
			logger.warn?.(
				`Error retiring superseded replication session to ${this.url} (db: "${this.databaseName}"): ${error.message}`
			);
		}
	}
	resetSession() {
		this.session = new Promise((resolve, reject) => {
			this.sessionResolve = resolve;
			this.sessionReject = reject;
		});
		this.session.catch(() => {}); // suppress any unhandled errors
	}
	subscribe(nodeSubscriptions, replicateTablesByDefault) {
		this.nodeSubscriptions = nodeSubscriptions;
		this.replicateTablesByDefault = replicateTablesByDefault;
		this.emit('subscriptions-updated', nodeSubscriptions);
	}
	unsubscribe() {
		this.intentionallyUnsubscribed = true;
		this.socket?.close(1008, 'No longer subscribed');
	}
	// Drive recovery when the receive watchdog detects a silent connection. The normal recovery path is
	// the close handler's retry, but an open-but-idle socket (copy stalls, no transport close) may never
	// emit 'close' — and even when terminate() does fire one, the wedge reconciler skips a (peer, db)
	// whose node entry is still connected:true, and the cached connection is still "reusable" so a
	// re-subscribe hands back the same dead socket (replicator.isReusableConnection). So drive recovery
	// here, independent of the close event: notify the main thread the node is disconnected (flipping the
	// entry to connected:false for the reconciler backstop), tear the socket down, and schedule one fresh
	// connect. See harper-pro#420.
	forceReconnect() {
		if (this.intentionallyUnsubscribed || this.isFinished || this.reconnectScheduled) return;
		if (this.isConnected) {
			if (this.nodeSubscriptions) {
				disconnectedFromNode({
					name: this.nodeName,
					database: this.databaseName,
					url: this.url,
					finished: false,
				});
			}
			this.isConnected = false;
			// Watchdog-forced teardown of a wedged link: mark down in shared memory (W1 / harper-pro#431).
			if (this.sharedStatus && this.nodeSubscriptions !== undefined)
				this.sharedStatus[CONNECTION_STATE_POSITION] = CONNECTION_STATE_DOWN;
		}
		// Drop this connection's stale subscription listener before reconnecting. The close handler
		// normally does this (removeAllListeners), but its socket-identity guard early-returns for a
		// superseded socket, so an open-but-idle wedge — whose old socket never fires a timely close —
		// would otherwise leak one 'subscriptions-updated' listener per recovery cycle (eventually a
		// MaxListenersExceededWarning). The fresh connect re-registers its own. See harper-pro#420.
		this.removeAllListeners('subscriptions-updated');
		const socket = this.socket;
		// Retire the superseded session now, not when the replacement socket arrives: this path recovers a
		// wedged-but-open socket, so its keepalive would keep refreshing shared liveness (masking an
		// unhealthy replacement) and its watchdogs stay armed for the whole backoff window. terminate()
		// below is best-effort and the 'close' it should trigger may never deliver, which is exactly why
		// this cannot be left to the close listener. retireInstance is idempotent.
		this.retireSession('superseded by forceReconnect');
		// Sets reconnectScheduled and arms one backoff retry (matching the close-handler backoff so a
		// repeatedly-wedging peer backs off the same way, #339). connect() clears reconnectScheduled once
		// the new socket is installed, which keeps a late close from the old socket from double-scheduling.
		this.scheduleReconnect();
		// Best-effort teardown of the dead socket; recovery above does not depend on the close it fires.
		try {
			socket?.terminate();
		} catch {
			// already destroyed — the scheduled connect still runs
		}
	}

	getRecord(request) {
		return this.session.then((session) => {
			return session.getRecord(request);
		});
	}
}

/**
 * This handles both incoming and outgoing WS allowing either one to issue a subscription and get replication and/or handle subscription requests
 */
export function replicateOverWS(ws: WebSocket, options: any, authorization: any) {
	const p = options.port || options.securePort;
	const connectionId =
		(process.pid % 1000) +
		'-' +
		threadId +
		(p ? 's:' + p : 'c:' + options.url?.slice(-4)) +
		' ' +
		Math.random().toString().slice(2, 3);
	logger.debug?.(connectionId, 'Initializing replication connection', authorization);
	const frame = new FrameWriter();
	let databaseName = options.database;
	const dbSubscriptions = options.databaseSubscriptions || databaseSubscriptions;
	let auditStore: any;
	let auditLogIterable: Iterable<AuditRecord> & { removeLog?: (name: string) => void; addLog?: (name: string) => void }; // reusable iterator for a subscription
	let replicationSharedStatus: Float64Array;
	// this is the subscription that the local table makes to this replicator, and incoming messages
	// are sent to this subscription queue:
	let subscribed = false;
	// Re-derive rather than trusting the cached reference: the connection seeds every reconnect from the
	// subscription it was built with, which may since have been retired (expirePendingDatabaseSubscription).
	let tableSubscriptionToReplicator: DatabaseSubscription = options.subscription
		? subscriptionForConnection(options.subscription, databaseName, dbSubscriptions)
		: undefined;
	if (tableSubscriptionToReplicator?.then)
		(tableSubscriptionToReplicator as Promise<any>)
			.then((sub) => {
				if (!sub) return;
				tableSubscriptionToReplicator = sub;
				if (tableSubscriptionToReplicator.auditStore) auditStore = tableSubscriptionToReplicator.auditStore;
			})
			// This handler is detached — nothing awaits it — so a rejection here would surface as a
			// process-level unhandled rejection rather than a connection error (the DESIGN item-12 /
			// harper-pro#466 trap). The placeholder has no reject path today (only `.ready` resolves it), but
			// the receive path's bounded wait already recovers a subscription that never resolves, so log and
			// let that close-and-reconnect handle it instead of crashing the worker.
			.catch((error) => logger.warn?.(connectionId, 'Subscription to database failed to resolve', error));
	let tables = options.tables || (databaseName && getDatabases()[databaseName]);
	/**
	 * This database's audit + `__dbis__` stores. Goes through resolveDatabaseStores so they stay readable
	 * while the local subscription is still the unresolved placeholder (harper-pro#622). `tables` is
	 * captured above at construction and is undefined for a database that only came into existence
	 * afterwards, so re-read the database when it is unset.
	 */
	function getDatabaseStores() {
		return resolveDatabaseStores(
			tableSubscriptionToReplicator,
			tables || (databaseName ? getDatabases()?.[databaseName] : undefined)
		);
	}
	let remoteNodeName: string;
	const awaitingResponse = new Map();
	let receivingDataFromNodeIds = [];
	remoteNodeName = authorization.name;
	if (remoteNodeName && options.connection) options.connection.nodeName = remoteNodeName;
	const blobGapGeneration: number = options.connection ? ++options.connection.blobGapGeneration : 0;
	options.connection?.blobGapBudget?.beginGeneration(blobGapGeneration);
	let lastSequenceIdReceived, lastSequenceIdCommitted;
	// Bulk-copy resume state (receiver side). While inCopyMode, each committed batch persists a cursor
	// (copyStartTime + last committed table/key) so an interrupted copy can resume instead of restarting.
	let inCopyMode = false;
	let copyModeStartTime = 0;
	let copyModeOrderVersion; // copy-order version the leader announced in COPY_START; persisted in the cursor (#421)
	let copyFromNodeId; // local id of the node we are copying from — the key for the persisted cursor
	let copyCompleteReceived = false;
	// User-DB tables that received at least one audit-less copy-apply snapshot row in the current copy
	// pass (harper-pro#495). Only these need a reload marker: an empty (or fully-audited) table delivered
	// nothing invisible to its live subscribers, so emitting a marker for it would be wasted work. Reset
	// on every COPY_START; the send path skips non-replicated tables, so this set is inherently
	// replicated-only. (System-DB reload tables are a fixed list and don't consult this.)
	const copiedTablesThisPass = new Set<string>();
	// Durable-eligible copy resume cursor awaiting persist (#426). The copy cursor
	// (`{currentTable, afterKey, ...}` = "fully copied through this key") is KEY-based and, exactly like
	// the sequence watermark, must only be PERSISTED once the copied key's blob — and every earlier
	// blob — is durable. We must NOT await blobs in onCommit to achieve that (the same `ws.pause()` ×
	// in-flight-blob circular wait that deadlocked the non-copy path deadlocks copy mode too). onCommit
	// stages each committed frame's cursor into `copyWatermark`, which orders it against in-flight and
	// gapped blobs by walk position; the durable-advance points (onCommit and the blob save `.finally`)
	// pull the highest eligible cursor here and persist via flushDurableCopyCursor(). A transient blob
	// fault clamps persistence only from its own frame onward (harper-pro#699), so everything walked
	// before the first fault still banks and the healing reconnect resumes there instead of from scratch.
	let pendingCopyCursor: { copyStartTime: number; currentTable: any; afterKey: any; copyOrder: any } | null = null;
	const copyWatermark = new CopyCursorWatermark();
	// Durability gate for copy-apply rows (harper-pro#480): bulk-copy frames are applied WAL-off with NO
	// transaction-log entry, so the resume cursor must only advance behind an explicit RocksDB flush
	// (memtable -> SST). flushDurableCopyCursor() flushes the copied DB on a size/time cadence (or immediately
	// when finishing) and persists the cursor staged at flush time; a crash before a flush re-copies
	// idempotently from the last durable cursor. Flushing per batch would be too frequent (write amplification,
	// tiny SSTs), so we batch by COPY_CURSOR_FLUSH_BYTES / _INTERVAL_MS.
	let copyBytesSinceFlush = 0;
	let copyFlushInFlight = false;
	let lastCopyFlushTime = 0;
	// Backoff for a failing copy-cursor flush (e.g. disk-full / I/O error). Without it, the .catch re-stages
	// the cursor and the .finally re-invokes maybeFinishCopy → flushDurableCopyCursor immediately, busy-looping
	// at ~100% CPU and flooding logs on a persistent failure. Escalating backoff + a scheduled retry paces it:
	// transient errors self-heal, a persistent one idles until the operator (or a higher-level watchdog) acts.
	let copyFlushBackoffUntil = 0;
	let copyFlushRetryMs = 0;
	let copyFlushRetryTimer;
	const COPY_CURSOR_FLUSH_BYTES = env.get('replication_copyCursorFlushBytes') ?? 64 * 1024 * 1024;
	const COPY_CURSOR_FLUSH_INTERVAL_MS = Math.max(env.get('replication_copyCursorFlushIntervalMs') ?? 5000, 1);
	// copyApply (and its WAL-off durability gate) engages for every RocksDB copy, the system DB included. The
	// system DB's tables drive event-based machinery off the audit `aftercommit` stream — hdb_nodes feeds
	// subscribeToNodeUpdates (peer discovery / connection setup) and hdb_certificate feeds CA install — which
	// copyApply's audit-less snapshot writes would otherwise suppress. A per-table "reload" marker emitted once
	// the copy is durable (emitCopyReloadMarkers) re-drives those subscribers, so a freshly-copied node still
	// forms its cluster while copyApply also covers hdb_analytics — retiring the system-DB exclusion and the
	// #480 system-analytics spin's interim retention-horizon guard. LMDB stays excluded (copy rows stay
	// audited/durable via the transaction log). (harper-pro#489)
	const copyApplyActive = () => STORAGE_IS_ROCKSDB;
	// Emit a whole-table reload marker for each table whose live subscribers saw no per-row events once a
	// copyApply base copy is durable (the snapshotted rows carry no audit entries), so those subscribers
	// re-read the table. For the system DB this re-drives cluster machinery off the cluster-machinery
	// tables (hdb_nodes peer discovery / hdb_certificate CA install); other system tables (e.g.
	// hdb_analytics) have no live re-read consumer, so it stays the fixed SYSTEM_RELOAD_TABLES list there.
	// For a user DB a table's copyApply snapshot is invisible to live subscribers, so a marker is emitted
	// for every table that actually received an audit-less copy-apply row in this pass (tracked in
	// `copiedTablesThisPass`); Table.subscribe re-delivers the current scope on 'reload', so every live
	// subscriber (MQTT/SSE/WS all funnel through subscribe()) recovers the snapshotted rows (harper-pro#495).
	// A user table that got zero copied rows this pass — empty, non-replicated, or fully audited — has
	// nothing invisible to recover and is skipped (cb1kenobi review, PR #507). A no-op for
	// audited (LMDB / non-copyApply) copies, which already delivered per-row events. Fire-and-forget: each
	// marker is its own tiny transaction, and a failure self-heals on the next restart's subscription scan,
	// so it must never block or fail copy finalization. (harper-pro#489)
	function emitCopyReloadMarkers() {
		if (!copyApplyActive()) return;
		const isSystem = databaseName === 'system';
		const tableNames = isSystem ? SYSTEM_RELOAD_TABLES : Object.keys(tables ?? {});
		for (const tableName of tableNames) {
			const table = (tables as any)?.[tableName];
			if (!shouldEmitCopyReloadMarker(isSystem, tableName, table, copiedTablesThisPass)) continue;
			// `.then(() => writeReloadMarker())` rather than `Promise.resolve(writeReloadMarker())` so a
			// SYNCHRONOUS throw (the marker's transaction commits inline) is also routed to the catch — never
			// bubbling out of this fire-and-forget call into copy finalization (maybeFinishCopy).
			Promise.resolve()
				.then(() => table.writeReloadMarker())
				.catch((error: unknown) =>
					logger.warn?.(connectionId, `failed to emit reload marker for ${databaseName}.${tableName}`, error)
				);
		}
	}
	// `wsClosed` alone is not ownership: forceReconnect() schedules the replacement without waiting for this
	// socket's close event, so a late callback from a superseded connection can still see wsClosed === false
	// and clear the cursor the replacement copy is relying on.
	const supersededOrClosed = () => wsClosed || (options.connection != null && options.connection.socket !== ws);
	// Progress toward FINALIZING, deliberately not `consumerProgress`: that counter advances on every commit,
	// so live traffic from a busy leader would re-arm the watchdog forever while the copy stayed stuck. Only
	// a finalization gate actually closing counts — the commit queue reaching empty, a blob finishing, a
	// cursor flush succeeding. Commits that merely churn a non-empty queue are not progress toward a copy
	// that can only finish at zero. Off entirely outside the window it guards, so the default apply path
	// pays nothing for it.
	function noteCopyFinalizeProgress(fromCommit = false) {
		if (fromCommit && outstandingCommits > 0) return;
		// Ceiling on how long progress may keep deferring the watchdog. Live traffic can drain the commit
		// queue to zero over and over while a different gate stays stuck, so "some gate closed recently"
		// cannot be the only guard. Past the ceiling nothing counts, so the watchdog fires on its next
		// check — this bounds the wedge at the ceiling plus one (possibly escalated) threshold rather than
		// firing exactly at it. A false positive costs a resumed copy, not data.
		if (performance.now() - copyCompleteAt > COPY_FINALIZE_DEADLINE_MULTIPLE * COPY_FINALIZE_TIMEOUT) return;
		copyFinalizeProgress++;
	}
	// Finish the copy — leave copy mode and remove the resume cursor — only once COPY_COMPLETE has been
	// received AND every copied batch has committed (outstandingCommits drained, which includes the final
	// end_txn that advances the resume seqId to copyStartTime). We deliberately stay in copy mode until
	// then so batches still committing keep advancing the cursor (onCommit). Finishing earlier — e.g.
	// synchronously when COPY_COMPLETE is decoded while batches are still queued — would freeze the cursor
	// and risk a crash that loses both the cursor and the not-yet-durable rows, leaving the next start to
	// resume from seqId with gaps.
	function maybeFinishCopy() {
		// The removal below targets the same [copyCursor, nodeId] key the ownership guards in
		// persistCopyCursor protect: a superseded closure's late flush `.finally` reaching here would
		// delete the REPLACEMENT connection's cursor and force a from-scratch re-copy (#683).
		if (connectionSuperseded()) return;
		// Finishing REMOVES the copy resume cursor and exits copy mode, so it must only happen once the copy
		// is fully durable: COPY_COMPLETE received, every batch committed (outstandingCommits drained), AND —
		// since onCommit no longer awaits blobs (#426) — every copied blob durably saved with no held gap.
		// Removing the cursor while a blob is still in flight or a transient gap is held would let a crash
		// resume from the post-copy seqId and skip re-streaming the not-yet-durable blob, losing it.
		if (copyCompleteReceived && outstandingCommits === 0 && outstandingBlobsToFinish.length === 0 && !hasBlobGap) {
			// copy-apply rows are WAL-off with no transaction-log entry: the last copied rows must be durably
			// flushed before the cursor is removed, or a crash after removal loses them (resume-from-seqId can't
			// re-stream base-copy rows). Force the final flush, then finish on its completion. (harper-pro#480)
			if (pendingCopyCursor != null || !copyWatermark.isDrained) {
				flushDurableCopyCursor(); // copyCompleteReceived forces a flush; re-invokes maybeFinishCopy when durable
				return;
			}
			if (copyFlushInFlight) return; // a flush is persisting the final cursor; finish on its completion
			const cloneAttempt = process.env.HARPER_CLONE_ATTEMPT;
			if (cloneAttempt && copyFromNodeId !== undefined) {
				try {
					getDatabaseStores().dbisDB?.put([Symbol.for('cloneCopyComplete'), copyFromNodeId], {
						cloneAttempt,
						copyStartTime: copyModeStartTime,
					});
				} catch (error) {
					logger.warn?.(connectionId, 'failed to persist clone copy completion', databaseName, error);
					close(1011, 'Failed to persist clone copy completion');
					return;
				}
			}
			// guard only the cursor removal on a known node id; ALWAYS exit copy mode, otherwise a
			// COPY_START whose getIdOfRemoteNode returned undefined would strand the node in copy mode
			// (received-version watermark suppressed) and it could never reach Available.
			if (copyFromNodeId !== undefined) getDatabaseStores().dbisDB?.remove([Symbol.for('copyCursor'), copyFromNodeId]);
			inCopyMode = false;
			subscriptionSetupWatchdog?.resume();
			// Retired before the flags its onStall re-checks are cleared, so the timer stops waking the
			// event loop for the rest of the connection's life.
			copyFinalizeWatchdog?.stop();
			copyCompleteReceived = false;
			copyFromNodeId = undefined;
			pendingCopyCursor = null;
			copyProgressWatchdog?.stop(); // copy is done; no longer watching for copy-progress stalls (#453)
			// Copy is over: narrow the byte watchdog back from COPY_TIMEOUT to PING_TIMEOUT so an idle/dead
			// connection in normal replication is still detected on the normal timeout. stop()+reset() so the
			// per-frame throttle can't swallow this transition re-arm (mirrors the COPY_START widen). (#460)
			receiveWatchdog?.stop();
			receiveWatchdog?.reset();
			// The copy's rows are now durable; signal the audit-stream subscribers to re-read the tables
			// copyApply snapshotted without per-row events — cluster-machinery system tables (harper-pro#489)
			// and user-DB tables with live MQTT/SSE/WS subscribers (harper-pro#495).
			emitCopyReloadMarkers();
		}
	}
	// Persist the highest durable-eligible staged copy cursor and, if the copy is now fully durable,
	// finish it. This is the copy-mode analog of the `lastDurableSequenceId` advance: it runs from every
	// durable-advance point (onCommit, and the blob save `.finally`) so the key-based cursor advances
	// without the apply loop ever blocking on blobs. The watermark orders staged cursors against
	// in-flight and gapped blobs by walk position, so a held gap clamps only from its own frame onward
	// (harper-pro#699) while the pre-gap prefix keeps banking below.
	let flushingDurableCopyCursor = false;
	function flushDurableCopyCursor() {
		// Re-entrancy latch: maybeFinishCopy re-enters here when the watermark is undrained, and the
		// synchronous non-copyApply persist calls maybeFinishCopy back — eligibility cannot change
		// within one synchronous body (settles arrive via promise callbacks), so the inner re-entry
		// could only repeat the outer call's work, or recurse unboundedly if a future change ever let
		// staged entries sit below an unreachable limit.
		if (flushingDurableCopyCursor) return;
		flushingDurableCopyCursor = true;
		try {
			const eligible = copyWatermark.takeDurable();
			if (eligible) pendingCopyCursor = eligible;
			if (pendingCopyCursor && copyFromNodeId !== undefined) {
				// Once a held barrier has no unsettled blob below it, this is the last persist the
				// connection will ever perform and the gap watchdog may reconnect at any moment — flush
				// immediately so the reconnect finds it on disk. Earlier gap-path eligibles stay on the
				// cadence: forcing a full store flush per settling blob would chain tiny SSTs (#480).
				persistCopyCursor(pendingCopyCursor, copyWatermark.barrierDrained);
				return;
			}
			maybeFinishCopy();
		} finally {
			flushingDurableCopyCursor = false;
		}
	}
	// Persist a durable-eligible copy cursor. The normal path keeps the #480 cadence; `immediate`
	// (barrier held) forces the flush now — see flushDurableCopyCursor.
	function persistCopyCursor(cursor: typeof pendingCopyCursor, immediate: boolean) {
		// Once this closure no longer owns the link its persists must stop: a replacement connection
		// owns the same [copyCursor, nodeId] key and has moved (or removed) it, so a late write from
		// here — the flush-failure retry timer, or a flush `.then` that resolves late — would overwrite
		// newer resume state with stale, or resurrect a cursor for a completed copy.
		if (connectionSuperseded() || copyFromNodeId === undefined) return;
		// A same-socket COPY_START replaces the walk without superseding the connection; a persist (or
		// its async flush completion) from the prior pass writing under the new pass would claim keys the
		// new walk has not delivered — validated at every asynchronous edge below, not just staging.
		const passAtPersist = copyWatermark.currentPass;
		const reconnectAtDrainedBarrier = () => {
			if (!immediate || !copyWatermark.barrierDrained) return;
			logger.warn?.(
				`Banked copy cursor at held blob gap for ${remoteNodeName}; reconnecting immediately to re-stream from it (harper-pro#699)`
			);
			if (options.connection) options.connection.forceReconnect();
			else ws.terminate();
		};
		// Restore the staged state, back off, and schedule a re-drive. Shared by the async
		// flush `.catch` and the synchronous catch at the bottom: this function runs from the blob-save
		// `.finally` whose promise onCommit awaits, so a synchronous store throw (dbisDB.put, or
		// flushRootStore() evaluated before Promise.resolve — likely the same ENOSPC that failed the
		// blob save) must not escape as a rejection of that awaited promise.
		const onPersistFailure = (error: unknown) => {
			if (wsClosed || connectionSuperseded()) return;
			if (passAtPersist === copyWatermark.currentPass) pendingCopyCursor ??= cursor; // hold the staged cursor
			// Escalating backoff (250ms → 30s cap) instead of an immediate re-flush, so a persistent flush
			// failure idles rather than busy-looping; a scheduled retry drives progress without another event.
			copyFlushRetryMs = Math.min(copyFlushRetryMs ? copyFlushRetryMs * 2 : 250, 30000);
			copyFlushBackoffUntil = performance.now() + copyFlushRetryMs;
			clearTimeout(copyFlushRetryTimer);
			copyFlushRetryTimer = setTimeout(() => {
				copyFlushRetryTimer = undefined;
				// This timer IS the backoff expiring: timers can fire fractionally early relative to
				// performance.now(), and an early fire hitting the backoff guard would no-op with nothing
				// left to re-drive a quiescent link.
				copyFlushBackoffUntil = 0;
				flushDurableCopyCursor();
			}, copyFlushRetryMs);
			copyFlushRetryTimer.unref?.();
			logger.warn?.(connectionId, `copy cursor flush failed; backing off ${copyFlushRetryMs}ms`, error);
		};
		try {
			if (!copyApplyActive()) {
				// Non-copyApply copies (LMDB, or the system DB) stay audited (durable via the transaction log), so
				// the cursor needs no RocksDB flush gate — persist it directly, exactly as before copyApply. (#480)
				getDatabaseStores().dbisDB?.put([Symbol.for('copyCursor'), copyFromNodeId], cursor);
				if (pendingCopyCursor === cursor) pendingCopyCursor = null;
				logger.trace?.(connectionId, 'copy cursor advanced (blobs durable)');
				maybeFinishCopy();
				reconnectAtDrainedBarrier();
				return;
			}
			// copy-apply rows are WAL-off with no transaction-log entry, so the cursor must sit behind an explicit
			// RocksDB flush (memtable -> SST). Flush the copied DB on a size/time cadence (or immediately when
			// finishing) and persist the staged cursor only once the flush resolves; never persist without a
			// durable flush, or a crash would lose the unflushed rows the cursor claims. If the store isn't
			// reachable, hold the cursor rather than risk loss. (harper-pro#480)
			const flushRootStore = copyStoreFlush();
			const flushNow =
				immediate ||
				copyCompleteReceived ||
				copyBytesSinceFlush >= COPY_CURSOR_FLUSH_BYTES ||
				performance.now() - lastCopyFlushTime >= COPY_CURSOR_FLUSH_INTERVAL_MS;
			if (!flushNow || copyFlushInFlight || !flushRootStore || performance.now() < copyFlushBackoffUntil) return;
			const cursorAtFlush = cursor;
			if (pendingCopyCursor === cursor) pendingCopyCursor = null;
			copyBytesSinceFlush = 0;
			lastCopyFlushTime = performance.now();
			// flushRootStore() can throw synchronously; invoke it BEFORE taking the in-flight flag so the
			// catch below never clears a flag a different, genuinely in-flight flush owns.
			const flushStarted = flushRootStore();
			copyFlushInFlight = true;
			Promise.resolve(flushStarted)
				.then(() => {
					// A superseded connection must not touch shared copy state: its replacement is already
					// copying, and persisting this cursor (or finishing below) would rewind or clear the live
					// copy's progress.
					if (supersededOrClosed()) return;
					// rows up to cursorAtFlush are now durable in SST; dbisDB is WAL-on, so this persist is durable.
					// Order (flush data -> persist cursor) keeps the cursor from ever pointing past durable rows.
					// The ownership and pass checks mirror the entry guards: the flush may resolve after this
					// closure died, or after a same-socket COPY_START replaced the walk.
					if (connectionSuperseded() || passAtPersist !== copyWatermark.currentPass) return;
					if (copyFromNodeId !== undefined)
						getDatabaseStores().dbisDB?.put([Symbol.for('copyCursor'), copyFromNodeId], cursorAtFlush);
					copyFlushBackoffUntil = 0;
					copyFlushRetryMs = 0; // flush succeeded; reset backoff
					if (copyCompleteReceived) noteCopyFinalizeProgress();
					logger.trace?.(connectionId, 'copy cursor advanced (rows flushed durable)');
					// A persist under a drained barrier is the connection's LAST possible progress: every
					// later frame is unbankable and only a reconnect (re-stream from this cursor) heals the
					// gap. Reconnect NOW instead of burning the rest of the watchdog interval applying work
					// the next pass re-delivers — this is what makes gap-heal cadence track walk time rather
					// than blobGapReconnectMs. Banking-gated by construction (this persist IS banked
					// progress), so a link that banks nothing still paces at the watchdog interval. (#699)
					reconnectAtDrainedBarrier();
				})
				.catch(onPersistFailure)
				.finally(() => {
					copyFlushInFlight = false;
					if (supersededOrClosed()) return;
					maybeFinishCopy();
					// A cursor that became eligible while THIS flush was in flight deferred its persist on
					// copyFlushInFlight; on a quiescent link (e.g. a barrier latched, nothing left to drain)
					// nothing else re-invokes it, so re-enter now (#683).
					if (pendingCopyCursor || !copyWatermark.isDrained) flushDurableCopyCursor();
				});
		} catch (error) {
			onPersistFailure(error);
		}
	}
	// Select the copied DB's flush primitive: RocksDB exposes flush() (memtable -> SST); LMDB exposes a
	// `flushed` promise. Returns undefined if neither is reachable. (replication targets RocksDB; the LMDB
	// suite exercises this path.)
	function copyStoreFlush(): (() => Promise<unknown>) | undefined {
		const rootStore = auditStore?.rootStore;
		const flush =
			typeof rootStore?.flush === 'function'
				? () => rootStore.flush()
				: rootStore?.flushed !== undefined
					? () => Promise.resolve(rootStore.flushed)
					: undefined;
		if (!flush) return undefined;
		// A flush that never settles is strictly worse than one that fails. onCommit awaits this, and the
		// per-database apply subscription is REUSED across reconnects (subscriptionForDatabase returns the
		// cached active one), so the hung await bricks that database's apply loop for the life of the process
		// — a watchdog reconnect cannot clear it, as the recovery test proves. Rejecting on a bound routes a
		// hang into the failure path this code already handles: core skips the seq persist, the subscription
		// unwinds, and the copy re-runs from the durable cursor rather than resuming past undurable rows.
		return () => {
			// The bound rejects our WAIT, never the flush itself — the native call cannot be cancelled and is
			// still running. Refuse to start another once too many are outstanding, so a permanently stalled
			// store fails fast instead of queueing one more native flush on every retry.
			const outstanding = copyFlushOutstandingByDatabase.get(databaseName) ?? 0;
			if (outstanding >= MAX_OUTSTANDING_COPY_FLUSHES)
				return Promise.reject(
					new Error(
						`copy durability flush for database "${databaseName}" not started: ${outstanding} earlier flushes are still unsettled`
					)
				);
			copyFlushOutstandingByDatabase.set(databaseName, outstanding + 1);
			// `.then` on a resolved promise so a SYNCHRONOUS throw from flush() becomes a rejection that
			// releases the slot below, rather than escaping past the release and leaking capacity until no
			// copy for this database can ever flush again.
			const underlying = Promise.resolve().then(() => maybeStallCopyFinalizeForTest(databaseName) ?? flush());
			const release = () => {
				copyFlushOutstandingByDatabase.set(databaseName, (copyFlushOutstandingByDatabase.get(databaseName) ?? 1) - 1);
			};
			underlying.then(release, release);
			const doublings = copyFlushTimeoutsByDatabase.get(databaseName) ?? 0;
			const boundMs = COPY_FINALIZE_TIMEOUT * 2 ** Math.min(doublings, COPY_FLUSH_BOUND_MAX_DOUBLINGS);
			const timeoutError = new Error(
				`copy durability flush for database "${databaseName}" from ${remoteNodeName} did not settle within ${boundMs}ms`
			);
			return rejectIfUnsettled(underlying, boundMs, timeoutError).then(
				(value) => {
					copyFlushTimeoutsByDatabase.delete(databaseName);
					return value;
				},
				(error) => {
					// Identity, not message: a genuine flush failure (disk full, store closing) is not evidence
					// that the bound was too tight and must not widen it. Deliberately not fenced by connection
					// ownership — the bound tracks the STORE's behavior, which a replacement connection inherits.
					if (error === timeoutError) copyFlushTimeoutsByDatabase.set(databaseName, doublings + 1);
					throw error;
				}
			);
		};
	}
	// Force the copied DB durable and await it. Gates [seq] = copyStartTime behind the copyApply rows'
	// durability: those rows are WAL-off with no transaction-log entry, and core awaits the end_txn onCommit
	// before persisting [seq] (Table.ts updateRecordedSequenceId), so awaiting here orders flush-before-seq.
	// A flush rejection propagates out of onCommit, so core skips the seq persist and the copy re-runs rather
	// than resuming past undurable rows. (harper-pro#480)
	async function flushCopyRowsDurable(): Promise<void> {
		const flush = copyStoreFlush();
		if (flush) await flush();
	}
	// Build an empty sequence-update end_txn. ONLY the RocksDB copy-apply path needs the durability flush gate:
	// those rows are WAL-off with no transaction-log entry. The final copy sequence update (seqId >=
	// copyStartTime) gets an onCommit that flushes before core persists [seq] (core awaits onCommit, then
	// updateRecordedSequenceId). Every other seq-update — normal replication, LMDB (copy rows stay
	// audited/durable), and mid-copy updates below copyStartTime — is a plain end_txn exactly as before, so this
	// adds no per-seq-update overhead and does not alter non-copyApply paths. (harper-pro#480)
	function seqUpdateEndTxn(seqId: number): any {
		if (copyApplyActive() && inCopyMode && copyModeStartTime > 0 && seqId >= copyModeStartTime) {
			return {
				type: 'end_txn',
				localTime: seqId,
				remoteNodeIds: receivingDataFromNodeIds,
				async onCommit() {
					await flushCopyRowsDurable();
				},
			};
		}
		return { type: 'end_txn', localTime: seqId, remoteNodeIds: receivingDataFromNodeIds };
	}
	let sendPingInterval, lastPingTime, skippedMessageSequenceUpdateTimer;
	let receiveWatchdog: { reset: () => void; stop: () => void } | undefined;
	let peerSupportsSubscriptionSetupAck = false;
	let nextSubscriptionSetupRequestId = 0;
	let pendingSubscriptionSetupRequestId: number | undefined;
	let subscriptionSetupTimeoutMs = SUBSCRIPTION_SETUP_TIMEOUT_MS;
	// Outbound-only application setup guard (harper-pro#642). Unlike receiveWatchdog it deliberately
	// ignores ping/pong bytes: those prove the socket is alive, not that the peer entered its replay loop.
	let subscriptionSetupWatchdog:
		| {
				arm: () => void;
				complete: () => void;
				pause: () => void;
				resume: () => void;
				stop: () => void;
		  }
		| undefined;
	// Companion to receiveWatchdog that guards the back-pressure-paused window the byte watchdog is
	// blind to (harper-pro#466). Armed on pause, stopped on resume — see addPauseReason/removePauseReason.
	let pauseStallWatchdog: { reset: () => void; stop: () => void } | undefined;
	// Copy-progress watchdog (harper-pro#453): keyed on base-copy app-frame progress rather than raw
	// socket bytes, so keepalive pings (WS control frames, not 'message' events) can't suppress it the way
	// they do the byte-level receiveWatchdog. `copyProgressFrames` advances on every received 'message'
	// while in copy mode; if it stalls past the threshold while still `connected`, the copy has wedged.
	let copyProgressWatchdog: { reset: () => void; stop: () => void } | undefined;
	let blobGapReconnectTimer: ReturnType<typeof createBlobGapReconnectTimer> | undefined;
	let copyProgressFrames = 0;
	// Guards COPY_COMPLETE → copy actually finished, the one phase the three watchdogs above all leave
	// unguarded. Armed at COPY_COMPLETE, stopped when copy mode exits. See createCopyFinalizeWatchdog.
	let copyFinalizeWatchdog: { reset: () => void; stop: () => void } | undefined;
	let copyFinalizeProgress = 0;
	let copyCompleteAt = 0;
	// Count ONLY base-copy frames as progress — COPY_START, the per-batch copy records (isCopyFrame), and
	// copy BLOB_CHUNKs — not every 'message'. replicateOverWS is bidirectional, so counting arbitrary
	// frames (schema/subscription updates, reverse-direction traffic) could re-arm the watchdog once per
	// threshold and mask a genuinely stalled copy. Re-arms the watchdog while copying. (harper-pro#453)
	const noteCopyProgress = () => {
		copyProgressFrames++;
		// Not while paused for back-pressure: the commit-backlog pause trips mid-frame, and the same
		// frame's (or an already-buffered frame's) progress note would re-arm the watchdog addPauseReason
		// just stopped. A pause outlasting blobTimeout then reads as a copy stall and the watchdog kills a
		// healthy, actively-committing leg. Same invariant as resetPingTimer (harper-pro#466 review):
		// while paused the pause-stall watchdog is the liveness guard; removePauseReason re-arms this one.
		if (pauseReasons === 0) copyProgressWatchdog?.reset();
	};
	let blobsTimer;
	const DELAY_CLOSE_TIME = 60000; // amount of time to wait before closing the connection if we haven't any activity and there are no subscriptions
	let delayedClose: NodeJS.Timeout;
	let lastMessageTime = 0;
	// track bytes read and written so we can verify if a connection is really dead on pings
	let bytesRead = 0;
	let bytesWritten = 0;
	// wall-clock time of the last observed socket activity (bytes moved in either direction); the
	// keep-alive timeout is measured from this so a legitimately slow-but-progressing transfer stays
	// alive while a truly idle/dead peer is still terminated.
	let lastByteActivity = performance.now();
	// Multiple independent conditions can ask to pause receive on this WS (commit backlog, consumer
	// queue full, blob write backpressure). We refcount the reasons so that resuming one does not race
	// ahead of another that still wants the WS paused. Declared before the ping setup below because the
	// immediate sendPing() reads it.
	let pauseReasons = 0;
	// Monotonic local-consumer progress tick sampled by pauseStallWatchdog. Unlike socket `bytesRead`
	// (frozen by `ws.pause()`), this keeps advancing while the receive socket is paused for back-pressure
	// — bumped when the apply loop commits a queued batch (onCommit) and when an in-flight blob stream
	// drains to disk — so the watchdog can tell a healthy back-pressure pause (consumer draining) from a
	// leg that died mid-pause (harper-pro#466). Only meaningful while paused.
	let consumerProgress = 0;
	// Default 15min: a 120s cap dropped ~4,500 blobs to permanent divergence when a rolling
	// upgrade + concurrent writes had blob transfers routinely stalling past the timeout, the
	// receive watchdog then killed the subscription, and the audit cursor advanced past the
	// missing blob. 900000 lets in-flight transfers complete across a peer restart window.
	const blobTimeout = env.get(CONFIG_PARAMS.REPLICATION_BLOBTIMEOUT) ?? 900000;
	const blobsInFlight = new Map();
	// Blobs whose file was (or is being) repaired IN PLACE (#699): these are files a committed
	// record already references, so they must never enter a decode-failure/relocation cleanup list.
	const inPlaceRepairedBlobs = new WeakSet();
	// Repair candidates exist only on a link that is re-delivering already-applied records: a copy
	// that resumed from a persisted cursor, a copy restarted on a live connection, or a resume's
	// leading-duplicate tail. A virgin base copy never pays the stored-entry read.
	let copyResumeRequested = false;
	let sawCopyRestart = false;
	// Latch the repair window OFF once the resumed walk has provably passed the re-delivered span:
	// re-delivered duplicates are contiguous, so a run of stored-entry misses means every later
	// record is genuinely new and the per-record getEntry would be a pure miss tax for the rest of
	// the copy. A hit resets the run (healthy duplicates also reset it — still inside the window).
	const repairWindowMissRunByNode = new Map<number | undefined, number>();
	const repairDeclines: Record<string, number> = {};
	// Blob-transfer ids whose record was skipped as an identity tie. The chunk handler drops their chunks on sight,
	// so a blob whose bytes arrive after its record never opens a stream no consumer will ever drain.
	// Retired by the blob's own final chunk, by a record that does apply the same transfer, or by
	// the connection closing.
	const skippedBlobIds = new Map<any, number>();
	const outstandingBlobsToFinish: Promise<void>[] = [];
	let outstandingBlobsBeingSent = 0;
	const blobSentCallbacks: Array<(v?: any) => void> = [];
	// Refresh the keep-alive liveness clock from observed socket byte movement. If the underlying
	// _socket isn't observable (test mocks, pre-connect, or a change in the ws library internals),
	// bytesRead/bytesWritten read as undefined; we can't measure activity, so treat the connection as
	// live rather than let the keep-alive falsely terminate a healthy peer.
	function noteByteActivity(): void {
		const read = ws._socket?.bytesRead;
		const written = ws._socket?.bytesWritten;
		if (read === undefined || written === undefined || read !== bytesRead || written !== bytesWritten) {
			lastByteActivity = performance.now();
		}
	}
	// The idle-silence window the byte-level liveness checks tolerate. While receiving a base copy the
	// sender can sit in writableNeedDrain backpressure with no bytes reaching us for far longer than
	// PING_TIMEOUT even though the copy is healthy, so widen the window to COPY_TIMEOUT during copy and
	// fall back to the normal ping timeout otherwise (harper-pro#460). Evaluated per check/arm because
	// inCopyMode flips during the connection's life.
	const currentReceiveSilenceThresholdMs = () => (inCopyMode ? COPY_TIMEOUT : RECEIVE_SILENCE_THRESHOLD_MS);
	if (shouldRunKeepalive(options)) {
		const sendPing = () => {
			// Note any socket activity since the last interval (incoming pong/data or our send buffer
			// draining as the peer consumes) — either proves the peer is still alive.
			noteByteActivity();
			if (
				shouldTerminateIdlePing(performance.now() - lastByteActivity, currentReceiveSilenceThresholdMs(), pauseReasons)
			) {
				ws.terminate(); // no socket activity within the timeout — peer is gone
				return;
			}
			// While paused for receiver backpressure, keep our own liveness fresh: the stall is local and
			// self-clearing (it doesn't depend on the peer), so we must not time the peer out for it.
			if (pauseReasons > 0) {
				lastByteActivity = performance.now();
				// Keep the shared-memory liveness fresh too, so the main thread's connection truth (W1 / #431)
				// does not falsely flip this healthy-but-paused link to down and trigger a needless reconcile.
				// LAST_LIVENESS_TIME_POSITION holds a wall-clock timestamp (Date.now()), since the main thread
				// compares it against Date.now() in deriveConnectionTruth — not performance.now() like
				// lastByteActivity above (which is the keepalive's own monotonic clock). See gemini review on #445.
				// Only the owning subscription may refresh the (db, peer) truth; a paused inbound/retrieval
				// connection sharing the buffer must not keep a dead subscription's link alive.
				const pausedStatus = getSharedStatus();
				if (pausedStatus && options.connection?.nodeSubscriptions !== undefined)
					pausedStatus[LAST_LIVENESS_TIME_POSITION] = Date.now();
			}
			// Always send the keep-alive ping. ws.pause() only stops reads, not writes, and the accepted
			// peer relies on our pings to keep its own receive timer alive even when it has no data to send
			// us. Record byte counts AFTER the ping so the ping's own bytes aren't later mistaken for peer
			// activity.
			lastPingTime = performance.now();
			ws.ping();
			bytesRead = ws._socket?.bytesRead;
			bytesWritten = ws._socket?.bytesWritten;
		};
		// Both call sites are callbacks — an interval, and the 'open' listener below — where a throw is
		// an uncaught exception rather than something a caller can reject. Stop the tick instead of
		// crashing; the receive watchdog still guards liveness.
		const tick = () => {
			try {
				sendPing();
			} catch (error) {
				clearInterval(sendPingInterval);
				logger.warn?.(connectionId, 'stopped replication keepalive', remoteNodeName, error);
			}
		};
		const startKeepalive = () => {
			sendPingInterval = setInterval(tick, PING_INTERVAL).unref();
			tick(); // ping immediately so we can measure latency
		};
		if (keepaliveArmsOnOpen(ws.readyState)) ws.once('open', startKeepalive);
		else startKeepalive();
	}
	// Both client and server arm the receive watchdog. On the client this is independent of the
	// sendPing tick above: if that tick is missed or its ws.terminate() does not propagate a
	// 'close' event, the watchdog forces the reconnect path. See harper-pro#233 for the failure
	// modes observed in the field.
	// `let` so the leak-after-COPY_START test hook can flip it mid-connection (see COPY_START below).
	let wedgedForTest = armReplicationWedgeForTest(options.connection, ws, databaseName);
	// W1 T1 (#431): truth snapshot for watchdog fire logs — what the shared-memory connection truth said
	// at the moment a worker-local watchdog decided to act (see formatTruthSnapshot for how the
	// demotion soak reads this).
	const truthSnapshotForLog = () => {
		// This telemetry feeds the watchdog fire logs, emitted from the onSilence/onStall recovery
		// callbacks immediately before forceReconnect()/ws.terminate(). getSharedStatus() and
		// deriveConnectionTruth() read shared memory / the auditStore and can throw if that state is
		// unexpected; an unhandled throw here would abort the recovery callback and leave the connection
		// permanently wedged — the opposite of what a recovery net is for. Swallow (trace-log) so a
		// telemetry failure degrades the log line to a marker and recovery always proceeds. (harper-pro#431)
		try {
			const status = getSharedStatus();
			return formatTruthSnapshot(status && deriveConnectionTruth(status));
		} catch (error) {
			logger.trace?.(connectionId, 'failed to build connection-truth snapshot for watchdog fire log', error);
			return 'truth=error';
		}
	};
	// Watchdog fires act on the SHARED connection object, but the watchdogs are per replicateOverWS
	// instance. An instance whose socket was already replaced on the connection (its teardown never ran,
	// e.g. close suppressed on a paused socket) firing forceReconnect would tear down the CURRENT healthy
	// leg — observed in production as one "no base-copy progress" kill per churn cycle against a live,
	// committing copy. Mirror the close handler's socket-identity guard (NodeReplicationConnection
	// connect()): a superseded instance runs its own full retirement and stands down instead of acting.
	// The connection retires the session it supersedes (retireSession, on forceReconnect and on socket
	// replacement in connect()), so this fires only for a leak that escaped those — a backstop, not the
	// primary teardown.
	const firingFromSupersededInstance = (watchdogName: string) => {
		if (!options.connection || options.connection.socket === ws) return false;
		const dbContext = databaseName ? ` (db: "${databaseName}")` : '';
		logger.warn?.(
			`${watchdogName} fired on a superseded connection instance for ${remoteNodeName}${dbContext}; ignoring and retiring this instance`
		);
		retireInstance(undefined, 'superseded instance retired by stale watchdog fire');
		return true;
	};
	receiveWatchdog = createReceiveWatchdog({
		intervalMs: currentReceiveSilenceThresholdMs,
		getBytesRead: () => (wedgedForTest ? 0 : (ws._socket?.bytesRead ?? 0)),
		onSilence: () => {
			if (firingFromSupersededInstance('Receive watchdog')) return;
			// Warn-level: if the active sendPing was healthy this watchdog should not have fired,
			// so it is a signal that something is wrong upstream (event-loop stall, keepalive timer
			// misbehaving, peer accepting bytes but not progressing the protocol). Surface it so
			// operators have something to grep for.
			const dbContext = databaseName ? ` (db: "${databaseName}")` : '';
			const direction = options.url ? 'no activity from' : 'no ping from';
			logger.warn?.(
				`Receive watchdog: ${direction} ${remoteNodeName}${dbContext} for ${currentReceiveSilenceThresholdMs()}ms — terminating connection and reconnecting — ${truthSnapshotForLog()}`
			);
			// On the client (subscription) side drive recovery through the connection so it does not depend
			// on terminate() propagating a 'close' (an open-but-idle socket may never emit one). A
			// server-accepted connection has no connection object to reconnect — the remote client
			// reconnects — so just terminate. See harper-pro#420.
			if (options.connection) options.connection.forceReconnect();
			else ws.terminate();
		},
	});
	// Guards the window the receive watchdog cannot: while the socket is paused for back-pressure the
	// byte watchdog is stopped (bytesRead frozen) and the sendPing is exempt, so a leg that dies
	// mid-pause has no recovery driver. This one keys off consumer progress instead and is armed only
	// while paused (addPauseReason → reset, removePauseReason → stop). Same recovery as above. (harper-pro#466)
	pauseStallWatchdog = createPauseStallWatchdog({
		thresholdMs: PAUSE_STALL_THRESHOLD_MS,
		getProgress: () => consumerProgress,
		onStall: () => {
			if (firingFromSupersededInstance('Pause-stall watchdog')) return;
			const dbContext = databaseName ? ` (db: "${databaseName}")` : '';
			logger.warn?.(
				`Receive watchdog: no consumer progress from ${remoteNodeName}${dbContext} for ${PAUSE_STALL_THRESHOLD_MS}ms while paused for back-pressure — terminating connection and reconnecting — ${truthSnapshotForLog()}`
			);
			if (options.connection) options.connection.forceReconnect();
			else ws.terminate();
		},
	});
	// Re-arm the byte watchdog on observed frame activity — but NOT while the socket is paused for
	// back-pressure. The 'message'/'ping'/'pong' handlers call this on every frame; without the guard a
	// frame delivered around a pause boundary could re-arm the byte watchdog after addPauseReason stopped
	// it, and since `ws.pause()` freezes `bytesRead` it would then spuriously fire `forceReconnect` after
	// PING_TIMEOUT on a healthy paused leg — breaking the "exactly one of {receiveWatchdog,
	// pauseStallWatchdog} armed while paused" invariant. While paused the pause-stall watchdog is the
	// liveness guard; removePauseReason re-arms the byte watchdog on resume. (harper-pro#466 review)
	const resetPingTimer = () => {
		if (pauseReasons === 0) receiveWatchdog?.reset();
	};
	resetPingTimer();
	// Copy-progress watchdog: the byte-level receiveWatchdog above can't catch a base copy that stalls
	// while the socket stays ping-alive — keepalive pings keep `bytesRead` advancing, so it never fires
	// (a customer's 5.1.7 deploy wedge, harper-pro#453: follower parked connected:true, status "Receiving",
	// version frozen,
	// while the connected:false wedge-reconcile and this byte watchdog both pass it by). This watchdog is
	// keyed on copy app-frame progress instead, so pings can't suppress it. Armed only while in copy mode
	// (reset on COPY_START and on each in-copy 'message'; stopped on copy finish / pause). On a stall it
	// forces the same close-independent reconnect, which restarts the copy from the leader. (harper-pro#453)
	// blobTimeout (REPLICATION_BLOBTIMEOUT) defaults to 900000 and is shared with blobsTimer; guard
	// against a misconfigured 0/negative that would otherwise forceReconnect in a tight loop.
	const effectiveBlobTimeoutMs = blobTimeout > 0 ? blobTimeout : 900000;
	copyProgressWatchdog = createReceiveWatchdog({
		intervalMs: effectiveBlobTimeoutMs,
		getBytesRead: () => copyProgressFrames,
		onSilence: () => {
			if (firingFromSupersededInstance('Copy-progress watchdog')) return;
			if (!inCopyMode || copyCompleteReceived) return; // only act on an actively-receiving, stalled copy
			const dbContext = databaseName ? ` (db: "${databaseName}")` : '';
			logger.warn?.(
				`Copy-progress watchdog: no base-copy progress from ${remoteNodeName}${dbContext} for ${effectiveBlobTimeoutMs}ms while connected — terminating connection and reconnecting to restart the copy (harper-pro#453) — ${truthSnapshotForLog()}`
			);
			if (options.connection) options.connection.forceReconnect();
			else ws.terminate();
		},
	});
	// Blob-gap watchdog: a connection whose `hasBlobGap` latched keeps flowing frames and answering
	// pings, so neither the byte watchdog nor the copy-progress watchdog above ever notices it — yet
	// its durable cursors are pinned and only a reconnect (which re-streams the gapped blob) can heal
	// it. Bound that state to blobTimeout instead of waiting for an unrelated reconnect (#683).
	// Tunable separately from blobTimeout: the copy cursor now banks up to the gap (#699), so a
	// shorter cycle retries the gapped blob sooner without also shortening blob stream timeouts.
	const blobGapReconnectMs = Math.max(
		positiveMsOr(env.get('replication_blobGapReconnectMs'), effectiveBlobTimeoutMs),
		1000
	);
	blobGapReconnectTimer = createBlobGapReconnectTimer({
		timeoutMs: blobGapReconnectMs,
		onGapHeld: () => {
			// The repeating fire must die with ownership, not just with 'close': the forced reconnect's
			// teardown of THIS socket is best-effort and may never fire 'close' (#420), and a zombie
			// closure re-firing every cycle would terminate each healthy replacement mid-copy.
			if (connectionSuperseded()) {
				blobGapReconnectTimer?.stop();
				return;
			}
			const dbContext = databaseName ? ` (db: "${databaseName}")` : '';
			logger.warn?.(
				`Blob-gap watchdog: a blob gap from ${remoteNodeName}${dbContext} has pinned the resume cursor for ${blobGapReconnectMs}ms while connected — terminating connection and reconnecting to re-stream the gapped blob (harper-pro#683) — ${truthSnapshotForLog()}`
			);
			if (options.connection) options.connection.forceReconnect();
			else ws.terminate();
		},
	});
	// The stuck-state detail is logged inline because the forced reconnect immediately clears it, and it is
	// the only record of WHY finalization never completed.
	copyFinalizeWatchdog = createCopyFinalizeWatchdog({
		// Widens with the flush bound. A fixed threshold would force-reconnect at 1x while the escalation was
		// still waiting out a slow-but-honest flush at 2x or 4x, so the escalation could never take effect.
		thresholdMs: () =>
			COPY_FINALIZE_TIMEOUT *
			2 ** Math.min(copyFlushTimeoutsByDatabase.get(databaseName) ?? 0, COPY_FLUSH_BOUND_MAX_DOUBLINGS),
		getProgress: () => copyFinalizeProgress,
		onStall: () => {
			// Finalization may have completed between the last arm and this fire; a finished copy must not be
			// reconnected out from under itself.
			if (supersededOrClosed() || !inCopyMode || !copyCompleteReceived) return;
			const dbContext = databaseName ? ` (db: "${databaseName}")` : '';
			logger.error?.(
				`Copy-finalization watchdog: base copy from ${remoteNodeName}${dbContext} received COPY_COMPLETE but did not finalize within ${COPY_FINALIZE_TIMEOUT}ms — this node stays in copy mode and can never become available; terminating connection and reconnecting to resume the copy — stuck on {outstandingCommits: ${outstandingCommits}, outstandingBlobs: ${outstandingBlobsToFinish.length}, blobGap: ${hasBlobGap}, copyFlushInFlight: ${copyFlushInFlight}, pendingCopyCursor: ${pendingCopyCursor != null}} — ${truthSnapshotForLog()}`
			);
			if (options.connection) options.connection.forceReconnect();
			else ws.terminate();
		},
	});
	subscriptionSetupWatchdog = createSubscriptionSetupWatchdog({
		timeoutMs: () => subscriptionSetupTimeoutMs,
		onTimeout: () => {
			if (firingFromSupersededInstance('Subscription-setup watchdog')) return;
			if (wsClosed || inCopyMode) return;
			pendingSubscriptionSetupRequestId = undefined;
			const dbContext = databaseName ? ` (db: "${databaseName}")` : '';
			logger.warn?.(
				`Subscription-setup watchdog: no application response from ${remoteNodeName}${dbContext} for ${subscriptionSetupTimeoutMs}ms while transport remained connected — reconnecting from the durable cursor (harper-pro#642) — ${truthSnapshotForLog()}`
			);
			if (options.connection) options.connection.forceReconnect();
			else ws.terminate();
		},
	});
	ws._socket?.setMaxListeners(200); // we should allow a lot of drain listeners for concurrent blob streams
	let ratioOfBackPressureTime = 0;
	let lastBackPressureCheck = 0;
	let isPausedForBackPressure = false;
	const BACK_PRESSURE_INTERVAL = 30_000;
	function updateBackPressureRatio() {
		// we only want to track/record backpressure for sending data for incoming subscriptions
		if (nodeSubscriptions?.length > 0) {
			const now = performance.now();
			const durationSinceCheck = now - lastBackPressureCheck;
			// calculate the running average ratio of back-pressure time, logarithmically decaying towards 1 if paused, towards 0 if not paused
			ratioOfBackPressureTime =
				(ratioOfBackPressureTime * BACK_PRESSURE_INTERVAL + (isPausedForBackPressure ? durationSinceCheck : 0)) /
				(BACK_PRESSURE_INTERVAL + durationSinceCheck);
			if (replicationSharedStatus) replicationSharedStatus[BACK_PRESSURE_RATIO_POSITION] = ratioOfBackPressureTime;
			lastBackPressureCheck = now;
		}
	}
	const backPressureInterval = setInterval(updateBackPressureRatio, BACK_PRESSURE_INTERVAL).unref();
	function getSharedStatus() {
		if (!remoteNodeName || !databaseName || !auditStore) {
			return;
		}
		if (!replicationSharedStatus) {
			replicationSharedStatus = getReplicationSharedStatus(auditStore, databaseName, remoteNodeName);
			// Make the buffer available to the connection's lifecycle methods (close/forceReconnect) so they
			// can record DOWN/error without re-resolving auditStore. See W1 (harper-pro#431).
			if (options.connection) options.connection.sharedStatus = replicationSharedStatus;
		}
		return replicationSharedStatus;
	}
	if (databaseName) {
		setDatabase(databaseName);
	}
	let schemaUpdateListener, dbRemovalListener;
	const tableDecoders = [];
	const remoteTableById = [];
	let receivingDataFromNodeNames;
	const residencyMap = [];
	const sentResidencyLists = [];
	const receivedResidencyLists = [];
	const MAX_OUTSTANDING_COMMITS = env.get(CONFIG_PARAMS.REPLICATION_RECORDCONCURRENCY) ?? 150; // maximum before requesting that other nodes pause
	const MAX_OUTSTANDING_BLOBS_BEING_SENT = env.get(CONFIG_PARAMS.REPLICATION_BLOBCONCURRENCY) ?? 5;
	let outstandingCommits = 0;
	let lastStructureLength = 0;
	let commitBacklogPaused = false;
	// Wall-clock at which the current back-pressure pause began (0 when not paused). Used to discount the
	// paused interval from the blob-stream timeout: while paused no chunks are processed so every in-flight
	// stream's `lastChunk` freezes, and counting that time against `blobTimeout` would spuriously destroy a
	// healthy transfer (harper-pro#368). The blobsTimer adds the *ongoing* pause duration in its check, and
	// `removePauseReason` shifts each stream's `lastChunk` forward by the *total* paused duration on resume.
	let pauseStartTime = 0;
	function addPauseReason(): void {
		if (pauseReasons === 0) {
			ws.pause();
			pauseStartTime = Date.now();
			subscriptionSetupWatchdog?.pause();
			// Suspend the receive watchdog while the socket is intentionally paused — `bytesRead`
			// is frozen by `ws.pause()` so the byte check cannot tell legitimate backpressure
			// from peer silence, and firing here would terminate a healthy mid-ingest connection.
			receiveWatchdog?.stop();
			// Hand liveness off to the pause-stall watchdog for the paused window: the byte watchdog is now
			// blind, but a leg can still die mid-pause, so guard it by consumer progress instead (harper-pro#466).
			pauseStallWatchdog?.reset();
			// Same reasoning for the copy-progress watchdog: paused means no 'message' frames arrive, so
			// `copyProgressFrames` legitimately freezes — don't count backpressure as a copy stall (#453).
			copyProgressWatchdog?.stop();
		}
		pauseReasons++;
	}
	function removePauseReason(): void {
		if (pauseReasons === 0) return;
		pauseReasons--;
		if (pauseReasons === 0) {
			ws.resume();
			subscriptionSetupWatchdog?.resume();
			// Resuming: the byte watchdog can see the socket again, so retire the pause-stall watchdog and
			// restart the silence window from the resume point — we deliberately do not penalize the
			// connection for the time it spent paused.
			pauseStallWatchdog?.stop();
			receiveWatchdog?.reset();
			// Restart the copy-progress window too, but only while still copying (#453).
			if (inCopyMode && !copyCompleteReceived) copyProgressWatchdog?.reset();
			// Same reasoning for in-flight blob streams: while paused we stop reading the socket, so no
			// blob chunks are processed and each stream's `lastChunk` clock goes stale even though the
			// transfer is perfectly healthy. The blobsTimer below would then count the paused interval
			// against blobTimeout and spuriously destroy a live stream — observed as a swallowed "Blob save
			// failed" during post-restart catch-up, the root-cause trigger of the soak-rolling-restarts
			// record loss (harper-pro#368). Shift each stream's `lastChunk` forward by EXACTLY the paused
			// duration so only time spent *not* paused counts toward the timeout — and, crucially, so genuine
			// pre-pause idle time is preserved (resetting to `now` would let repeated pause/resume churn keep
			// a truly stuck stream alive forever). A genuinely stuck local blob write still times out: its
			// clock keeps advancing across resumes since the shift only credits actual paused time.
			refreshBlobStreamsOnResume(blobsInFlight, Date.now() - pauseStartTime);
		}
	}
	let subscriptionRequest, auditSubscription;
	let nodeSubscriptions;
	let excludedNodes: string[]; // list of nodes to exclude from this subscription
	// undefined = not yet computed; null = computed, no exclusions; Set = tables to drop on receive
	let receiveExcludedTables: Set<string> | null | undefined;
	let remoteShortIdToLocalId: Map<number, number>;
	let subscribedNodeIds: Array<boolean | { startTime: number; endTime?: number }> | undefined; // map of node IDs to their subscription time ranges
	// Serialize message handling so that async backpressure inside onWSMessage doesn't allow
	// the WS library to start processing the next frame before the current one is fully decoded.
	// Without serialization, awaiting inside the handler would let concurrent message handlers
	// share the consumer queue and defeat the per-record backpressure below.
	let messageProcessing: Promise<void> = Promise.resolve();
	let wsClosed = false;
	// Anything this closure persists (copy cursors, their removal) or forces (the blob-gap
	// watchdog's reconnect) after losing ownership would act against the replacement's state.
	const connectionSuperseded = () => isConnectionSuperseded(wsClosed, options.connection, ws);
	// Receive-side resume-cursor durability watermark. A record is "fully durable" only once it is
	// committed AND its blob (and all earlier blobs) have finished saving; the persisted replication
	// resume cursor must never advance past that point. We track this with an ASYNC watermark rather
	// than blocking the apply loop on blobs:
	//   - `committedSequence` = the highest sequence id from an end_txn event the apply loop has
	//     committed so far. Commit == visibility; this advances synchronously in onCommit.
	//   - `lastDurableSequenceId` = the durable watermark = the highest committed sequence whose blobs
	//     (and all earlier ones) are durably saved. It is what we persist as the resume cursor.
	// The watermark advances to `committedSequence` only when there is no in-flight blob AND no gap:
	// in onCommit when `outstandingBlobsToFinish` is empty, and in the blob save `.finally` (success
	// path) when the last in-flight blob drains. Because the cursor only ever advances to a sequence
	// whose blobs are all durable, a crash/restart resumes from the watermark and re-streams — and
	// re-saves — any record whose blob wasn't durable; nothing is lost.
	// `hasBlobGap` is set when a blob save FAILS (see receiveBlobs); from then on the watermark holds
	// (the advance is gated on `!hasBlobGap`) until a reconnect re-streams the disrupted blob.
	// This design removes the synchronous `await Promise.all(outstandingBlobsToFinish)` that used to
	// run inside onCommit, which (combined with receive backpressure pausing the WS, and thus the
	// BLOB_CHUNK frames those blobs need) produced a circular wait / permanent deadlock during
	// catch-up. The apply loop now never blocks on blobs; the cursor simply lags within the bounded
	// in-flight window (sender caps concurrent blobs at MAX_OUTSTANDING_BLOBS_BEING_SENT) and holds on
	// a gap. See onCommit, the blob save `.finally`, and the sequence-update branches.
	let hasBlobGap = false;
	let lastDurableSequenceId = 0;
	let committedSequence = 0;
	// Blob-divergence escalation (harper-pro#386). Each blob save failure already logs at `error`, but a
	// sustained failing link emits that per-blob spam without a single line naming it as ongoing
	// divergence. Once this connection crosses SUSTAINED_BLOB_FAILURE_THRESHOLD failures we log one
	// escalation line pointing the operator at cluster_status, then stay quiet (the per-blob errors and
	// the metric carry the rest). Connection-scoped so it re-arms on reconnect.
	let blobFailureCount = 0;
	let sustainedBlobFailureLogged = false;
	// The cursor must not advance past a sequence id whose blobs are not yet durable — whether a blob has
	// already failed (`hasBlobGap`) OR is still in flight and might fail. A sequence-update can arrive while
	// a slow blob (e.g. one about to hit the stream timeout) is still saving; advancing on it would push the
	// cursor past a blob that then fails, before `hasBlobGap` is ever set. The data-record onCommit awaits
	// `outstandingBlobsToFinish` before it clamps, so it only needs `hasBlobGap`; the sequence-update sites
	// don't await, so they also gate on outstanding blobs.
	const cursorBlockedByBlob = () => hasBlobGap || outstandingBlobsToFinish.length > 0;

	// ── Leading-duplicate fast-skip state ───────────────────────────────────────────────────────────
	// Per *source node* (NOT a single global flag): the resume cursor we asked this node to re-stream
	// from. On resume the leader re-streams from this version, so every incoming record from that node
	// whose version is `<= cursor` is a record we already received and applied before the disconnect —
	// a leading duplicate. A proxied/multi-node subscription interleaves records from independent source
	// nodes with independent version spaces, so the latch MUST be keyed by source node id, and gated by
	// version: once a record from a node arrives with `version > cursor`, that node has streamed past the
	// already-applied tail and we drop its entry so nothing newer is ever treated as a duplicate.
	// Keyed by the *local* node id (matching `event.nodeId` = remoteShortIdToLocalId.get(...)).
	const leadingDupCursorByNode: Map<number, number> = new Map();

	/**
	 * Decide whether an incoming record is a *provably-already-applied* leading duplicate that can be
	 * skipped before it ever reaches core's apply loop. CORRECTNESS IS PARAMOUNT: this returns true only
	 * for a TRUE identity tie (same version AND same source node as the record already stored locally),
	 * within the per-node resume-cursor window, and only when skipping cannot lose data or block a repair.
	 * Anything ambiguous (older version, different node, no existing record, missing blob, decode/read
	 * failure) returns false and the record flows to the apply loop untouched — exactly as today.
	 *
	 * @param tableDecoder per-table decoder (exposes getEntry against the live primaryStore)
	 * @param id           record primary key
	 * @param incomingVersion incoming record version (scalar timestamp)
	 * @param sourceNodeId    local id of the originating node (`event.nodeId`)
	 * @param hasBlobs        whether the audit header's HAS_BLOBS bit is set on the incoming record
	 *
	 * NOTE: the blob-present check intentionally inspects the EXISTING (already-applied) record's blobs,
	 * not the incoming duplicate's — they share content, and the existing record reflects the durable
	 * on-disk state we must not skip a repair for. So the incoming value is not needed here.
	 */
	async function isSkippableLeadingDuplicate(
		tableDecoder: any,
		id: any,
		incomingVersion: number,
		sourceNodeId: number | undefined,
		hasBlobs: boolean
	): Promise<boolean> {
		if (!LEADING_DUP_SKIP_ENABLED) return false;
		// No mapped source node id → cannot reason about its version space. Let it flow.
		if (sourceNodeId === undefined) return false;
		const cursor = leadingDupCursorByNode.get(sourceNodeId);
		if (cursor === undefined) return false; // this node has already streamed past its resume tail
		if (incomingVersion > cursor) {
			// This node has caught up to live data; stop treating anything from it as a leading duplicate.
			leadingDupCursorByNode.delete(sourceNodeId);
			return false;
		}
		// Within the leading-duplicate window. Read the existing record to confirm a TRUE identity tie.
		return isDurableIdentityTie(readLocalEntry(tableDecoder, id), incomingVersion, sourceNodeId, hasBlobs);
	}

	/**
	 * The locally stored entry for `id`, or undefined when it cannot be read as a plain synchronous entry —
	 * a getEntry throw, or a store that hands back a thenable. Both mean "we cannot prove anything about the
	 * local state", which every caller treats as "let the record flow".
	 */
	function readLocalEntry(tableDecoder: any, id: any) {
		let existing;
		try {
			existing = tableDecoder?.getEntry?.(id);
			if (existing && typeof existing.then === 'function') return undefined;
		} catch (error) {
			logger.trace?.(connectionId, 'identity-tie: getEntry threw, letting record flow', id, error);
			return undefined;
		}
		if (existing && typeof existing.then === 'function') {
			logger.trace?.(connectionId, 'identity-tie: getEntry returned a promise, letting record flow', id);
			return undefined;
		}
		return existing;
	}

	function getBlobTransferId(blob: Blob): number | undefined {
		return (blob as Blob & { replicationTransferId?: number }).replicationTransferId;
	}

	// Drop skipped transfer chunks without leaving a reader-less stream in flight.
	function discardIncomingBlobStream(blob: Blob) {
		const transferId = getBlobTransferId(blob);
		const streamKey = getBlobTransferKey(getFileId(blob), transferId);
		const stream = blobsInFlight.get(streamKey);
		if (stream?.connectedToBlob) return;
		if (!stream) {
			skippedBlobIds.set(streamKey, Date.now());
			return;
		}
		if (stream.writableEnded) {
			blobsInFlight.delete(streamKey);
			unregisterBlobReceiveInFlight(stream.fileId, auditStore?.rootStore);
			return;
		}
		skippedBlobIds.set(streamKey, Date.now());
		stream.destroy?.();
	}

	/**
	 * Stamp the receive-side liveness signals for a record we just processed — including one we skipped,
	 * which is still proof the link is delivering. Callers must have refreshed `replicationSharedStatus`
	 * (getSharedStatus()) first.
	 */
	function noteReceiveLiveness() {
		replicationSharedStatus[RECEIVED_TIME_POSITION] = Date.now();
		replicationSharedStatus[RECEIVING_STATUS_POSITION] = RECEIVING_STATUS_RECEIVING;
		if (options.connection?.nodeSubscriptions !== undefined) {
			replicationSharedStatus[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
			replicationSharedStatus[LAST_LIVENESS_TIME_POSITION] = replicationSharedStatus[RECEIVED_TIME_POSITION];
		}
	}

	const receiveQueue = createReceiveQueueGate(RECEIVE_QUEUE_HIGH_WATER_MARK);
	const receiveQueueWarnThrottle = createThrottleState();
	ws.on('message', (body: Buffer) => {
		// Reset the receive watchdog synchronously on every frame — async processing below may
		// take a long time and we want a single late frame to count as proof of life immediately.
		resetPingTimer();
		const queuedBytes = body.byteLength;
		const processThenSettle = async () => {
			try {
				if (!wsClosed) await onWSMessage(body);
			} finally {
				try {
					// A settled frame is consumer progress made WHILE the socket is paused — tick it or the
					// pause-stall watchdog reads a draining queue as a dead leg (#466).
					consumerProgress++;
					if (receiveQueue.settle(queuedBytes)) removePauseReason();
				} catch (error) {
					// Nothing handles the tail of `messageProcessing`, so a throw here would surface as an
					// unhandled rejection with the pause refcount half-updated.
					logger.error?.(connectionId, 'Error settling inbound frame accounting', error);
				}
			}
		};
		// Enqueue BEFORE the gate: a throw between arrival and enqueue (a logger fault, say) would drop
		// this frame while later frames kept applying and confirming higher sequence ids — the silent
		// receiver gap closeOnInboundMessageError exists to prevent (harper-pro#440).
		messageProcessing = messageProcessing.then(processThenSettle, processThenSettle);
		try {
			if (receiveQueue.admit(queuedBytes)) {
				addPauseReason();
				warnThrottled(receiveQueueWarnThrottle, 'Pausing replication receive: inbound frame queue over its budget', {
					database: databaseName,
					node: remoteNodeName,
					queuedBytes: receiveQueue.queuedBytes,
					queuedFrames: receiveQueue.queuedFrames,
					peakQueuedBytes: receiveQueue.peakQueuedBytes,
					peakQueuedFrames: receiveQueue.peakQueuedFrames,
					highWaterMark: RECEIVE_QUEUE_HIGH_WATER_MARK,
					maxFrames: receiveQueue.maxFrames,
				});
			}
		} catch (error) {
			logger.error?.(connectionId, 'Error applying inbound frame queue back-pressure', error);
		}
	});
	let authorizationFinished = false;
	function checkAuthorization(): boolean {
		authorizationFinished = true;
		if (!authorization) {
			logger.error?.(connectionId, 'No authorization provided');
			// don't send disconnect because we want the client to potentially retry
			close(1008, 'Unauthorized');
			return false;
		}
		return true;
	}
	/**
	 * Resolve `tableSubscriptionToReplicator` before the receive path delivers to it. Until
	 * `Replicator.subscribe()` registers this database's queue on this thread, it is the unresolved
	 * placeholder Promise, and `.send()` on a Promise throws `<x>.send is not a function` — which the outer
	 * catch logged once per inbound message while dropping every record in it (harper-pro#622).
	 *
	 * Awaiting here is safe and order-preserving: ws messages are serialized through `messageProcessing`.
	 * It must NOT be awaited ahead of the handshake commands, though — NODE_NAME/DB_SCHEMA are what create
	 * the tables whose registration resolves the placeholder, so blocking them would deadlock a bootstrap.
	 *
	 * Returns false (after closing for a backoff retry) if the subscription never resolved; the caller must
	 * then abandon the message rather than fall through to a `.send()`.
	 */
	async function whenSubscriptionResolved(): Promise<boolean> {
		if (tableSubscriptionToReplicator?.retired)
			tableSubscriptionToReplicator = subscriptionForConnection(
				tableSubscriptionToReplicator,
				databaseName,
				dbSubscriptions
			);
		if (!tableSubscriptionToReplicator?.then) return true;
		// Socket intake is paused for the duration of the wait — see awaitPendingSubscription. Liveness while
		// paused belongs to the pause-stall watchdog, whose threshold is floored above
		// SUBSCRIPTION_RESOLVE_TIMEOUT so it can never pre-empt this wait.
		const resolved = await awaitPendingSubscription(tableSubscriptionToReplicator, SUBSCRIPTION_RESOLVE_TIMEOUT, {
			pause: addPauseReason,
			resume: removePauseReason,
		});
		if (!resolved?.send) {
			// A timeout (`undefined`) leaves the placeholder pending: settle it, or the peer's retry stacks
			// another waiter on the same promise (see expirePendingDatabaseSubscription).
			if (!resolved) expirePendingDatabaseSubscription(databaseName, tableSubscriptionToReplicator, dbSubscriptions);
			logger.error?.(
				connectionId,
				`No local subscription registered for database ${databaseName} after ${SUBSCRIPTION_RESOLVE_TIMEOUT}ms; closing so replication resumes from the last durable cursor`
			);
			// 1011 (internal error), no `finish`: same transient-close semantics as an inbound message error,
			// so the normal retry path reconnects with backoff and re-streams from the durable cursor.
			close(1011, `No local subscription registered for database ${databaseName}`);
			return false;
		}
		tableSubscriptionToReplicator = resolved;
		auditStore ??= resolved.auditStore;
		return true;
	}
	async function onWSMessage(body: Buffer): Promise<void> {
		if (!authorizationFinished) {
			if (authorization?.then) {
				try {
					authorization = await authorization;
				} catch (error) {
					authorizationFinished = true;
					logger.error?.(connectionId, 'Authorization failed', error);
					// don't send disconnect because we want the client to potentially retry
					close(1008, 'Unauthorized');
					return;
				}
				if (!checkAuthorization()) return;
			} else if (!checkAuthorization()) {
				return;
			}
			// fall through to handle this message now that authorization succeeded
		}
		if (!authorization) return;
		// A replication header should begin with either a transaction timestamp or messagepack message of
		// of an array that begins with the command code
		lastMessageTime = performance.now();
		try {
			const decoder = ((body as any).dataView = new Decoder(body.buffer, body.byteOffset, body.byteLength));
			if (body[0] > 127) {
				// not a transaction, special message
				const message = decode(body);
				const [command, data, tableId] = message;
				switch (command) {
					case NODE_NAME: {
						if (data) {
							const setupCapability = resolveSubscriptionSetupCapability(
								message[4],
								SUBSCRIPTION_SETUP_TIMEOUT_MS,
								!(TEST_SUBSCRIPTION_SETUP_TIMEOUT_MS > 0)
							);
							peerSupportsSubscriptionSetupAck = setupCapability.supported;
							subscriptionSetupTimeoutMs = setupCapability.timeoutMs;
							// this is the node name
							if (remoteNodeName) {
								if (remoteNodeName !== data) {
									logger.error?.(
										connectionId,
										`Node name mismatch, expecting to connect to ${remoteNodeName}, but peer reported name as ${data}, disconnecting`
									);
									ws.send(encode([DISCONNECT]));
									close(1008, 'Node name mismatch');
									return;
								}
							} else {
								remoteNodeName = data;
								if (options.connection?.tentativeNode) {
									// if this was a tentative node, we need to update the node name
									const nodeToAdd = options.connection.tentativeNode;
									nodeToAdd.name = remoteNodeName;
									options.connection.tentativeNode = null;
									ensureNode(remoteNodeName, nodeToAdd);
								}
							}
							if (options.connection) options.connection.nodeName = remoteNodeName;
							// Mark the link connected as soon as the handshake identifies the peer, so the main thread's
							// connection truth (W1 / #431) reflects an established-but-idle link immediately rather than
							// waiting for the first post-handshake pong up to a ping interval later — otherwise a
							// reconnected idle link reads as connected:false until then (replicationReconnect tests).
							const handshakeStatus = getSharedStatus();
							if (handshakeStatus && options.connection?.nodeSubscriptions !== undefined) {
								handshakeStatus[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
								handshakeStatus[LAST_LIVENESS_TIME_POSITION] = Date.now();
							}
							//const url = message[3] ?? thisNodeUrl;
							logger.debug?.(connectionId, 'received node name:', remoteNodeName, 'db:', databaseName ?? message[2]);
							if (!databaseName) {
								// this means we are the server
								try {
									setDatabase((databaseName = message[2]));
									if (databaseName === 'system') {
										schemaUpdateListener = forEachReplicatedDatabase(options, (database, databaseName) => {
											if (checkDatabaseAccess(databaseName)) sendDBSchema(databaseName);
										});
										// onWSMessage is async, so the WS may have already closed by the time we get
										// here — in that case 'close' has fired and adding the cleanup listener now
										// would silently leak. Drop the registration immediately.
										if (wsClosed) {
											schemaUpdateListener.remove();
											schemaUpdateListener = undefined;
										} else {
											ws.on('close', () => {
												schemaUpdateListener?.remove();
											});
										}
									}
								} catch (error) {
									// if this fails, we should close the connection and indicate that we should not reconnect
									logger.warn?.(connectionId, 'Error setting database', error);
									ws.send(encode([DISCONNECT]));
									close(1008, error.message);
									return;
								}
							}
							sendSubscriptionRequestUpdate();
						}
						break;
					}
					case DB_SCHEMA: {
						if (
							isSubscriptionSetupProgressFrame(
								command,
								databaseName,
								message[2],
								pendingSubscriptionSetupRequestId,
								message[3]
							)
						) {
							pendingSubscriptionSetupRequestId = undefined;
							subscriptionSetupWatchdog?.complete();
						}
						logger.debug?.(
							connectionId,
							'Received table definitions for',
							data.map((t) => t.table)
						);
						for (const tableDefinition of data) {
							const newDatabaseName = message[2];
							tableDefinition.database = newDatabaseName;
							let table: any;
							if (checkDatabaseAccess(newDatabaseName)) {
								if (databaseName === 'system') {
									// the system connection allows us to create new databases (which wouldn't otherwise have an existing connection)
									if (!databases[newDatabaseName]?.[tableDefinition.table]) {
										table = ensureTableIfChanged(tableDefinition, databases[newDatabaseName]?.[tableDefinition.table]);
									}
								} else {
									// a database connection is not allowed to create new databases, so we need to check if the database exists
									if (newDatabaseName !== 'data' && !databases[newDatabaseName]) {
										logger.warn?.('Database not found', newDatabaseName);
										return;
									}
									table = ensureTableIfChanged(tableDefinition, databases[newDatabaseName]?.[tableDefinition.table]);
								}
								if (!auditStore) auditStore = table?.auditStore;
								if (!tables) tables = getDatabases()?.[newDatabaseName];
							}
						}
						break;
					}
					case DISCONNECT:
						close();
						break;
					case OPERATION_REQUEST:
						try {
							const isAuthorizedNode = authorization?.replicates || authorization?.subscribers || authorization?.name;
							// data may carry a secret (registry token / ssh key / password); redact before
							// logging. The conditional logger skips arg evaluation when debug is inactive.
							logger.debug?.('Received operation request', redactOperationForLog(data), 'from', remoteNodeName);
							server.operation(data, { user: authorization }, !isAuthorizedNode).then(
								async (response) => {
									try {
										logger.debug?.('Requested request from finished', remoteNodeName, response);
										// Drain streaming responses (e.g. get_analytics) into a concrete value so this
										// single replication message can be encoded — see materializeOperationResponse.
										response = await materializeOperationResponse(response);
										response.requestId = data.requestId;
										ws.send(encode([OPERATION_RESPONSE, response]));
									} catch (error) {
										logger.debug?.('Failed encoding operation response for', remoteNodeName, error);
										ws.send(
											encode([
												OPERATION_RESPONSE,
												{
													requestId: data.requestId,
													error: errorToString(error),
												},
											])
										);
									}
								},
								(error) => {
									logger.debug?.('Failed requested operation from', remoteNodeName, error);
									ws.send(
										encode([
											OPERATION_RESPONSE,
											{
												requestId: data.requestId,
												error: errorToString(error),
											},
										])
									);
								}
							);
						} catch (error) {
							ws.send(
								encode([
									OPERATION_RESPONSE,
									{
										requestId: data.requestId,
										error: errorToString(error),
									},
								])
							);
						}
						break;
					case OPERATION_RESPONSE:
						const { resolve, reject } = awaitingResponse.get(data.requestId);
						logger.debug?.('Received completed operation request', remoteNodeName, data);
						if (data.error) reject(new Error(data.error));
						else resolve(data);
						awaitingResponse.delete(data.requestId);
						break;
					case TABLE_FIXED_STRUCTURE:
						const tableName = message[3];
						if (!tables) {
							if (databaseName) logger.error?.(connectionId, 'No database found for', databaseName);
							else logger.error?.(connectionId, 'Database name never received');
							close();
							return;
						}
						let table = tables[tableName];
						table = ensureTableIfChanged(
							{
								table: tableName,
								database: databaseName,
								attributes: data.attributes,
								schemaDefined: data.schemaDefined,
							},
							table
						);
						// replication messages come across in binary format of audit log entries from the source node,
						// so we need to have the same structure and decoder configuration to decode them. We keep a map
						// of the table id to the decoder so we can decode the binary data for each table.
						tableDecoders[tableId] = {
							name: tableName,
							decoder: new StructonPackr({
								useBigIntExtension: true,
								freezeData: true,
								typedStructs: data.typedStructs,
								structures: data.structures,
							} as any),
							getEntry(id) {
								return table.primaryStore.getEntry(id);
							},
							rootStore: table.primaryStore.rootStore,
						};
						break;
					case NODE_NAME_TO_ID_MAP:
						// this is the mapping of node names to short local ids. if there is no auditStore (yet), just make an empty map, but not sure why that would happen.
						remoteShortIdToLocalId = auditStore ? remoteToLocalNodeId(data, auditStore) : new Map();
						receivingDataFromNodeNames = message[2];
						logger.debug?.(
							connectionId,
							`Acknowledged subscription request, receiving messages for nodes: ${receivingDataFromNodeNames}`
						);
						break;
					case RESIDENCY_LIST:
						// we need to keep track of the remote node's residency list by id
						const residencyId = tableId;
						receivedResidencyLists[residencyId] = data;
						break;
					case COMMITTED_UPDATE:
						// we need to record the sequence number that the remote node has received
						getSharedStatus()[CONFIRMATION_STATUS_POSITION] = data;
						logger.info?.(
							connectionId,
							'received and broadcasting committed update',
							data,
							'from',
							databaseName,
							remoteNodeName
						);
						recordAction(
							body.length,
							'bytes-received',
							`${remoteNodeName}.${databaseName}`,
							'replication',
							'committed-update'
						);
						(getSharedStatus().buffer as any).notify();
						break;
					case COPY_START: {
						// the leader is (re)starting a bulk copy; track a resume cursor for it
						const copyWasAlreadyActive = inCopyMode;
						if (copyWasAlreadyActive) sawCopyRestart = true;
						repairWindowMissRunByNode.clear();
						inCopyMode = true;
						if (!copyWasAlreadyActive) subscriptionSetupWatchdog?.pause();
						pendingCopyCursor = null; // discard any cursor staged by a prior copy on this connection
						// A prior pass's staged cursors (and its in-flight persists — see passAtPersist) must not
						// be persisted under this pass: they claim delivery this pass's walk has not made (#699).
						copyWatermark.beginPass();
						// A COPY_COMPLETE from the prior pass must not finalize this one: with the flag left set,
						// the first commit/blob drain that found nothing outstanding would remove the cursor and
						// exit copy mode mid-walk, advertising a partial copy as caught-up.
						copyCompleteReceived = false;
						copiedTablesThisPass.clear(); // reset per-pass reload-marker tracking (harper-pro#495)
						copyBytesSinceFlush = 0; // reset the copy-apply flush gate for this (re)start (harper-pro#480)
						lastCopyFlushTime = performance.now();
						// The byte watchdog was already (re)armed for THIS frame back in the synchronous
						// ws.on('message') handler — before inCopyMode flipped — so it is still sized to
						// PING_TIMEOUT. Re-arm it now that we're in copy mode so it picks up the wider
						// COPY_TIMEOUT; otherwise a sender that goes silent immediately after COPY_START would
						// trip the ping timeout and reconnect, the exact starvation loop #460 avoids. stop()
						// first so the per-frame reset() throttle can't swallow this transition re-arm.
						receiveWatchdog?.stop();
						receiveWatchdog?.reset();
						noteCopyProgress(); // COPY_START is itself copy progress; arm the watchdog (#453)
						// Test-only: turn this instance into a leaked, silent leg now that the copy-progress
						// watchdog is armed — reproduces the stale-fire class the identity guard suppresses.
						if (maybeLeakConnectionAfterCopyStartForTest(options.connection, ws, databaseName)) wedgedForTest = true;
						copyModeStartTime = data; // copyStartTime anchor chosen by the leader
						// Copy-order version (message[2]); undefined from a pre-versioning leader. Persisted in the
						// cursor and echoed back so a future leader can reject a cursor built under a different order. (#421)
						copyModeOrderVersion = message[2];
						copyFromNodeId = getIdOfRemoteNode(remoteNodeName, auditStore);
						const cloneAttempt = process.env.HARPER_CLONE_ATTEMPT;
						const sharedStatus = getSharedStatus();
						if (cloneAttempt && sharedStatus) sharedStatus[RECEIVED_VERSION_POSITION] = 0;
						if (cloneAttempt && copyFromNodeId !== undefined) {
							try {
								getDatabaseStores().dbisDB?.remove([Symbol.for('cloneCopyComplete'), copyFromNodeId]);
							} catch (error) {
								closeOnInboundMessageError(error, {
									connectionId,
									logger,
									markInboundClosed: () => (wsClosed = true),
									close,
								});
								return;
							}
						}
						logger.debug?.(connectionId, 'bulk copy starting from', remoteNodeName, new Date(copyModeStartTime));
						break;
					}
					case COPY_COMPLETE:
						// Copy signalled complete. Stay in copy mode so batches still committing keep advancing the
						// cursor; maybeFinishCopy exits copy mode and clears the cursor once those commits drain.
						copyCompleteReceived = true;
						// No more copy frames will arrive, so stop watching for copy-progress stalls now rather
						// than leaving the timer to wake the event loop until the commit drain finishes (#453).
						copyProgressWatchdog?.stop();
						copyCompleteAt = performance.now();
						maybeFinishCopy();
						if (inCopyMode) copyFinalizeWatchdog?.reset();
						logger.debug?.(connectionId, 'bulk copy complete from', remoteNodeName);
						break;
					case SEQUENCE_ID_UPDATE:
						// we need to record the sequence number that the remote node has received
						lastSequenceIdReceived = data;
						// The resume cursor is persisted by the subscription queue, so this needs the resolved
						// subscription just like the record path below (harper-pro#622).
						if (!(await whenSubscriptionResolved())) return;
						// Clamp: a sequence-id update carries no commit/blob-durability gate, so while any blob is not
						// yet durable it must not push the resume cursor past the last fully-durable point (same as the
						// inline REMOTE_SEQUENCE_UPDATE branch below). seqUpdateEndTxn also gates copy-apply durability.
						tableSubscriptionToReplicator.send(
							seqUpdateEndTxn(cursorBlockedByBlob() ? lastDurableSequenceId : lastSequenceIdReceived)
						);
						getSharedStatus();
						replicationSharedStatus[RECEIVED_VERSION_POSITION] = Math.max(
							// ensure monotonicity
							lastSequenceIdReceived,
							replicationSharedStatus[RECEIVED_VERSION_POSITION]
						);

						replicationSharedStatus[RECEIVED_TIME_POSITION] = Date.now();
						replicationSharedStatus[RECEIVING_STATUS_POSITION] = RECEIVING_STATUS_WAITING;
						break;
					case BLOB_CHUNK: {
						if (inCopyMode) noteCopyProgress(); // copy blob chunk arriving — the copy is advancing (#453)
						// this is a blob chunk, we need to write it to the blob store
						const blobInfo = message[1];
						const { fileId, transferId, size, finished, error, errorCode, errorStatus } = blobInfo;
						const streamKey = getBlobTransferKey(fileId, transferId);
						let stream = blobsInFlight.get(streamKey);
						logger.debug?.(
							'Received blob',
							fileId,
							'has stream',
							!!stream,
							'connectedToBlob',
							!!stream?.connectedToBlob,
							'length',
							message[2].length,
							'finished',
							finished
						);

						if (skippedBlobIds.has(streamKey)) {
							// Every record referencing these bytes was skipped as an identity tie, so nothing will
							// attach a consumer. Drop the chunk rather than let it open (or feed) a reader-less
							// stream holding the whole blob until the timeout sweep. The final chunk retires the
							// tombstone and any stream/lock the blob had taken before the record arrived.
							skippedBlobIds.set(streamKey, Date.now());
							if (finished) {
								skippedBlobIds.delete(streamKey);
								if (blobsInFlight.delete(streamKey)) unregisterBlobReceiveInFlight(fileId, auditStore?.rootStore);
							}
							break;
						}
						if (!stream) {
							stream = createBlobReceiveStream(blobTimeout);
							stream.fileId = fileId;
							stream.expectedSize = size;
							blobsInFlight.set(streamKey, stream);
							registerBlobReceiveInFlight(fileId, auditStore?.rootStore);
						}
						if (size !== undefined) stream.expectedSize = size;
						stream.lastChunk = Date.now();
						const blobBody = message[2];
						recordAction(
							blobBody.byteLength,
							'bytes-received',
							`${remoteNodeName}.${databaseName}`,
							'replication',
							'blob'
						);
						try {
							if (finished) {
								if (error) {
									// the stream already carries a no-op 'error' listener from createBlobReceiveStream
									const blobError = new Error(
										'Blob error: ' + error + ' for record ' + (stream.recordId ?? 'unknown') + ' from ' + remoteNodeName
									);
									// A PERMANENT source failure — the blob is gone (ENOENT/404) or confidently
									// corrupt/incomplete (500, harper-pro#429) at the origin — is unrecoverable:
									// re-streaming reproduces it, so the save `.catch` advances the resume cursor past
									// it instead of holding forever (harper-pro#403). A transient source read fault
									// (EIO, EMFILE, timeout, 503 write-in-progress) is left UNMARKED so the receiver
									// holds the gap and a reconnect retries. An older sender that sends neither
									// `errorCode` nor `errorStatus` also stays unmarked — the safe (hold) default for a
									// mixed-version cluster. A 503 additionally carries its status so the save `.catch`
									// can charge the cross-reconnect escalation budget (harper-pro#432).
									if (isPermanentSourceBlobErrorCode(errorCode, errorStatus)) markSourceBlobUnavailable(blobError);
									else markSourceBlobStatus(blobError, errorStatus);
									stream.destroy(blobError);
								} else if (stream.destroyed || stream.writableEnded) {
									// The stream was torn down mid-blob and intentionally left in blobsInFlight
									// (see the destroyed branch below) so intervening chunks were dropped rather
									// than recreating a reader-less stream. Now that the blob is complete it will
									// never connect to a record — forget it instead of writing to a dead stream.
									blobsInFlight.delete(streamKey);
									unregisterBlobReceiveInFlight(stream.fileId, auditStore?.rootStore);
								} else stream.end(blobBody);
								if (stream.connectedToBlob) blobsInFlight.delete(streamKey);
							} else if (stream.destroyed || stream.writableEnded) {
								// The stream was already torn down before this mid-blob chunk arrived —
								// typically because saveBlob's pipeline failed (e.g. ENOENT on
								// createWriteStream) and destroyed the PassThrough source, firing 'close'.
								// We must NOT fall into the backpressure branch below: writing to a dead
								// stream returns false, and pausing to wait for a 'drain'/'close' that has
								// already fired strands the pause reason forever, wedging the entire
								// receive loop (observed in prod: receiver goes silent, sender stuck
								// reconnecting, replication never recovers). Drop the orphaned chunk.
								// Deliberately keep the dead stream in blobsInFlight: deleting it here would
								// make the next chunk for this fileId recreate a fresh, reader-less PassThrough
								// that backpressures and re-wedges the WS. Holding the destroyed stream routes
								// every subsequent chunk back through this branch (dropped), and it is removed
								// when the final chunk arrives (above) or by the blobsTimer timeout sweep.
							} else if (!stream.write(blobBody)) {
								// The PassThrough's internal queue is over its HWM, meaning the downstream
								// file write (via pipeline in saveBlob) can't keep up. Pause the WS until the
								// stream drains so blob chunks don't accumulate in memory faster than they
								// can be flushed to disk.
								if (stream.destroyed || stream.writableEnded) {
									// write() itself may have torn the stream down (e.g. a late error). If so,
									// 'drain'/'close' won't arrive — skip pausing rather than strand the reason.
									// Keep the dead stream in blobsInFlight for the same reason as above.
								} else if (!stream.connectedToBlob) {
									// No consumer is attached yet: the blob's chunks have outrun its record, so
									// saveBlob — the only thing that drains this PassThrough — has not started
									// (receiveBlobs sets connectedToBlob when the record is decoded). Pausing here
									// would block the very record that attaches the consumer behind the pause,
									// stranding it forever (the same wedge class as the destroyed/ended guard above,
									// but for a not-yet-connected stream — the base-copy receive deadlock). Let the
									// chunk buffer instead; saveBlob attaches and drains it once the record arrives.
									// Exposure is bounded by the sender's in-flight blob cap
									// (MAX_OUTSTANDING_BLOBS_BEING_SENT) and the blobsTimer reclaims a truly orphaned stream.
								} else {
									addPauseReason();
									const release = () => {
										stream.off('drain', release);
										stream.off('close', release);
										// Consumer-progress tick for pauseStallWatchdog: the blob's buffered bytes drained to
										// disk — progress that survives the pause even if another reason keeps the socket
										// paused after this one clears (harper-pro#466).
										consumerProgress++;
										removePauseReason();
									};
									stream.on('drain', release);
									stream.on('close', release);
								}
							}
						} catch (error) {
							logger.error?.(
								`Error receiving blob for ${stream.recordId} from ${remoteNodeName} and streaming to storage`,
								error
							);
							blobsInFlight.delete(streamKey);
							if (!stream.connectedToBlob) unregisterBlobReceiveInFlight(stream.fileId, auditStore?.rootStore);
						}
						break;
					}
					case GET_RECORD: {
						// this is a request for a record, we need to send it back
						const requestId = data;
						let responseData: Buffer;
						try {
							const recordId = message[3];
							const table = remoteTableById[tableId] || (remoteTableById[tableId] = tables[message[4]]);
							if (!table) {
								return logger.warn?.('Unknown table id trying to handle record request', tableId);
							}
							// we are sending raw binary data back, so we have to send the typed structure information so the
							// receiving side can properly decode it. We only need to send this once until it changes again, so we can check if the structure
							// has changed. It will only grow, so we can just check the length.
							const structuresBinary = table.primaryStore.getBinaryFast(Symbol.for('structures'));
							const structureLength = structuresBinary?.length ?? 0;
							if (structureLength > 0 && structureLength !== lastStructureLength) {
								lastStructureLength = structureLength;
								const structure = decode(structuresBinary);
								ws.send(
									encode([
										TABLE_FIXED_STRUCTURE,
										{
											typedStructs: structure.typed,
											structures: structure.named,
										},
										tableId,
										table.tableName,
									])
								);
							}
							// we might want to prefetch here
							const binaryEntry = table.primaryStore.getBinaryFast(recordId);
							if (binaryEntry) {
								let valueBuffer = table.primaryStore.decoder.decode(binaryEntry, { valueAsBuffer: true });
								const entry: any = lastMetadata || {};
								// getLastVersion() reads lmdb-native thread-local state that doesn't exist for a
								// RocksDB store — calling it there throws, silently failing every on-demand record
								// fetch (GET_RECORD) on RocksDB. Only call it on LMDB. On RocksDB the version is carried
								// inline on the decoded metadata: when the record has a metadata prefix the decoder
								// returns that metadata object (=== lastMetadata, value bytes under `.value`, version
								// already on `entry`); when it doesn't, `valueBuffer` is the plain value buffer and the
								// version isn't available here (left undefined) — never fall through to getLastVersion().
								if (table.primaryStore.decoder.isRocksDB) {
									if (valueBuffer === lastMetadata && lastMetadata != null) {
										valueBuffer = lastMetadata.value;
									}
								} else {
									entry.version = getLastVersion();
								}
								if (lastMetadata && lastMetadata[METADATA] & HAS_BLOBS) {
									// if there are blobs, we need to find them and send their contents
									// but first, the decoding process can destroy our buffer above, so we need to copy it
									valueBuffer = Buffer.from(valueBuffer);
									decodeWithBlobCallback(
										() => table.primaryStore.decoder.decode(binaryEntry),
										(blob) => sendBlobs(blob, recordId),
										table.primaryStore.rootStore
									);
								}
								responseData = encode([
									GET_RECORD_RESPONSE,
									requestId,
									{
										value: valueBuffer,
										expiresAt: entry.expiresAt,
										version: entry.version,
										residencyId: entry.residencyId,
										nodeId: entry.nodeId,
										user: entry.user,
									},
								]);
							} else {
								responseData = encode([GET_RECORD_RESPONSE, requestId]);
							}
						} catch (error) {
							responseData = encode([
								GET_RECORD_RESPONSE,
								requestId,
								{
									error: error.message,
								},
							]);
						}
						ws.send(responseData);
						break;
					}
					case GET_RECORD_RESPONSE: {
						// this is a response to a record request, we need to resolve the promise
						const { resolve, reject, tableId, key } = awaitingResponse.get(message[1]);
						const entry = message[2];
						if (entry?.error) reject(new Error(entry.error));
						else if (entry) {
							let blobsToDelete: any[];
							decodeBlobsWithWrites(
								() => {
									const record = tableDecoders[tableId].decoder.decode(entry.value);
									entry.value = record;
									entry.key = key;
									if (!resolve(entry)) {
										// if it was not moved locally, clean up any blobs that were written
										if (blobsToDelete) {
											// The blobs are asynchronously used, and it is very difficult to actually know
											// when they can be safely deleted (we might be able to use a WeakRef with CleanupRegistry).
											// For now, this should give us plenty of time and provide adequate cleanup measures
											setTimeout(() => blobsToDelete.forEach(deleteBlob), 60000).unref();
										}
									}
								},
								auditStore?.rootStore,
								(remoteBlob) => {
									const localBlob = receiveBlobs(remoteBlob, key, undefined, undefined, tableDecoders[tableId]?.name);
									// track the blobs that were written in case we need to delete them if the record is not moved locally
									if (!blobsToDelete) blobsToDelete = [];
									blobsToDelete.push(localBlob);
									return localBlob;
								}
							);
						} else resolve();
						awaitingResponse.delete(message[1]);
						break;
					}
					case SUBSCRIPTION_UPDATE: {
						// Handle dynamic updates to subscription exclusion list
						const nodesToExclude = data?.excludeNodes || [];
						const nodesToInclude = data?.includeNodes || [];

						logger.debug?.(
							connectionId,
							'received subscription update, excluding:',
							nodesToExclude,
							'including:',
							nodesToInclude
						);

						if (!excludedNodes) excludedNodes = [];

						// Add new excluded nodes (remove their logs from the iterator)
						for (const nodeName of nodesToExclude) {
							if (!excludedNodes.includes(nodeName)) {
								excludedNodes.push(nodeName);
								// Update the subscribedNodeIds to mark this node as excluded
								if (auditStore && subscribedNodeIds) {
									const localId = getIdOfRemoteNode(nodeName, auditStore);
									subscribedNodeIds[localId] = false;
								}
								// Remove this log from the iterator
								auditLogIterable?.removeLog?.(nodeName);
								logger.debug?.(connectionId, 'removed log from iterator:', nodeName);
							}
						}

						// Remove nodes from exclusion list (add their logs to the iterator)
						for (const nodeName of nodesToInclude) {
							const index = excludedNodes.indexOf(nodeName);
							if (index !== -1) {
								excludedNodes.splice(index, 1);
								// Update the subscribedNodeIds to remove the exclusion
								if (auditStore && subscribedNodeIds) {
									const localId = getIdOfRemoteNode(nodeName, auditStore);
									delete subscribedNodeIds[localId];
								}
								// Add this log back to the iterator
								auditLogIterable?.addLog(nodeName);
								logger.debug?.(connectionId, 'added log to iterator:', nodeName);
							}
						}

						break;
					}
					case SUBSCRIPTION_REQUEST: {
						nodeSubscriptions = data;
						excludedNodes = message[2]; // use the third argument for exclusion list
						const subscriptionSetupRequestId = message[3];
						// permission check to make sure that this node is allowed to subscribe to this database, that is that
						// we have publish permission for this node/database
						let subscriptionToHdbNodes, whenSubscribedToHdbNodes;
						let sentNodeIds = new Set<number>();
						let closed = false;
						// dbSubscriptions, not the module-level map: that is the map Replicator.subscribe() resolves
						// from for this connection, so writing anywhere else would leave a placeholder pending forever.
						tableSubscriptionToReplicator = subscriptionForConnection(
							tableSubscriptionToReplicator,
							databaseName,
							dbSubscriptions
						);
						if (!tableSubscriptionToReplicator.then && databaseName !== tableSubscriptionToReplicator.databaseName) {
							logger.error?.(
								'Subscription request for wrong database',
								databaseName,
								tableSubscriptionToReplicator.databaseName
							);
							return;
						}
						logger.debug?.(connectionId, 'received subscription request for', databaseName, 'at', nodeSubscriptions);
						if (tableSubscriptionToReplicator.then)
							logger.debug?.('Waiting for subscription to database ' + databaseName);
						// Local config-route directionality for this peer, resolved once and reused by the send
						// authority gate below and the send-side excludeTables further down. harper-pro#498.
						const sendRoute = getConfigRouteReplicates(options, remoteNodeName);
						const sendRouteDirectional = sendRoute && typeof sendRoute === 'object' ? sendRoute : undefined;
						if (authorization.name) {
							// Send authority (do WE send to this subscriber for this database). A directional config
							// route (the controlled-flow object form) is authoritative — unlike the receive path, the
							// server-side handler has no subscription payload to read routeReplicates from, but it does
							// have the raw replication `options` (with routes). A boolean/subscriptions-only route yields
							// undefined here and keeps the existing dynamic hdb_nodes path. harper-pro#498.
							const configSendDecision = sendRouteDirectional
								? !!(
										sendRouteDirectional.sends ||
										routeEntriesIncludePeer(sendRouteDirectional.sendsTo, remoteNodeName, databaseName)
									)
								: undefined;
							if (configSendDecision === false) {
								// Our config route to this peer does not authorize sending to them for this database;
								// reject up front rather than optimistically wiring up the send path.
								closed = true;
								close(1008, `Unauthorized database subscription to ${databaseName}`);
								return;
							}
							// configSendDecision === true → the config route is authoritative (and static until reload),
							// so skip the hdb_nodes auth watch entirely. Only when there is no directional config route
							// (undefined) do we watch the subscriber's hdb_nodes record for dynamic (de)authorization.
							if (configSendDecision === undefined) {
								whenSubscribedToHdbNodes =
									maybeStallSubscriptionSetupForTest(databaseName) ?? getHDBNodeTable().subscribe(authorization.name);
								whenSubscribedToHdbNodes
									.then(async (subscription) => {
										// The setup wait below is bounded. If it timed out and closed this socket before this
										// promise resolved, retire the late subscription instead of leaking a global hdb_nodes
										// listener past the close event.
										if (closed || wsClosed) {
											subscription?.end();
											return;
										}
										subscriptionToHdbNodes = subscription;
										for await (const event of subscriptionToHdbNodes) {
											const shouldClose = await shouldCloseSendAuthWatch(event, authorization.name, databaseName, {
												isClosed: () => closed,
												onReprobeTimeout: () =>
													logger.warn?.(
														connectionId,
														`hdb_nodes row for ${authorization.name} did not decode within ${SEND_AUTH_REPROBE_ATTEMPTS * SEND_AUTH_REPROBE_INTERVAL_MS}ms; failing closed so a revocation carried by an undecodable write cannot be missed`
													),
											});
											if (shouldClose) {
												logger.warn?.(
													connectionId,
													`hdb_nodes no longer authorizes ${authorization.name} to receive ${databaseName}; closing the subscription`
												);
												closed = true;
												close(1008, `Unauthorized database subscription to ${databaseName}`);
												return;
											}
										}
										if (!closed && !wsClosed) {
											closed = true;
											close(1011, `Replication authorization watch ended for ${databaseName}`);
										}
									})
									.catch((error) => {
										logger.error?.(connectionId, 'Error subscribing to HDB nodes', error);
										// This catch also receives a throw from the watch loop itself, after the subscription
										// resolved. Logging alone would leave the replay loop running with no live
										// authorization watcher, so a later revocation would go unobserved: fail closed and
										// let the retry rebuild the watch.
										if (!closed && !wsClosed) {
											closed = true;
											close(1011, `Replication authorization watch failed for ${databaseName}`);
										}
									});
							}
						} else if (!(authorization?.role?.permission?.super_user || authorization.replicates)) {
							ws.send(encode([DISCONNECT]));
							close(1008, `Unauthorized database subscription to ${databaseName}`);
							return;
						}

						if (auditSubscription) {
							// any subscription will supersede the previous subscription, so end that one
							logger.debug?.(connectionId, 'stopping previous subscription', databaseName);
							auditSubscription.emit('close');
						}
						if (nodeSubscriptions.length === 0)
							// this means we are unsubscribing
							return;
						const firstNode = nodeSubscriptions[0];
						const tableToTableEntry = (table) => {
							if (
								table &&
								(firstNode.replicateByDefault
									? !firstNode.tables.includes(table.tableName)
									: firstNode.tables.includes(table.tableName))
							) {
								return { table };
							}
						};
						const currentTransaction = { txnLogKey: 0 };
						let tableById;
						let currentSequenceId = Infinity; // the last sequence number in the audit log that we have processed, set this with a finite number from the subscriptions
						let sentSequenceId; // the last sequence number we have sent
						// Tables excluded from outgoing replication to this peer+database. Prefer this node's
						// config-route sendsTo (the `sendRoute` resolved above), falling back to the peer's hdb_nodes
						// authorization.replicates.sendsTo for add_node-configured peers. Previously this read only
						// hdb_nodes, so config-route excludeTables never applied on the send side. harper-pro#498.
						const sendsToForExclusions = sendRouteDirectional?.sendsTo
							? sendRouteDirectional.sendsTo
							: authorization?.replicates && typeof authorization.replicates === 'object'
								? authorization.replicates.sendsTo
								: undefined;
						const sendExcludedTables = getExcludedTablesForRouteEntries(
							sendsToForExclusions,
							remoteNodeName,
							databaseName
						);
						const sendAuditRecord = (auditRecord, cursor, subscriptionNodeId = auditRecord.nodeId) => {
							if (auditRecord.type === 'end_txn') {
								if (currentTransaction.txnLogKey) {
									if (frame.encodingBuffer[frame.encodingStart] !== 66) {
										logger.error?.(
											new Error('Invalid encoding of message to'),
											remoteNodeName,
											databaseName,
											frame.encodingBuffer
										);
									}
									frame.writeInt(9); // replication message of nine bytes long
									frame.writeInt(REMOTE_SEQUENCE_UPDATE); // action id
									frame.writeFloat64((sentSequenceId = cursor)); // send the log key so we know what sequence number to start from next time.
									sendQueuedData();
								}
								frame.encodingStart = frame.position;
								currentTransaction.txnLogKey = 0;
								return; // end of transaction, nothing more to do
							}
							// Local-only records (e.g. a v4 bridge peer's hdb_nodes row) are never forwarded to
							// peers. The flag rides the audit entry's extendedType, so this is a pure bitmask test
							// on an already-decoded integer — no record value decode is added to the send path.
							if (auditRecord.extendedType & LOCAL_ONLY) {
								return skipAuditRecord();
							}
							const nodeId = auditRecord.nodeId;
							const tableId = auditRecord.tableId;
							let tableEntry = tableById[tableId];
							if (!tableEntry) {
								tableEntry = tableById[tableId] = tableToTableEntry(tableSubscriptionToReplicator.tableById[tableId]);
								if (!tableEntry) {
									// Must yield like every other skip path: a contiguous run of entries for a
									// table this peer doesn't subscribe to (or a dropped table, or corrupt-entry
									// sentinels with tableId undefined) otherwise iterates with await undefined,
									// which never leaves the microtask queue. Timers, I/O, and watchdogs starve
									// for the whole run, and the periodic sequence updates skipAuditRecord sends
									// never go out, so the peer's cursor can't advance past the run and every
									// reconnect rescans it from the start.
									logger.debug?.('Not subscribed to table', tableId);
									return skipAuditRecord();
								}
							}
							const table = tableEntry.table;
							if (sendExcludedTables?.has(table.tableName)) {
								return skipAuditRecord();
							}
							const primaryStore = table.primaryStore;
							const encoder = primaryStore.encoder;
							// Audit scans provide the canonical origin key; copy-walk records use the cursor supplied
							// by the primary-store iterator and pre-stage-0b producers fall back to the record version.
							const txnLogKey = auditRecord.txnLogKey ?? cursor ?? auditRecord.version;
							// Force a reload the first time this connection touches each table:
							// `primaryStore.encoder` is a process-wide singleton, so its typedStructs
							// may have been populated to a stale length by prior activity on this
							// thread, and this connection's initial TABLE_FIXED_STRUCTURE must reflect
							// what's actually in LMDB right now. After this, HAS_STRUCTURE_UPDATE on
							// subsequent audit records keeps the encoder in sync, since every
							// typed-struct addition produces a flagged audit record.
							if (
								!tableEntry.structuresLoaded ||
								auditRecord.extendedType & HAS_STRUCTURE_UPDATE ||
								!encoder.typedStructs ||
								auditRecord.structureVersion > encoder.typedStructs.length + encoder.structures.length
							) {
								tableEntry.structuresLoaded = true;
								// there is a structure update, we need to reload the structure from storage.
								// this is copied from msgpackr's struct, may want to expose as public method
								encoder._mergeStructures(encoder.getStructures());
								if (encoder.typedStructs) encoder.lastTypedStructuresLength = encoder.typedStructs.length;
							}
							const timeRange = subscribedNodeIds?.[subscriptionNodeId];
							// if we have a list of excluded nodes, that means we are including nodes by default so if the nodeId is not
							// in the subscribedNodeIds list, than it matches the subscription
							const matchesSubscription =
								(excludedNodes && timeRange === undefined) ||
								// if it is in the list, we check the timestamps to verify it matches
								(timeRange &&
									(timeRange as any).startTime < txnLogKey &&
									(!(timeRange as any).endTime || (timeRange as any).endTime > txnLogKey));
							if (!matchesSubscription) {
								if (DEBUG_MODE)
									logger.trace?.(
										connectionId,
										'skipping replication update',
										auditRecord.recordId,
										'to:',
										remoteNodeName,
										'from:',
										nodeId,
										'subscribed:',
										subscribedNodeIds
									);
								// we are skipping this message because it is being sent from another node, but we still want to
								// occasionally send a sequence update so that if we reconnect we don't have to go back to far in the
								// audit log
								return skipAuditRecord();
							}
							if (DEBUG_MODE)
								logger.trace?.(
									connectionId,
									'sending replication update',
									auditRecord.recordId,
									'to:',
									remoteNodeName,
									'from:',
									nodeId,
									'subscribed:',
									subscribedNodeIds
								);
							const residencyId = auditRecord.residencyId;
							const residency = getResidence(residencyId, table);
							let invalidationEntry;
							if (residency && !residency.includes(remoteNodeName)) {
								// If this node won't have residency, we need to send out invalidation messages
								const previousResidency = getResidence(auditRecord.previousResidencyId, table);
								if (
									(previousResidency &&
										!previousResidency.includes(remoteNodeName) &&
										(auditRecord.type === 'put' || auditRecord.type === 'patch')) ||
									table.getResidencyById
								) {
									// if we were already omitted from the previous residency, we don't need to send out invalidation messages for record updates
									// or if we are using residency by id, this means we don't even need any data sent to other servers
									return skipAuditRecord();
								}
								const recordId = auditRecord.recordId;
								// send out invalidation messages
								logger.trace?.(connectionId, 'sending invalidation', recordId, remoteNodeName, 'from', nodeId);
								let extendedType = 0;
								if (residencyId) extendedType |= HAS_CURRENT_RESIDENCY_ID;
								if (auditRecord.previousResidencyId) extendedType |= HAS_PREVIOUS_RESIDENCY_ID;
								let fullRecord: any,
									partialRecord = null;
								for (const name in table.indices) {
									if (isResolverOwnedIndexedName(table, name)) continue;
									if (!partialRecord) {
										fullRecord = getResidencyProjectionRecord(auditRecord, primaryStore);
										if (!fullRecord) break; // if there is no record, as is the case with a relocate, we can't send it
										partialRecord = {};
									}
									// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
									partialRecord[name] = fullRecord[name];
								}
								invalidationEntry = createAuditEntry({
									...auditRecord,
									tableId,
									recordId,
									previousVersion: null,
									nodeId,
									type: auditRecord.type === 'put' || auditRecord.type === 'patch' ? 'invalidate' : auditRecord.type,
									encodedRecord: encoder.encode(partialRecord), // use the store's encoder; note that this may actually result in a new structure being created
									extendedType,
									residencyId,
								});
								// entry is encoded, send it after checks for new structure and residency
							}

							// when we can skip an audit record, we still need to occasionally send a sequence update:
							function skipAuditRecord() {
								logger.trace?.(connectionId, 'skipping audit record', auditRecord.recordId);
								if (!skippedMessageSequenceUpdateTimer) {
									skippedMessageSequenceUpdateTimer = setTimeout(() => {
										skippedMessageSequenceUpdateTimer = null;
										// check to see if we are too far behind, but if so, send a sequence update
										if ((sentSequenceId || 0) + SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY / 2 < currentSequenceId) {
											if (DEBUG_MODE)
												logger.trace?.(connectionId, 'sending skipped sequence update', currentSequenceId);
											ws.send(encode([SEQUENCE_ID_UPDATE, currentSequenceId]));
										}
									}, SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY).unref();
								}
								return new Promise(setImmediate); // we still need to yield (otherwise we might never send a sequence id update)
							}
							if (!sentNodeIds.has(auditRecord.nodeId)) {
								sentNodeIds.add(auditRecord.nodeId);
								// If this is a nodeId that we have not sent yet, send a message to the remote node with the node id
								// mapping, indicating how each node name is mapped to a short id
								// and a list of the node names that are subscribed to this node
								ws.send(
									encode([
										NODE_NAME_TO_ID_MAP,
										exportIdMapping(tableSubscriptionToReplicator.auditStore),
										nodeSubscriptions.map(({ name }) => name),
									])
								);
							}

							const typedStructs = encoder.typedStructs;
							const structures = encoder.structures;
							if (
								typedStructs?.length != tableEntry.typed_length ||
								structures?.length != tableEntry.structure_length
							) {
								tableEntry.typed_length = typedStructs?.length;
								tableEntry.structure_length = structures.length;
								// the structure used for encoding records has changed, so we need to send the new structure
								logger.debug?.(connectionId, 'send table struct', tableEntry.typed_length, tableEntry.structure_length);
								if (!tableEntry.sentName) {
									tableEntry.sentName = true;
								}
								ws.send(
									encode([
										TABLE_FIXED_STRUCTURE,
										{
											typedStructs,
											structures,
											attributes: table.attributes,
											schemaDefined: table.schemaDefined,
										},
										tableId,
										tableEntry.table.tableName,
									])
								);
							}
							if (residencyId && !sentResidencyLists[residencyId]) {
								ws.send(encode([RESIDENCY_LIST, residency, residencyId]));
								sentResidencyLists[residencyId] = true;
							}
							if (currentTransaction.txnLogKey !== txnLogKey) {
								// send the queued transaction
								if (currentTransaction.txnLogKey) {
									if (DEBUG_MODE)
										logger.trace?.(connectionId, 'new txn log key, sending queued txn', currentTransaction.txnLogKey);
									if (frame.encodingBuffer[frame.encodingStart] !== 66) {
										logger.error?.('Invalid encoding of message');
									}
									sendQueuedData();
								}
								currentTransaction.txnLogKey = txnLogKey;
								frame.encodingStart = frame.position;
								frame.writeFloat64(txnLogKey);
							}

							/*
						TODO: At some point we may want fancier logic to elide the version when it equals txnLogKey
							and username from subsequent audit entries in multiple entry transactions*/
							if (invalidationEntry) {
								// if we have an invalidation entry to send, do that now
								frame.writeInt(invalidationEntry.length);
								frame.writeBytes(invalidationEntry);
							} else {
								// directly write the audit record.
								const encoded = auditRecord.encoded;
								if (auditRecord.extendedType & HAS_BLOBS) {
									// if there are blobs, we need to find them and send their contents
									decodeWithBlobCallback(
										() => auditRecord.getValue(primaryStore),
										(blob) => sendBlobs(blob, auditRecord.recordId),
										primaryStore.rootStore
									);
								}
								// If it starts with the previous local time, we omit that
								const start = encoded[0] === 66 ? 8 : 0;
								frame.writeInt(encoded.length - start);
								frame.writeBytes(encoded, start);
								logger.debug?.(
									'wrote record',
									auditRecord.recordId,
									'length:',
									encoded.length,
									'remoteNode',
									remoteNodeName,
									databaseName
								);
							}
							// wait if there is back-pressure
							if (ws._socket.writableNeedDrain) {
								isPausedForBackPressure = true;
								updateBackPressureRatio();
								return new Promise<void>((resolve) => {
									logger.debug?.(
										`Waiting for remote node ${remoteNodeName} to allow more commits ${ws._socket.writableNeedDrain ? 'due to network backlog' : 'due to requested flow directive'}`
									);
									const onDrain = () => {
										ws.off('close', onClose);
										isPausedForBackPressure = false;
										updateBackPressureRatio();
										// Also wait out blob saturation before admitting the next record; as an
										// else-if this check was unreachable while the socket stayed congested.
										// The !wsClosed guard matters: a drain queued behind the close event would
										// otherwise push onto an already-flushed callback list and park forever.
										if (outstandingBlobsBeingSent >= MAX_OUTSTANDING_BLOBS_BEING_SENT && !wsClosed) {
											blobSentCallbacks.push(resolve);
										} else resolve();
									};
									const onClose = () => {
										// a closed socket never drains; resolve so the loop can observe closed and exit
										ws._socket?.off('drain', onDrain);
										resolve();
									};
									ws._socket.once('drain', onDrain);
									ws.once('close', onClose);
								});
							} else if (outstandingBlobsBeingSent >= MAX_OUTSTANDING_BLOBS_BEING_SENT && !wsClosed) {
								return new Promise((resolve) => {
									blobSentCallbacks.push(resolve);
								});
							} else return new Promise(setImmediate); // yield on each turn for fairness and letting other things run
						};
						const sendQueuedData = () => {
							if (frame.position - frame.encodingStart > 8) {
								// if we have more than just a txn time, send it
								// Throw, don't return: a silent return skips this transaction while later ones
								// keep advancing the peer's resume cursor past it, losing it permanently. Throwing
								// closes the leg so it resumes from the un-advanced cursor (as the blob path does).
								if (checkExcessMessageSize(frame.position - frame.encodingStart))
									throw new Error('Replication message too large to send');
								ws.send(frame.encodingBuffer.subarray(frame.encodingStart, frame.position));
								// A frame actually went out: tell the outbound connection so it can reset its reconnect
								// backoff on genuine progress rather than on bare socket-open (harper-pro#339).
								options.connection?.onFrameSent?.();
								logger.debug?.(connectionId, 'Sent message, size:', frame.position - frame.encodingStart);
								if (databaseName !== 'system') {
									recordAction(
										frame.position - frame.encodingStart,
										'bytes-sent',
										`${remoteNodeName}.${databaseName}`,
										'replication',
										'egress'
									);
								}
							} else logger.debug?.(connectionId, 'skipping empty transaction');
						};

						auditSubscription = new EventEmitter();
						auditSubscription.once('close', () => {
							closed = true;
							subscriptionToHdbNodes?.end();
						});
						// find the earliest start time of the subscriptions
						let copyResume:
							{ copyStartTime: number; currentTable: string; afterKey: any; copyOrder?: number } | undefined;
						for (const subscription of nodeSubscriptions) {
							if (subscription.startTime < currentSequenceId) currentSequenceId = subscription.startTime;
							// a follower resuming an interrupted bulk copy sends back where it left off. This keeps the
							// last cursor if several subscriptions carry one — the single-cursor assumption is load-bearing
							// for the copy loop below (the order-version guard, skip-loop, and copyStartTime anchor all key
							// off this one copyResume); per-source resume would need a cursor per source.
							if (subscription.copyResume) copyResume = subscription.copyResume;
						}

						// A promise that never settles here would leave this WS ping-alive forever with the
						// receiver seeing no application frames and no cursor progress (harper-pro#642). Bound
						// each gate separately so the log identifies which one stuck, then close transiently so
						// the peer retries from its last durable cursor.
						Promise.resolve()
							.then(async () => {
								const resolvedDatabaseSubscription = await resolveSendSubscriptionSetup(
									whenSubscribedToHdbNodes,
									tableSubscriptionToReplicator,
									SEND_SUBSCRIPTION_RESOLVE_TIMEOUT,
									(gate, reason) => {
										if (closed || wsClosed) return;
										closed = true;
										subscriptionToHdbNodes?.end();
										// Settle the placeholder we timed out on, or every retry attaches another waiter to
										// the same permanently-pending promise (see expirePendingDatabaseSubscription).
										if (gate === 'database' && reason === 'timeout')
											expirePendingDatabaseSubscription(databaseName, tableSubscriptionToReplicator, dbSubscriptions);
										const databaseHint =
											gate === 'database' ? '; this can also mean this node does not host the database' : '';
										const failure =
											reason === 'timeout'
												? `Timed out waiting for ${gate} subscription setup`
												: `${gate} subscription setup resolved without a subscription`;
										logger.error?.(
											connectionId,
											`${failure} for ${databaseName}${databaseHint}; closing so the subscriber retries from its durable cursor (harper-pro#642)`
										);
										close(1011, `Replication ${gate} setup ${reason === 'timeout' ? 'timed out' : 'unavailable'}`);
									}
								);
								if (!resolvedDatabaseSubscription) return;
								tableSubscriptionToReplicator = resolvedDatabaseSubscription;
								if (closed || wsClosed) return;
								auditStore = tableSubscriptionToReplicator.auditStore;
								tableById = tableSubscriptionToReplicator.tableById.map(tableToTableEntry);
								subscribedNodeIds = [];
								if (excludedNodes) {
									for (let node of excludedNodes) {
										const localId = getIdOfRemoteNode(node, auditStore);
										subscribedNodeIds[localId] = false;
									}
								}
								let subscribedNodeName: string;
								for (const { name, startTime, endTime } of nodeSubscriptions) {
									const localId = getIdOfRemoteNode(name, auditStore);
									logger.debug?.('subscription to', name, 'using local id', localId, 'starting', startTime);
									subscribedNodeIds[localId] = { startTime, endTime };
									subscribedNodeName = name;
								}

								sendDBSchema(databaseName, subscriptionSetupRequestId);
								if (!schemaUpdateListener) {
									schemaUpdateListener = onUpdatedTable((table) => {
										if (table.databaseName === databaseName) {
											sendDBSchema(databaseName);
										}
									});
									dbRemovalListener = onRemovedDB((db) => {
										// I guess if a database is removed then we disconnect. This is kind of weird situation for replication,
										// as the replication system will try to preserve consistency between nodes and their databases, and
										// it is unclear what to do if a database is removed and what that means for consistency seekingd
										if (db === databaseName) {
											ws.send(encode([DISCONNECT]));
											close();
										}
									});
									// We are inside an async .then(); if the WS closed while waiting for it to
									// resolve, attaching a 'close' handler now will not fire and the listeners
									// above would stay subscribed on the global databaseEventsEmitter forever.
									if (wsClosed) {
										schemaUpdateListener.remove();
										dbRemovalListener.remove();
										schemaUpdateListener = undefined;
										dbRemovalListener = undefined;
										return;
									}
									ws.on('close', () => {
										schemaUpdateListener?.remove();
										dbRemovalListener?.remove();
									});
								}

								let isFirst = true;
								do {
									// We run subscriptions as a loop where retrieve entries from the audit log, since the last entry
									// and sending out the results while applying back-pressure from the socket. When we are out of entries
									// then we switch to waiting/listening for the next transaction notifications before resuming the iteration
									// through the audit log.
									if (!isFinite(currentSequenceId)) {
										logger.warn?.('Invalid sequence id ' + currentSequenceId);
										close(1008, 'Invalid sequence id' + currentSequenceId);
									}
									if (isFirst && !closed) {
										isFirst = false;
										// If the requested incremental start predates the transaction-log history we still
										// retain, the entries needed to catch up incrementally have been purged (retention is
										// time-based). Upgrade to the bounded base-copy path instead of audit replay, which would
										// otherwise silently skip the purged entries or replay an unbounded history (harper#1114).
										if (currentSequenceId > 0) {
											const oldestLogName = subscribedNodeName === getThisNodeName() ? 'local' : subscribedNodeName;
											let oldestRetainedTime: number | undefined;
											// Mirror the replay scope below (single log, or all non-excluded logs) and take the
											// first (oldest) entry; getRange yields ascending by audit-log key. Use the same key
											// basis as the replay loop (`txnLogKey`) and retention cleanup.
											for (const entry of auditStore.getRange({
												start: 1,
												log: excludedNodes ? undefined : oldestLogName,
												excludeLogs: excludedNodes,
												snapshot: false,
											})) {
												oldestRetainedTime = entry.txnLogKey;
												break;
											}
											if (
												shouldForceBaseCopyForRetention(
													currentSequenceId,
													oldestRetainedTime,
													Date.now() - auditRetention
												)
											) {
												logger.warn?.(
													`Peer ${remoteNodeName} requested replication of database ${databaseName} from ${new Date(currentSequenceId).toISOString()}, which predates retained transaction-log history (oldest retained ${oldestRetainedTime ? new Date(oldestRetainedTime).toISOString() : 'none'}, retention ${auditRetention}ms); forcing a bounded base-copy resync.`
												);
												currentSequenceId = 0;
											}
										}
										if (currentSequenceId === 0) {
											logger.info?.('Replicating all tables to', remoteNodeName);
											// Capture the resume point BEFORE iterating. The bulk copy walks the primary store in
											// key order (snapshot: false), but the follower resumes replication from the audit log in
											// time order. Using copyStartTime — not max(localTime) of the copied records — guarantees
											// the post-copy audit replay re-delivers every write committed during the copy, including
											// ones to keys we already passed; resuming from max(localTime) would skip those (data loss).
											// When the follower is resuming an interrupted copy, keep the original copy start time so
											// the post-copy resume point stays anchored to when the copy first began (see safety note).
											const copyStartTime = copyResume?.copyStartTime ?? Date.now();
											const nodeId = getThisNodeId(auditStore);
											// Tell the follower a bulk copy is starting, its anchor time, and the copy-order version,
											// so it tracks a resume cursor that a later leader can validate before trusting the skip.
											ws.send(encode([COPY_START, copyStartTime, COPY_ORDER_VERSION]));
											// Test-only (#453): one-shot stall here leaves the follower in copy mode with no
											// further frames while pings keep flowing — the connected:true copy wedge.
											const copyStallForTest = maybeStallCopyForTest(databaseName);
											if (copyStallForTest) await copyStallForTest;
											let recordsSinceCheckpoint = 0;
											// Paces the flush/yield cadence inside the copy loop below (see
											// COPY_CHECKPOINT_MAX_INTERVAL_MS). Marked on every in-loop flush/yield.
											const copyFlushPacer = createCopyFlushPacer(COPY_CHECKPOINT_MAX_INTERVAL_MS, Date.now());
											// If resuming, the follower already committed every table before currentTable (records commit
											// in stable iteration order), so skip to currentTable and continue after its last committed key.
											let reachedResumeTable = !copyResume;
											// currentTable must be one the loop below will actually visit (present in `tables` AND passing
											// the same replication filter); otherwise the skip loop never reaches it and would omit every
											// later table. Mirror the loop's own check so a dropped/unreplicated cursor table forces a restart.
											// `tables` can be undefined on a freshly-joined peer, and a malformed cursor can have an
											// undefined currentTable (#321); the `?.` makes both fall into the warn-and-recopy branch
											// instead of throwing, which would bubble to the outer .catch and close the channel (1008).
											if (copyResume && !isCopyResumeOrderCompatible(copyResume.copyOrder, COPY_ORDER_VERSION)) {
												// The cursor was built under a different copy order, or a pre-versioning leader (an absent
												// or explicit-undefined copyOrder both decode to undefined here). The skip-loop below trusts
												// that every table before currentTable was already copied, which only holds under the order
												// that built the cursor — honoring it here could silently skip tables the old order had not yet
												// reached (e.g. hdb_deployment behind hdb_analytics). Recopy from scratch (idempotent puts;
												// copyStartTime is captured above, so the resume anchor survives the reset). (#421)
												logger.warn?.(
													'Copy-resume order version mismatch, restarting full copy',
													copyResume.copyOrder,
													'!=',
													COPY_ORDER_VERSION
												);
												copyResume = undefined;
												reachedResumeTable = true;
											} else if (copyResume && !tableToTableEntry(tables?.[copyResume.currentTable])) {
												// cursor table is gone, unreplicated, or the cursor itself is malformed — the skip loop
												// would never reach it and would omit every later table, so recopy from scratch
												// (idempotent puts; copyStartTime is captured above, so the resume anchor survives the reset).
												logger.warn?.(
													'Copy-resume table missing or unreplicated, restarting full copy',
													copyResume.currentTable
												);
												copyResume = undefined;
												reachedResumeTable = true;
											}
											const resumeCurrentTable = copyResume?.currentTable;
											const resumeAfterKey = copyResume?.afterKey;
											// Copy control-plane tables before bulk tables so a large table (hdb_analytics) can't gate
											// convergence of small tables that gate cluster operations (hdb_deployment). Ordering is a
											// pure function of the table-name set, so it stays stable across runs — which the skip-loop
											// above (reachedResumeTable) relies on; cross-version cursors are rejected by the guard above. (#421)
											const orderedTableNames = orderTablesForCopy(tables ? Object.keys(tables) : []);
											// Every read here can come back missing or unreadable, and the answer to all of them is to
											// copy in full: withholding is the only outcome that can lose data, and a throw would reach
											// the outer catch and close the channel, turning a metadata hiccup into a reconnect loop.
											let withheldOriginNodeId: number | undefined;
											let withheldRecordCount = 0;
											try {
												const peerNodeRow = getHDBNodeTable().primaryStore.getSync(remoteNodeName);
												if (
													shouldWithholdPeerOwnRecords({
														cloneSource: cloneAttemptSource(),
														// the marker records the host from the leader URL, which need not be the peer's
														// node name — match either
														peerNames: [remoteNodeName, hostnameFromNodeUrl(peerNodeRow?.url)],
														peerIsOurLeader: !!peerNodeRow?.isLeader,
													})
												) {
													// NOT getIdOfRemoteNode: it mints and persists an id for an unseen name, and a fresh id
													// matches no stored record — it would withhold nothing while reporting that it had.
													const peerOriginNodeId = exportIdMapping(auditStore)?.[remoteNodeName];
													// our own id resolves for everything we authored, so filtering on it would withhold
													// this node's whole dataset
													withheldOriginNodeId = peerOriginNodeId === nodeId ? undefined : peerOriginNodeId;
													logger.warn?.(
														withheldOriginNodeId === undefined
															? `Copying ${databaseName} to ${remoteNodeName} in full: this node is mid-clone from that peer, but holds no record attributed to it (harper-pro#737).`
															: `Copying ${databaseName} to ${remoteNodeName} without the records that peer originated: this node is mid-clone from it (harper-pro#737).`
													);
												}
											} catch (error) {
												withheldOriginNodeId = undefined;
												logger.warn?.(
													`Could not determine whether ${remoteNodeName} is the peer this node is cloning from; copying ${databaseName} in full`,
													error
												);
											}
											for (const tableName of orderedTableNames) {
												const table = tables[tableName];
												if (!tableToTableEntry(table)) continue; // if we aren't replicating this table, skip it
												if (!reachedResumeTable) {
													if (tableName !== resumeCurrentTable) continue; // already committed on the follower
													reachedResumeTable = true;
												}
												const rangeOptions: any = { snapshot: false, versions: true };
												// values: false, // TODO: eventually, we don't want to decode, we want to use fast binary transfer
												if (tableName === resumeCurrentTable) {
													// resume this table after the last key the follower committed
													rangeOptions.start = resumeAfterKey;
													rangeOptions.exclusiveStart = true;
												}
												for (const entry of table.primaryStore.getRange(rangeOptions)) {
													if (closed) return;
													// Bound the wall-clock gap between socket flushes and event-loop yields,
													// independent of record count. The count checkpoint below alone can let a cold
													// batch run past the watchdog window with no bytes flushed (reads dominate cost),
													// and the LOCAL_ONLY `continue` below skips the normal per-record flush+yield
													// entirely — a contiguous skipped run would then never reach the timers phase, so
													// the ping timer and receive side starve. Flush any pending batch (plain flush, NOT
													// an end_txn — see the watermark note below) and yield a macrotask on this cadence
													// so both watchdog variants stay satisfied regardless of which records we walk.
													const now = Date.now();
													if (copyFlushPacer.due(now)) {
														copyFlushPacer.mark(now);
														if (frame.position - frame.encodingStart > 8) {
															recordsSinceCheckpoint = 0;
															sendQueuedData();
															frame.encodingStart = frame.position;
															currentTransaction.txnLogKey = 0;
														}
														await new Promise(setImmediate);
														if (closed) return;
													}
													// Local-only records must never be full-copied to a peer. metadataFlags is the
													// already-available record metadata integer from the range entry — a pure bitmask
													// test, no record value decode added to this send path.
													if (entry.metadataFlags & LOCAL_ONLY) continue;
													// same origin normalization as recordNodeId below: undefined means we authored it
													if (withheldOriginNodeId !== undefined && (entry.nodeId ?? nodeId) === withheldOriginNodeId) {
														withheldRecordCount++;
														continue;
													}
													logger.trace?.(
														connectionId,
														'Copying record from',
														databaseName,
														tableName,
														entry.key,
														entry.localTime
													);
													getSharedStatus()[SENDING_TIME_POSITION] = 1;
													// The record's ORIGIN, not ours: stamping a copy with the copier's id
													// re-attributes every copied record, so it can never tie against its true
													// origin on the follower. `entry.nodeId` is this node's local id for that
													// origin (undefined/0 = us) — the same id space the wire uses.
													const recordNodeId = entry.nodeId ?? nodeId;
													const encodeCopyRecord = () =>
														createAuditEntry({
															version: entry.version,
															tableId: table.tableId,
															recordId: entry.key,
															previousVersion: null,
															nodeId: recordNodeId,
															type: 'put',
															encodedRecord: encodeCopyRecordValue(table.primaryStore, entry.value, (blob) =>
																sendBlobs(blob, entry.key)
															),
															extendedType: entry.metadataFlags & ~0xff & ~(ACTION_32_BIT << 24), // exclude lower type byte and ACTION_32_BIT format marker
															residencyId: entry.residencyId,
															previousResidencyId: null,
															expiresAt: entry.expiresAt,
														} as any);
													const encoded =
														entry.metadataFlags & HAS_BLOBS
															? encodeWithCopyBlobTransferTags(entry.value, encodeCopyRecord)
															: encodeCopyRecord();
													await sendAuditRecord(
														{
															// make it look like an audit record
															recordId: entry.key,
															tableId: table.tableId,
															type: 'put',
															getValue() {
																return entry.value;
															},
															encoded,
															version: entry.version,
															residencyId: entry.residencyId,
															nodeId: recordNodeId,
															extendedType: entry.metadataFlags,
														},
														entry.localTime,
														nodeId
													);
													logger.debug?.(
														'sent record from table',
														entry.key,
														'length:',
														encoded.length,
														encoded.slice(0, 10)
													);
													// Periodically flush the accumulated records as a message so the follower commits this
													// batch and advances its resume cursor. This is a plain flush with NO sequence update:
													// emitting an end_txn here would advance the follower's received-version watermark to
													// copyStartTime mid-copy, which monitorSync could read as "caught up" and mark the clone
													// Available/cloned with rows still uncopied. (Records with differing versions already flush
													// naturally above; this also bounds same-version bulk data into committable batches.) The
													// watermark is only advanced to copyStartTime by the single end_txn after the whole copy.
													if (
														(++recordsSinceCheckpoint >= COPY_CHECKPOINT_RECORDS ||
															frame.position - frame.encodingStart >= COPY_FLUSH_BYTES) &&
														frame.position - frame.encodingStart > 8
													) {
														recordsSinceCheckpoint = 0;
														copyFlushPacer.mark(Date.now());
														sendQueuedData();
														frame.encodingStart = frame.position;
														currentTransaction.txnLogKey = 0;
													}
												}
												logger.info?.('Finished copy table', tableName, remoteNodeName);
											}
											if (withheldOriginNodeId !== undefined)
												logger.warn?.(
													`Copied ${databaseName} to ${remoteNodeName} without ${withheldRecordCount} record(s) that peer originated (harper-pro#737)`
												);
											currentSequenceId = copyStartTime;
											if (!currentTransaction.txnLogKey) {
												// no records pending (none sent, or the last batch landed on a checkpoint flush):
												// force a txn so the end_txn below still carries the sequence update
												currentTransaction.txnLogKey = copyStartTime;
												frame.encodingStart = frame.position;
												frame.writeFloat64(copyStartTime);
											}
											// ALWAYS emit the final end_txn at copyStartTime. It carries the REMOTE_SEQUENCE_UPDATE
											// that advances the follower's seqId and received-version watermark to copyStartTime —
											// the sole signal that the copy is synced (per-record watermark advance is suppressed
											// during the copy). Skipping it when the last rows landed exactly on a checkpoint flush
											// would leave the clone unable to ever reach Available.
											sendAuditRecord(
												{
													type: 'end_txn',
												},
												currentSequenceId
											);
											// The full copy is done — tell the follower to clear its resume cursor and fall back to
											// normal audit-log replication from the persisted seqId (which is copyStartTime).
											ws.send(encode([COPY_COMPLETE]));
											getSharedStatus()[SENDING_TIME_POSITION] = 0;
											currentSequenceId = copyStartTime;
										}
									}
									const logName = subscribedNodeName === getThisNodeName() ? 'local' : subscribedNodeName;
									// Capture the current generation before scanning. A commit after this live scan
									// drains must wake this iteration; subscribing afterward can miss that commit.
									const nextTransaction = whenNextTransaction(auditStore);
									auditLogIterable =
										(auditStore.reusableIterable && auditLogIterable) ??
										auditStore.getRange({
											start: currentSequenceId || 1,
											exclusiveStart: true,
											exactStart: false, // TODO: This should be enabled if we are starting from a previous transaction log entry (vs a table copy)
											log: excludedNodes ? undefined : logName,
											startByLog: new Map([[logName, currentSequenceId || 1]]),
											excludeLogs: excludedNodes,
											snapshot: false, // don't want to use a snapshot, and we want to see new entries
										});
									for (const auditRecord of auditLogIterable) {
										const key: number = auditRecord.txnLogKey;
										if (closed) return;
										logger.debug?.('sending audit record', key, auditRecord.recordId);
										if (tables?.test)
											logger.debug?.(
												'audit record version',
												auditRecord.version,
												'table record version',
												tables.test.primaryStore.getEntry(auditRecord.recordId)?.version
											);
										getSharedStatus()[SENDING_TIME_POSITION] = key;
										currentSequenceId = key;
										await sendAuditRecord(auditRecord, key);
										auditSubscription.startTime = key; // update so don't double send
									}
									if (frame.position - frame.encodingStart > 8) {
										sendAuditRecord(
											{
												type: 'end_txn',
											},
											currentSequenceId
										);
									}
									getSharedStatus()[SENDING_TIME_POSITION] = 0;
									await nextTransaction;
								} while (!closed);
							})
							.catch((error) => {
								logger.error?.(connectionId, 'Error handling subscription to node', error);
								// An authorization-watch rejection before it resolves reaches this chain too (the setup
								// gate awaits the same promise), and that chain has already closed with a more accurate
								// code — so a second close here would only overwrite the reason.
								if (closed || wsClosed) return;
								closed = true;
								close(1008, 'Error handling subscription to node ' + error);
							});
						break;
					}
				}
				return;
			}

			/* If we are past the commands, we are now handling an incoming replication message, the next block
			 * handles parsing and transacting these replication messages */
			// Every record in this body is delivered with `tableSubscriptionToReplicator.send()`, so resolve the
			// subscription before decoding any of it rather than throwing per record (harper-pro#622).
			if (!(await whenSubscriptionResolved())) return;
			// The origin's log key for every record in this body, read once. It is what the apply
			// transaction commits under, so the destination's log for this origin keeps the origin's clock
			// and a downstream peer's resume cursor stays comparable with it (harper-pro#790).
			// Read only after proving the header is there: a body shorter than its own 8-byte header is
			// malformed, and getFloat64 would throw a RangeError past every graceful path below.
			const frameTxnLogKey = body.byteLength >= 8 ? decoder.getFloat64(0) : NaN;
			if (!isValidFrameTxnLogKey(frameTxnLogKey)) {
				// Hold rather than skip, as the missing-table-decoder path does: nothing durable or
				// status-visible has moved yet, so closing leaves the cursor where it was and the peer
				// re-sends from it. Latch inbound off BEFORE closing so queued frames cannot advance it.
				recordAction(true, DECODE_HOLD_METRIC, databaseName + '.frame-log-key');
				logger.error?.(
					connectionId,
					`Replication frame from ${remoteNodeName} for ${databaseName} carries an out-of-range transaction-log key (${frameTxnLogKey}); holding and reconnecting`
				);
				wsClosed = true;
				close(1011, 'invalid replication frame log key');
				return;
			}
			decoder.position = 8;
			let beginTxn = true;
			let event;
			let sequenceIdReceived;
			let maxBatchTxnLogKey; // this batch's origin log key; end_txn resume cursor when no sequence-update set lastSequenceIdReceived
			// The log key is one value for the whole body, so the cursor and watermark below are recorded
			// on the first record that is not part of a bulk copy rather than re-derived per record.
			let recordedFrameTxnLogKey = false;
			// Last copy-frame key seen in this message body, applied OR skipped as an identity tie — the copy
			// resume cursor must cover skipped keys too, or a copy whose records we all already hold would
			// never advance it and every reconnect would restart the copy from the beginning.
			let lastCopyFrameKey: { table: string; id: any } | undefined;
			let lastYieldTime = performance.now();
			// Latch the copy-frame status ONCE for this whole WS message body. The decode loop below awaits
			// (waitForDrain / setImmediate) and ws does not serialize async message handlers, so a later
			// COPY_COMPLETE could otherwise flip copyCompleteReceived mid-body and make trailing rows fall back to
			// the audited/resequencing path — reintroducing the O(n) copy-time work this avoids. (harper-pro#480)
			const messageIsCopyFrame = inCopyMode && !copyCompleteReceived;
			// Copy frames get a walk position, and everything staging or blob-tagging against it is
			// captured NOW (decode time): onCommit runs later from the apply queue, by which time a
			// same-socket COPY_START may have replaced the pass and its copyStartTime/copyOrder — staging
			// this frame's key under those NEW values would claim keys the new walk has not delivered.
			// Non-copy frames never touch the watermark (live replication pays no bookkeeping, #699).
			const copyFrameIndex = messageIsCopyFrame ? copyWatermark.beginFrame() : undefined;
			const copyFramePass = copyWatermark.currentPass;
			const copyFrameStartTime = copyModeStartTime;
			const copyFrameOrder = copyModeOrderVersion;
			do {
				getSharedStatus();
				const eventLength = decoder.readInt();
				if (eventLength === 9 && decoder.getUint8(decoder.position) == REMOTE_SEQUENCE_UPDATE) {
					// this is an empty txn ending, but need to record the timestamps
					decoder.position++;
					lastSequenceIdReceived = sequenceIdReceived = decoder.readFloat64();
					replicationSharedStatus[RECEIVED_VERSION_POSITION] = Math.max(
						// ensure monotonicity
						lastSequenceIdReceived,
						replicationSharedStatus[RECEIVED_VERSION_POSITION]
					);
					replicationSharedStatus[RECEIVED_TIME_POSITION] = Date.now();
					replicationSharedStatus[RECEIVING_STATUS_POSITION] = RECEIVING_STATUS_WAITING;
					// Clamp: an empty sequence update carries no commit/blob-durability gate, so while any blob is
					// not yet durable it must not push the resume cursor past the last fully-durable point.
					// seqUpdateEndTxn also gates copy-apply durability (flush before [seq] = copyStartTime).
					tableSubscriptionToReplicator.send(
						seqUpdateEndTxn(cursorBlockedByBlob() ? lastDurableSequenceId : lastSequenceIdReceived)
					);
					logger.trace?.('received remote sequence update', lastSequenceIdReceived, databaseName);
					break;
				}
				const start = decoder.position;
				const auditRecord = readAuditEntry(body, start, start + eventLength);
				const tableDecoder = tableDecoders[auditRecord.tableId];
				if (!tableDecoder) {
					// No structure/decoder for this table id yet. tableDecoders is populated only by a
					// TABLE_FIXED_STRUCTURE message, which the sender always emits BEFORE the first record of a
					// table (see the length-gated send at ~2882) over an ordered WS — so reaching here means the
					// structure sync was missed (a reset/edge case) or the table's schema has not propagated to
					// this node yet (#1497 family). Both are TRANSIENT/recoverable — categorically unlike an
					// undecodable record (handled as permanent below). So HOLD rather than skip-and-advance: skipping
					// would seal a still-deliverable record under the resume cursor, and falling through would crash
					// (the decode throws on `tableDecoder.name`, then the catch's `tableDecoder.decoder` deref throws
					// again and escapes the catch — a wedge). Close so the leg reconnects and resumes from the durable
					// cursor, which re-sends TABLE_FIXED_STRUCTURE and lets the record decode. The cursor is not
					// advanced (we return before this record applies), so nothing is lost.
					logger.error?.(
						connectionId,
						`No decoder for table id ${auditRecord.tableId} in ${databaseName}; holding and reconnecting to resync table structures`
					);
					recordAction(true, DECODE_HOLD_METRIC, databaseName + '.' + auditRecord.tableId);
					// Latch inbound off BEFORE closing (markInboundClosed-first, #440): frames already queued on the
					// messageProcessing chain — or delivered by the peer before the close handshake completes — would
					// otherwise run onWSMessage and advance the resume cursor past this held record, silently turning
					// the hold into a skip. `close()` alone does not set `wsClosed`.
					wsClosed = true;
					close(1011, 'missing table structure; reconnecting to resync');
					return;
				}
				// Lazily compute receive-side exclusions once remoteNodeName is known.
				// Prefer routeReplicates from the subscriber-side connection; fall back to
				// authorization.replicates when this is the server-side handler.
				if (receiveExcludedTables === undefined) {
					const firstNode = options.connection?.nodeSubscriptions?.[0];
					const receivesFromEntries =
						firstNode?.routeReplicates?.receivesFrom ??
						(authorization?.replicates && typeof authorization.replicates === 'object'
							? authorization.replicates.receivesFrom
							: undefined);
					receiveExcludedTables =
						getExcludedTablesForRouteEntries(receivesFromEntries, remoteNodeName, databaseName) ?? null;
				}
				if (tableDecoder && receiveExcludedTables?.has(tableDecoder.name)) {
					logger.trace?.(
						connectionId,
						'dropping incoming replication for excluded table',
						databaseName + '.' + tableDecoder.name,
						'from',
						remoteNodeName
					);
					decoder.position = start + eventLength;
					continue;
				}
				// Defense-in-depth: a correct sender never forwards local-only records, but if one ever
				// arrives (older/misconfigured peer), drop it here. The flag rides the audit entry's
				// extendedType — a bitmask test on the already-decoded header, no record value decode.
				if (auditRecord.extendedType & LOCAL_ONLY) {
					logger.trace?.(
						connectionId,
						'dropping incoming local-only replication record',
						databaseName,
						auditRecord.recordId,
						'from',
						remoteNodeName
					);
					decoder.position = start + eventLength;
					continue;
				}
				let residencyList;
				if (auditRecord.residencyId) {
					residencyList = receivedResidencyLists[auditRecord.residencyId];
					logger.trace?.(
						connectionId,
						'received residency list',
						residencyList,
						auditRecord.type,
						auditRecord.recordId
					);
				}
				const id = auditRecord.recordId;
				// A copy frame is applied as a snapshot with no duplicate detection, so it re-mints the
				// record's blobs as fresh local files and dereferences the durable ones we already hold —
				// and if the copy is interrupted mid-blob the record is left on a PENDING stub the source
				// cannot fill. Skip a frame that ties with what we have, which copy mode would otherwise
				// never detect: it is outside the leading-duplicate window (a copy has no resume cursor).
				// Blob-carrying records only; re-applying an identical blob-less record is harmless.
				if (
					messageIsCopyFrame &&
					!!(auditRecord.extendedType & HAS_BLOBS) &&
					(await isDurableIdentityTie(
						readLocalEntry(tableDecoder, id),
						auditRecord.version,
						remoteShortIdToLocalId?.get(auditRecord.nodeId),
						true
					))
				) {
					let skippedBlobs: Blob[] | undefined;
					try {
						skippedBlobs = collectAuditRecordBlobsFromBinary(auditRecord, tableDecoder, auditStore?.rootStore);
					} catch (error) {
						logger.trace?.(connectionId, 'copy identity-tie: could not enumerate skipped blobs', id, error);
					}
					if (
						skippedBlobs &&
						skippedBlobs.length > 0 &&
						skippedBlobs.every((blob) => Object.hasOwn(blob, 'replicationTransferId'))
					) {
						for (const blob of skippedBlobs) discardIncomingBlobStream(blob);
						noteReceiveLiveness();
						if (tableDecoder?.name) lastCopyFrameKey = { table: tableDecoder.name, id };
						logger.trace?.(connectionId, 'copy identity-tie skip', 'id', id, 'version', auditRecord.version);
						decoder.position = start + eventLength;
						continue;
					}
				}
				event = undefined; // reset before each decode attempt
				let receivedBlobs: any[] | undefined;
				// Dangling-blob repair pairing (#699): computed only for blob-carrying records in the windows
				// where identity-tie duplicates occur — the copy walk and a resume's leading-duplicate tail —
				// so live replication never pays the existing-entry read. A tie's re-delivered bytes stream
				// INTO the stored record's damaged fileIds (repairBlobFile), so the tie-skipped record needs
				// no rewrite and its dangling reference heals in place. MUST be computed BEFORE
				// decodeBlobsWithWrites: getEntry decodes the stored value, and doing that while this
				// record's blob callback is installed re-enters the callback on the stored record's own blob
				// references (unbounded recursion).
				const localSourceNodeId = remoteShortIdToLocalId.get(auditRecord.nodeId);
				let repairTargets: any[] | null = null;
				if (
					auditRecord.extendedType & HAS_BLOBS &&
					(repairWindowMissRunByNode.get(localSourceNodeId) ?? 0) < 8 &&
					((messageIsCopyFrame && (copyResumeRequested || sawCopyRestart)) ||
						leadingDupCursorByNode.has(localSourceNodeId as any))
				) {
					let storedEntry: any = null;
					let entryReadResolved = false;
					try {
						storedEntry = tableDecoder?.getEntry?.(id);
						if (storedEntry && typeof storedEntry.then === 'function') storedEntry = await storedEntry;
						entryReadResolved = true;
					} catch {
						repairDeclines['entry-read-error'] = (repairDeclines['entry-read-error'] ?? 0) + 1;
					}
					if (storedEntry != null) {
						repairWindowMissRunByNode.delete(localSourceNodeId);
						repairTargets = await collectBlobRepairTargets(
							tableDecoder,
							id,
							auditRecord.version,
							localSourceNodeId,
							blobFileMissingOrIncompleteAsync,
							repairDeclines,
							storedEntry
						);
					} else if (entryReadResolved) {
						repairWindowMissRunByNode.set(
							localSourceNodeId,
							(repairWindowMissRunByNode.get(localSourceNodeId) ?? 0) + 1
						);
						repairDeclines['no-stored-entry'] = (repairDeclines['no-stored-entry'] ?? 0) + 1;
					}
				}
				let repairIndex = 0;
				try {
					maybeInjectDecodeFailureForTest(id);
					decodeBlobsWithWrites(
						() => {
							event = {
								table: tableDecoder.name,
								id: auditRecord.recordId,
								type: auditRecord.type,
								nodeId: localSourceNodeId,
								viaNodeId: receivingDataFromNodeIds[0],
								residencyList,
								timestamp: STORAGE_IS_ROCKSDB ? frameTxnLogKey : auditRecord.version,
								version: auditRecord.version,
								value: auditRecord.getValue(tableDecoder),
								user: auditRecord.user,
								beginTxn,
								expiresAt: auditRecord.expiresAt,
							};
						},
						auditStore?.rootStore,
						(blob) => {
							const repairTarget = repairTargets?.[repairIndex++];
							const localBlob = receiveBlobs(blob, id, copyFrameIndex, repairTarget, tableDecoder.name);
							// An in-place-repaired blob is a file a committed record already references (possibly a
							// coalesced reuse from an earlier record in this message) — never let the decode-failure
							// cleanup below unlink it.
							if (!inPlaceRepairedBlobs.has(localBlob)) (receivedBlobs ??= []).push(localBlob);
							return localBlob;
						}
					);
				} catch (error) {
					// tableDecoder is guaranteed set here (the unknown-tableId case returns above), so the derefs
					// below are safe without optional chaining. Every failure is counted; classifyReplicationDecodeError
					// only picks the label (harper-pro#537). The old bare catch skipped silently — no metric, no class.
					if (classifyReplicationDecodeError(error) === 'skip-missing-structure') {
						// Missing shared structure (harper#1163): genuinely absent on this node, re-copy re-ships the
						// same undecodable bytes. Surface it through the same metric core's local-read path fires so
						// the drop is alertable rather than laundered as emptiness. Kept concise: this is the #537
						// flood path (an interrupted copy can replay thousands of these), so we do NOT stringify the
						// decoder's full struct dictionaries per record — the metric carries the volume and `error`
						// already names the specific missing structure.
						recordAction(true, DECODE_MISSING_STRUCTURE_METRIC, databaseName + '.' + tableDecoder.name);
						logger.warn?.(
							connectionId,
							`Skipping replication record referencing a shared structure missing on this node (permanent; see harper#1163), table: ${tableDecoder.name}, record id: ${id}`,
							error
						);
					} else {
						// Any other decode failure: skip + advance, and COUNT it (decode-drop) — the class we don't
						// recognize is the one an operator most needs a number for (harper-pro#537 review). What lands
						// here is a truncated/mis-framed or structure-forked record VALUE buffer: a blob reference
						// decodes to a lazy handle (no read on this path), so an in-flight blob produces no decode error
						// at all — its transient (503 → hold) vs permanent split is the async receiveBlobs/#403 path,
						// not this catch. Decoder dictionaries passed as objects (not eager JSON.stringify) so the
						// format cost is paid only when the log emits.
						recordAction(true, DECODE_DROP_METRIC, databaseName + '.' + tableDecoder.name);
						logger.error?.(
							connectionId,
							'Error decoding replication message, record id: ' + id,
							'typed structures for current decoder',
							tableDecoder.decoder.typedStructs,
							'structures for current decoder',
							tableDecoder.decoder.structures,
							'encoded message',
							auditRecord.encoded.subarray(0, 1000),
							auditRecord,
							error
						);
					}
				}
				if (!event && receivedBlobs) {
					// decode failed mid-message; the blobs that were already accepted will never be referenced. Give in-flight reads
					// a window to complete, then unlink the files. (mirrors the pattern at the relocate path above.)
					setTimeout(() => receivedBlobs.forEach(deleteBlob), 60000).unref();
				}
				// During a bulk copy, do NOT advance the received-version watermark per copied record:
				// records arrive in primary-key order carrying their original (possibly newest) versions, so a
				// single record at the leader's latest timestamp would otherwise let checkSyncStatus mark the
				// clone Available with rows still uncopied. The watermark is advanced to copyStartTime by the
				// single end_txn after the whole copy (the REMOTE_SEQUENCE_UPDATE branch above).
				if (!inCopyMode && !recordedFrameTxnLogKey) {
					recordedFrameTxnLogKey = true;
					replicationSharedStatus[RECEIVED_VERSION_POSITION] = Math.max(
						// the sender's log position, the same domain lastSequenceIdReceived reports
						frameTxnLogKey,
						replicationSharedStatus[RECEIVED_VERSION_POSITION]
					);
					// Only on RocksDB does the receiver key this origin's log by the origin's own clock, making
					// the frame's log key a valid resume cursor. On LMDB the cursor must stay on the sender's
					// audit sequence id (lastSequenceIdReceived); the receiver's own audit keys are unrelated.
					if (STORAGE_IS_ROCKSDB) maxBatchTxnLogKey = frameTxnLogKey;
				}
				noteReceiveLiveness();

				if (event) {
					// Leading-duplicate fast-skip: on a resumed stream the first records re-streamed from the
					// resume cursor are records this follower already applied. If this is a provably-already-
					// applied identity-tie duplicate (and not part of a bulk copy), suppress the dispatch so it
					// never incurs core's per-record CRDT resequencing walk. This only ever drops a record the
					// apply loop would itself have discarded as a tie — see isSkippableLeadingDuplicate.
					if (
						!inCopyMode &&
						(await isSkippableLeadingDuplicate(
							tableDecoder,
							event.id,
							auditRecord.version,
							event.nodeId,
							!!(auditRecord.extendedType & HAS_BLOBS)
						))
					) {
						leadingDuplicateSkipCount++;
						logger.trace?.(
							connectionId,
							LEADING_DUP_SKIP_LOG,
							'id',
							event.id,
							'version',
							auditRecord.version,
							'nodeId',
							event.nodeId,
							'table',
							event.table
						);
						// A skipped record still carries any blob chunks (delivered as their own BLOB_CHUNK
						// messages and written independently) and does not affect txn framing: we simply do not
						// enqueue it for the apply loop. Leave `beginTxn` as-is so the first record we *do*
						// dispatch still correctly opens the transaction. Advance the decoder past this record.
						decoder.position = start + eventLength;
						continue;
					}
					beginTxn = false;
					// TODO: Once it is committed, also record the localtime in the table with symbol metadata, so we can resume from that point
					logger.debug?.(
						connectionId,
						'received replication message',
						auditRecord.type,
						'id',
						event.id,
						'version',
						new Date(auditRecord.version),
						'logKey',
						new Date(frameTxnLogKey),
						'nodeId',
						event.nodeId
					);
					// Mark base-copy frames so core applies them as snapshots: record + indices only, no
					// audit/transaction-log entry and no out-of-order resequencing/dedup (harper-pro#480).
					// Snapshot rows whose stored version predates copyStartTime. A source fill can have an
					// older version but a later txnLogKey and therefore be redelivered by the audit replay;
					// the full-row identity tie is idempotent, but its missing relay audit entry remains a
					// stage-2 gap until primary records store both clocks. Strict `<` keeps the boundary audited.
					event.isCopyApply = messageIsCopyFrame && copyApplyActive() && auditRecord.version < copyModeStartTime;
					// Record which tables actually received an audit-less snapshot row so only those get a
					// reload marker at copy finalization (harper-pro#495). isCopyApply is exactly "invisible to
					// live subscribers" — a copy frame with version >= copyStartTime carries a real audit entry
					// and already delivers per-row events, so it needs no marker and is intentionally excluded.
					if (event.isCopyApply && event.table) copiedTablesThisPass.add(event.table);
					if (messageIsCopyFrame && event.table) lastCopyFrameKey = { table: event.table, id: event.id };
					tableSubscriptionToReplicator.send(event);
					// Per-record backpressure: a single large WS message can synchronously decode
					// thousands of records, each holding a decoded value object and a closure over
					// the source buffer. Without yielding here the consumer can never drain the
					// queue mid-message and the worker heap balloons until it OOMs.
					const queueLength = tableSubscriptionToReplicator.queue?.length ?? 0;
					if (queueLength > RECEIVE_EVENT_HIGH_WATER_MARK) {
						addPauseReason();
						try {
							await tableSubscriptionToReplicator.waitForDrain();
						} finally {
							removePauseReason();
						}
						lastYieldTime = performance.now();
					} else if (performance.now() - lastYieldTime >= RECEIVE_YIELD_INTERVAL) {
						// The high-water-mark pause only fires under heap pressure. When the consumer keeps
						// up, yield on a time budget anyway so a large message doesn't decode in one
						// synchronous turn and stall ping responses (see RECEIVE_YIELD_INTERVAL).
						await new Promise(setImmediate);
						lastYieldTime = performance.now();
					}
				}
				decoder.position = start + eventLength;
			} while (decoder.position < body.byteLength);
			outstandingCommits++;
			if (databaseName !== 'system') {
				recordAction(
					body.byteLength,
					'bytes-received',
					`${remoteNodeName}.${databaseName}.${event?.table || 'unknown_table'}`,
					'replication',
					'ingest'
				);
			}
			if (outstandingCommits > MAX_OUTSTANDING_COMMITS && !commitBacklogPaused) {
				commitBacklogPaused = true;
				addPauseReason();
				logger.debug?.(
					`Commit backlog causing replication back-pressure, requesting that ${remoteNodeName} pause replication`
				);
			}
			// Is this a bulk-copy frame? Only frames received before COPY_COMPLETE are part of the
			// primary-key copy; later audit-replay frames must not be recorded as the resume cursor.
			const isCopyFrame = messageIsCopyFrame; // latched above (consistent across the body despite awaits)
			if (isCopyFrame) {
				copyBytesSinceFlush += body.byteLength; // feed the copy-apply flush cadence (harper-pro#480)
				noteCopyProgress(); // a copy record batch arrived — the copy is advancing (#453)
			}
			// Capture the end_txn in a const so onCommit can clamp its `localTime` before the apply loop reads
			// it: core Table.ts awaits onCommit and only THEN reads `event.localTime` to persist the resume
			// cursor (same object — onCommit being callable proves the event isn't cloned across send()).
			const endTxnEvent: any = {
				type: 'end_txn',
				localTime:
					isCopyFrame || maxBatchTxnLogKey == null
						? lastSequenceIdReceived
						: Math.max(lastSequenceIdReceived ?? 0, maxBatchTxnLogKey), // resume cursor from the batch even without a sequence-update
				remoteNodeIds: receivingDataFromNodeIds,
				async onCommit() {
					// Test-only: hold this copy commit (and so the commit-backlog pause) open — see the hook.
					const testCommitDelay = isCopyFrame && maybeDelayCopyCommitForTest(databaseName);
					if (testCommitDelay) await testCommitDelay;
					if (event) {
						const latency = Date.now() - event.timestamp;
						if (databaseName !== 'system') {
							recordAction(
								latency,
								'replication-latency',
								remoteNodeName + '.' + databaseName + '.' + event.table,
								event.type,
								'ingest'
							);
						}
					}
					outstandingCommits--;
					// Consumer-progress tick for pauseStallWatchdog: the apply loop committed a queued batch,
					// which advances even while the receive socket is paused for back-pressure (harper-pro#466).
					consumerProgress++;
					if (copyCompleteReceived) noteCopyFinalizeProgress(true);
					if (commitBacklogPaused) {
						commitBacklogPaused = false;
						removePauseReason();
						logger.debug?.(`Replication resuming ${remoteNodeName}`);
					}
					// Record the highest committed sequence (this batch's resume cursor value). Commit ==
					// visibility; this is monotonic across batches. The durable watermark below only ever
					// catches up TO this value, never past it.
					committedSequence = Math.max(committedSequence, endTxnEvent.localTime ?? 0);
					// Advance the durable watermark WITHOUT awaiting blobs — for copy AND non-copy frames alike.
					// COPY MODE used to keep a synchronous `await Promise.all(outstandingBlobsToFinish)` here on
					// the assumption only the non-copy catch-up path could deadlock. That was wrong (#426): the
					// receive loop ws.pause()s on apply-queue backpressure, which starves the very BLOB_CHUNK
					// frames the await waits on — a circular wait that hangs base copies too once a copy is
					// blob-heavy enough to push the apply queue past the high-water mark mid-blob. So copy mode
					// now uses the same async watermark: advance immediately only when nothing is in flight and
					// there is no gap (the common blob-less / already-saved case); otherwise the watermark stays
					// put and the in-flight blobs' `.finally` advances it once the last one drains. A failed blob
					// (`hasBlobGap`) holds the watermark until a reconnect re-streams it. Because the watermark
					// only ever includes durable blobs, the persisted cursor never advances past an unfinished or
					// failed blob — preserving the no-data-loss guarantee — while the apply loop never blocks.
					if (outstandingBlobsToFinish.length === 0 && !hasBlobGap) lastDurableSequenceId = committedSequence;
					endTxnEvent.localTime = lastDurableSequenceId;
					// When this end_txn advances the durable seq to copyStartTime, the copyApply snapshot rows
					// (version < copyStartTime, WAL-off, no transaction-log entry) must be flushed to SST BEFORE
					// core persists [seq] = copyStartTime. Otherwise a small copy that finished before the cadence
					// flush persists the cursor with rows still in the memtable and no copyCursor, and a crash loses
					// them (resume-from-seq skips pre-copyStartTime rows). core awaits this onCommit, then calls
					// updateRecordedSequenceId, so awaiting the flush here orders flush-before-seq. (harper-pro#480)
					if (copyApplyActive() && inCopyMode && copyModeStartTime > 0 && lastDurableSequenceId >= copyModeStartTime) {
						await flushCopyRowsDurable();
					}
					if (isCopyFrame) {
						// Stage this copied key as the copy resume cursor. It is only PERSISTED once its blob (and
						// every earlier blob) is durable — by flushDurableCopyCursor() just below when eligible, or
						// otherwise from the blob save `.finally`. Same key-based durability guarantee as before; it
						// just no longer comes from blocking onCommit. Pass/anchor values were captured at decode
						// time; a stale-pass staging is dropped inside the watermark.
						if ((event?.table || lastCopyFrameKey) && copyFromNodeId !== undefined) {
							copyWatermark.stageCursor(copyFrameIndex, copyFramePass, {
								copyStartTime: copyFrameStartTime,
								currentTable: event?.table ?? lastCopyFrameKey!.table,
								afterKey: event?.id ?? lastCopyFrameKey!.id,
								copyOrder: copyFrameOrder, // validated by the leader before it trusts the resume skip (#421)
							});
						} else if (event && !event.table && copyFromNodeId !== undefined) {
							logger.warn?.(connectionId, 'copy cursor not advanced: event has no table name', databaseName);
						}
					}
					// Persist any staged copy cursor + (when durable) finish the copy. Called on EVERY commit —
					// copy frame or not — because the copy can complete on a trailing NON-copy frame: the sender
					// streams catch-up audit-replay frames right after COPY_COMPLETE, and the commit that finally
					// drains outstandingCommits to 0 may be one of those (isCopyFrame === false). If only copy
					// frames re-checked, that trailing frame would leave the clone stuck in copy mode forever
					// (cursor never cleared, per-record received-version updates suppressed → never Available).
					// This restores the original unconditional maybeFinishCopy() call; the blob-durability gate
					// now lives inside flushDurableCopyCursor()/maybeFinishCopy().
					flushDurableCopyCursor();
					if (!lastSequenceIdCommitted && sequenceIdReceived) {
						logger.trace?.(connectionId, 'queuing confirmation of a commit at', sequenceIdReceived);
						setTimeout(() => {
							// Gate the receipt on the durable watermark. Now that onCommit no longer awaits the
							// blob saves, a commit's blobs may still be in flight at send time; confirming the raw
							// committed sequence would tell the sender we durably hold past `lastDurableSequenceId`
							// and let it discard a blob we haven't yet saved. Clamp to the watermark so we never
							// claim durability beyond what we'd actually resume from after a crash. (Copy frames
							// already awaited their blobs above, so the watermark covers them too.)
							const confirmed = Math.min(lastSequenceIdCommitted, lastDurableSequenceId);
							ws.send(encode([COMMITTED_UPDATE, confirmed]));
							logger.trace?.(connectionId, 'sent confirmation of a commit at', confirmed);
							lastSequenceIdCommitted = null;
						}, COMMITTED_UPDATE_DELAY);
					}
					if (sequenceIdReceived) {
						lastSequenceIdCommitted = sequenceIdReceived;
					}
					logger.debug?.('last sequence committed', new Date(lastSequenceIdCommitted), databaseName);
				},
			};
			tableSubscriptionToReplicator.send(endTxnEvent);
		} catch (error) {
			closeOnInboundMessageError(error, {
				connectionId,
				logger,
				markInboundClosed: () => (wsClosed = true),
				close,
			});
		}
	}
	ws.on('ping', resetPingTimer);
	ws.on('pong', resetPingTimer);
	ws.on('pong', () => {
		if (options.connection) {
			// every pong we can use to update our connection information (and latency)
			const latency = performance.now() - lastPingTime;
			options.connection.latency = latency;
			if (getSharedStatus()) {
				replicationSharedStatus[LATENCY_POSITION] = latency;
				// A pong confirms the link is alive in both directions; record it as the authoritative state —
				// but only from the connection that owns the (db, peer) subscription truth (an inbound or
				// cache-miss retrieval connection shares the buffer key and must not stamp CONNECTED for it).
				if (options.connection?.nodeSubscriptions !== undefined) {
					replicationSharedStatus[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
					replicationSharedStatus[LAST_LIVENESS_TIME_POSITION] = Date.now();
				}
			}
			// update the manager with latest connection information
			if (options.isSubscriptionConnection) {
				connectedToNode({
					name: remoteNodeName,
					database: databaseName,
					url: options.url,
					latency,
				});
			}
		}
		lastPingTime = null;
	});
	// Complete teardown of THIS replicateOverWS instance: every interval, watchdog, subscription,
	// pending request, and in-flight blob it owns. Runs on the socket's real 'close' and on explicit
	// supersession (forceReconnect retiring the previous session, or a stale watchdog fire detecting
	// its socket was replaced) — a superseded instance whose close never fires would otherwise keep
	// its keepalive refreshing shared liveness and leak an instance per recovery cycle. Idempotent so
	// supersession followed by a late real close runs it once.
	let instanceRetired = false;
	function retireInstance(code?, reasonBuffer?) {
		if (instanceRetired) return;
		instanceRetired = true;
		wsClosed = true;
		pendingSubscriptionSetupRequestId = undefined;
		clearInterval(sendPingInterval);
		receiveWatchdog?.stop();
		subscriptionSetupWatchdog?.stop();
		pauseStallWatchdog?.stop();
		copyProgressWatchdog?.stop();
		blobGapReconnectTimer?.stop();
		copyFinalizeWatchdog?.stop();
		// A pending copy-cursor flush retry must die with the connection: persistCopyCursor guards on
		// wsClosed, and leaving the timer would only wake a closure whose persists are all no-ops now.
		clearTimeout(copyFlushRetryTimer);
		copyFlushRetryTimer = undefined;
		clearInterval(blobsTimer);
		clearInterval(backPressureInterval);
		// The blobsTimer that would otherwise reap stalled receives is now cleared, and the connection is
		// gone, so abort any in-flight blob receives immediately instead of waiting up to blobTimeout for
		// core's source-idle watchdog. This clamps the resume cursor (transient failure) so the reconnect
		// re-requests them promptly — a worker restart on the sender (deploy_component lifecycle) closes the
		// WS mid-blob, and holding the stream for the full timeout is what leaves the blob diverged.
		// Tombstones only matter while the sender that queued those chunks is still attached; a reconnect
		// re-streams from the resume cursor, so carrying them across would drop chunks we do want.
		skippedBlobIds.clear();
		if (blobsInFlight.size > 0) {
			const aborted = abortInFlightBlobsOnClose(blobsInFlight, remoteNodeName, (_blobId, stream) =>
				unregisterBlobReceiveInFlight(stream.fileId, auditStore?.rootStore)
			);
			logger.debug?.(connectionId, `aborted ${aborted} in-flight blob receive(s) on close for re-request`);
		}
		if (auditSubscription) auditSubscription.emit('close');
		if (subscriptionRequest) subscriptionRequest.end();
		if (hdbNodesSubscription) hdbNodesSubscription.end();
		// Wake queued blob senders and writer waits so they observe wsClosed instead of parking forever
		while (blobSentCallbacks.length > 0) blobSentCallbacks.shift()?.();
		for (const callbacks of blobFileSentCallbacks.values()) {
			while (callbacks.length > 0) callbacks.shift()?.();
		}
		blobFileSentCallbacks.clear();
		for (const [_id, { reject }] of awaitingResponse) {
			reject(new Error(`Connection closed ${reasonBuffer?.toString()} ${code}`));
		}
		if (Object.keys(repairDeclines).length > 0)
			logger.warn?.(connectionId, 'blob repair declines for this connection', repairDeclines);
		logger.debug?.(connectionId, 'closed', code, reasonBuffer?.toString());
	}
	ws.on('close', retireInstance);

	function close(code?, reason?, intentional?: boolean) {
		try {
			// Only the deliberate "we are done with this connection" call sites pass intentional=true
			// (currently just the empty-subscription delayed close below). Everything else — auth
			// failures after open, peer-initiated DISCONNECT, schema/sequence errors — is a
			// transient protocol close that should reconnect, so we let the WS close event fall
			// through to NodeReplicationConnection's normal retry path instead of marking the
			// connection as finished or emitting 'finished' (which would remove it from the
			// worker's connections map).
			if (intentional && options.connection) options.connection.intentionallyUnsubscribed = true;
			logger.debug?.(connectionId, 'closing', remoteNodeName, databaseName, code, reason);
			ws.close(code, reason);
			if (intentional) options.connection?.emit('finished'); // synchronously indicate that the connection is finished, so it is not accidentally reused
		} catch (error) {
			logger.error?.(connectionId, 'Error closing connection', error);
		}
	}
	// Track the blobs being sent, so we can wait for them to finish before sending the next blob.
	// The same blobs can't be sent concurrently of the packets will get mixed up. The receiving
	// end should handle aggregated the results of the same blob for separate record requests.
	const blobsBeingSent = new Set();
	// Copy frames use a per-record transfer id so a skipped record cannot suppress an applied record
	// with the same file id. Keep those transfers serialized by file id: a mixed-version receiver only
	// knows the file id and would otherwise merge concurrent streams into one corrupt blob.
	const fileIdsBeingSent = new Set();
	const blobFileSentCallbacks = new Map<any, Array<() => void>>();
	let blobSendErrorsSuppressed = 0;
	let lastBlobSendErrorLog = 0;
	// Throttle state for the blob-send visibility warnings below (park-on-cap, unpark, declined).
	// Each bucket is throttled independently so a burst under one cause can't drown the others.
	const parkWarnThrottle = createThrottleState();
	const unparkWarnThrottle = createThrottleState();
	const declineWarnThrottle = createThrottleState();
	function warnThrottled(state: ThrottleState, message: string, details: Record<string, unknown>) {
		const { emit, suppressedCount } = decideThrottledWarn(state, Date.now());
		if (!emit) return;
		if (suppressedCount > 0) {
			logger.warn?.(`Suppressed ${suppressedCount} additional "${message}" warnings in the last ${WARN_THROTTLE_MS}ms`);
		}
		logger.warn?.(message, details);
	}
	function warnBlobSendDeclined(id, reason: string) {
		warnThrottled(declineWarnThrottle, 'Not sending blob; peer will rely on re-request to converge', {
			fileId: id,
			database: databaseName,
			node: remoteNodeName,
			reason,
		});
	}
	async function sendBlobs(blob: Blob, recordId: any) {
		// found a blob, start sending it
		const id = getFileId(blob);
		const transferId = (blob as Blob & { replicationTransferId?: number }).replicationTransferId;
		const blobSendKey = transferId ?? id;
		if (blobsBeingSent.has(blobSendKey)) {
			logger.debug?.('Blob already being sent', id);
			return;
		}
		if (wsClosed) {
			warnBlobSendDeclined(id, 'connection closed');
			return;
		}
		if (isDrainingBlobSends()) {
			// The worker is draining for shutdown; don't start a new send that we'd only tear down (or
			// hold the drain open for). The peer re-requests this blob on reconnect (harper-pro#527).
			warnBlobSendDeclined(id, 'worker draining for shutdown');
			return;
		}
		blobsBeingSent.add(blobSendKey);
		// Retain the file for as long as this send needs it. The blob was resolved from the record
		// being replicated, but the file is not opened until `blob.stream()` below — and between here
		// and there this send can park on the outstanding-sends cap for an unbounded time. A write
		// that supersedes the record in that gap reclaims the file, so the send reads a missing file
		// and reports it to the peer as unrecoverable at source; the peer then advances its resume
		// cursor past a record whose bytes it will never have (harper-pro#403/#388).
		// A null hold means reclamation already claimed the file: the read below will fail, and the
		// error frame it produces is the honest answer for the peer.
		const releaseBlobHold = holdBlobFile(blob);
		if (!releaseBlobHold) logger.debug?.(`Blob ${id} is already being reclaimed; sending it will report it missing`);
		// Acquire a send slot before opening the blob stream. Enforcing the cap only at the audit
		// writer's backpressure check didn't bound concurrency: there it sat in an else-if behind the
		// drain wait (unreachable while the socket stayed congested) and the GET_RECORD path never
		// checked it at all, so concurrent sends grew by one per drain event (200+ drain listeners
		// on one TLSSocket observed in the field).
		let parkWarned = false;
		let parkStartedAt = 0;
		let parkWarnTimer: NodeJS.Timeout | undefined;
		if (outstandingBlobsBeingSent >= MAX_OUTSTANDING_BLOBS_BEING_SENT) {
			parkStartedAt = Date.now();
			// Only fires if still parked once PARK_WARN_MS elapses; cleared below the moment we unpark
			// or bail out, so a send that acquires a slot quickly never logs anything.
			parkWarnTimer = setTimeout(() => {
				parkWarned = true;
				warnThrottled(parkWarnThrottle, 'Blob send parked on the outstanding-sends cap', {
					fileId: id,
					database: databaseName,
					node: remoteNodeName,
					outstandingBlobsBeingSent,
					waitedMs: Date.now() - parkStartedAt,
				});
			}, PARK_WARN_MS);
			parkWarnTimer.unref?.();
		}
		while (outstandingBlobsBeingSent >= MAX_OUTSTANDING_BLOBS_BEING_SENT) {
			await new Promise((resolve) => blobSentCallbacks.push(resolve));
			if (wsClosed) {
				clearTimeout(parkWarnTimer);
				blobsBeingSent.delete(blobSendKey);
				releaseBlobHold?.();
				return;
			}
			if (isDrainingBlobSends()) {
				// A shutdown drain can start while this send was queued behind the concurrency cap;
				// don't let a freshly-dequeued send start after that point (same reasoning as the
				// pre-queue check above).
				clearTimeout(parkWarnTimer);
				warnBlobSendDeclined(id, 'worker draining for shutdown (while parked on the outstanding-sends cap)');
				blobsBeingSent.delete(blobSendKey);
				releaseBlobHold?.();
				return;
			}
		}
		clearTimeout(parkWarnTimer);
		if (parkWarned) {
			warnThrottled(unparkWarnThrottle, 'Blob send unparked after waiting on the outstanding-sends cap', {
				fileId: id,
				database: databaseName,
				node: remoteNodeName,
				waitedMs: Date.now() - parkStartedAt,
			});
		}
		while (fileIdsBeingSent.has(id)) {
			await new Promise<void>((resolve) => {
				const callbacks = blobFileSentCallbacks.get(id);
				if (callbacks) callbacks.push(resolve);
				else blobFileSentCallbacks.set(id, [resolve]);
			});
			if (wsClosed) {
				blobsBeingSent.delete(blobSendKey);
				releaseBlobHold?.();
				return;
			}
		}
		let fileSendClaimed = false;
		let outstandingSlotClaimed = false;
		let drainToken: ReturnType<typeof registerBlobSend> | undefined;
		try {
			fileIdsBeingSent.add(id);
			fileSendClaimed = true;
			while (outstandingBlobsBeingSent >= MAX_OUTSTANDING_BLOBS_BEING_SENT) {
				await new Promise((resolve) => blobSentCallbacks.push(resolve));
				if (wsClosed) return;
				if (isDrainingBlobSends()) {
					warnBlobSendDeclined(id, 'worker draining for shutdown (after waiting for the same file id)');
					return;
				}
			}
			// Track this send so a worker restart can gracefully drain it (finish it if it's still making
			// progress) before shutting down, rather than tearing it down mid-stream. See blobSendDrain.ts.
			drainToken = registerBlobSend();
			outstandingBlobsBeingSent++;
			outstandingSlotClaimed = true;
			// Per-chunk timeout: races each iterator.next() against a setTimeout reject so a stuck
			// underlying read can't park the send loop forever. The local blob file may be missing or
			// confidently corrupt; the read stream then sits without emitting `data`, `end`, or
			// `error`, the for-await waits indefinitely, no finishing BLOB_CHUNK is ever sent, and the
			// receiver's apply consumer wedges at `lastReceivedStatus:"Receiving"` until its own idle
			// watchdog fires (core/resources/blob.ts) 120s later. With the timeout, the catch below
			// emits the finishing error frame so the receiver advances cleanly.
			// Defaults ON to the replication blob timeout (REPLICATION_BLOBTIMEOUT, 900000 default) so a
			// stalled send can't silently wedge a base copy out of the box (harper-pro#453). The
			// HARPER_BLOB_SEND_CHUNK_TIMEOUT_MS env var overrides it; set it to 0 to disable.
			const rawEnv = process.env.HARPER_BLOB_SEND_CHUNK_TIMEOUT_MS;
			const chunkTimeoutMs = rawEnv != null && rawEnv !== '' ? Math.max(0, Number(rawEnv) || 0) : blobTimeout;
			// Once any chunk is on the wire the receiver holds partial state, so a failed read can only be
			// resolved by the error frame; before that, a 503 read fault (transiently unavailable at this
			// node — typically a PENDING placeholder from a concurrent receive, which heals within seconds)
			// is retried in place rather than forwarded, since a forwarded 503 latches the receiver's blob
			// gap and pins its resume cursor until a reconnect (#683).
			let sentAnyChunk = false;
			for (let attempt = 0; ; attempt++) {
				// Opened inside the try: if core surfaces the 503 synchronously from stream() rather than
				// from the first iterator.next(), the retry (and the error frame) must still engage.
				let iterator: AsyncIterator<Uint8Array> | undefined;
				try {
					iterator = blob.stream()[Symbol.asyncIterator]();
					let lastBuffer: Buffer;
					while (true) {
						let result: IteratorResult<any>;
						if (chunkTimeoutMs > 0) {
							let timer: NodeJS.Timeout | undefined;
							try {
								result = await Promise.race([
									iterator.next(),
									new Promise<never>((_, reject) => {
										timer = setTimeout(
											() => reject(new Error(`Blob send chunk timeout after ${chunkTimeoutMs}ms (fileId=${id})`)),
											chunkTimeoutMs
										);
										timer.unref();
									}),
								]);
							} finally {
								if (timer) clearTimeout(timer);
							}
						} else {
							result = await iterator.next();
						}
						if (result.done) break;
						const buffer = result.value as Buffer;
						if (lastBuffer) {
							logger.debug?.('Sending blob chunk', id, 'length', lastBuffer.length);
							// do the previous buffer so we know if it is the last one or not
							ws.send(
								encode([
									BLOB_CHUNK,
									{
										fileId: id,
										transferId,
										size: blob.size,
									},
									lastBuffer,
								])
							);
							sentAnyChunk = true;
						}
						lastBuffer = buffer;
						// Optional-chain the guard: the connection can close during an await, leaving `_socket` null.
						if (ws._socket?.writableNeedDrain) {
							logger.debug?.('draining', id);
							// Waiting on the socket to flush IS progress — mark it so a shutdown drain doesn't misread a
							// slow-but-alive peer (a large chunk taking longer than the stall window to flush) as stalled.
							noteBlobSendProgress(drainToken);
							// Races against close/error so a mid-flush disconnect still lets `finally` below run
							// (endBlobSend/outstandingBlobsBeingSent cleanup) instead of hanging on a `drain` that
							// will never fire (harper-pro#529 review, cb1kenobi).
							await waitForDrainOrSocketEnd(ws._socket, ws);
							logger.debug?.('drained', id);
						}
						recordAction(buffer.length, 'bytes-sent', `${remoteNodeName}.${databaseName}`, 'replication', 'blob');
						noteBlobSendProgress(drainToken);
					}
					// A zero-chunk stream (a legitimately empty blob) leaves lastBuffer unset; send the
					// terminal frame with an empty body rather than throwing. The old TypeError here fed the
					// receiver a code-less error frame, classified transient, latching its gap — with the
					// repeating watchdog that would now mean a reconnect cycle every blobTimeout, forever.
					lastBuffer ??= Buffer.alloc(0);
					logger.debug?.('Sending final blob chunk', id, 'length', lastBuffer.length);
					if (checkExcessMessageSize(lastBuffer.length)) throw new Error('Blob chunk too large');
					ws.send(
						encode([
							BLOB_CHUNK,
							{
								fileId: id,
								transferId,
								size: blob.size,
								finished: true,
							},
							lastBuffer,
						])
					);
					sentAnyChunk = true;
					noteBlobSendProgress(drainToken);
					// Keep this send "in flight" until the terminal frame has actually flushed to the socket, so a
					// concurrent shutdown drain waits for the `finished:true` frame rather than exiting with it still
					// buffered (which would leave the peer's blob diverged until it re-requests). Only waits under
					// backpressure; if the peer stops reading, the drain's stall detection abandons it after the
					// stall window and the receiver re-requests (harper-pro#527).
					if (ws._socket?.writableNeedDrain) {
						// Same close/error race as the mid-loop wait above — otherwise a peer that disconnects
						// while this terminal-frame flush is parked on backpressure never lets `finally` run.
						await waitForDrainOrSocketEnd(ws._socket, ws);
						noteBlobSendProgress(drainToken);
					}
					break;
				} catch (error) {
					try {
						await iterator?.return?.();
					} catch {}
					if (shouldRetrySourceBlobRead({ error, sentAnyChunk, wsClosed, draining: isDrainingBlobSends(), attempt })) {
						logger.debug?.(
							'Blob read transiently unavailable; retrying before forwarding the error',
							id,
							'attempt',
							attempt + 1,
							errorToString(error)
						);
						// Deliberately NOT noted as blob-send progress: a purely-retrying send has moved no
						// bytes, and a shutdown drain should be free to reap it (the peer re-requests, #527).
						await delay(BLOB_SEND_RETRY_DELAYS_MS[attempt]);
						continue;
					}
					// Throttle the warn (a peer backfilling thousands of already-deleted blobs makes this fire
					// at kHz); the error frame below is unconditional
					const errorLogTime = Date.now();
					if (errorLogTime - lastBlobSendErrorLog >= 5000) {
						if (blobSendErrorsSuppressed > 0) {
							logger.warn?.(`Suppressed ${blobSendErrorsSuppressed} additional blob send errors in the last 5s`);
						}
						blobSendErrorsSuppressed = 0;
						lastBlobSendErrorLog = errorLogTime;
						logger.warn?.('Error sending blob', error, 'blob id', id, 'for record', recordId);
					} else blobSendErrorsSuppressed++;
					// Forward the error CODE and STATUS alongside the message so the receiver can tell a PERMANENT
					// source failure — the blob is gone (ENOENT/404) or confidently corrupt/incomplete (500,
					// harper-pro#429) — from a TRANSIENT read fault (EIO, EMFILE, timeout, 503 write-in-progress —
					// a reconnect may succeed). Only the former lets the receiver advance the resume cursor past the
					// blob; the latter must still hold so the gap is retried. `errorCode` is the fs `.code` (set by
					// pre-#1425 core); `errorStatus` is the HTTP-style status core PR harper#1425 attaches to
					// `BlobReadError` (its read paths no longer carry a raw fs `.code`). See harper-pro#403 and
					// receiveBlobs's classification.
					ws.send(
						encode([
							BLOB_CHUNK,
							{
								fileId: id,
								transferId,
								finished: true,
								error: errorToString(error),
								errorCode: (error as { code?: string })?.code,
								errorStatus: (error as { statusCode?: number })?.statusCode,
							},
							Buffer.alloc(0),
						])
					);
					break;
				}
			}
		} finally {
			if (drainToken) endBlobSend(drainToken);
			blobsBeingSent.delete(blobSendKey);
			releaseBlobHold?.();
			if (fileSendClaimed) {
				fileIdsBeingSent.delete(id);
				const nextFileSend = blobFileSentCallbacks.get(id)?.shift();
				if (nextFileSend) nextFileSend();
				else blobFileSentCallbacks.delete(id);
			}
			if (outstandingSlotClaimed) {
				outstandingBlobsBeingSent--;
				while (outstandingBlobsBeingSent < MAX_OUTSTANDING_BLOBS_BEING_SENT && blobSentCallbacks.length > 0) {
					blobSentCallbacks.shift()?.();
				}
			}
		}
	}
	// A budget with nothing tracked costs one size check, so the healthy path builds no key.
	function settleBlobGapBudget(blobId: string, id: unknown, tableName: string | undefined) {
		const budget = options.connection?.blobGapBudget;
		if (budget && budget.size > 0) budget.resolve(blobGapDeliveryKey(blobId, id, tableName), blobGapGeneration);
	}
	function receiveBlobs(
		remoteBlob: Blob,
		id: string | number,
		copyFrameIndex?: number,
		repairTarget?: any,
		tableName?: string
	) {
		// write the blob to the blob store
		const blobId = getFileId(remoteBlob);
		const transferId = getBlobTransferId(remoteBlob);
		const streamKey = getBlobTransferKey(blobId, transferId);
		// A record that IS being applied always outranks a tombstone for the same transfer. A matching
		// file id alone is insufficient: adjacent copy records can share an id while requiring distinct
		// transfers, and clearing either one's tombstone would route the other record's chunks incorrectly.
		skippedBlobIds.delete(streamKey);
		let stream = blobsInFlight.get(streamKey);
		logger.debug?.('Received transaction with blob', blobId, 'has stream', !!stream, 'ended', !!stream?.writableEnded);
		if (stream) {
			if (stream.writableEnded) blobsInFlight.delete(streamKey);
		} else {
			stream = createBlobReceiveStream(blobTimeout);
			stream.fileId = blobId;
			blobsInFlight.set(streamKey, stream);
			registerBlobReceiveInFlight(blobId, auditStore?.rootStore);
		}
		stream.connectedToBlob = true;
		stream.lastChunk = Date.now();
		stream.recordId = id;
		if (remoteBlob.size === undefined && stream.expectedSize) (remoteBlob as any).size = stream.expectedSize;
		if (stream.blob && inPlaceRepairedBlobs.has(stream.blob)) return stream.blob;
		// In-place dangling-reference repair (#699): this record is an identity-tie duplicate and
		// `repairTarget` is the stored record's damaged blob — stream the re-delivered bytes INTO its
		// existing fileId instead of minting a fresh one the tie-skipped record would never reference.
		// A repair that cannot acquire its file lock fails this delivery and holds the resume cursor;
		// saving fresh would let the tie-skipped record keep its damaged reference while the cursor advances.
		let localBlob: any;
		let finished: Promise<void> | undefined;
		if (repairTarget && !stream.blob) {
			const sizesMatch =
				repairTarget.size === undefined || remoteBlob.size === undefined || repairTarget.size === remoteBlob.size;
			if (sizesMatch)
				finished = decodeFromDatabase(
					() => repairBlobFile(repairTarget, stream, () => stream.expectedSize ?? remoteBlob.size),
					tableSubscriptionToReplicator.auditStore?.rootStore
				);
			if (!finished) {
				const reason = sizesMatch ? 'repair-start-declined' : 'repair-size-mismatch';
				repairDeclines[reason] = (repairDeclines[reason] ?? 0) + 1;
				const error = new Error(`Blob repair deferred for damaged file ${getFileId(repairTarget)} (${reason})`);
				stream.destroy(error);
				finished = Promise.reject(error);
			}
			localBlob = repairTarget;
			inPlaceRepairedBlobs.add(repairTarget);
		}
		if (!localBlob) {
			localBlob = stream.blob ?? createBlob(stream, remoteBlob);
			// start the save immediately. TODO: If we could add support for blobs to directly pass on a stream to the consumer
			// we would skip this
			finished = decodeFromDatabase(
				() => saveBlob(localBlob).saving,
				tableSubscriptionToReplicator.auditStore?.rootStore
			);
		}
		stream.blob = localBlob; // record the blob so we can reuse it if another request uses the same blob
		if (finished && !stream.writableEnded && !stream.destroyed) {
			// The close handler may have swept blobsInFlight before this already-queued record handler
			// creates and attaches its stream. Without this post-attach ownership check, the orphaned
			// source has no producer or connection timer left and an in-place repair holds its file lock
			// until core's long source-idle timeout. Fail it now so the next connection can repair it.
			abortLateBlobReceiveAfterClose(
				isConnectionSuperseded(wsClosed, options.connection, ws),
				stream,
				remoteNodeName,
				blobId
			);
		}
		if (finished) {
			// A copy-frame blob gates the copy cursor by walk position; a gapped settle clamps the
			// watermark from this frame onward while earlier frames keep banking (#699).
			copyWatermark.trackBlob(copyFrameIndex);
			let copyBlobGapped = false;
			let saveFailed = false;
			// We log the rejection via .catch() and also need the resulting promise — not the
			// raw `finished` — to be what we hand to `Promise.all(outstandingBlobsToFinish)` in
			// the end_txn onCommit path below. If we pushed `finished` directly, a save
			// rejection would surface to that `await Promise.all(...)` as an unhandled error
			// even though we already logged it here, and it would escape onCommit as an
			// uncaughtException — observed in prod as ~35/sec ENOENT spam during catch-up.
			const tracked = finished
				.catch((err) => {
					// This .catch runs inside the same microtask chain that onCommit's
					// `await Promise.all(outstandingBlobsToFinish)` is waiting on; we deliberately do NOT tear
					// down here. Classify the failure to decide whether the resume cursor holds or advances.
					saveFailed = true;
					if (isReplicationConnectionClosedError(err)) {
						// The connection closed mid-blob (e.g. a peer worker restart in the deploy_component
						// lifecycle). Clamp like any transient gap so the reconnect re-requests it, but skip the
						// error log and the divergence metric below — this is routine and self-healing, and would
						// otherwise spam logs / inflate cluster_status.blobReplicationFailures on every deploy.
						logger.debug?.(
							connectionId,
							`Blob ${blobId} receive interrupted by connection close; will re-request on reconnect`
						);
						// No watchdog arm here: this branch only runs because the connection is already closing,
						// so the healing reconnect is already in motion (#683).
						hasBlobGap = true;
						copyBlobGapped = true;
						return;
					}
					// A source-reported 503 would hold below; charge it against the connection's cross-reconnect
					// budget first, so a delivery the origin keeps failing is reclassified as unrecoverable once
					// its budget is spent and skipped exactly like a 404/500 (harper-pro#432). Charged here, not
					// at the frame, because only a failed save proves the delivery holds the cursor.
					// Budget bookkeeping must never throw into this chain: a throw here would skip both the hold
					// and the advance-past branch, and in the `.finally` below it would leave the blob in flight
					// for good.
					try {
						if (
							BLOB_GAP_ESCALATION_ENABLED &&
							options.connection &&
							isBudgetedSourceBlobError(err) &&
							!isUnrecoverableSourceBlobError(err)
						) {
							const budget = (options.connection.blobGapBudget ??= createBlobGapEscalationBudget({
								maxCycles: BLOB_GAP_ESCALATION_CYCLES,
								maxHoldMs: BLOB_GAP_ESCALATION_MS,
								generation: options.connection.blobGapGeneration,
								onCapacity: blobGapCapacityWarning(remoteNodeName, databaseName),
							}));
							const escalation = budget.charge(blobGapDeliveryKey(blobId, id, tableName), blobGapGeneration);
							if (escalation) markSourceBlobUnavailable(err, escalation);
						} else if (isUnrecoverableSourceBlobError(err)) {
							settleBlobGapBudget(blobId, id, tableName);
						}
					} catch (budgetError) {
						logger.warn?.(`Blob-gap escalation budget error for ${blobId} from ${remoteNodeName}`, budgetError);
					}
					if (isUnrecoverableSourceBlobError(err)) {
						// The sender reported it cannot provide this blob (BLOB_CHUNK `error` marker — typically
						// ENOENT because the blob was evicted/expired at the origin). Re-streaming on reconnect
						// reproduces the identical error, so holding `hasBlobGap` would wedge the connection
						// forever and block every healthy record behind it (harper-pro#403). Leave `hasBlobGap`
						// unset so the watermark advances past it; the diverged record is left for proactive
						// blob backfill (harper-pro#388). Recorded loudly below so the skip is never silent.
						const escalation = getBlobGapEscalation(err);
						logger.error?.(
							escalation
								? `Blob ${blobId} for record ${id} stayed transiently unavailable at source ${remoteNodeName} (${errorToString(err)}) — ` +
										describeBlobGapEscalation(escalation, {
											maxCycles: BLOB_GAP_ESCALATION_CYCLES,
											maxHoldMs: BLOB_GAP_ESCALATION_MS,
										}) +
										`; advancing the resume cursor past it — the record's blob stays diverged until backfilled (repair_blob_data, harper-pro#388/#432).`
								: `Blob ${blobId} for record ${id} is unrecoverable at source ${remoteNodeName} (${errorToString(err)}); ` +
										`advancing the resume cursor past it — the record's blob stays diverged until backfilled (harper-pro#388).`
						);
						// Missing is the unambiguous backfill signal. This also unlinks a damaged in-place repair
						// target, but never healthy bytes: this branch only follows a failed write to that target.
						deleteBlob(localBlob);
					} else {
						logger.error?.(`Blob save failed for ${blobId} from ${remoteNodeName}`, err);
						// A local/transient save fault. Mark a blob gap so onCommit and the sequence-update branch
						// clamp the persisted resume cursor at the last fully-durable transaction
						// (lastDurableSequenceId) instead of advancing over the gap; records keep flowing live and
						// the next reconnect/restart resumes from the clamp and re-saves the disrupted blob. A
						// transient catch-up fault (e.g. a blob-stream timeout) clears on resume. Nothing else in
						// the connection's lifetime clears the latch, so bound it: the watchdog forces the healing
						// reconnect if none happens on its own (#683).
						hasBlobGap = true;
						copyBlobGapped = true;
						blobGapReconnectTimer?.arm();
					}
					// Either failure is an observable divergence: surface the metric (cluster_status) and, on a
					// sustained link, one escalation line — see harper-pro#386.
					recordBlobReplicationFailure(getSharedStatus(), Date.now());
					if (
						shouldLogSustainedBlobDivergence(
							++blobFailureCount,
							SUSTAINED_BLOB_FAILURE_THRESHOLD,
							sustainedBlobFailureLogged
						)
					) {
						sustainedBlobFailureLogged = true;
						logger.error?.(
							`Sustained blob replication divergence from ${remoteNodeName}: ${blobFailureCount} blob saves have failed on this connection ` +
								`(cluster_status.blobReplicationFailures reports the cumulative total across connections); ` +
								`transient gaps hold the resume cursor for re-streaming, unrecoverable (source-missing) blobs are skipped past. ` +
								`Check cluster_status (blobReplicationFailures/lastBlobFailure).`
						);
					}
				})
				.finally(() => {
					logger.debug?.(`Finished receiving blob stream ${blobId}`);
					unregisterBlobReceiveInFlight(blobId, auditStore?.rootStore);
					if (!saveFailed) {
						try {
							settleBlobGapBudget(blobId, id, tableName);
						} catch (budgetError) {
							logger.warn?.(`Blob-gap escalation budget error for ${blobId} from ${remoteNodeName}`, budgetError);
						}
					}
					// Settle before flushDurableCopyCursor below so the watermark sees this blob's outcome
					// (an unrecoverable-source skip settles un-gapped — the cursor advances past it, #403).
					copyWatermark.settleBlob(copyFrameIndex, copyBlobGapped);
					const index = outstandingBlobsToFinish.indexOf(tracked);
					if (index > -1) outstandingBlobsToFinish.splice(index, 1);
					if (copyCompleteReceived) noteCopyFinalizeProgress();
					// Advance the durable watermark when the LAST in-flight blob settles without a held gap. The
					// splice above runs first so the length check sees the post-removal count. A local/transient
					// save FAILURE set `hasBlobGap` in the `.catch` (which runs before this `.finally`), so the
					// `!hasBlobGap` guard keeps the watermark pinned until a reconnect re-streams it. A clean drain
					// — OR an unrecoverable source-missing blob that was skipped (which intentionally leaves
					// `hasBlobGap` unset, see the `.catch`) — lets the watermark catch up to the highest committed
					// sequence, which the next end_txn/sequence-update persists as the resume cursor.
					if (outstandingBlobsToFinish.length === 0 && !hasBlobGap) {
						lastDurableSequenceId = committedSequence;
						// The last in-flight blob is now durable. Any resume-cursor update we sent earlier while it
						// was outstanding was clamped to the pre-drain watermark (cursorBlockedByBlob() at the
						// REMOTE_SEQUENCE_UPDATE / SEQUENCE_ID_UPDATE sites). Re-emit an end_txn at the now-durable
						// received sequence so core persists the advance. Without this, a copy that completes and
						// then goes quiescent — no later sequence-update to carry the clamp forward — would leave the
						// persisted resume cursor below copyStartTime and force a needless base copy on restart (#426).
						// Safe: at drain with no gap, every received record (incl. blobs) through lastSequenceIdReceived
						// is durable, and core applies this end_txn after the records already enqueued ahead of it, so
						// the cursor never advances past an uncommitted/undurable point. max() keeps it monotonic.
						tableSubscriptionToReplicator.send(
							seqUpdateEndTxn(Math.max(lastSequenceIdReceived ?? 0, lastDurableSequenceId))
						);
					}
					// In copy mode, the last blob draining is also what makes the staged key-based copy cursor
					// durable: persist it (and finish the copy if COPY_COMPLETE already arrived). No-op outside
					// copy mode or while blobs/gaps remain. This is the copy analog of the watermark advance above.
					flushDurableCopyCursor();
				});
			(tracked as any).blobId = blobId;
			outstandingBlobsToFinish.push(tracked);
		}
		return localBlob;
	}
	let hdbNodesSubscription;
	let lastSentExcludedNodes: string[] = [];
	function sendSubscriptionRequestUpdate() {
		// once we have received the node name, and we know the database name that this connection is for,
		// we can send a subscription request, if no other threads have subscribed.
		if (!subscribed) {
			subscribed = true;
			options.connection?.on('subscriptions-updated', sendSubscriptionRequestUpdate);

			// Subscribe to hdbNodesTable changes to dynamically update excluded nodes
			if (options.connection) {
				getHDBNodeTable()
					.subscribe({})
					.then(async (subscription) => {
						hdbNodesSubscription = subscription;
						for await (const event of subscription) {
							if (event.type === 'delete') {
								// Node was removed, no action needed on excluded list
								continue;
							}

							const node = event.value;
							const nodeName = event.id;
							const thisNodeName = getThisNodeName();

							if (nodeName === thisNodeName || !nodeName) continue;

							// Check if this node qualifies for replication
							const qualifies =
								node?.replicates === true ||
								node?.replicates?.sends ||
								node?.subscriptions?.some(
									(sub) => (sub.database || sub.schema) === databaseName && sub.subscribe !== false
								);

							// Get current state of excluded nodes based on last sent list
							const currentlyExcluded = lastSentExcludedNodes.includes(nodeName);

							// Determine if we should exclude this node
							const shouldExclude =
								qualifies && !options.connection?.nodeSubscriptions?.some((sub) => sub.name === nodeName);

							if (shouldExclude && !currentlyExcluded) {
								// Need to add to excluded list (exclude this node's log)
								logger.debug?.(connectionId, 'sending subscription update to exclude node:', nodeName);
								ws.send(encode([SUBSCRIPTION_UPDATE, { excludeNodes: [nodeName] }]));
								lastSentExcludedNodes.push(nodeName);
							} else if (!shouldExclude && currentlyExcluded) {
								// Need to remove from excluded list (include this node's log)
								logger.debug?.(connectionId, 'sending subscription update to include node:', nodeName);
								ws.send(encode([SUBSCRIPTION_UPDATE, { includeNodes: [nodeName] }]));
								const index = lastSentExcludedNodes.indexOf(nodeName);
								if (index !== -1) lastSentExcludedNodes.splice(index, 1);
							}
						}
					})
					.catch((error) => {
						logger.error?.(connectionId, 'Error subscribing to hdb_nodes for dynamic exclusion updates:', error);
					});
			}
		}
		if (options.connection?.isFinished)
			throw new Error('Can not make a subscription request on a connection that is already closed');
		let lastTxnTimes = new Map();
		// Resolve the audit/__dbis__ stores from the database itself, so a subscription that is still the
		// unresolved placeholder can't make a database with a current resume cursor on disk look like one with
		// no baseline and trigger a full copy (harper-pro#622).
		const { auditStore: databaseAuditStore, dbisDB } = getDatabaseStores();
		// if it hasn't been set yet, do so now
		if (!auditStore) auditStore = databaseAuditStore;
		// iterate through all the sequence entries and find the newest txn time for each node.
		// collectLastTxnTimes tolerates a `seq` row that fails to decode (harper-pro#352) so one
		// undecodable cursor entry can't crash the subscription handshake.
		try {
			const seqEntries = dbisDB?.getRange({
				start: Symbol.for('seq'),
				end: [Symbol.for('seq'), Buffer.from([0xff])],
			});
			if (seqEntries) lastTxnTimes = collectLastTxnTimes(seqEntries);
		} catch (error) {
			// if the database is closed, just proceed (matches multiple error messages)
			if (!error.message.includes('Can not re')) throw error;
		}
		const connectedNode = options.connection?.nodeSubscriptions?.[0];
		receivingDataFromNodeIds = [];
		const nodeSubscriptions = options.connection?.nodeSubscriptions.map((node: any) => {
			const tableSubs = [];
			let { replicateByDefault } = node;
			// Tables excluded by this node's receivesFrom config for this peer+database
			const receiverExcludedTables = getExcludedTablesForRouteEntries(
				node.routeReplicates?.receivesFrom,
				node.name,
				databaseName
			);
			if (node.subscriptions) {
				// if the node has explicit subscriptions, we need to use that to determine subscriptions
				for (const subscription of node.subscriptions) {
					// if there is an explicit subscription listed
					if (subscription.subscribe && (subscription.schema || subscription.database) === databaseName) {
						const tableName = subscription.table;
						if (tables?.[tableName]?.replicate !== false && !receiverExcludedTables?.has(tableName))
							// if replication is enabled for this table and not excluded
							tableSubs.push(tableName);
					}
				}
				replicateByDefault = false; // now turn off the default replication because it was an explicit list of subscriptions
			} else {
				// note that if replicateByDefault is enabled, we are listing the *excluded* tables
				for (const tableName in tables) {
					if (
						replicateByDefault
							? tables[tableName].replicate === false || receiverExcludedTables?.has(tableName)
							: tables[tableName].replicate && !receiverExcludedTables?.has(tableName)
					) {
						tableSubs.push(tableName);
					}
				}
			}

			const nodeId = auditStore && getIdOfRemoteNode(node.name, auditStore);
			auditStore?.ensureLogExists?.(node.name);
			const sequenceEntry = readDbisCursorSync(dbisDB, 'seq', nodeId);
			// A persisted copy cursor means a bulk copy from this node was interrupted mid-stream. We must
			// resume that copy (not treat the persisted seqId as a normal start point — the un-copied table
			// data predates copyStartTime and would never be delivered by an audit-log resume).
			const copyCursor = maybeInjectCopyCursorForTest(
				discardMalformedCopyCursor(
					nodeId === undefined ? undefined : readDbisCursorSync(dbisDB, 'copyCursor', nodeId),
					dbisDB,
					nodeId,
					() => logger.warn?.('Discarding malformed copy-resume cursor (no currentTable) for', node.name, databaseName)
				),
				databaseName
			);
			const cloneAttempt = process.env.HARPER_CLONE_ATTEMPT;
			const copyCompletion = cloneAttempt ? readDbisCursorSync(dbisDB, 'cloneCopyComplete', nodeId) : undefined;
			if (!copyCursor && matchesCloneCopyCompletion(copyCompletion, cloneAttempt)) {
				const sharedStatus = getSharedStatus();
				if (sharedStatus)
					sharedStatus[RECEIVED_VERSION_POSITION] = Math.max(
						sharedStatus[RECEIVED_VERSION_POSITION],
						copyCompletion.copyStartTime!
					);
			}
			// if we are connected directly to the node, we start from the last sequence number we received at the top level
			// setNode persists the operator's start point as `start_time` (snake); routes/the Node type use
			// `startTime` (camel). Read both, else an add_node start point is dropped and the join full-copies.
			const nodeStartTime = node.startTime ?? (node as any).start_time;
			const parsedStartTime = typeof nodeStartTime === 'string' ? new Date(nodeStartTime).getTime() : nodeStartTime;
			// setNode validates start_time at the boundary, so a non-finite value here is a legacy/corrupt
			// stored row: warn and ignore it rather than letting NaN poison the resume bound.
			if (nodeStartTime != null && !Number.isFinite(parsedStartTime))
				logger.warn?.('Ignoring unparseable stored start_time for node', node.name, nodeStartTime);
			// Never apply the operator's data cutoff to the system database: a joining node needs its cluster
			// metadata (auth, roles, membership, schema) in full, so only user databases honor start_time.
			const startCutoff = databaseName === 'system' || !Number.isFinite(parsedStartTime) ? undefined : parsedStartTime;
			let startTime = Math.max(sequenceEntry?.seqId ?? 1, startCutoff ?? 1);
			// A genuine resume = we have a persisted last-received sequence id (>1) for this node. Only then
			// does the leader re-stream an already-applied tail worth fast-skipping. A fresh subscription
			// (no persisted seqId, which later falls back to a full copy, startTime 0) has no such tail, so we
			// must NOT arm the latch from that synthetic start point. This checks the DIRECT sequence cursor;
			// a proxied/indirect subscription has no direct cursor and instead arms from `proxiedSkipCursor`
			// (set in the indirect block below).
			const hasPersistedResumeCursor = (sequenceEntry?.seqId ?? 0) > 1;
			// For a proxied/indirect subscription: the relayed per-source resume cursor, used ONLY to arm the
			// leading-duplicate fast-skip (it does not move `startTime` — see the indirect block for why).
			let proxiedSkipCursor: number | undefined;
			logger.debug?.(
				'Starting time recorded in db',
				node.name,
				nodeId,
				databaseName,
				sequenceEntry?.seqId,
				'start time:',
				startTime,
				new Date(startTime)
			);
			if (connectedNode !== node) {
				// Indirect (proxied) subscription: this source node's writes reach us relayed through
				// `connectedNode`. The relayed per-source resume cursor lives in the proxy connection's seq
				// node-states, which are keyed by node *id* (see Table.ts `updateRecordedSequenceId`, which
				// builds `{ id, seqId, lastTxnTime }` and never sets a `name`).
				const connectedNodeId = auditStore && getIdOfRemoteNode(connectedNode.name, auditStore);
				// getSync via readDbisCursorSync: a get() Promise on a cache miss has no `.nodes`, silently
				// disarming the proxied leading-duplicate fast-skip (#399) and forcing the per-record walk.
				const proxySeqEntry = readDbisCursorSync(dbisDB, 'seq', connectedNodeId);
				for (const seqNode of proxySeqEntry?.nodes || []) {
					// Guard `nodeId !== undefined` first: if both `nodeId` and a malformed `seqNode.id` were
					// undefined the `===` would spuriously match an unrelated entry. (Arming is gated on a
					// defined nodeId downstream too, but match it here so intent is explicit.)
					if (nodeId !== undefined && seqNode.id === nodeId && seqNode.seqId > 1) {
						// Arm the leading-duplicate fast-skip from this relayed cursor so the proxy's re-streamed
						// already-applied tail (the high-volume out-of-order re-delivery in #399) is dropped
						// cheaply at the receive layer instead of driving the core resequencing walk per record.
						// We deliberately do NOT raise `startTime` from this value: the relayed seqId is the proxy
						// connection's local time, which for an out-of-order source can sit ahead of what we have
						// actually applied for this source, so using it as the leader's resume lower bound could
						// skip un-applied writes. (Tightening the proxied resume start itself is #399 direction 1
						// and needs the `lastTxnTime` overlap as a data-loss floor.) The skip stays safe regardless
						// of this cursor's precision — it only ever elides a TRUE identity tie against the stored
						// record, so an imprecise cursor at worst skips nothing.
						proxiedSkipCursor = seqNode.seqId;
						logger.debug?.(
							'Proxied leading-dup-skip cursor from proxy node',
							connectedNode.name,
							node.name,
							proxiedSkipCursor
						);
					}
				}
			}
			if (nodeId === undefined) {
				logger.warn('Starting subscription request from node', node, 'but no node id found');
			} else receivingDataFromNodeIds.push(nodeId);
			// if another node had previously acted as a proxy, it may not have the same sequence ids, but we can use the last
			// originating txn time, and sequence ids should always be higher than their originating txn time, and starting from them should overlap
			if (lastTxnTimes.get(nodeId) > startTime) {
				startTime = lastTxnTimes.get(nodeId);
				logger.debug?.('Updating start time from more recent txn recorded', connectedNode.name, startTime);
			}
			if (startTime === 1) {
				// We resolved no resume cursor for this source (no direct seqId, no recorded lastTxnTime).
				// That means we have no proven baseline for it, so we must fully copy: a `Date.now() - 60000`
				// incremental start would silently claim "I already hold everything older than a minute" and
				// drop the un-acquired backlog. That assumption breaks when an initial copy never completed
				// (e.g. interrupted by restart churn) — the node then resumes from now-60s and permanently
				// loses the gap, even though it never lost the connection (harper-pro#426). A full copy is
				// idempotent, and the leader collapses redundant requests via the per-connection
				// min(startTime); the cost of an occasional extra copy is acceptable versus silent data loss.
				const legacyStartForTest = maybeLegacyCursorlessResumeStartForTest(node.isLeader);
				if (legacyStartForTest !== undefined) {
					startTime = legacyStartForTest;
					logger.warn?.(
						`HARPER_TEST_DISABLE_CURSORLESS_FULL_COPY: resuming database ${databaseName} from ${getNodeURL(node)} at ${new Date(startTime).toISOString()} with no resume cursor for this source`
					);
				} else {
					if (node.isLeader) {
						logger.warn?.(`Requesting full copy of database ${databaseName} from ${getNodeURL(node)}`);
					} else {
						logger.warn?.(
							`Requesting full copy of database ${databaseName} from ${getNodeURL(node)} (no resume cursor for this source)`
						);
					}
					startTime = 0; // use this to indicate that we want to fully copy
				}
			}
			let copyResume;
			if (copyCursor) {
				copyResumeRequested = true;
				startTime = 0; // request a copy; the cursor tells the leader where to resume
				copyResume = {
					copyStartTime: copyCursor.copyStartTime,
					currentTable: copyCursor.currentTable,
					afterKey: copyCursor.afterKey,
					copyOrder: copyCursor.copyOrder, // leader rejects the resume if this != its current COPY_ORDER_VERSION (#421)
				};
				logger.warn?.(
					`Resuming interrupted copy of database ${databaseName} from ${getNodeURL(node)} at table ${copyCursor.currentTable} after key ${copyCursor.afterKey}`
				);
			}
			logger.trace?.(connectionId, 'defining subscription request', node.name, databaseName, new Date(startTime));
			// Arm the leading-duplicate fast-skip for this source node. Incoming records from this node with
			// version <= the arming cursor are the already-applied tail the leader re-streams on resume.
			//   - DIRECT resume → arm from `startTime` (the persisted direct cursor we asked to resume from).
			//   - PROXIED resume → arm from `proxiedSkipCursor` (the relayed per-source cursor; startTime is
			//     left conservative, so the skip absorbs the re-streamed tail #399 produces).
			// Only arm for a genuine incremental resume from a real prior cursor:
			//   - copyResume / startTime === 0  → a bulk copy re-streams in key order carrying original
			//     (possibly newest) versions, so "version <= cursor" is NOT a duplicate signal there.
			//   - no direct or proxied cursor / a fresh "now - 60s" start → no prior applied tail to dedupe.
			// Keyed by local node id so a proxied multi-node subscription gets an independent latch.
			// Branch on the connection type rather than falling back: a node that previously had a DIRECT
			// subscription leaves a persisted direct cursor (`hasPersistedResumeCursor`) on disk, so once it
			// fails over to a PROXIED subscription we must still arm from the live `proxiedSkipCursor` — a
			// fallback that preferred the stale direct `startTime` would dedupe against an old, narrower window.
			const leadingDupArmCursor =
				connectedNode === node
					? hasPersistedResumeCursor && startTime > 1
						? startTime
						: undefined
					: proxiedSkipCursor;
			if (nodeId !== undefined && !copyResume && leadingDupArmCursor !== undefined && leadingDupArmCursor > 1) {
				leadingDupCursorByNode.set(nodeId, leadingDupArmCursor);
				logger.debug?.(
					connectionId,
					'armed leading-duplicate fast-skip',
					node.name,
					nodeId,
					databaseName,
					connectedNode === node ? 'direct resume cursor' : 'proxied resume cursor',
					leadingDupArmCursor
				);
			} else if (nodeId !== undefined) {
				// Re-subscription without a resumable cursor (or a copy): clear any stale latch so we never
				// dedupe against an old window.
				leadingDupCursorByNode.delete(nodeId);
			}
			return {
				name: node.name,
				replicateByDefault,
				tables: tableSubs, // omitted or included based on flag above
				startTime,
				isLeader: node.isLeader,
				endTime: node.endTime,
				copyResume, // present only when resuming an interrupted bulk copy
			};
		});
		let excluded: string[];
		// Build excluded nodes list for each subscription - should include all other qualified nodes we're subscribing to
		if (nodeSubscriptions) {
			const hdbNodesTable = getHDBNodeTable();
			const thisNodeName = getThisNodeName();
			const allDirectlySubscribedNodes: string[] = [thisNodeName];

			// Collect all qualified nodes from hdb_nodes table
			for (const hdbNode of hdbNodesTable.search([])) {
				if (hdbNode.name && hdbNode.name !== thisNodeName) {
					// Check if this node qualifies for replication to this database
					const qualifies =
						hdbNode.replicates === true ||
						hdbNode.replicates?.sends ||
						hdbNode.subscriptions?.some(
							(sub) => (sub.database || sub.schema) === databaseName && sub.subscribe !== false
						);
					if (qualifies) {
						allDirectlySubscribedNodes.push(hdbNode.name);
					}
				}
			}

			// Set excluded list for each subscription (all other qualified nodes except itself)
			excluded = allDirectlySubscribedNodes.filter(
				(nodeName) => !nodeSubscriptions.some((subscription) => nodeName === subscription.name)
			);
		}

		if (nodeSubscriptions) {
			logger.debug?.(connectionId, 'sending subscription request', nodeSubscriptions, dbisDB?.path);
			clearTimeout(delayedClose);
			if (nodeSubscriptions.length > 0) {
				const requestId = peerSupportsSubscriptionSetupAck ? ++nextSubscriptionSetupRequestId : undefined;
				ws.send(encode([SUBSCRIPTION_REQUEST, nodeSubscriptions, excluded, requestId]));
				// Start a fresh request -> first application-response window on every non-empty request. This is
				// intentionally after send(): a synchronous send failure must not leave an orphaned timer.
				if (requestId === undefined) {
					pendingSubscriptionSetupRequestId = undefined;
					subscriptionSetupWatchdog?.stop();
				} else {
					pendingSubscriptionSetupRequestId = requestId;
					subscriptionSetupWatchdog?.arm();
				}
				// Track the excluded list we just sent
				lastSentExcludedNodes = excluded ? [...excluded] : [];
			} else {
				pendingSubscriptionSetupRequestId = undefined;
				subscriptionSetupWatchdog?.stop();
				// no nodes means we are unsubscribing/disconnecting
				// don't immediately close the connection, but wait a bit to see if we get any messages, since opening new connections is a bit expensive
				const scheduleClose = () => {
					const scheduled = performance.now();
					delayedClose = setTimeout(() => {
						// if we have not received any messages in a while, we can close the connection
						if (lastMessageTime <= scheduled)
							// Only finish (no reconnect) when the local database is genuinely gone; an empty
							// subscription while the database is still present is spurious (e.g. a #470 filter
							// misread for a still-desired peer) and must self-heal. See
							// shouldFinishEmptySubscriptionClose.
							close(
								1008,
								'Connection has no subscriptions and is no longer used',
								shouldFinishEmptySubscriptionClose(getDatabases()?.[databaseName] != null)
							);
						else scheduleClose();
					}, DELAY_CLOSE_TIME).unref();
				};
				scheduleClose();
			}
		}
	}

	function getResidence(residencyId, table) {
		if (!residencyId) return;
		let residency = residencyMap[residencyId];
		if (!residency) {
			residency = table.getResidencyRecord(residencyId);
			residencyMap[residencyId] = residency;
			// TODO: Send the residency record
		}
		return residency;
	}

	function checkDatabaseAccess(databaseName: string) {
		if (
			enabledDatabases &&
			enabledDatabases != '*' &&
			!enabledDatabases[databaseName] &&
			!enabledDatabases.includes?.(databaseName) &&
			!enabledDatabases.some?.((dbConfig) => dbConfig.name === databaseName)
		) {
			// TODO: Check the authorization as well
			return false;
		}
		return true;
	}
	function setDatabase(databaseName) {
		tableSubscriptionToReplicator =
			activeDatabaseSubscription(tableSubscriptionToReplicator) ??
			activeDatabaseSubscription(dbSubscriptions.get(databaseName));
		if (!checkDatabaseAccess(databaseName)) {
			throw new Error(`Access to database "${databaseName}" is not permitted`);
		}
		if (!tableSubscriptionToReplicator) {
			logger.warn?.(`No database named "${databaseName}" was declared and registered`);
		}
		auditStore = tableSubscriptionToReplicator?.auditStore;
		if (!tables) tables = getDatabases()?.[databaseName];

		const thisNodeName = getThisNodeName();
		if (thisNodeName === remoteNodeName) {
			if (!thisNodeName) throw new Error('Node name not defined');
			else throw new Error('Should not connect to self: ' + thisNodeName);
		}
		sendNodeDBName(thisNodeName, databaseName);
		return true;
	}
	function sendNodeDBName(thisNodeName, databaseName) {
		const database = getDatabases()?.[databaseName];
		const tables = [];
		for (const tableName in database) {
			const table = database[tableName];
			tables.push({
				table: tableName,
				schemaDefined: table.schemaDefined,
				attributes: table.attributes.map((attr) => ({
					name: attr.name,
					type: attr.type,
					isPrimaryKey: attr.isPrimaryKey,
				})),
			});
		}
		logger.trace?.('Sending database info for node', thisNodeName, 'database name', databaseName);
		ws.send(
			encode([
				NODE_NAME,
				thisNodeName,
				databaseName,
				tables,
				{
					subscriptionSetupAck: SUBSCRIPTION_SETUP_ACK_CAPABILITY,
					subscriptionSetupBudgetMs: SEND_SUBSCRIPTION_SETUP_BUDGET_MS,
				},
			])
		);
	}
	function sendDBSchema(databaseName, subscriptionSetupRequestId?) {
		const database = getDatabases()?.[databaseName];
		const tables = [];
		for (const tableName in database) {
			if (
				nodeSubscriptions &&
				!nodeSubscriptions.some((node) => {
					return node.replicateByDefault ? !node.tables.includes(tableName) : node.tables.includes(tableName);
				})
			)
				continue;
			const table = database[tableName];
			tables.push({
				table: tableName,
				schemaDefined: table.schemaDefined,
				attributes: table.attributes.map((attr) => ({
					name: attr.name,
					type: attr.type,
					isPrimaryKey: attr.isPrimaryKey,
				})),
			});
		}

		ws.send(encode([DB_SCHEMA, tables, databaseName, subscriptionSetupRequestId]));
	}
	blobsTimer = setInterval(
		() => {
			const now = Date.now();
			// Discount the time spent in the *current* (not-yet-ended) back-pressure pause: a pause can outlast
			// blobTimeout, and this sweep fires independently of the pause, so without crediting the ongoing
			// pause it would destroy a healthy stream mid-pause before `removePauseReason` ever runs (harper-pro
			// #368). Shifting `lastChunk` forward by the ongoing pause duration here mirrors the permanent shift
			// `removePauseReason` applies on resume.
			const ongoingPauseMs = pauseReasons > 0 ? now - pauseStartTime : 0;
			for (const [blobId, stream] of blobsInFlight) {
				if (isBlobStreamTimedOut(stream.lastChunk + ongoingPauseMs, blobTimeout, now)) {
					logger.warn?.(
						`Timeout waiting for blob stream to finish ${blobId} for record ${stream.recordId ?? 'unknown'} from ${remoteNodeName}`
					);
					blobsInFlight.delete(blobId);
					unregisterBlobReceiveInFlight(stream.fileId ?? blobId, auditStore?.rootStore);
					stream.destroy(new Error(`Timeout waiting for blob stream in replication from ${remoteNodeName}`));
				}
			}
			for (const [streamKey, skippedAt] of skippedBlobIds) {
				if (skippedAt + blobTimeout <= now) skippedBlobIds.delete(streamKey);
			}
			// Sweep more often than the idle threshold: with the interval coupled to blobTimeout (900s
			// default), an orphaned stream could hold its buffered chunks for up to 2x blobTimeout.
		},
		Math.max(Math.min(blobTimeout > 0 ? blobTimeout : 900000, 60000), 1000)
	).unref();

	let nextId = 1;
	const sentTableNames = [];
	return {
		end() {
			// cleanup
			if (subscriptionRequest) subscriptionRequest.end();
			if (auditSubscription) auditSubscription.emit('close');
		},
		// Full teardown for a session whose socket is being replaced without a delivered 'close'
		// (forceReconnect on an open-but-wedged socket). See retireInstance.
		retire(reason?: string) {
			retireInstance(undefined, reason);
		},
		getRecord(request) {
			// send a request for a specific record
			const requestId = nextId++;
			return new Promise((resolve, reject) => {
				const message = [GET_RECORD, requestId, request.table.tableId, request.id];
				if (!sentTableNames[request.table.tableId]) {
					message.push(request.table.tableName);
					sentTableNames[request.table.tableId] = true;
				}
				ws.send(encode(message));
				lastMessageTime = performance.now();
				awaitingResponse.set(requestId, {
					tableId: request.table.tableId,
					key: request.id,
					resolve(entry) {
						const { table, entry: existingEntry, blobRepairOnly } = request;
						// we can immediately resolve this because the data is available.
						resolve(entry);
						// However, if we are going to record this locally, we need to record it as a relocation event
						// and determine new residency information. For blob-repair-only fetches we skip relocation
						// (we only want the blob bytes written by BLOB_CHUNK, not to update the record's residency).
						if (entry && !blobRepairOnly) return table._recordRelocate(existingEntry, entry);
						// Return truthy for blob-repair-only so the GET_RECORD_RESPONSE handler does not schedule
						// the freshly-received blobs for deferred deletion (they are exactly what we came for).
						return !!blobRepairOnly;
					},
					reject,
				});
			});
		},
		/**
		 * Send an operation request to the remote node, returning a promise for the result
		 * @param operation
		 */
		sendOperation(operation) {
			const requestId = nextId++;
			operation.requestId = requestId;
			ws.send(encode([OPERATION_REQUEST, operation]));
			return new Promise((resolve, reject) => {
				awaitingResponse.set(requestId, { resolve, reject });
			});
		},
	};

	function checkExcessMessageSize(messageSize) {
		if (exceedsMaxPayload(messageSize)) {
			const { emit, suppressedCount } = decideThrottledWarn(oversizedSendWarnThrottle, Date.now());
			if (emit)
				logger.error?.(
					connectionId,
					'Message too large to send, size:',
					messageSize,
					'remote node:',
					remoteNodeName,
					'database:',
					databaseName,
					suppressedCount ? `(${suppressedCount} suppressed)` : ''
				);
			return true;
		}
	}
	// Check the attributes in the msg vs the table and if they dont match call ensureTable to create them
	function ensureTableIfChanged(tableDefinition: any, existingTable: any) {
		if (!existingTable) existingTable = {};
		const wasSchemaDefined = existingTable.schemaDefined;
		let hasChanges = false;
		const schemaDefined = tableDefinition.schemaDefined;
		const attributes = existingTable.attributes?.slice() || [];
		for (let i = 0; i < tableDefinition.attributes?.length; i++) {
			const ensureAttribute = tableDefinition.attributes[i];
			const existingAttribute = attributes.find((attr) => attr.name === ensureAttribute.name);
			if (!existingAttribute || existingAttribute.type !== ensureAttribute.type) {
				// a difference in the attribute definitions was found
				if (wasSchemaDefined) {
					// if the schema is defined, we will not change, we will honor our local definition, as it is just going to cause a battle between nodes if there are differences that we try to propagate
					logger.error?.(
						`Schema for '${databaseName}.${tableDefinition.table}' is defined locally, but attribute '${ensureAttribute.name}: ${ensureAttribute.type}' from '${
							remoteNodeName
						}' does not match local attribute ${existingAttribute ? "'" + existingAttribute.name + ': ' + existingAttribute.type + "'" : 'which does not exist'}`
					);
				} else {
					hasChanges = true;
					if (!schemaDefined) ensureAttribute.indexed = true; // if it is a dynamic schema, we need to index (all) the attributes
					if (existingAttribute) attributes[attributes.indexOf(existingAttribute)] = ensureAttribute;
					else attributes.push(ensureAttribute);
				}
			}
		}
		if (hasChanges) {
			logger.debug?.('(Re)creating', tableDefinition);
			return ensureTable({
				table: tableDefinition.table,
				database: tableDefinition.database,
				schemaDefined: tableDefinition.schemaDefined,
				...existingTable,
				// keep after the spread — a live Table's own attributes/origin would otherwise override the merge
				attributes,
				origin: 'cluster',
			});
		}
		return existingTable;
	}
}
