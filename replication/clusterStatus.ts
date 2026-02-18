'use strict';

import { parentPort } from 'worker_threads';
import { onMessageByType } from '../core/server/threads/manageThreads.js';
import { getThisNodeName } from '../core/server/nodeName.ts';
import { requestClusterStatus } from './subscriptionManager.ts';
import { getReplicationSharedStatus, getHDBNodeTable } from './knownNodes.ts';
import {
	CONFIRMATION_STATUS_POSITION,
	RECEIVED_VERSION_POSITION,
	RECEIVED_TIME_POSITION,
	SENDING_TIME_POSITION,
	RECEIVING_STATUS_POSITION,
	RECEIVING_STATUS_RECEIVING,
	BACK_PRESSURE_RATIO_POSITION,
} from './replicationConnection.ts';
import '../core/server/serverHelpers/serverUtilities.ts';

let clusterStatusResolve;
onMessageByType('cluster-status', async (message) => {
	clusterStatusResolve(message);
});
/**
 * Function will msg all the remote nodes in the hdbNodes table. From the replies
 * it gets back from each node and the details in the hdbNodes table it will
 * generate a status object. All the status objects are pushed to an array and returned.
 * @returns {Promise<{is_enabled: *, node_name: *, connections: *[]}>}
 */
export async function clusterStatus() {
	let response;
	if (parentPort) {
		parentPort.postMessage({ type: 'request-cluster-status' });
		response = await new Promise((resolve) => {
			clusterStatusResolve = resolve;
		});
	} else {
		response = requestClusterStatus();
	}

	// Augment the response with replication status information
	for (let connection of response.connections) {
		const remoteNodeName = connection.name;
		for (let socket of connection.database_sockets) {
			const databaseName = socket.database;
			let auditStore;
			for (let table of Object.values(databases[databaseName] || {})) {
				auditStore = table.auditStore;
				if (auditStore) break;
			}
			if (!auditStore) continue;
			let replicationSharedStatus = getReplicationSharedStatus(auditStore, databaseName, remoteNodeName);
			socket.lastCommitConfirmed = asDate(replicationSharedStatus[CONFIRMATION_STATUS_POSITION]);
			socket.lastReceivedRemoteTime = asDate(replicationSharedStatus[RECEIVED_VERSION_POSITION]);
			socket.lastReceivedLocalTime = asDate(replicationSharedStatus[RECEIVED_TIME_POSITION]);
			// Raw version timestamp for precise sync comparison (preserves float64 precision)
			socket.lastReceivedVersion = replicationSharedStatus[RECEIVED_VERSION_POSITION];
			socket.sendingMessage = asDate(replicationSharedStatus[SENDING_TIME_POSITION]);
			socket.backPressurePercent = replicationSharedStatus[BACK_PRESSURE_RATIO_POSITION] * 100;
			socket.lastReceivedStatus =
				replicationSharedStatus[RECEIVING_STATUS_POSITION] === RECEIVING_STATUS_RECEIVING ? 'Receiving' : 'Waiting';
		}
	}

	// Add node name and shard/url info for this node
	response.node_name = getThisNodeName();
	// If it doesn't exist and or needs to be updated.
	const thisNode = getHDBNodeTable().primaryStore.get(response.node_name);
	if (thisNode?.shard) response.shard = thisNode.shard;
	if (thisNode?.url) response.url = thisNode.url;
	response.is_enabled = true; // if we have replication, replication is enabled

	return response;
}
function asDate(date) {
	return date ? (date === 1 ? 'Copying' : new Date(date).toUTCString()) : undefined;
}

server.registerOperation?.({
	name: 'cluster_status',
	execute: clusterStatus,
	httpMethod: 'GET',
});
