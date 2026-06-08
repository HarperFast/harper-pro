// Test-only component that exposes a `/suicide-worker` endpoint. Hitting it
// kills the worker thread that received the request — the conventional exit
// code 137 (128 + 9, SIGKILL) is used. Harper's worker supervisor will respawn
// a fresh worker and trigger replication subscription reassignment, which is
// the codepath PR #147's stagger fix protects.
//
// Authorized via Harper's normal auth so the test driver must provide creds.
// Returns 200 immediately, then schedules the exit on the next tick so the
// response actually reaches the caller before the worker dies.
import { threadId } from 'node:worker_threads';

export class SuicideWorker extends Resource {
	allowRead() {
		return true;
	}
	get() {
		// Schedule the exit asynchronously so the HTTP response can flush.
		setImmediate(() => {
			// core/server/threads/workerProcessGuard intercepts `process.exit()` in
			// worker threads (so component code cannot terminate a worker), exposing
			// `process._realExit` as the escape hatch for a genuine termination. We
			// must use it here to actually kill the worker; a plain `process.exit`
			// would be logged-and-ignored and the worker would survive. Fall back to
			// `process.exit` for environments where the guard isn't loaded.
			(process._realExit ?? process.exit)(137);
		});
		return {
			threadId,
			pid: process.pid,
			message: 'worker will exit shortly',
		};
	}
}
