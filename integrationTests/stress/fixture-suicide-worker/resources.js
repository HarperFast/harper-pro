// Test-only component that exposes a `/suicide-worker` endpoint. Hitting it
// kills the worker thread that received the request via process.exit(137) —
// the conventional exit code for SIGKILL-like termination. Harper's worker
// supervisor will respawn a fresh worker and trigger replication subscription
// reassignment, which is the codepath PR #147's stagger fix protects.
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
			// 137 = 128 + 9 (SIGKILL convention), but we use process.exit so the
			// node test harness still sees a clean exit code from the worker.
			process.exit(137);
		});
		return {
			threadId,
			pid: process.pid,
			message: 'worker will exit shortly',
		};
	}
}
