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
	return new Float64Array(
		auditStore.getUserSharedBuffer(
			['replicated', databaseName, node_name],
			new ArrayBuffer(64),
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
export async function runNodeUpdateWatcher(listener: (node: any, id: string) => void, options: WatcherOptions = {}) {
	const subscribe = options.subscribe ?? (() => getHDBNodeTable().subscribe({}));
	const processEvent = options.processEvent ?? processNodeUpdateEvent;
	const restartDelayMs = options.restartDelayMs ?? NODE_WATCHER_RESTART_DELAY_MS;
	const maxDelayMs = options.maxDelayMs ?? NODE_WATCHER_MAX_DELAY_MS;
	const maxRestarts = options.maxRestarts ?? Infinity;
	let restarts = 0;
	let consecutiveFailures = 0;
	while (restarts < maxRestarts) {
		let iteratedSuccessfully = false;
		try {
			const events = await subscribe();
			iteratedSuccessfully = true; // we got past subscribe — any later throw is a fresh failure
			for await (const event of events) {
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
			logger.warn?.('hdb_nodes subscription ended unexpectedly; restarting watcher');
		} catch (error) {
			logger.error?.('hdb_nodes watcher failed; restarting', error);
		}
		// Successful subscribe → reset backoff so a fresh failure restarts quickly.
		consecutiveFailures = iteratedSuccessfully ? 0 : consecutiveFailures + 1;
		restarts++;
		if (restarts >= maxRestarts) return;
		const delay = Math.min(restartDelayMs * Math.pow(2, Math.min(consecutiveFailures, 5)), maxDelayMs);
		await new Promise((resolve) => setTimeout(resolve, delay));
	}
}
/**
 * Raw existence check for an hdb_nodes record that does NOT decode the stored value.
 * A decode failure (e.g. stale msgpackr shared-structures, harper#1163) must not be
 * misread as the record being absent: `primaryStore.get()` would throw/return undefined
 * for an undecodable-but-present row, so we probe at the bytes level instead.
 */
export function nodeRecordPhysicallyExists(name: string): boolean {
	const store: any = getHDBNodeTable().primaryStore;
	if (typeof store.doesExist === 'function') return store.doesExist(name);
	// getBinaryFast returns the raw value bytes (or undefined when the key is absent).
	if (typeof store.getBinaryFast === 'function') return store.getBinaryFast(name) != null;
	// Last-resort fallback: a present-but-undecodable record will still throw here, so be
	// conservative and treat a throw as "present" (don't let it look like a deletion).
	try {
		return store.get(name) != null;
	} catch {
		return true;
	}
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

async function processNodeUpdateEvent(event: any, listener: (node: any, id: string) => void) {
	// remove any nodes that have been updated or deleted
	const node_name = event?.value?.name || event?.id;
	logger.debug?.('adding node', node_name, 'on  node', getThisNodeName(), ' on process', process.pid);
	server.nodes = server.nodes.filter((node) => node && node.name !== node_name);
	if (event.type === 'put' && node_name !== getThisNodeName()) {
		// add any new nodes
		if (event.value) server.nodes.push(event.value);
		else {
			console.error('Invalid node update event', event);
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
			// msgpackr shared-structures, harper#1163) — NOT a node removal. Forwarding it here
			// would make onNodeUpdate treat the nullish value as a deletion and unsubscribe the
			// peer from every database. Drop it instead; the next decodable event self-heals.
			logger.warn?.(
				'hdb_nodes change event for',
				event.id,
				'had no decodable value; treating as a transient decode failure (see harper#1163), not a node deletion'
			);
		}
	} else if (event.type === 'patch' && event.value?.isLeader !== undefined) {
		// isLeader patches need to drive subscription bootstrap; pass the merged record.
		const fullRecord = getHDBNodeTable().primaryStore.get(event.id);
		if (fullRecord) listener(fullRecord, event.id);
	}
}
export function subscribeToNodeUpdates(listener: (node: any, id: string) => void) {
	runNodeUpdateWatcher(listener);
	server.nodes = [];
	server.shards = new Map();

	for (let entry of getHDBNodeTable().primaryStore.getRange({})) {
		const { value: node, key } = entry;
		if (!node) continue;
		server.nodes.push(node);
		if (node.shard != undefined) {
			let nodesForShard = server.shards.get(node.shard);
			if (!nodesForShard) {
				server.shards.set(node.shard, (nodesForShard = []));
			}
			nodesForShard.push(node);
		}
		listener(node, key);
	}
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
	});
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
