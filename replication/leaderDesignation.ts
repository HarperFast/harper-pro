/**
 * Node-local leader designation.
 *
 * `add_node { isLeader: true }` expresses a NODE-LOCAL intent: "I, this node, should
 * full-table-copy from this peer (and bypass the local-db precondition for its databases)".
 * It must NOT be persisted onto the replicated `system.hdb_nodes` record, because that record
 * replicates to the rest of the mesh; every other v5 node would then read `isLeader: true` and
 * adopt the same peer as ITS leader, opening direct full-copy subscriptions that fail cert
 * validation in a reconnect loop (harper-pro#246).
 *
 * Instead we record the designation node-locally using `getUserSharedBuffer` on the hdb_nodes
 * store — the same non-replicated, cross-thread shared-memory primitive used elsewhere in the
 * codebase (e.g. requestRestart, replication confirmation buffers). The flag is:
 *   - node-local: it lives only in this process's shared memory and never touches the wire,
 *   - cross-thread: the operations worker that runs `setNode` and the main thread that runs the
 *     subscription manager see the same buffer (keyed per peer node name),
 *   - non-persisted: it does NOT survive a process restart. If a full-copy was already in
 *     progress, the persisted copy cursor (replicationConnection.ts) resumes it on restart; if the
 *     copy had not started, re-issue `add_node { isLeader }` (or configure routes / HDB_LEADER_URL)
 *     to re-establish it. Restart-persistence of the designation itself is an intentional
 *     follow-up — see harper-pro#246.
 */
import { getHDBNodeTable } from './knownNodes.ts';

const KEY_PREFIX = 'leader-designation:';

// Cache the per-node shared-buffer views so repeated reads don't re-acquire them.
const buffers = new Map<string, Uint8Array>();

function getBuffer(nodeName: string, callback?: () => void): Uint8Array {
	let view = buffers.get(nodeName);
	if (!view) {
		const buffer = getHDBNodeTable().primaryStore.getUserSharedBuffer(
			KEY_PREFIX + nodeName,
			new ArrayBuffer(1),
			callback ? { callback } : undefined
		);
		view = new Uint8Array(buffer as ArrayBuffer);
		buffers.set(nodeName, view);
	}
	return view;
}

/**
 * Record (or clear) the node-local leader designation for a peer. Called by `setNode` when an
 * `add_node`/`update_node`/`set_node` operation carries an explicit `isLeader`.
 *
 * Correctness does NOT depend on the notify() below: it is a no-op today because readers acquire
 * the buffer without registering a callback, so no listener exists. The happens-before guarantee
 * comes from ordering — `setNode` calls this BEFORE writing the hdb_nodes record, and that record
 * write is what triggers the main thread's subscription bootstrap (which then reads the same shared
 * buffer). The notify() is retained only so a future reader that registers a callback gets live
 * re-evaluation; it is harmless when unlistened.
 */
export function setLeaderDesignation(nodeName: string, isLeader: boolean) {
	if (!nodeName) return;
	const view = getBuffer(nodeName);
	view[0] = isLeader ? 1 : 0;
	const buffer = view.buffer as ArrayBuffer & { notify?: () => void };
	buffer.notify?.();
}

/**
 * Returns true if THIS node has locally designated the given peer as a leader. Only the node that
 * issued `add_node { isLeader }` sees this as true; a node that merely received the peer's
 * hdb_nodes record via mesh replication will see false (the flag never replicated).
 */
export function isLeaderDesignated(nodeName: string | undefined): boolean {
	if (!nodeName) return false;
	return getBuffer(nodeName)[0] === 1;
}
