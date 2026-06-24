/**
 * This module is responsible for managing the subscriptions for replication. It determines the connections and
 * subscriptions that are needed and delegates them to the available threads. It also manages when connections are
 * lost and delegating subscriptions through other nodes
 */
import { getDatabases } from '../core/resources/databases.ts';
import { transaction } from '../core/resources/transaction.ts';
import { workers, onMessageByType, whenThreadsStarted } from '../core/server/threads/manageThreads.js';
import { lastTimeInAuditStore } from '../core/resources/nodeIdMapping.ts';
import { subscribeToNode, urlToNodeName, forEachReplicatedDatabase, unsubscribeFromNode } from './replicator.ts';
import { getThisNodeName, getThisNodeUrl } from '../core/server/nodeName.ts';
import { parentPort } from 'worker_threads';
import {
	subscribeToNodeUpdates,
	getHDBNodeTable,
	iterateRoutes,
	shouldReplicateFromNode,
	type Route,
	getNodeURL,
} from './knownNodes.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import lodash from 'lodash';
const { cloneDeep } = lodash;
import * as env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import { X509Certificate } from 'crypto';
import minimist from 'minimist';
const cliArgs = minimist(process.argv);

type ConnectedWorkerStatus = {
	worker: any;
	connected?: boolean;
	latency?: number;
	// Timestamp (ms) of the most recent transition to connected:false, used by the reconcile to
	// distinguish a connection that is briefly retrying from one that is wedged. Cleared on connect.
	disconnectedAt?: number;
	// Timestamp (ms) the entry was created. A never-connected entry (connected still undefined) never
	// receives a disconnectedAt — disconnectedFromNode only stamps that on a connected->false transition
	// — so the wedge reconcile uses disconnectedAt ?? createdAt as its "down since" clock. This lets a
	// connected:false transition that bypasses disconnectedFromNode (e.g. a connect() that never fired
	// 'open'/'close') still trip the wedge net once it's been down past the threshold. See harper-pro#466.
	createdAt?: number;
};
type ReplicationConnectionStatus = {
	url?: string;
	nodes: ({
		name: string;
		url: string;
		replicates: boolean;
		replicateByDefault: boolean;
		startTime?: number;
		endTime?: number;
		shard?: string;
		subscriptions?: any;
		worker?: any;
		isLeader?: boolean;
	} & ConnectedWorkerStatus)[];
} & ConnectedWorkerStatus;
type DBReplicationStatusMap = Map<string, ReplicationConnectionStatus> & { iterator?: any };

const NODE_SUBSCRIBE_DELAY = 200; // delay before sending node subscribe to other nodes, so operations can complete first
// When a worker dies it may have been holding subscriptions for many (database, node) pairs.
// All of those pairs fire onDatabase reassignments in the same tick, which would otherwise
// slam a fresh worker with a burst of catchup connections and is the kind of pressure that
// caused the OOM in the first place. We stagger the re-subscriptions in time so the new
// worker(s) absorb them gradually.
const WORKER_EXIT_REASSIGN_STAGGER_MS = 100;
// When the wedge reconcile re-drives disconnected subscriptions, each one opens a new WebSocket
// (and for TLS, a full TLS handshake). Firing hundreds simultaneously can spike memory (each
// replicateOverWS instance + TLS buffer). Stagger them so at most ~1 new connection starts
// per RECONNECT_STAGGER_MS, keeping peak concurrent connection setup bounded.
const RECONNECT_STAGGER_MS = 50;
// Cadence of the per-process safety-net reconcile that rebinds subscriptions whose
// worker no longer exists. Pure read-side filter against `workers` and
// `connectionReplicationMap` on each tick when nothing is wrong, so a short interval
// is cheap. Sized for the deploy-time rapid-restart-storm pattern (stacked
// `restart_http_workers` at ~1.5s spacing under live write traffic), where the per-
// worker exit chain races against shutdown and silently drops half the subscription
// assignments — this is the user-visible recovery latency for the resulting drift.
const RECONCILE_INTERVAL_MS = 5_000;
// A connection that is connected:false but still actively retrying reconnects within seconds (the
// retry backoff starts at 500ms). Only re-drive a connection that has stayed disconnected well
// beyond that, so the reconcile targets genuinely wedged connections (e.g. an intentionally-closed
// connection with no pending retry) rather than churning connections that are mid-reconnect.
const WEDGE_RECONCILE_THRESHOLD_MS = 30_000;
let nextWorkerExitReassignAt = 0;
const connectionReplicationMap = new Map<string, DBReplicationStatusMap>();

// harper-pro#351 defense-in-depth. Pure helper so the fail-loud identity check (and its unit
// tests) don't need the live subscription machinery. Given this node's resolved name/url and
// the set of nodes registered in hdb_nodes, return a loud warning string when there ARE
// registered peers but none of them is this node (by name or url) — i.e. this node's identity
// does not match what the cluster knows it as. In that state
// `primaryStore.get(thisName)?.replicates` is undefined, which is treated as "replication off"
// and silently unsubscribes from every peer for user databases (system keeps syncing, so the
// node looks healthy). Returns undefined when there's no mismatch (or no registered peers yet,
// since a brand-new/unjoined node legitimately has no self row).
export function describeIdentityMismatch(
	thisName: string | undefined,
	thisUrl: string | undefined,
	nodes: Array<{ name?: string; url?: string } | null | undefined>
): string | undefined {
	if (!nodes || nodes.length === 0) return undefined;
	const selfRow = nodes.find((node) => (thisName && node?.name === thisName) || (thisUrl && node?.url === thisUrl));
	if (selfRow) return undefined;
	const registered = nodes
		.map((n) => n?.name)
		.filter(Boolean)
		.join(', ');
	return (
		`Replication identity mismatch: this node identifies as "${thisName}" (url ${thisUrl}) but no matching row ` +
		`exists in system.hdb_nodes (which has ${nodes.length} node(s): ${registered}). User-database replication ` +
		`will NOT run for this node until its identity matches a registered node name. This usually means ` +
		`node.hostname / replication.hostname resolves to the wrong value (e.g. an in-place v4->v5 upgrade boot ` +
		`planted node.hostname: localhost — see harper-pro#351). Set node.hostname to the name this node is ` +
		`registered under in hdb_nodes, or remove it to fall back to replication.hostname.`
	);
}

// harper-pro#351 defense-in-depth. Emit the identity-mismatch error at most once per process: the
// silent-disable decision point below runs per-database, so without this the same warning would be
// logged once for every user database. `describeIdentityMismatch` is the gate — it returns undefined
// (no log) whenever a self row exists, so a node with replication legitimately off, or a correct
// identity that is merely mid-boot, never trips it; only a genuine name/url mismatch does.
let identityMismatchReported = false;
function reportIdentityMismatchOnce(nodes: Array<{ name?: string; url?: string } | null | undefined>): void {
	if (identityMismatchReported) return;
	const warning = describeIdentityMismatch(getThisNodeName(), getThisNodeUrl(), nodes);
	if (warning) {
		identityMismatchReported = true;
		logger.error(warning);
	}
}

// Returns the set of node URLs whose replication entries either point at a worker no longer
// in the supplied http pool, OR have no worker assigned at all while live workers exist.
// The second case covers "all workers were down at registration time" — onDatabase stores
// `worker: undefined` when httpWorkers is empty, and without this the entry would never
// get reassigned once workers came back. Pure helper so the reconcile pass below — and its
// unit tests — can verify the broken-chain detection without spinning up real workers.
export function findStaleNodeUrls(connectionMap: Map<string, DBReplicationStatusMap>, httpWorkers: any[]): Set<string> {
	const staleNodeUrls = new Set<string>();
	// No live workers to reassign to — flagging here would cause endless no-op reassignments.
	if (httpWorkers.length === 0) return staleNodeUrls;
	for (const [url, dbReplicationWorkers] of connectionMap) {
		for (const entry of dbReplicationWorkers.values()) {
			if (!entry.worker || !httpWorkers.includes(entry.worker)) {
				staleNodeUrls.add(url);
				break;
			}
		}
	}
	return staleNodeUrls;
}
// Returns the set of node URLs that have a desired replication subscription but have been
// connected:false on a *live* worker for longer than `thresholdMs`. This is the recovery path for a
// connection that wedged without a pending retry — most notably the empty-subscription delayed close
// (intentionallyUnsubscribed) firing during a peer restart and then never re-establishing even though
// the peer is reachable and still subscribed. findStaleNodeUrls does not catch this because the
// worker is alive. Re-driving these through onNodeUpdate creates a fresh connection (the prior one is
// no longer reusable — see replicator.isReusableConnection). A threshold well above the normal
// reconnect backoff keeps this from firing on connections that are merely mid-retry.
// `isDesired` must be the same predicate onDatabase uses to decide shouldSubscribe
// (shouldReplicateFromNode), so a connection intentionally unsubscribed because this node should NOT
// subscribe (replication off, or a sendsTo/subscription targeting another database) is not flagged
// and re-driven forever. See harper-pro#233 / #289.
export function findWedgedNodeUrls(
	connectionMap: Map<string, DBReplicationStatusMap>,
	httpWorkers: any[],
	now: number,
	thresholdMs: number,
	isDesired: (node: any, database: string) => boolean
): Set<string> {
	const wedgedNodeUrls = new Set<string>();
	if (httpWorkers.length === 0) return wedgedNodeUrls;
	for (const [url, dbReplicationWorkers] of connectionMap) {
		for (const [database, entry] of dbReplicationWorkers) {
			// connected !== true (not === false) so a never-connected entry — connected still undefined
			// because its connect() never fired 'open' — is caught too, not only an entry that flipped
			// false via disconnectedFromNode. downSince falls back to createdAt for that never-connected
			// case so the threshold gate still uses a real timestamp and a fresh/mid-initial-connect entry
			// is never flagged (it clears to connected:true within seconds on a healthy 'open'). See #466.
			const downSince = entry.disconnectedAt ?? entry.createdAt;
			if (
				entry.connected !== true &&
				entry.worker &&
				httpWorkers.includes(entry.worker) &&
				downSince != null &&
				now - downSince >= thresholdMs &&
				isDesired(entry.nodes?.[0], database)
			) {
				wedgedNodeUrls.add(url);
				break;
			}
		}
	}
	return wedgedNodeUrls;
}
// Tear down the failover subscription(s) a restored node left behind on another connection's
// worker, and prune it from that entry's nodes list. The unsubscribe must mirror the subscribe-time
// connectionKey built in replicator.getSubscriptionConnection (connectingUrl + '-' + subscriptionUrl),
// so `url` is the failover entry's own (connecting) url, not the restored node's url.
export function removeRestoredNodeFromFailoverEntry(
	failOverConnections: ReplicationConnectionStatus,
	restoredNode: { name: string },
	database: string,
	unsubscribe: (request: any) => void = unsubscribeFromNode
) {
	const failOverNodes = failOverConnections.nodes;
	const filtered = failOverNodes.filter((node) => {
		if (!node) return false;
		if (node.name !== restoredNode.name) return true;
		const request = {
			type: 'unsubscribe-from-node',
			database,
			url: failOverConnections.url,
			nodes: [node],
		};
		// single-threaded instances have no worker assigned; unsubscribe directly on this thread
		if (node.worker) node.worker.postMessage(request);
		else unsubscribe(request);
		return false;
	});
	if (filtered.length < failOverNodes.length) {
		// if we were in the list, reset the nodes list
		failOverConnections.nodes = filtered;
	}
}
export let disconnectedFromNode; // this is set by thread to handle when a node is disconnected (or notify main thread so it can handle)
export let connectedToNode; // this is set by thread to handle when a node is connected (or notify main thread so it can handle)
const nodeMap = new Map(); // this is a map of all nodes that are available to connect to
const selfCatchupOfDatabase = new Map<string, number>(); // this is a map of databases that need to catch up to themselves, and the time of the last audit entry (to start from)
const routes: Route[] = [];
export async function startOnMainThread(options) {
	// we do all of the main management of tracking connections and subscriptions on the main thread and delegate
	// the actual work to the worker threads
	let nextWorkerIndex = 0;
	const databases = getDatabases();
	// find all the databases last recorded audit entry so that we can inquire from the first node for self catch-up
	// of any records that may have been missed
	for (const dbName of Object.getOwnPropertyNames(databases)) {
		const database = databases[dbName];
		for (const tableName in database) {
			const table = database[tableName];
			if (table.auditStore) {
				selfCatchupOfDatabase.set(dbName, lastTimeInAuditStore(table.auditStore) as number);
				break;
			}
		}
	}
	// we need to wait for the threads to start before we can start adding nodes
	// but don't await this because this start function has to finish before the threads can start
	whenThreadsStarted.then(async () => {
		// A deploy_component reload re-invokes startOnMainThread on this same already-resolved module
		// instance, so this callback re-fires (whenThreadsStarted is already settled). Reset the
		// module-level route list before repopulating so routes don't accumulate duplicates across
		// deploys; the node-update watcher started by subscribeToNodeUpdates below is itself idempotent
		// (it supersedes the prior watcher rather than stacking one — see knownNodes.ts). harper-pro#460.
		routes.length = 0;
		const nodes = [];
		// if we are getting notified of system table updates, hdbNodes could be absent
		for await (const node of databases.system.hdb_nodes?.search([]) || []) {
			nodes.push(node);
		}
		const thisName = getThisNodeName();
		// Fail loud on identity mismatch (harper-pro#351 defense-in-depth). If there are peers
		// registered in hdb_nodes but none of them is THIS node (by name or url), then this
		// node's identity does not match what the cluster knows it as. Downstream that means
		// `getHDBNodeTable().primaryStore.get(thisName)?.replicates` is undefined, which is
		// treated as "replication off" and silently unsubscribes from every peer for user
		// databases while system keeps syncing — the node looks healthy but quietly drops
		// replicated writes (silent split-brain). Surface it loudly instead of failing silent.
		// This early check is a no-op when hdb_nodes hasn't loaded yet on this boot path (empty
		// nodes → brand-new-node case); the authoritative check is at the unsubscribe decision
		// point in onDatabase below, which has the loaded hdb_nodes rows in hand (harper-pro#351).
		reportIdentityMismatchOnce(nodes);
		function ensureThisNode() {
			// If it doesn't exist and or needs to be updated.
			const existing = getHDBNodeTable().primaryStore.get(thisName);
			if (existing !== null) {
				// if this was null it has previously been deleted, and we don't want to recreate nodes for deleted nodes
				const url = options.url ?? getThisNodeUrl();
				if (existing === undefined || existing.url !== url || existing.shard !== options.shard) {
					return ensureNode(thisName, {
						name: thisName,
						url,
						shard: options.shard,
						replicates: true,
					});
				}
			}
		}
		if (getHDBNodeTable().primaryStore.get(thisName)) ensureThisNode(); // if this node record already exists, check for config changes
		for (const route of iterateRoutes(options) as any) {
			try {
				const replicateAll = !route.subscriptions;
				if (replicateAll) {
					await ensureThisNode();
				}
				if (replicateAll) {
					if (route.replicates == undefined) route.replicates = true;
				}
				routes.push(route);
				if (nodes.find((node) => node.name === route.name)) continue;
				// just tentatively add this node to the list of nodes in memory
				onNodeUpdate(route);
			} catch (error) {
				console.error(error);
			}
		}
		// keyed 'subscription-manager' so a deploy_component reload (which re-fires this callback)
		// supersedes only this watcher, while the CA-monitor and replication-confirmation watchers
		// keyed elsewhere keep running concurrently (harper-pro#460).
		subscribeToNodeUpdates(onNodeUpdate, 'subscription-manager');
	});
	let isFullyReplicating;
	/**
	 * This is called when a new node is added to the hdbNodes table
	 * @param node
	 */
	function onNodeUpdate(node, hostname = node?.name, forceResubscribe = false) {
		const isSelf =
			(getThisNodeName() && hostname === getThisNodeName()) || (getThisNodeUrl() && node?.url === getThisNodeUrl());
		if (isSelf) {
			// this is just this node, we don't need to connect to ourselves, but if we get removed, we need to remove all fully replicating connections,
			// so we update each one
			const shouldFullyReplicate = Boolean(node?.replicates);
			if (isFullyReplicating !== undefined && isFullyReplicating !== shouldFullyReplicate) {
				for (const node of getHDBNodeTable().search([])) {
					if (node.replicates && node.name !== hostname) onNodeUpdate(node, node.name);
				}
			}
			isFullyReplicating = shouldFullyReplicate;
		}
		logger.info('Setting up node replication for', node);
		if (!node) {
			// deleted node
			nodeMap.delete(hostname);
			for (const [url, dbReplicationWorkers] of connectionReplicationMap) {
				let foundNode;
				for (const [_database, { nodes }] of dbReplicationWorkers) {
					const node = nodes[0];
					if (!node) continue;
					if (node.name == hostname) {
						foundNode = true;
						for (const [database, { worker }] of dbReplicationWorkers) {
							dbReplicationWorkers.delete(database);
							logger.warn('Node was deleted, unsubscribing from node', hostname, database, url);
							worker?.postMessage({ type: 'unsubscribe-from-node', node: hostname, nodes, database, url });
						}
						break;
					}
				}
				if (foundNode) {
					const dbReplicationWorkers = connectionReplicationMap.get(url);
					dbReplicationWorkers.iterator.remove();
					connectionReplicationMap.delete(url);
					return;
				}
			}
			return;
		}
		if (isSelf) return;
		let dbReplicationWorkers = connectionReplicationMap.get(getNodeURL(node));
		if (dbReplicationWorkers) dbReplicationWorkers.iterator.remove(); // we need to remove the old iterator so we can create a new one
		if (
			!(
				node.replicates === true ||
				node.replicates?.sends ||
				node.replicates?.sendsTo?.length ||
				node.replicates?.receivesFrom?.length
			) &&
			!node.subscriptions?.length &&
			!dbReplicationWorkers
		)
			return; // we don't have any subscriptions and we haven't connected yet, so just return
		logger.info(`Added node ${node.name} at ${getNodeURL(node)} for process ${getThisNodeName()}`);
		if (node.replicates && node.subscriptions) {
			node = { ...node, subscriptions: null }; // if we have replicates flag set and have subscriptions, remove the subscriptions, they are just there for NATS
		}
		if (node.name) {
			// don't add to a map if we don't have a name (yet)
			// replace any node with same url
			for (const [key, existingNode] of nodeMap) {
				if (node.url === existingNode.url) {
					nodeMap.delete(key);
					break;
				}
			}
			nodeMap.set(node.name, node);
		}
		const databases = getDatabases();
		if (!dbReplicationWorkers) {
			dbReplicationWorkers = new Map();
			connectionReplicationMap.set(getNodeURL(node), dbReplicationWorkers);
		}
		dbReplicationWorkers.iterator = forEachReplicatedDatabase(options, (database, databaseName, replicateByDefault) => {
			if (replicateByDefault) {
				onDatabase(databaseName, true, forceResubscribe);
			} else {
				onDatabase(databaseName, false, forceResubscribe);
			}
		});
		// check to see if there are any explicit subscriptions to databases that don't exist yet
		if (node.subscriptions) {
			// if we can't find any more granular subscriptions, then we skip this database
			// check to see if we have any explicit node subscriptions
			for (const sub of node.subscriptions) {
				const databaseName = sub.database || sub.schema;
				if (!databases[databaseName]) {
					logger.warn(`Database ${databaseName} not found for node ${node.name}, making a subscription anyway`);
					onDatabase(databaseName, false, forceResubscribe);
				}
			}
		}
		// When this peer is our leader, bootstrap subscriptions for configured databases
		// that don't exist locally yet — they need a full-table copy from the leader.
		// forEachReplicatedDatabase above only iterates local databases, so an empty node
		// joining a populated leader would never schedule the catchup without this.
		if (node.isLeader && Array.isArray(options?.databases)) {
			for (const dbConfig of options.databases) {
				const databaseName = typeof dbConfig === 'string' ? dbConfig : dbConfig?.name;
				if (databaseName && !databases[databaseName]) {
					logger.warn(
						`isLeader: bootstrapping full-copy subscription for non-existent database ${databaseName} from ${node.name}`
					);
					onDatabase(databaseName, true, forceResubscribe);
				}
			}
		}

		function onDatabase(databaseName, tablesReplicateByDefault, forceResubscribe = false) {
			logger.trace('Setting up replication for database', databaseName, 'on node', node.name);
			let existingEntry = dbReplicationWorkers.get(databaseName);
			let worker;
			// Find the matching route config for this peer so we can pass its receivesFrom/sendsTo
			// exclusions to the worker thread (via the node subscription payload). For dynamic
			// routes (add_node), fall back to the node's own hdb_nodes replicates object.
			const matchingRoute = routes.find((r) => r.name === node.name);
			const routeReplicates =
				typeof matchingRoute?.replicates === 'object'
					? matchingRoute.replicates
					: node.replicates && typeof node.replicates === 'object'
						? node.replicates
						: null;
			const nodes = [{ replicateByDefault: tablesReplicateByDefault, ...node, routeReplicates }];
			// Self catchup is done in case we have replicated any records that weren't actually written to our storage
			// before a crash.
			if (selfCatchupOfDatabase.has(databaseName) && env.get(CONFIG_PARAMS.REPLICATION_FAILOVER)) {
				// if we have a self catchup (only do if we have failover enabled), we need to add this node to the list of nodes that need to catch up
				// and then we will remove it when it is done
				nodes.push({
					replicateByDefault: tablesReplicateByDefault,
					name: getThisNodeName(),
					startTime: selfCatchupOfDatabase.get(databaseName),
					endTime: Date.now(),
					replicates: true,
				});
				selfCatchupOfDatabase.delete(databaseName);
			}
			const shouldSubscribe = shouldReplicateFromNode(node, databaseName);
			const httpWorkers = workers.filter((worker) => worker.name === 'http');
			// Defensively detect entries that point at a worker no longer in the http pool.
			// This happens when the worker.on('exit') handler below never fired (hung WebSocket
			// refs blocking exit), the identity check rejected the reassignment, or its
			// setTimeout retry was lost. We also catch the case where the entry has no worker
			// assigned at all (all workers were down at registration time) so it gets rebound
			// once workers come back. Without these checks, the early-return branch keeps the
			// entry stuck and the subscription never recovers.
			if (existingEntry && httpWorkers.length > 0 && !httpWorkers.includes(existingEntry.worker as any)) {
				logger.warn(`Subscription for ${databaseName} on node ${node.name} has no live worker; reassigning`);
				dbReplicationWorkers.delete(databaseName);
				existingEntry = undefined;
			}
			if (existingEntry) {
				worker = existingEntry.worker;
				existingEntry.nodes = nodes;
				// Normally an existing subscribed entry is left alone. Only the wedge reconcile passes
				// forceResubscribe for a connection that has been connected:false past the threshold: that
				// falls through to re-post subscribe-to-node on the same worker (the worker then reuses a
				// still-retrying connection or builds a fresh one — replicator.isReusableConnection). We
				// deliberately do NOT re-subscribe every connected:false entry on an ordinary onNodeUpdate —
				// doing so disrupts in-flight replication (e.g. an active legacy-node base copy).
				if (shouldSubscribe && !(forceResubscribe && existingEntry.connected === false)) {
					return;
				}
			} else if (shouldSubscribe) {
				nextWorkerIndex = nextWorkerIndex % httpWorkers.length; // wrap around as necessary
				worker = httpWorkers[nextWorkerIndex++];
				if (!worker) {
					logger.warn('No http workers available to subscribe to node', node.name, getNodeURL(node));
				}
				dbReplicationWorkers.set(databaseName, {
					worker,
					nodes,
					url: getNodeURL(node),
					// "Down since" baseline for the wedge reconcile. A subscription that is created here but
					// never reaches 'open' (so connectedToNode never clears it and disconnectedFromNode never
					// stamps disconnectedAt) would otherwise be invisible to findWedgedNodeUrls. See harper-pro#466.
					createdAt: Date.now(),
				});
				worker?.on('exit', () => {
					// when a worker exits, we need to remove the entry from the map, and then reassign the subscriptions
					if (dbReplicationWorkers.get(databaseName)?.worker === worker) {
						// first verify it is still the worker
						dbReplicationWorkers.delete(databaseName);
						const now = Date.now();
						nextWorkerExitReassignAt = Math.max(now, nextWorkerExitReassignAt) + WORKER_EXIT_REASSIGN_STAGGER_MS;
						const delay = nextWorkerExitReassignAt - now;
						setTimeout(() => onDatabase(databaseName, tablesReplicateByDefault), delay).unref();
					}
				});
			}
			if (shouldSubscribe) {
				let leaderUrl: string =
					cliArgs.HDB_LEADER_URL ?? // first see if there was a leader explicitly specified
					process.env.HDB_LEADER_URL ??
					routes[0]?.url; // if we have routes, use the first one
				// Track whether the leader is explicitly configured (env/cli/routes). The
				// fallback "first other node in hdb_nodes" is only a guess and must NOT be
				// treated as authoritative — otherwise a bidirectional add_node handshake
				// where the responder has no leader config will incorrectly mark the
				// requester as its leader and trigger a reverse full-table copy.
				const hasExplicitLeader = !!leaderUrl;

				let leaderName = leaderUrl
					? new URL(leaderUrl).hostname
					: Array.from(
							getHDBNodeTable()
								.primaryStore.getKeys({})
								.filter((nodeName) => nodeName !== getThisNodeName()) // find the first node that is not this one
						)[0]; // try to find the first node
				const nodeName = nodes[0].name ?? (nodes[0].url && new URL(nodes[0].url).hostname);
				logger.warn(`Setting up subscription with leader ${leaderName} for node ${nodeName}`);
				// isLeader is true only if:
				//   1. it was explicitly persisted (e.g. by add_node { isLeader: true }), OR
				//   2. there is no leader candidate at all, OR
				//   3. an explicitly configured leader (env/cli/routes) matches this node.
				// We deliberately do NOT honour nodeName === leaderName when leaderName came
				// from the "first other node in hdb_nodes" fallback — that's just a guess.
				nodes[0].isLeader = nodes[0].isLeader || !leaderName || (hasExplicitLeader && nodeName === leaderName);
				nodes[0].url ??= getNodeURL(nodes[0]);
				setTimeout(() => {
					const request = {
						...nodes[0],
						type: 'subscribe-to-node',
						database: databaseName,
						nodes,
					};
					if (worker) {
						worker.postMessage(request);
					} else subscribeToNode(request);
				}, NODE_SUBSCRIBE_DELAY);
			} else {
				logger.info('Node no longer should be used, unsubscribing from node', {
					replicates: node.replicates,
					databaseName,
					node,
					subscriptions: node.subscriptions,
					hasDatabase: !!databases[databaseName],
					thisReplicates: getHDBNodeTable().primaryStore.get(getThisNodeName())?.replicates,
				});
				const nodeStore = getHDBNodeTable().primaryStore;
				const selfNodeRow = nodeStore.get(getThisNodeName());
				if (!selfNodeRow?.replicates) {
					// if we are not fully replicating because it is turned off, make sure we set this
					// flag so that we actually turn on subscriptions if full replication is turned on
					isFullyReplicating = false;
					logger.info('Disabling replication, this node name', getThisNodeName(), selfNodeRow, databaseName);
					// harper-pro#351: this is the authoritative silent-disable point — it runs with the
					// loaded hdb_nodes rows in hand, unlike the brand-new-node startup check which sees an
					// empty table. Reaching it with NO self row (as opposed to a self row with
					// replicates:false, the legitimate "replication off") while OTHER nodes are registered
					// means this node's identity doesn't match what the cluster knows it as, so replication
					// is being silently disabled for a harmful reason. Surface it loudly. Only enumerate the
					// table when the self row is actually absent, so the legitimate replication-off path
					// stays a cheap point read.
					if (!selfNodeRow) {
						const registeredNodes = Array.from(nodeStore.getKeys({})).map((name) => ({
							name,
							...nodeStore.get(name),
						}));
						reportIdentityMismatchOnce(registeredNodes);
					}
				}
				const request = {
					type: 'unsubscribe-from-node',
					database: databaseName,
					url: getNodeURL(node),
					name: node.name,
					nodes,
				};
				if (worker) {
					worker.postMessage(request);
				} else unsubscribeFromNode(request);
			}
		}
	}
	// only assign these if we are on the main thread
	disconnectedFromNode = function (connection) {
		// if a node is disconnected, we need to reassign the subscriptions to another node
		// we try to do this in a deterministic way so that we don't end up with a cycle that short circuits
		// a node that may have more recent updates, so we try to go to the next node in the list, using
		// a sorted list of node names that all nodes should have and use.
		try {
			logger.info('Disconnected from node', connection.name, connection.url, 'finished', !!connection.finished);
			const nodeMapKeys = Array.from(nodeMap.keys());
			const nodeNames = nodeMapKeys.sort();
			const existingIndex = nodeNames.indexOf(connection.name || urlToNodeName(connection.url));
			if (existingIndex === -1) {
				logger.warn('Disconnected node not found in node map', connection.name, nodeMapKeys);
				return;
			}
			let dbReplicationWorkers = connectionReplicationMap.get(connection.url);
			const existingWorkerEntry = dbReplicationWorkers?.get(connection.database);
			if (!existingWorkerEntry) {
				logger.warn('Disconnected node not found in replication map', connection.database, dbReplicationWorkers);
				return;
			}
			// Record the first transition to disconnected so the reconcile can tell a wedged connection
			// from one that is briefly mid-retry; don't reset it on repeated disconnect notifications.
			if (existingWorkerEntry.connected !== false) existingWorkerEntry.disconnectedAt = Date.now();
			existingWorkerEntry.connected = false;
			if (connection.finished) {
				return;
			} // intentionally closed connection
			if (!env.get(CONFIG_PARAMS.REPLICATION_FAILOVER)) {
				// if failover is disabled, immediately return
				return;
			}
			const mainNode: any = existingWorkerEntry.nodes[0];
			if (
				!(
					mainNode.replicates === true ||
					mainNode.replicates?.sends ||
					mainNode.replicates?.sendsTo?.length ||
					mainNode.replicates?.receivesFrom?.length ||
					mainNode.subscriptions?.length
				)
			) {
				// no replication, so just return
				return;
			}
			const shard = mainNode.shard;
			let nextIndex = (existingIndex + 1) % nodeNames.length;
			while (existingIndex !== nextIndex) {
				const nextNodeName = nodeNames[nextIndex];
				const nextNode = nodeMap.get(nextNodeName);
				dbReplicationWorkers = connectionReplicationMap.get(getNodeURL(nextNode));
				const failoverWorkerEntry = dbReplicationWorkers?.get(connection.database);
				if (
					!failoverWorkerEntry ||
					failoverWorkerEntry.connected === false ||
					failoverWorkerEntry.nodes[0].shard !== shard
				) {
					// try the next node if this isn't connected or isn't in the same shard
					nextIndex = (nextIndex + 1) % nodeNames.length;
					continue;
				}
				const { nodes } = failoverWorkerEntry;
				// record which node we are now redirecting to
				let hasMovedNodes = false;
				for (const node of existingWorkerEntry.nodes) {
					if (nodes.some((n) => n.name === node.name)) {
						logger.info(`Disconnected node is already failing over to ${nextNodeName} for ${connection.database}`);
						continue;
					}
					if (node.endTime < Date.now()) continue; // already expired
					nodes.push(node);
					logger.info(`Failing over ${connection.database} from ${connection.name} to ${nextNodeName}`);
					connectToNextWorker(node, connection.database, failoverWorkerEntry.nodes[0]);
					hasMovedNodes = true;
				}
				existingWorkerEntry.nodes = [existingWorkerEntry.nodes[0]]; // only keep our own subscription
				if (!hasMovedNodes) {
					logger.info(`Disconnected node ${connection.name} has no nodes to fail over to ${nextNodeName}`);
				}
				return;
			}
			logger.warn('Unable to find any other node to fail over to', connection.name, connection.url);
		} catch (error) {
			logger.error('Error failing over node', error);
		}
	};

	connectedToNode = function (connection) {
		// Basically undo what we did in disconnectedFromNode and also update the latency
		const dbReplicationWorkers = connectionReplicationMap.get(connection.url);
		const mainWorkerEntry = dbReplicationWorkers?.get(connection.database);
		if (!mainWorkerEntry) {
			logger.warn(
				'Connected node not found in replication map, this may be because the node is being removed',
				connection.database,
				dbReplicationWorkers
			);
			return;
		}
		mainWorkerEntry.connected = true;
		mainWorkerEntry.disconnectedAt = undefined;
		mainWorkerEntry.latency = connection.latency;
		const restoredNode = mainWorkerEntry.nodes[0];
		if (!restoredNode) {
			logger.warn('Newly connected node has no node subscriptions', connection.database, mainWorkerEntry);
			return;
		}
		if (!restoredNode.name) {
			logger.debug('Connected node is not named yet', connection.database, mainWorkerEntry.url);
			return;
		}
		if (!env.get(CONFIG_PARAMS.REPLICATION_FAILOVER)) {
			// if failover is disabled, immediately return, we don't need to restore anything
			return;
		}

		mainWorkerEntry.nodes = [restoredNode]; // restart with just our own connection
		for (const nodeWorkers of connectionReplicationMap.values()) {
			const failOverConnections = nodeWorkers.get(connection.database);
			if (!failOverConnections || failOverConnections == mainWorkerEntry) continue;
			const { nodes: failOverNodes, connected } = failOverConnections;
			if (!failOverNodes) continue;
			if (connected === false && failOverNodes[0].shard === restoredNode.shard && connection.url === restoredNode.url) {
				// if it is not connected and has extra nodes, grab them
				for (let node of failOverNodes) {
					connectToNextWorker(node, connection.database);
				}
			} else {
				// remove the restored node from any other connections list of node
				removeRestoredNodeFromFailoverEntry(failOverConnections, restoredNode, connection.database);
			}
		}
	};
	function connectToNextWorker(node: any, database: string, connectingNode = node) {
		const httpWorkers = workers.filter((worker: any) => worker.name === 'http');
		nextWorkerIndex = nextWorkerIndex % httpWorkers.length; // wrap around as necessary
		const worker = httpWorkers[nextWorkerIndex++];
		// not enumerable property, we don't want this to be serialized in the postMessage
		Object.defineProperty(node, 'worker', { value: worker, configurable: true });
		if (worker) {
			worker.postMessage({
				url: getNodeURL(connectingNode),
				name: connectingNode.name,
				type: 'subscribe-to-node',
				database,
				nodes: [node],
			});
		} else subscribeToNode({ url: getNodeURL(connectingNode), name: connectingNode.name, database, nodes: [node] });
	}
	// Periodic safety net for stale subscription entries. The existing per-database
	// worker.on('exit') chain reassigns to a healthy worker after a worker dies, but a
	// single broken link in that chain (identity check failing, setTimeout retry being
	// lost under load, shouldSubscribe early-return pinning to a dead worker before
	// the defensive check was added) used to leave the entry permanently pointing at
	// an exited worker, silently breaking outbound replication for the lifetime of the
	// process. This reconciles independently of the chain so the broken-state node
	// can never get stuck.
	function reconcileWorkers() {
		const httpWorkers = workers.filter((worker) => worker.name === 'http');
		const staleNodeUrls = findStaleNodeUrls(connectionReplicationMap, httpWorkers);
		const wedgedNodeUrls = findWedgedNodeUrls(
			connectionReplicationMap,
			httpWorkers,
			Date.now(),
			WEDGE_RECONCILE_THRESHOLD_MS,
			shouldReplicateFromNode
		);
		if (staleNodeUrls.size === 0 && wedgedNodeUrls.size === 0) return;
		if (staleNodeUrls.size > 0)
			logger.warn(
				'Reconciling replication subscriptions for nodes pointing at exited workers:',
				Array.from(staleNodeUrls)
			);
		if (wedgedNodeUrls.size > 0)
			logger.warn(
				'Reconciling replication subscriptions for nodes wedged disconnected on a live worker:',
				Array.from(wedgedNodeUrls)
			);
		for (const node of nodeMap.values()) {
			const url = getNodeURL(node);
			const isWedged = wedgedNodeUrls.has(url);
			if (!staleNodeUrls.has(url) && !isWedged) continue;
			if (isWedged) {
				// Re-drive ONLY the existing connected:false entries, not the full onNodeUpdate pass.
				//
				// onNodeUpdate calls forEachReplicatedDatabase → Object.getOwnPropertyNames(databases),
				// which fires subscribe-to-node for EVERY database in the process — including any that
				// aren't yet in dbReplicationWorkers. In a cluster with many databases this creates
				// hundreds of simultaneous replicateOverWS + TLS-handshake instances and can OOM.
				// The updatedListener in forEachReplicatedDatabase already handles newly-added databases
				// during normal operation; the wedge reconcile should only reconnect entries that are
				// already tracked and stuck in connected:false.
				const entries = connectionReplicationMap.get(url);
				if (!entries) continue;
				let reconnectCount = 0;
				for (const [databaseName, entry] of entries) {
					// Mirror findWedgedNodeUrls: skip only confirmed-connected entries, so a never-connected
					// entry (connected still undefined) is re-driven too — not just one that flipped false via
					// disconnectedFromNode. See harper-pro#466.
					if (entry.connected === true) continue;
					// Restart the disconnect clock so this entry is not re-driven on every reconcile
					// tick until it either connects or exceeds the threshold again. Stamping disconnectedAt
					// also gives a never-connected entry a real "down since" for subsequent ticks.
					entry.disconnectedAt = Date.now();
					const worker = entry.worker;
					const nodes = entry.nodes;
					if (!worker || !nodes) continue;
					const request = {
						...nodes[0],
						type: 'subscribe-to-node',
						database: databaseName,
						nodes,
						// Force a reconnect rather than relying on the re-subscribe alone. subscribeToNode reuses
						// the cached connection when isReusableConnection is true (not finished, not intentionally
						// unsubscribed), so a never-connected wedge — connect() rejected with no socket, but the
						// connection object is still "reusable" — would otherwise just receive subscribe() again
						// and stay wedged. forceReconnect drives an independent reconnect (and no-ops when a retry
						// is already pending, via its reconnectScheduled guard), keeping this backstop effective
						// even if the connection's own retry never armed. See harper-pro#466.
						forceReconnect: true,
					};
					// Stagger reconnects (RECONNECT_STAGGER_MS apart) so opening N TLS connections
					// simultaneously does not spike memory when there are many databases.
					const delay = NODE_SUBSCRIBE_DELAY + reconnectCount * RECONNECT_STAGGER_MS;
					reconnectCount++;
					setTimeout(() => worker.postMessage(request), delay).unref();
				}
				if (reconnectCount > 0)
					logger.warn(
						`Reconciling ${reconnectCount} wedged subscription(s) for ${url} (staggered over ${reconnectCount * RECONNECT_STAGGER_MS}ms)`
					);
			} else {
				try {
					onNodeUpdate(node);
				} catch (error) {
					logger.error('Error reconciling node', node?.name, error);
				}
			}
		}
	}
	setInterval(reconcileWorkers, RECONCILE_INTERVAL_MS).unref();
	onMessageByType('disconnected-from-node', disconnectedFromNode);
	onMessageByType('connected-to-node', connectedToNode);
	onMessageByType('request-cluster-status', requestClusterStatus);
}

/**
 * This is called when a request is made to get the cluster status. This should be executed only on the main thread
 * and will return the status of all replication connections (for each database)
 * @param message
 * @param port
 */
export function requestClusterStatus(message?, port?) {
	const connections = [];
	for (const [node_name, node] of nodeMap) {
		try {
			const dbReplicationMap = connectionReplicationMap.get(getNodeURL(node));
			logger.info('Getting cluster status for', node_name, getNodeURL(node), 'has dbs', dbReplicationMap?.size);
			const databases = [];
			if (dbReplicationMap) {
				for (const [database, { worker, connected, nodes, latency }] of dbReplicationMap) {
					databases.push({
						database,
						connected,
						latency,
						threadId: worker?.threadId,
						nodes: nodes.filter((node) => !(node.endTime < Date.now())).map((node) => node.name),
					});
				}

				const res = cloneDeep(node);
				res.database_sockets = databases;
				delete res.ca;
				delete res.node_name;
				delete res.__updatedtime__;
				delete res.__createdtime__;
				connections.push(res);
			}
		} catch (error) {
			logger.warn('Error getting cluster status for', node?.url, error);
		}
	}
	port?.postMessage({
		type: 'cluster-status',
		connections,
	});
	return { connections };
}

// threadServer.js starts servers at import time on non-main workers, and job workers import this
// module (replication is a HARPER_BUILTIN_COMPONENT), so importing it at module load would spuriously
// start servers / keep job workers alive. Lazily import it only when a subscribe/unsubscribe actually
// arrives — which only happens on HTTP/replication workers, where threadServer is already loaded, so
// the dynamic import resolves to the cached module with no side effect. Cached after first use.
let componentsLoadedPromise: Promise<unknown> | undefined;
function whenWorkerComponentsLoaded(): Promise<unknown> {
	return (componentsLoadedPromise ??= import('../core/server/threads/threadServer.js').then(
		(threadServer) => threadServer.whenComponentsLoaded
	));
}

if (parentPort) {
	disconnectedFromNode = (connection) => {
		parentPort.postMessage({ type: 'disconnected-from-node', ...connection });
	};
	connectedToNode = (connection) => {
		parentPort.postMessage({ type: 'connected-to-node', ...connection });
	};
	onMessageByType('subscribe-to-node', (message) => {
		// Defer until this worker has finished loading components (databases/tables + persisted hdb_nodes
		// rows). subscribeToNode re-checks shouldReplicateFromNode, which reads that thread-local state; if
		// it runs before the state is loaded it filters the request down to empty and arms a permanent
		// "no subscriptions" close, wedging the (peer, db) until restart (harper-pro#289 / #233). Once
		// components are loaded the predicate is authoritative. In steady state the promise is already
		// resolved, so this is effectively synchronous.
		whenWorkerComponentsLoaded().then(() => subscribeToNode(message));
	});
	onMessageByType('unsubscribe-from-node', (message) => {
		// Defer through the same gate as subscribe-to-node so the two stay ordered: a pre-load
		// subscribe followed by an unsubscribe must apply in that order (else the deferred subscribe
		// would run after the unsubscribe and re-open a connection the main thread already removed).
		whenWorkerComponentsLoaded().then(() => unsubscribeFromNode(message));
	});
}

export async function ensureNode(name: string, node, options?: { localOnly?: boolean }) {
	const table = getHDBNodeTable();
	name = name ?? urlToNodeName(node.url);
	node.name = name;

	try {
		if (node.ca) {
			const cert = new X509Certificate(node.ca);
			node.ca_info = {
				issuer: cert.issuer.replace(/\n/g, ' '),
				subject: cert.subject.replace(/\n/g, ' '),
				subjectAltName: cert.subjectAltName,
				serialNumber: cert.serialNumber,
				validFrom: cert.validFrom,
				validTo: cert.validTo,
			};
		}
	} catch (err) {
		logger.error('Error parsing replication CA info for hdb_nodes table', err.message);
	}

	const existing = table.primaryStore.get(name);
	logger.debug(`Ensuring node ${name} at ${getNodeURL(node)}, existing record:`, existing, 'new record:', node);
	if (existing && Array.isArray(node.revoked_certificates)) {
		const existingRevoked = existing.revoked_certificates || [];
		node.revoked_certificates = [...new Set([...existingRevoked, ...node.revoked_certificates])];
	}
	if (existing) logger.info(`Updating node ${name} at ${getNodeURL(node)}`);

	// LOCAL_ONLY is sticky: once a node row is a cross-cluster bridge peer (harper-pro #246) it must
	// STAY local-only across subsequent writes, even when this particular update doesn't request it
	// (e.g. an `update_node` or a reconnect path that omits `isLeader`). The metadata bit is per-write,
	// not inherited, so without re-asserting it the next plain patch() would clear it and the row would
	// replicate to the mesh again, re-opening #246. We key off the existing record's `isLeader` field
	// (already loaded above; written together with the LOCAL_ONLY bit by setNode) rather than the
	// metadata bit — `isLeader === true` IS the bridge-peer marker. `node.isLeader === false` is an
	// explicit demotion, which is allowed to clear it.
	const alreadyLocalOnly = existing?.isLeader === true && node.isLeader !== false;

	if (options?.localOnly || alreadyLocalOnly) {
		// Persist the node row with the LOCAL_ONLY metadata bit so it never replicates to peers
		// (e.g. a v4 bridge peer that must stay invisible to the rest of the v5 mesh — harper-pro #246).
		// The public patch() API has no per-write option slot, so write through the resource's internal
		// _writeUpdate, which threads { localOnly } down to the record encoder. Wrapped in a transaction
		// to mirror the transactional() boundary that the public patch()/put() path provides.
		await transaction(async (txn) => {
			const context = (txn as any).getContext();
			const resource: any = await table.getResource(name, context, { async: true });
			await resource._writeUpdate(name, node, false, { localOnly: true });
			await resource.save?.();
		});
	} else {
		await table.patch(node);
	}
}
