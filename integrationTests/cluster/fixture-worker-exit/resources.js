// Test-only component for harper-pro#431 connection-truth cases. Its endpoints run on an HTTP worker and
// relay commands to the `threads.preload` injector (integrationTests/cluster/workerFaultInjector.mjs) on
// every worker thread, so they reach the thread that owns a replication subscription whether that is an
// HTTP worker or a `replication` pool worker, which loads no application code.
//
// Exiting a worker thread stops THAT THREAD, not the process, and it stops it hard — no 'close' on the
// replication socket, no shared-status DOWN write. That is exactly the fault the worker-exit truth stamp
// recovers from, and no operation produces it: `restart_service` drains workers gracefully AND is dispatched
// through a job, so it neither guarantees the abrupt exit nor lands within a bounded time.
//
// Inert unless the node was started with HARPER_TEST_WORKER_COMMANDS=1 and the injector preloaded: no thread
// answers, so every endpoint reports no acks.
import { BroadcastChannel } from 'node:worker_threads';

const COMMAND_CHANNEL = 'harper-test-worker-commands';

// Resolves with the acks that arrive within `windowMs`, or with the first one for a command addressed to a
// single thread. This thread's own injector receives the command too.
function sendWorkerCommand(command, windowMs = 1000) {
	const id = `${Date.now()}-${Math.random()}`;
	const channel = new BroadcastChannel(COMMAND_CHANNEL);
	const acks = [];
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			channel.close();
			resolve(acks);
		};
		const timer = setTimeout(finish, windowMs);
		channel.onmessage = ({ data }) => {
			if (data?.ack !== id) return;
			acks.push({ threadId: data.threadId, threadType: data.threadType });
			if (command.threadId !== undefined) finish();
		};
		channel.postMessage({ ...command, id });
	});
}

// GET /KillWorker/<threadId>: the named worker thread exits abruptly.
export class KillWorker extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const [killed] = await sendWorkerCommand({ type: 'exit', threadId: Number(target.id) }, 5000);
		return { killed };
	}
}

// Arms R5's subscribe-deferral hook at runtime rather than at startup, so R1-R4 run unperturbed. On every
// thread: the re-subscribe this precedes may be placed on any replication worker, and the hook is a
// one-shot per thread.
export class ArmSubscribeAfterOpen extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const armedThreads = await sendWorkerCommand({
			type: 'set-env',
			name: 'HARPER_TEST_SUBSCRIBE_AFTER_OPEN_ONCE_DB',
			value: 'data',
		});
		return { database: 'data', armedThreads };
	}
}
