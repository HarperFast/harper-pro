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
import env from '../core/utility/environment/environmentManager.js';
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
export function subscribeToNodeUpdates(listener: (node: any, id: string) => void) {
	getHDBNodeTable()
		.subscribe({})
		.then(async (events) => {
			for await (const event of events) {
				// remove any nodes that have been updated or deleted
				const node_name = event?.value?.name;
				logger.debug?.('adding node', node_name, 'on  node', getThisNodeName(), ' on process', process.pid);
				server.nodes = server.nodes.filter((node) => node.name !== node_name);
				if (event.type === 'put' && node_name !== getThisNodeName()) {
					// add any new nodes
					if (event.value) server.nodes.push(event.value);
					else {
						console.error('Invalid node update event', event);
					}
				}
				const shards = new Map();
				for await (const node of getHDBNodeTable().search({})) {
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
					listener(event.value, event.id);
				}
			}
		});
	server.nodes = [];
	server.shards = new Map();

	for (let entry of getHDBNodeTable().primaryStore.getRange({})) {
		const { value: node, key } = entry;
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
			databases[databaseName] &&
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
function startSubscriptionToReplications() {
	subscribeToNodeUpdates((nodeRecord) => {
		forEachReplicatedDatabase({}, (database, databaseName) => {
			const node_name = nodeRecord.name;
			let confirmationsForNode = replicationConfirmationFloat64s.get(node_name);
			if (!confirmationsForNode) {
				replicationConfirmationFloat64s.set(node_name, (confirmationsForNode = new Map()));
			}
			if (confirmationsForNode.has(databaseName)) return;
			let auditStore;
			for (const tableName in database) {
				const table = database[tableName];
				auditStore = table.auditStore;
				if (auditStore) break;
			}
			if (auditStore) {
				const replicatedTime = getReplicationSharedStatus(auditStore, databaseName, node_name, () => {
					const updatedTime = replicatedTime[0];
					const lastTime = replicatedTime.lastTime;
					for (const { txnTime, onConfirm } of commitsAwaitingReplication.get(databaseName) || []) {
						if (txnTime > lastTime && txnTime <= updatedTime) {
							onConfirm();
						}
					}
					replicatedTime.lastTime = updatedTime;
				});
				replicatedTime.lastTime = 0;
				confirmationsForNode.set(databaseName, replicatedTime);
			}
		});
	});
}
export type Route = {
	url?: string;
	subscriptions?: { database: string; schema: string; subscribe: boolean }[];
	hostname?: string;
	host?: string;
	port?: any;
	routes?: any[];
};
export type Node = {
	name: string;
	subscriptions: { database: string; schema: string; subscribe: boolean }[];
	replicates:
		| boolean
		| {
				sends?: boolean;
				sendsTo?: ({ target: string; database: string } | string)[];
				receives?: boolean;
				receivesFrom?: ({ source: string; database: string } | string)[];
		  };
	url?: string;
	port?: number;
	startTime?: number;
	revoked_certificates?: string[];
	shard?: number;
};

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

		yield {
			replicates: route.replicates ?? !route.subscriptions, // if there is not a list of subscriptions, then this node is authorized to fully replicate
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
	const host = node.name;
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
