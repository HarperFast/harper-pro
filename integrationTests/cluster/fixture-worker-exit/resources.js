// Test-only component for harper-pro#431 connection-truth cases. Its endpoints run on an HTTP worker and
// relay commands to workerFaultInjector.mjs, preloaded on every worker thread, pool workers included.
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

// Resolves with the acks that arrive within `windowMs`, or as soon as thread `untilThreadId` acks. This
// thread's own injector receives the command too.
function sendWorkerCommand(command, untilThreadId, windowMs = 5000) {
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
			if (data.threadId === untilThreadId) finish();
		};
		channel.postMessage({ ...command, id });
	});
}

// GET /KillWorker/<threadId>: the named worker thread exits abruptly.
export class KillWorker extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const threadId = Number(target.id);
		const [killed] = await sendWorkerCommand({ type: 'exit', threadId }, threadId);
		return { killed };
	}
}

// GET /ArmSubscribeAfterOpen/<owner threadId>: arms R5's subscribe-deferral hook at runtime, so R1-R4 run
// unperturbed. On every thread, since the re-subscribe may be placed on another replication worker; returns
// once the current owner has armed.
export class ArmSubscribeAfterOpen extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		const armedThreads = await sendWorkerCommand(
			{ type: 'set-env', name: 'HARPER_TEST_SUBSCRIBE_AFTER_OPEN_ONCE_DB', value: 'data' },
			Number(target.id)
		);
		return { database: 'data', armedThreads };
	}
}
