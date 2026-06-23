/**
 * This module is responsible for managing the list of known nodes in the network. This also tracks replication confirmation
 * when we want to ensure that a transaction has been replicated to multiple nodes before we confirm it.
 */
import { table } from '../core/resources/databases.ts';
import { forEachReplicatedDatabase } from './replicator.ts';
import { getThisNodeName } from '../core/server/nodeName.ts';
import { replicationConfirmation } from '../core/resources/DatabaseTransaction.ts';
import { isMainThread } from 'worker_threads';
import { ClientError } from '../core/utility/errors/hdbError.js';
import * as env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import { logger } from '../core/utility/logging/logger.ts';

let hdbNodeTable;
server.nodes = [];

export function getHDBNodeTable() {
	return (
		hdbNodeTable ||
		(hdbNodeTable = table({
			table: 'hdb_nodes',
			database: 'system',
			attributes: [
				{
					name: 'name',
					isPrimaryKey: true,
				},
				{
					attribute: 'subscriptions',
				},
				{
					attribute: 'system_info',
				},
				{
					attribute: 'url',
				},
				{
					attribute: 'routes',
				},
				{
					attribute: 'ca',
				},
				{
					attribute: 'ca_info',
				},
				{
					attribute: 'replicates',
				},
				{
					attribute: 'revoked_certificates',
				},
				{
					attribute: '__createdtime__',
				},
				{
					attribute: '__updatedtime__',
				},
			],
		}))
	);
}
export function getReplicationSharedStatus(
	auditStore: any,
	databaseName: string,
	node_name: string,
	callback?: () => void
) {
	// 128 bytes = 16 Float64 slots. Positions 0..6 are the replication status fields and 7..8 the
	// blob-divergence signals (see the *_POSITION exports in replicationConnection.ts); the rest is
	// headroom for future metrics. This buffer is process-local shared memory (shared across this
	// node's threads via getUserSharedBuffer, never persisted or sent across nodes), so growing it is
	// safe: every caller goes through this function, and a node runs a single version.
	return new Float64Array(
		auditStore.getUserSharedBuffer(
			['replicated', databaseName, node_name],
			new ArrayBuffer(128),
			callback && { callback }
		)
	);
}
// If the async iterator for hdb_nodes throws or completes, the watcher used to die silently
// and the node lost the ability to (re)establish outbound replication subscriptions for the
// lifetime of the process. Run the watcher inside a restart loop so a single transient error
// (e.g. WebSocket close, schema mismatch, downstream throw) does not permanently disable
// node-update tracking. Per-event errors are caught individually so they cannot tear down
// the loop.
const NODE_WATCHER_RESTART_DELAY_MS = 1000;
// Cap the exponential backoff so a persistent failure (subscribe throws every time)
// doesn't run a tight 1s log+retry loop forever — back off up to 30s instead.
const NODE_WATCHER_MAX_DELAY_MS = 30_000;
type WatcherOptions = {
	subscribe?: () => Promise<AsyncIterable<any>> | AsyncIterable<any>;
	processEvent?: (event: any, listener: (node: any, id: string) => void) => Promise<void> | void;
	restartDelayMs?: number;
	maxDelayMs?: number;
	maxRestarts?: number;
};

// Generation tokens guarding against duplicate node-update watchers (harper-pro#460). A
// `deploy_component` reload re-invokes `replicator.startOnMainThread` on the SAME already-resolved
// main-thread module instance; its `whenThreadsStarted.then()` fires again and calls
// `subscribeToNodeUpdates` → `runNodeUpdateWatcher` a second (third, …) time. Each call previously
// started an independent unbounded watcher loop and an extra forEachReplicatedDatabase chain,
// accumulating listeners across deploys (the observed `MaxListenersExceededWarning`) and double-
// processing every hdb_nodes event. We let only the most-recent watcher per logical purpose run:
// starting a new one for a given key bumps that key's generation, closes the prior iterator, and the
// older loop exits on its next turn. The key namespaces watchers so the two concurrent legitimate
// consumers (subscription management vs replication-confirmation tracking) don't supersede each
// other — only a re-invocation of the SAME consumer does.
const watcherGenerations = new Map<string, number>();
const watcherIterators = new Map<string, AsyncIterator<any>>();
const DEFAULT_WATCHER_KEY = 'default';

/** Stop the currently-running node-update watcher for `key` (if any). Idempotent. */
export function stopNodeUpdateWatcher(key: string = DEFAULT_WATCHER_KEY) {
	watcherGenerations.set(key, (watcherGenerations.get(key) ?? 0) + 1);
	const iterator = watcherIterators.get(key);
	watcherIterators.delete(key);
	// Closing the iterator breaks the `for await` the active loop is parked on; the generation bump
	// makes the loop exit instead of restarting even if the close races the next iteration.
	iterator?.return?.(undefined);
}

export async function runNodeUpdateWatcher(
	listener: (node: any, id: string) => void,
	options: WatcherOptions & { key?: string } = {}
) {
	const subscribe = options.subscribe ?? (() => getHDBNodeTable().subscribe({}));
	const processEvent = options.processEvent ?? processNodeUpdateEvent;
	const restartDelayMs = options.restartDelayMs ?? NODE_WATCHER_RESTART_DELAY_MS;
	const maxDelayMs = options.maxDelayMs ?? NODE_WATCHER_MAX_DELAY_MS;
	const maxRestarts = options.maxRestarts ?? Infinity;
	const key = options.key ?? DEFAULT_WATCHER_KEY;
	// Supersede any watcher already running for this key so a reload doesn't stack a second loop
	// (harper-pro#460). Distinct keys (subscription vs confirmation) run concurrently and untouched.
	stopNodeUpdateWatcher(key);
	const generation = watcherGenerations.get(key) ?? 0;
	let restarts = 0;
	let consecutiveFailures = 0;
	const isCurrent = () => generation === (watcherGenerations.get(key) ?? 0);
	while (restarts < maxRestarts && isCurrent()) {
		let iteratedSuccessfully = false;
		try {
			const events = await subscribe();
			if (!isCurrent()) break; // superseded while awaiting subscribe
			iteratedSuccessfully = true; // we got past subscribe — any later throw is a fresh failure
			const iterator = events[Symbol.asyncIterator]();
			watcherIterators.set(key, iterator);
			try {
				while (true) {
					const { value: event, done } = await iterator.next();
					if (done || !isCurrent()) break;
					try {
						await processEvent(event, listener);
					} catch (error) {
						// Don't let a single bad event tear down the watcher — log and continue.
						// Optional chaining: this `logger` is the level-conditional one, where
						// `.error` is undefined when the configured level filters it out, and an
						// uncaught TypeError here would defeat the whole recovery loop.
						logger.error?.('Error processing hdb_nodes update event', error);
					}
				}
			} finally {
				if (watcherIterators.get(key) === iterator) watcherIterators.delete(key);
			}
			if (!isCurrent()) break; // superseded — exit without restarting
			logger.warn?.('hdb_nodes subscription ended unexpectedly; restarting watcher');
		} catch (error) {
			if (!isCurrent()) break; // superseded watcher; iterator.return rejected
			logger.error?.('hdb_nodes watcher failed; restarting', error);
		}
		// Successful subscribe → reset backoff so a fresh failure restarts quickly.
		consecutiveFailures = iteratedSuccessfully ? 0 : consecutiveFailures + 1;
		restarts++;
		if (restarts >= maxRestarts || !isCurrent()) return;
		const delay = Math.min(restartDelayMs * Math.pow(2, Math.min(consecutiveFailures, 5)), maxDelayMs);
		await new Promise((resolve) => setTimeout(resolve, delay));
	}
}
/**
 * Raw existence check for an hdb_nodes record that does NOT decode the stored value.
 * A decode failure (e.g. stale msgpackr shared-structures, harper#1163 / harper-pro#352) must not
 * be misread as the record being absent: `primaryStore.get()` would throw/return undefined for an
 * undecodable-but-present row, so we probe via the scan path (`getKeys`) instead.
 */
export function nodeRecordPhysicallyExists(name: string): boolean {
	return storeRecordRangeVisible(getHDBNodeTable().primaryStore, name);
}

/**
 * Decide whether a change-stream event that carried *no usable decoded value* represents a
 * genuine node deletion. (Callers only reach this for a nullish value; an event with a
 * decoded value is always an upsert.) The ambiguity is only for `put`/`patch` events, where
 * a decode failure can produce a null value while the record still physically exists.
 * A `delete` event from the change stream is already the reliable signal that the record is
 * truly gone — the physical-existence check was overly conservative and caused genuine
 * `remove_node` deletes to be suppressed because LMDB/RocksDB reads open against an older
 * snapshot that predates the delete commit (harper#1163 regression).
 */
export function isGenuineNodeDeletion(eventType: string): boolean {
	return eventType === 'delete'; // put/patch with null value = decode failure; delete events are genuine
}

/**
 * An hdb_nodes record is a node descriptor object with a `name` (which is also the table's
 * primary key); lookups that return anything else (null, an empty array, an object missing
 * `name`) are corrupt or partial-decoded state and must not be treated as a matched peer.
 * Observed in the field as `[]` returned from `primaryStore.get()` for v4-era entries after
 * a partial v4 to v5 migration; without this guard, the cert-auth path in replicator.ts
 * treats the truthy `[]` as a match, short-circuits the IP fallback, and rejects valid
 * peers with 1008 Unauthorized.
 */
export function isValidNodeRecord(record: unknown): boolean {
	return !!record && typeof record === 'object' && !Array.isArray(record) && typeof (record as any).name === 'string';
}

/**
 * Resolve an hdb_nodes record for the replication auth path (cert common-name / IP lookup).
 *
 * Root cause of harper-pro#352 (field variant #345): during a rolling in-place v4→v5 upgrade, a
 * freshly-flipped node's replication auth path reads a peer's `hdb_nodes` row via the POINT lookup
 * (`primaryStore.get()`) very early at boot. A v5-era msgpackr *shared-structure* row can
 * transiently misread through that point-lookup path — yielding `[]` / a non-record (it does not
 * necessarily throw) — even though the row is present on disk and the table's shared structures are
 * present too. (Diagnosis: on the wedged node the local log replay had already completed and the
 * read-path structures key `[Symbol.for('structures'), 'hdb_nodes']` was present and valid; the
 * point decode simply loses a race with the `hdb_nodes` base-copy resync that re-encodes the row
 * against local structures and heals it within seconds. The SCAN path lists the key reliably the
 * whole time.) `isValidNodeRecord` then (correctly) refuses the misread — but on a replication
 * socket the "require credentials" fallback can never succeed, so the peer is rejected with cycling
 * 1008 Unauthorized and its post-flip writes strand at origin.
 *
 * The information the auth decision actually needs is the peer's `name`, which is the table's
 * primary key — and the SCAN path (`getKeys`/`getRange`) lists that key reliably even while the
 * point decode transiently fails. So when the point lookup yields no valid record but the key is
 * range-visible (a known peer), reconstruct a minimal node descriptor from the key. This is safe:
 * the connection's certificate is independently validated by TLS and `verifyCertificate` in
 * replicator.ts before this record is consulted, and the hostname must already be a range-visible
 * known node to be reconstructed at all — we are not inventing a peer, we are recovering the
 * identity of one whose descriptor transiently failed to decode; the full record self-heals on the
 * next decodable update.
 *
 * Note: keying the reconstruction off range-visibility (not the point-lookup `doesExist`/`get`) is
 * deliberate — the point lookup is exactly the path that misreads, so depending on it would leave
 * the wedge open in the observed failure shape.
 *
 * (Separate, latent: `replayLogs` persists replication-applied structure updates under the plain
 * key `Symbol.for('structures')`, which the RocksDB decode path — composite `[Symbol.for('structures'),
 * name]` — never reads. Not the proximate trigger here, tracked separately.)
 *
 * Returns a valid node record, or `undefined` when the hostname is genuinely unknown (not range-
 * visible and no route). `isValidNodeRecord` is retained as defense-in-depth at the call sites.
 */
export function readNodeForAuth(name: string, routeRecord?: any): any {
	return resolveNodeForAuth(getHDBNodeTable().primaryStore, name, routeRecord);
}

/**
 * Pure resolution logic for {@link readNodeForAuth}, taking the store explicitly so it can be
 * unit-tested against a real (or fake) store without standing up a server. See readNodeForAuth
 * for the full root-cause rationale (harper-pro#352).
 */
export function resolveNodeForAuth(store: any, name: string, routeRecord?: any): any {
	let record: any;
	try {
		record = store.get(name);
	} catch {
		// A present-but-undecodable row throws here (missing shared structure); fall through to
		// the physical-existence check below rather than treating the peer as unknown.
		record = undefined;
	}
	if (isValidNodeRecord(record)) return record;
	// A static-route record (from replication.routes config) is already a valid descriptor and
	// carries fields the reconstructed minimal record cannot (e.g. revoked_certificates) — prefer it.
	if (isValidNodeRecord(routeRecord)) return routeRecord;
	// The point lookup yielded no valid record. If the key is RANGE-VISIBLE (the scan path reliably
	// lists v5-era rows even while the point decode transiently misreads — harper-pro#352), this is
	// a known peer: reconstruct its identity from the key so a cryptographically-validated peer is
	// not stranded by a transiently-undecodable descriptor.
	if (storeRecordRangeVisible(store, name)) {
		logger.warn?.(
			'hdb_nodes record for',
			name,
			'did not decode to a valid node descriptor on the point lookup but is range-visible (likely a v5-era shared-structure row transiently misreading at boot during an in-place upgrade; see harper-pro#352). Authorizing the peer by its certificate-validated name; the full record self-heals on the next decodable update.'
		);
		return { name };
	}
	return undefined;
}

/**
 * Reconstruct a minimal node descriptor from an hdb_nodes key whose stored value failed to decode,
 * for the OUTBOUND subscription path (harper-pro#460). Returns `undefined` when the key is not a
 * usable peer name (so the caller keeps skipping it).
 *
 * Background: `resolveNodeForAuth` recovers a `{ name }` descriptor for the *inbound* auth path so a
 * cert-validated peer is accepted when its row transiently fails to decode. But that fallback is
 * never reached by the *outbound* path — `subscribeToNodeUpdates` and the `processNodeUpdateEvent`
 * put-path simply did `if (!node) continue` / dropped the event, so a follower whose replicated
 * `hdb_nodes` rows decode to null at subscription-scan time (the state a `deploy_component`
 * worker-reload leaves them in: the scan re-fires on the already-resolved main-thread module with no
 * base-copy) built ZERO outbound subscriptions and silently stopped receiving replicated writes.
 *
 * The minimal descriptor mirrors `resolveNodeForAuth`'s `{ name }` but additionally sets
 * `replicates: true`: unlike the auth path (which only needs the identity), the subscription path
 * gates on `node.replicates` (see `shouldReplicateFromNode` and the early-return in
 * `subscriptionManager.onNodeUpdate`). Without it the reconstructed node would be filtered out and no
 * subscription created. `replicates: true` is the cluster default (it is what `ensureThisNode` and
 * the route defaulting write) and `getNodeURL` already falls back to `wss://<name>:9933`, so the
 * outbound subscription is re-established from the key alone. This is a recovery descriptor: the next
 * decodable `hdb_nodes` update replaces it with the full record (carrying url/shard/subscriptions/etc.).
 */
export function reconstructNodeFromKey(key: unknown): { name: string; replicates: true } | undefined {
	if (typeof key !== 'string' || key.length === 0) return undefined;
	return { name: key, replicates: true };
}

/**
 * Existence probe for an hdb_nodes key that prefers the RANGE/scan path. A v5-era shared-structure
 * row can transiently misread to `[]`/null through the point lookup (`doesExist`/`get`) at early
 * boot (harper-pro#352), but `getKeys` lists the key reliably because it never decodes the value.
 * Falls back to point checks only if `getKeys` is unavailable.
 */
function storeRecordRangeVisible(store: any, name: string): boolean {
	if (typeof store.getKeys === 'function') {
		try {
			for (const key of store.getKeys({ start: name, limit: 1 })) {
				return key === name;
			}
			return false;
		} catch {
			// fall through to point checks
		}
	}
	if (typeof store.doesExist === 'function' && store.doesExist(name)) return true;
	if (typeof store.getBinaryFast === 'function' && store.getBinaryFast(name) != null) return true;
	try {
		return store.get(name) != null;
	} catch {
		return true;
	}
}

async function processNodeUpdateEvent(event: any, listener: (node: any, id: string) => void) {
	// remove any nodes that have been updated or deleted
	const node_name = event?.value?.name || event?.id;
	logger.debug?.('adding node', node_name, 'on  node', getThisNodeName(), ' on process', process.pid);
	server.nodes = server.nodes.filter((node) => node && node.name !== node_name);
	if (event.type === 'put' && node_name !== getThisNodeName()) {
		// add any new nodes
		if (event.value) server.nodes.push(event.value);
		else {
			// put event with no decodable value — reconstruct a minimal descriptor from the key so
			// server.nodes (and the outbound subscription fired below) still reflect the peer
			// (harper-pro#460). A genuine delete is handled separately via isGenuineNodeDeletion.
			const reconstructed = reconstructNodeFromKey(node_name);
			// Cast: this is a deliberate partial recovery descriptor (name + replicates), parallel to
			// the loosely-typed `event.value` push above; the next decodable update supplies url/shard.
			if (reconstructed) server.nodes.push(reconstructed as any);
			else console.error('Invalid node update event', event);
		}
	} else if (event.type === 'patch' && node_name !== getThisNodeName() && event.value?.isLeader !== undefined) {
		// add_node { isLeader: true } reaches us as a patch event; read the merged
		// record from LMDB so server.nodes reflects the full record (including isLeader).
		const fullRecord = getHDBNodeTable().primaryStore.get(node_name);
		if (fullRecord) server.nodes.push(fullRecord);
	}
	const shards = new Map();
	for await (const node of getHDBNodeTable().search({})) {
		if (!node) continue;
		if (node.shard != undefined) {
			let nodesForShard = shards.get(node.shard);
			if (!nodesForShard) {
				shards.set(node.shard, (nodesForShard = []));
			}
			nodesForShard.push(node);
		}
	}
	server.shards = shards;
	if (event.type === 'put' || event.type === 'delete') {
		if (event.value != null) {
			// normal upsert with a decoded value
			listener(event.value, event.id);
		} else if (isGenuineNodeDeletion(event.type)) {
			// genuine deletion — forward the nullish value so the listener tears the node down
			listener(event.value, event.id);
		} else {
			// A put/patch with no decodable value is a transient decode failure (e.g. stale
			// msgpackr shared-structures, harper#1163) — NOT a node removal. We must NOT forward the
			// nullish value (onNodeUpdate would treat it as a deletion and unsubscribe the peer from
			// every database). But dropping it entirely left a put-event-driven peer with no outbound
			// subscription (harper-pro#460). Reconstruct a minimal descriptor from the key and forward
			// THAT instead, so the outbound subscription is (re)created; the next decodable event
			// replaces it with the full record.
			const reconstructed = reconstructNodeFromKey(event.id);
			if (reconstructed) {
				logger.warn?.(
					'hdb_nodes change event for',
					event.id,
					'had no decodable value; subscribing to the peer by name so outbound replication is not lost (see harper-pro#460), treating it as a transient decode failure (see harper#1163), not a node deletion'
				);
				listener(reconstructed, event.id);
			} else {
				logger.warn?.(
					'hdb_nodes change event for',
					event.id,
					'had no decodable value and no usable key; treating as a transient decode failure (see harper#1163), not a node deletion'
				);
			}
		}
	} else if (event.type === 'patch' && event.value?.isLeader !== undefined) {
		// isLeader patches need to drive subscription bootstrap; pass the merged record.
		const fullRecord = getHDBNodeTable().primaryStore.get(event.id);
		if (fullRecord) listener(fullRecord, event.id);
	}
}
/**
 * Distinguish a genuine `remove_node` tombstone from a transient decode failure for a range-visible
 * hdb_nodes row whose scan value was nullish (harper-pro#460 review). A deleted node leaves a row
 * whose POINT lookup returns `null` cleanly (the startup path in subscriptionManager already keys off
 * `primaryStore.get(name) === null` to mean "previously deleted, do not recreate"). A decode failure
 * instead THROWS from the point lookup (missing shared structure — the #352/#1163 misread) or yields
 * a present-but-invalid value. So: a clean `null` ⇒ `'deleted'` (skip, must NOT revive a removed
 * peer); a throw or any non-null point result ⇒ `'decode-failure'` (reconstruct so outbound
 * replication survives). Returns the point-looked-up record too, so a point lookup that succeeds
 * where the range value was null can be used directly.
 */
export function probeNodeRow(store: any, key: unknown): { outcome: 'deleted' | 'decode-failure'; record?: any } {
	let record: any;
	try {
		record = store.get(key);
	} catch {
		// present-but-undecodable row → decode failure, reconstruct.
		return { outcome: 'decode-failure' };
	}
	// A clean null is a genuine tombstone (removed node); undefined means physically absent. Either
	// way there is no live peer here — do not reconstruct.
	if (record == null) return { outcome: 'deleted' };
	// The point lookup returned something present (a valid record, or a misread `[]`/partial). Treat
	// it as still-present: a valid record is used directly; an invalid-but-present value reconstructs.
	return { outcome: 'decode-failure', record };
}

/**
 * Resolve the node descriptor to use for one hdb_nodes scan entry on the OUTBOUND subscription path.
 * Returns the decoded record when valid; when the value is nullish, `probe` distinguishes a genuine
 * tombstone (returns `undefined` → skip, harper-pro#460 review) from a transient decode failure
 * (reconstructs a minimal descriptor so the outbound subscription is still created — harper-pro#460/
 * #352). Returns `undefined` when there is no usable key (truly skip).
 *
 * `probe` is injected so this stays unit-testable without a live store; scanNodesForSubscription
 * supplies the store-backed {@link probeNodeRow}.
 */
export function resolveScannedNode(
	value: any,
	key: unknown,
	probe?: (key: unknown) => { outcome: 'deleted' | 'decode-failure'; record?: any }
): any {
	if (value) return value;
	// No probe (legacy/pure call): preserve the original reconstruct-on-null behavior.
	if (!probe) return reconstructNodeFromKey(key);
	const { outcome, record } = probe(key);
	if (outcome === 'deleted') return undefined; // genuine tombstone — do not revive a removed node
	if (record && isValidNodeRecord(record)) return record; // point lookup recovered the real record
	return reconstructNodeFromKey(key);
}

/**
 * Iterate the hdb_nodes range and drive `onNode(node, key)` for each peer, reconstructing a minimal
 * descriptor for any range-visible-but-undecodable row while skipping genuine tombstones
 * (harper-pro#460). Takes the store explicitly so it can be unit-tested against a fake/real store
 * without standing up a server. The shard/server bookkeeping stays in subscribeToNodeUpdates (its
 * concern, and it owns the `server` global).
 */
export function scanNodesForSubscription(store: any, onNode: (node: any, key: any) => void) {
	for (const entry of store.getRange({})) {
		const { value, key } = entry;
		const node = resolveScannedNode(value, key, (probeKey) => probeNodeRow(store, probeKey));
		if (!node) continue;
		if (!value) {
			logger.warn?.(
				'hdb_nodes record for',
				key,
				'did not decode to a live record at the subscription scan but is present (not a tombstone); subscribing to the peer so outbound replication is not lost (see harper-pro#460). The full record self-heals on the next decodable update.'
			);
		}
		onNode(node, key);
	}
}

export function subscribeToNodeUpdates(listener: (node: any, id: string) => void, watcherKey?: string) {
	// `watcherKey` namespaces the underlying watcher so a re-invocation of the SAME caller (e.g. a
	// deploy_component reload re-running startOnMainThread, harper-pro#460) supersedes its prior
	// watcher instead of stacking one, while the two distinct callers (subscription management vs
	// replication-confirmation tracking) keep independent concurrent watchers.
	runNodeUpdateWatcher(listener, { key: watcherKey });
	server.nodes = [];
	server.shards = new Map();

	scanNodesForSubscription(getHDBNodeTable().primaryStore, (node, key) => {
		server.nodes.push(node);
		if (node.shard != undefined) {
			let nodesForShard = server.shards.get(node.shard);
			if (!nodesForShard) {
				server.shards.set(node.shard, (nodesForShard = []));
			}
			nodesForShard.push(node);
		}
		listener(node, key);
	});
	logger.debug?.(
		'Known nodes at startup',
		server.nodes.map((node) => node.name)
	);
}

export function shouldReplicateFromNode(node: Node, databaseName: string) {
	const databaseReplications: string | Array<string | { name: string; sharded?: boolean }> = env.get(
		CONFIG_PARAMS.REPLICATION_DATABASES
	);
	// When this peer is our leader, the database may not exist locally yet — that's the
	// whole point of the full-table copy bootstrap. Skip the local-presence precondition
	// so the subscription can be scheduled and the leader can push records (and schema)
	// to create the database on this node.
	const hasLocalDatabase = !!databases[databaseName] || !!node.isLeader;
	return (
		((typeof node.replicates === 'object'
			? node.replicates?.sends ||
				node.replicates?.sendsTo?.some?.((sendsTo) =>
					typeof sendsTo === 'object'
						? (!sendsTo.target || sendsTo.target === getThisNodeName()) &&
							(!sendsTo.database || sendsTo.database === databaseName)
						: sendsTo === getThisNodeName()
				)
			: node.replicates) &&
			hasLocalDatabase &&
			(!databaseReplications ||
				databaseReplications === '*' ||
				(Array.isArray(databaseReplications) &&
					databaseReplications.find?.((dbReplication) => {
						return typeof dbReplication === 'string'
							? dbReplication === databaseName
							: dbReplication.name === databaseName &&
									(!dbReplication.sharded || node.shard === env.get(CONFIG_PARAMS.REPLICATION_SHARD));
					}))) &&
			getHDBNodeTable().primaryStore.get(getThisNodeName())?.replicates) ||
		node.subscriptions?.some((sub) => (sub.database || sub.schema) === databaseName && sub.subscribe)
	);
}

const replicationConfirmationFloat64s = new Map<string, Map<string, Float64Array>>();
/** Ensure that the shared user buffers are instantiated so we can communicate through them
 */

type AwaitingReplication = {
	txnTime: number;
	onConfirm: () => void;
};
export let commitsAwaitingReplication: Map<string, AwaitingReplication[]>;

replicationConfirmation((databaseName, txnTime, confirmationCount): Promise<void> => {
	if (confirmationCount > server.nodes.length) {
		let nodesInTable = Array.from(databases.system.hdb_nodes.primaryStore.getKeys());
		throw new ClientError(
			`Cannot confirm replication to more nodes (${confirmationCount}) than are in the network (${server.nodes.length} nodes: ${server.nodes.map((node) => node.name).join(', ')}, all in table ${nodesInTable.join(', ')})`
		);
	}
	if (!commitsAwaitingReplication) {
		commitsAwaitingReplication = new Map();
		startSubscriptionToReplications();
	}
	let awaiting: AwaitingReplication[] = commitsAwaitingReplication.get(databaseName);
	if (!awaiting) {
		awaiting = [];
		commitsAwaitingReplication.set(databaseName, awaiting);
	}
	return new Promise((resolve) => {
		let count = 0;
		awaiting.push({
			txnTime,
			onConfirm: () => {
				if (++count === confirmationCount) resolve();
			},
		});
	});
});
// Per-node confirmation watchers. Previously the per-node-update callback below called
// forEachReplicatedDatabase and discarded the returned remove handle, so every hdb_nodes
// update added two listeners (updateTable + dropDatabase) on the global databaseEventsEmitter
// and they accumulated unboundedly across the lifetime of the process — tripping
// MaxListenersExceededWarning once a cluster had ~5+ peers (or after a few node-table churn
// events). We need the future-DB watching aspect of forEachReplicatedDatabase here so that
// new databases added after this node started up still get replicationConfirmation tracking
// wired up; without it, commits on those databases would never receive their onConfirm()
// callback and hang. Keep one watcher per node and replace it on each node update so the
// callback closes over the latest nodeRecord rather than a stale one.
const confirmationWatchersByNode = new Map<string, { remove: () => void }>();
function startSubscriptionToReplications() {
	subscribeToNodeUpdates((nodeRecord, nodeId) => {
		// keyed 'replication-confirmation' so it runs concurrently with the subscription-manager
		// watcher and supersedes only a prior confirmation watcher on re-invocation (harper-pro#460).
		// subscribeToNodeUpdates fires the listener for both 'put' and 'delete' events; on delete
		// the value is undefined but the id (node name) is still passed. Tear down any existing
		// watcher in both cases so we don't accumulate stale watchers when nodes are removed.
		const nodeNameAtUpdate = nodeRecord?.name ?? nodeId;
		if (!nodeNameAtUpdate) return;
		confirmationWatchersByNode.get(nodeNameAtUpdate)?.remove();
		confirmationWatchersByNode.delete(nodeNameAtUpdate);
		if (!nodeRecord) {
			// Node was removed — release its shared-buffer entries so the map doesn't accumulate
			// stale node entries across long-running clusters where nodes churn.
			replicationConfirmationFloat64s.delete(nodeNameAtUpdate);
			return;
		}
		const handle = forEachReplicatedDatabase({}, (database, databaseName) => {
			let confirmationsForNode = replicationConfirmationFloat64s.get(nodeNameAtUpdate);
			if (!confirmationsForNode) {
				replicationConfirmationFloat64s.set(nodeNameAtUpdate, (confirmationsForNode = new Map()));
			}
			if (!database) {
				// dropDatabase notification — clear the entry so a later create-then-recreate of the
				// same databaseName will re-register confirmation tracking instead of being skipped
				// by the .has() guard below.
				confirmationsForNode.delete(databaseName);
				return;
			}
			if (confirmationsForNode.has(databaseName)) return;
			let auditStore;
			for (const tableName in database) {
				const table = database[tableName];
				auditStore = table.auditStore;
				if (auditStore) break;
			}
			if (auditStore) {
				const replicatedTime: Float64Array & { lastTime?: number } = getReplicationSharedStatus(
					auditStore,
					databaseName,
					nodeNameAtUpdate,
					() => {
						const updatedTime = replicatedTime[0];
						const lastTime = replicatedTime.lastTime;
						for (const { txnTime, onConfirm } of commitsAwaitingReplication.get(databaseName) || []) {
							if (txnTime > lastTime && txnTime <= updatedTime) {
								onConfirm();
							}
						}
						replicatedTime.lastTime = updatedTime;
					}
				);
				replicatedTime.lastTime = 0;
				confirmationsForNode.set(databaseName, replicatedTime);
			}
		});
		confirmationWatchersByNode.set(nodeNameAtUpdate, handle);
	}, 'replication-confirmation');
}
export type RouteEntry = {
	target?: string;
	source?: string;
	database?: string;
	excludeTables?: string[];
};
export type Route = {
	url?: string;
	subscriptions?: { database: string; schema: string; subscribe: boolean }[];
	hostname?: string;
	host?: string;
	port?: any;
	routes?: any[];
	sendsTo?: (RouteEntry | string)[];
	receivesFrom?: (RouteEntry | string)[];
	// yielded by iterateRoutes (may differ from raw config shape)
	name?: string;
	replicates?:
		| boolean
		| {
				sends?: boolean;
				sendsTo?: (RouteEntry | string)[];
				receives?: boolean;
				receivesFrom?: (RouteEntry | string)[];
		  };
};
export type Node = {
	name: string;
	subscriptions: { database: string; schema: string; subscribe: boolean }[];
	replicates:
		| boolean
		| {
				sends?: boolean;
				sendsTo?: (RouteEntry | string)[];
				receives?: boolean;
				receivesFrom?: (RouteEntry | string)[];
		  };
	url?: string;
	port?: number;
	startTime?: number;
	revoked_certificates?: string[];
	shard?: number;
	isLeader?: boolean;
};

/**
 * Returns the set of tables to exclude for a given peer+database from a sendsTo or receivesFrom
 * route-entry array. Returns null when there are no exclusions (hot path: avoids a Set allocation).
 */
export function getExcludedTablesForRouteEntries(
	entries: (RouteEntry | string)[] | undefined,
	peerName: string,
	databaseName: string
): Set<string> | null {
	if (!entries) return null;
	let excluded: Set<string> | null = null;
	for (const entry of entries) {
		if (typeof entry === 'string') continue;
		const entryPeer = entry.target ?? entry.source;
		if ((!entryPeer || entryPeer === peerName) && (!entry.database || entry.database === databaseName)) {
			if (entry.excludeTables?.length) {
				if (!excluded) excluded = new Set(entry.excludeTables);
				else for (const t of entry.excludeTables) excluded.add(t);
			}
		}
	}
	return excluded;
}

export function* iterateRoutes(options: { routes: (Route | any)[] }) {
	for (const route of options.routes || []) {
		let url = route.url;
		let host: string;
		if (typeof route === 'string') {
			// a plain route string can be a url or hostname (or host)
			if (route.includes('://')) url = route;
			else host = route;
		} else host = route.hostname ?? route.host;
		if (!host && url) {
			host = new URL(url).hostname;
		} else if (!url && !host) {
			if (isMainThread) console.error('Invalid route, must specify a url or host (with port)');
			continue;
		}

		// Support sendsTo/receivesFrom either nested under replicates: or as top-level route keys
		let replicates = route.replicates;
		if (replicates === undefined) {
			if (route.sendsTo || route.receivesFrom) {
				replicates = { sendsTo: route.sendsTo, receivesFrom: route.receivesFrom };
			} else {
				replicates = !route.subscriptions; // if there is not a list of subscriptions, then this node is authorized to fully replicate
			}
		}
		yield {
			replicates,
			name: host,
			url,
			port: route.port,
			subscription: route.subscriptions,
			routes: route.routes,
			startTime: route.startTime,
			revoked_certificates: route.revokedCertificates,
		};
	}
}

export function getNodeURL(node: Node): string {
	if (node.url) return node.url;
	let host = node.name;
	const securePort = env.get(CONFIG_PARAMS.REPLICATION_SECUREPORT);
	let port: any;
	// if the host includes a port, use that port
	if ((port = host.match(/:(\d+)$/)?.[1])) host = host.slice(0, -port[0].length - 1);
	else if (node.port)
		port = node.port; // could be in the routes config
	// otherwise use the default port for the service
	else port = securePort || env.get(CONFIG_PARAMS.REPLICATION_PORT) || 9933;
	const lastColon = port?.lastIndexOf?.(':');
	if (lastColon > 0) port = +port.slice(lastColon + 1).replace(/[[\]]/g, '');

	return (securePort ? 'wss://' : 'ws://') + host + ':' + port; // now construct the full url
}
