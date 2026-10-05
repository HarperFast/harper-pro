import { workers } from '../core/server/threads/manageThreads.js';

/**
 * Whether `worker` may own replication work: a (peer, database) subscription or a database's record-lock
 * coordination. A worker dedicated to an isolated application is an `http` worker too, but its event loop and
 * lifecycle belong to that one application, so it is excluded. It still loads replication and can serve
 * `lock()`, so it stays in every record-lock broadcast and fence (harper-pro#974).
 */
export function isReplicationWorker(worker: any): boolean {
	return worker.name === 'http' && worker.application === undefined;
}

export function replicationWorkers(): any[] {
	return workers.filter(isReplicationWorker);
}
