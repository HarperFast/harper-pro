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
	BLOB_FAILURE_COUNT_POSITION,
	LAST_BLOB_FAILURE_TIME_POSITION,
	readConnectionTruth,
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
			// Blob-replication divergence (harper-pro#386): a non-zero count means replicated blobs failed
			// to save durably on this link. `connected: true` alone can hide that; surface it here so an
			// operator (or alert) sees the divergence and its recency.
			// `|| undefined` so a healthy link omits the field entirely (matching lastBlobFailure's asDate(0)).
			socket.blobReplicationFailures = replicationSharedStatus[BLOB_FAILURE_COUNT_POSITION] || undefined;
			socket.lastBlobFailure = asDate(replicationSharedStatus[LAST_BLOB_FAILURE_TIME_POSITION]);
			// W1 (harper-pro#431): the shared-memory connection truth is authoritative over the edge-triggered
			// map mirror in requestClusterStatus, which can still read connected:true for an open-but-idle
			// wedge that never delivered a disconnect (#289/#233). Also surface the last disconnect (#214).
			const truth = readConnectionTruth(auditStore, databaseName, remoteNodeName);
			if (truth) {
				socket.connected = truth.connected;
				if (truth.errorCode != null) {
					socket.lastConnectionError = { code: truth.errorCode, time: asDate(truth.errorTime) };
				}
			}
		}
	}

	// Add node name and shard/url info for this node
	response.node_name = getThisNodeName();
	// If it doesn't exist and or needs to be updated.
	// getSync (not get): a get() Promise on a cache miss has no .shard/.url, so cluster_status would
	// silently omit this node's shard/url once hdb_nodes grows past the block cache.
	const thisNode = getHDBNodeTable().primaryStore.getSync(response.node_name);
	if (thisNode?.shard) response.shard = thisNode.shard;
	if (thisNode?.url) response.url = thisNode.url;
	// is_enabled now reports whether this node is an active cluster member (harper-pro#217): a removed node
	// (or one with no peers) has no connections and reports false, instead of the previous always-true that
	// hid removal. `connections` is the per-peer list requestClusterStatus assembles from nodeMap; once a
	// removed node's hdb_nodes delete propagates to onNodeUpdate(null) the peer is dropped and this flips.
	response.is_enabled = response.connections.length > 0;

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
