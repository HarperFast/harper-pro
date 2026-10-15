import { workers } from '../core/server/threads/manageThreads.js';
import { isWorkerPoolActive } from '../core/server/threads/workerPools.ts';
import { THREAD_TYPES } from '../core/utility/hdbTerms.ts';

/**
 * Whether `worker` may own replication work: a (peer, database) subscription or a database's record-lock
 * coordination. The dedicated `replication` pool's workers whenever the pool runs — even while all of its
 * members are restarting, so placement defers rather than moving to HTTP workers that do not own the
 * replication port — and otherwise the `http` workers. A worker dedicated to an isolated application is an
 * `http` worker too, but its event loop and lifecycle belong to that one application, so it is excluded. It
 * still loads replication and can serve `lock()`, so it stays in every record-lock broadcast and fence
 * (harper-pro#974).
 */
export function isReplicationWorker(worker: any): boolean {
	if (isWorkerPoolActive(THREAD_TYPES.REPLICATION)) return worker.name === THREAD_TYPES.REPLICATION;
	return worker.name === THREAD_TYPES.HTTP && worker.application === undefined;
}

export function replicationWorkers(liveWorkers: any[] = workers): any[] {
	return liveWorkers.filter(isReplicationWorker);
}

/**
 * Main thread: every worker that can call a cluster `lock()` or hold a relayed lock handle, so must hear
 * every owner change and fence: HTTP workers (isolated ones included, they run application code) and the
 * replication pool. Not job workers.
 */
export function recordLockParticipantWorkers(liveWorkers: any[] = workers): any[] {
	return liveWorkers.filter((worker) => worker.name === THREAD_TYPES.HTTP || worker.name === THREAD_TYPES.REPLICATION);
}
