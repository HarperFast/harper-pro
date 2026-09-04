// Test-only component for harper-pro#431 R1: terminate the HTTP worker thread that owns a replication
// subscription, without the connection ever getting to record its own disconnect.
//
// Exiting a worker thread stops THAT THREAD, not the process, and it stops it hard — no 'close' on the
// replication socket, no shared-status DOWN write. That is exactly the fault the worker-exit truth stamp
// recovers from, and no operation produces it: `restart_service http_workers` drains the worker gracefully
// AND is dispatched through a job, so it neither guarantees the abrupt exit nor lands within a bounded time.
//
// `process._realExit` rather than `process.exit`: Harper's worker guard intercepts `process.exit()` inside a
// worker and keeps the thread alive, exposing `_realExit` as the genuine exit primitive
// (core/server/threads workerProcessGuard).
//
// Armed only when HARPER_TEST_KILL_HTTP_WORKER=1, so a stray deploy of this fixture is inert.
import { threadId } from 'node:worker_threads';

export class KillHttpWorker extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		if (process.env.HARPER_TEST_KILL_HTTP_WORKER !== '1') return { armed: false, threadId };
		// Exit after the response is on the wire, so the caller learns which thread it killed.
		setTimeout(() => (process._realExit ? process._realExit(0) : process.exit(0)), 100).unref();
		return { armed: true, threadId };
	}
}
