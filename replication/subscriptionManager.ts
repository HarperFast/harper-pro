/**
 * This module is responsible for managing the subscriptions for replication. It determines the connections and
 * subscriptions that are needed and delegates them to the available threads. It also manages when connections are
 * lost and delegating subscriptions through other nodes
 */
import { getDatabases } from '../core/resources/databases.ts';
import { workers, onMessageByType, whenThreadsStarted } from '../core/server/threads/manageThreads.js';
import {
	subscribeToNode,
	urlToNodeName,
	forEachReplicatedDatabase,
	unsubscribeFromNode,
	lastTimeInAuditStore,
} from './replicator.ts';
import { getThisNodeName, getThisNodeUrl } from '../core/server/nodeName.ts';
import { parentPort } from 'worker_threads';
import {
	subscribeToNodeUpdates,
	getHDBNodeTable,
	iterateRoutes,
	shouldReplicateToNode,
	type Node,
	type Route,
	getNodeURL,
} from './knownNodes.ts';
import * as logger from '../core/utility/logging/harper_logger.js';
import lodash from 'lodash';
const { cloneDeep } = lodash;
import env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import { X509Certificate } from 'crypto';
import minimist from 'minimist';
const cliArgs = minimist(process.argv);

type ConnectedWorkerStatus = {
	worker: Worker | null;
	connected?: boolean;
	latency?: number;
};
type ReplicationConnectionStatus = {
	nodes: ({
		name: string;
		url: string;
		replicates: boolean;
		replicateByDefault: boolean;
		startTime?: number;
		endTime?: number;
		shard?: string;
	} & ConnectedWorkerStatus)[];
} & ConnectedWorkerStatus;
type DBReplicationStatusMap = Map<string, ReplicationConnectionStatus> & { iterator: any };

const NODE_SUBSCRIBE_DELAY = 200; // delay before sending node subscribe to other nodes, so operations can complete first
const connectionReplicationMap = new Map<string, DBReplicationStatusMap>();
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
				selfCatchupOfDatabase.set(dbName, lastTimeInAuditStore(table.auditStore));
				break;
			}
		}
	}
	// we need to wait for the threads to start before we can start adding nodes
	// but don't await this because this start function has to finish before the threads can start
	whenThreadsStarted.then(async () => {
		const nodes = [];
		// if we are getting notified of system table updates, hdbNodes could be absent
		for await (const node of databases.system.hdb_nodes?.search([]) || []) {
			nodes.push(node);
		}
		const thisName = getThisNodeName();
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

		// Pre-populate nodeMap with all nodes before calling onNodeUpdate, so excluded list can be built correctly
		for (const node of nodes) {
			if (node.name && node.name !== thisName) {
				nodeMap.set(node.name, node);
			}
		}
		for (const route of iterateRoutes(options)) {
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
				// Pre-populate nodeMap with route nodes
				if (route.name) {
					nodeMap.set(route.name, route);
				}
			} catch (error) {
				console.error(error);
			}
		}

		// Now call onNodeUpdate for all nodes - nodeMap is complete so excluded lists will be correct
		for (const node of nodes) {
			onNodeUpdate(node);
		}
		for (const route of iterateRoutes(options)) {
			if (nodes.find((node) => node.name === route.name)) continue;
			onNodeUpdate(route);
		}

		subscribeToNodeUpdates(onNodeUpdate);
	});
	let isFullyReplicating;
	/**
	 * This is called when a new node is added to the hdbNodes table
	 * @param node
	 */
	function onNodeUpdate(node, hostname = node?.name) {
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
		if (!(node.replicates === true || node.replicates?.sends) && !node.subscriptions?.length && !dbReplicationWorkers)
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
				onDatabase(databaseName, true);
			} else {
				onDatabase(databaseName, false);
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
					onDatabase(databaseName, false);
				}
			}
		}

		function onDatabase(databaseName, tablesReplicateByDefault) {
			logger.trace('Setting up replication for database', databaseName, 'on node', node.name);
			const existingEntry = dbReplicationWorkers.get(databaseName);
			let worker;

			// Build excluded nodes list - all other nodes we will be/are subscribing to for this database
			const excluded: string[] = [];
			for (const [otherNodeName, otherNode] of nodeMap) {
				if (otherNodeName === node.name) continue; // skip the current node
				// Check if we should replicate to this other node for this database
				if (shouldReplicateToNode(otherNode, databaseName)) {
					excluded.push(otherNodeName);
				}
			}

			const nodes = [{ replicateByDefault: tablesReplicateByDefault, ...node, excluded: excluded.length > 0 ? excluded : undefined }];
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
			const shouldSubscribe = shouldReplicateToNode(node, databaseName);
			const httpWorkers = workers.filter((worker) => worker.name === 'http');
			if (existingEntry) {
				worker = existingEntry.worker;
				existingEntry.nodes = nodes;
				if (shouldSubscribe) {
					// already subscribed, don't need to do anything
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
				});
				worker?.on('exit', () => {
					// when a worker exits, we need to remove the entry from the map, and then reassign the subscriptions
					if (dbReplicationWorkers.get(databaseName)?.worker === worker) {
						// first verify it is still the worker
						dbReplicationWorkers.delete(databaseName);
						onDatabase(databaseName, tablesReplicateByDefault);
					}
				});
			}
			if (shouldSubscribe) {
				let leaderUrl: string =
					cliArgs.HDB_LEADER_URL ?? // first see if there was a leader explicitly specified
					process.env.HDB_LEADER_URL ??
					routes[0]?.url; // if we have routes, use the first one

				let leaderName = leaderUrl
					? new URL(leaderUrl).hostname
					: Array.from(
							getHDBNodeTable()
								.primaryStore.getKeys({})
								.filter((nodeName) => nodeName !== getThisNodeName()) // find the first node that is not this one
						)[0]; // try to find the first node
				const nodeName = nodes[0].name ?? (nodes[0].url && new URL(nodes[0].url).hostname);
				logger.warn(`Setting up subscription with leader ${leaderName} for node ${nodeName}`);
				nodes[0].isLeader = !leaderName || nodeName === leaderName;
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
				if (!getHDBNodeTable().primaryStore.get(getThisNodeName())?.replicates) {
					// if we are not fully replicating because it is turned off, make sure we set this
					// flag so that we actually turn on subscriptions if full replication is turned on
					isFullyReplicating = false;
					logger.info(
						'Disabling replication, this node name',
						getThisNodeName(),
						getHDBNodeTable().primaryStore.get(getThisNodeName()),
						databaseName
					);
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
			existingWorkerEntry.connected = false;
			if (connection.finished) {
				return;
			} // intentionally closed connection
			if (!env.get(CONFIG_PARAMS.REPLICATION_FAILOVER)) {
				// if failover is disabled, immediately return
				return;
			}
			const mainNode = existingWorkerEntry.nodes[0];
			if (!(mainNode.replicates === true || mainNode.replicates?.sends || mainNode.subscriptions?.length)) {
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
				const filtered = failOverNodes.filter((node) => {
					if (node) {
						if (node.name === restoredNode.name && node.worker) {
							node.worker.postMessage({
								type: 'unsubscribe-to-node',
								database: connection.database,
								url: connection.url,
								nodes: [node],
							});
							return false;
						}
						return true;
					}
				});
				if (filtered.length < failOverNodes.length) {
					// if we were in the list, reset the nodes list
					failOverConnections.nodes = filtered;
				}
			}
		}
	};
	function connectToNextWorker(node: Node, database: string, connectingNode = node) {
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
export function requestClusterStatus(message, port) {
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

if (parentPort) {
	disconnectedFromNode = (connection) => {
		parentPort.postMessage({ type: 'disconnected-from-node', ...connection });
	};
	connectedToNode = (connection) => {
		parentPort.postMessage({ type: 'connected-to-node', ...connection });
	};
	onMessageByType('subscribe-to-node', (message) => {
		subscribeToNode(message);
	});
	onMessageByType('unsubscribe-from-node', (message) => {
		unsubscribeFromNode(message);
	});
}

export async function ensureNode(name: string, node) {
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
	if (!existing) {
		await table.patch(node);
	} else {
		if (node.replicates && !env.get(CONFIG_PARAMS.CLUSTERING_ENABLED)) node.subscriptions = null; // if we are fully replicating without NATS, we don't need to have subscriptions
		for (const key in node) {
			if (existing[key] !== node[key] && key === 'subscriptions' && node[key] && existing[key]) {
				// Update any existing subscriptions or append to subscriptions array
				const newSubs = [];
				const existingSubs = cloneDeep(existing[key]);
				for (const newSub of node[key]) {
					let matchFound = false;
					for (const existingSub of existingSubs) {
						if (
							(newSub.database ?? newSub.schema) === (existingSub.database ?? existingSub.schema) &&
							newSub.table === existingSub.table
						) {
							existingSub.publish = newSub.publish;
							existingSub.subscribe = newSub.subscribe;
							matchFound = true;
							break;
						}
					}

					if (!matchFound) newSubs.push(newSub);
				}

				node.subscriptions = [...existingSubs, ...newSubs];
				break;
			}
		}

		if (Array.isArray(node.revoked_certificates)) {
			const existingRevoked = existing.revoked_certificates || [];
			node.revoked_certificates = [...new Set([...existingRevoked, ...node.revoked_certificates])];
		}

		logger.info(`Updating node ${name} at ${getNodeURL(node)}`);
		await table.patch(node);
	}
}
