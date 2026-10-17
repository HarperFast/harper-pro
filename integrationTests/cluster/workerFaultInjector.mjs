// Test-only `threads.preload` module, so it runs on every worker thread including `replication` pool
// workers, which load no application code. Two features, each inert unless its environment variable is set:
//
// HARPER_TEST_BLOB_FAULT_DIR — blob save faults. Armed by the test creating `<dir>/armed`; while armed, every data-database /blobs/ save is SLOW (each held in flight
// HARPER_TEST_BLOB_SLOW_MS) and selected saves FAIL asynchronously with ENOENT (HARPER_TEST_BLOB_FAIL_SAVES:
// `<record>:<n>` fails that record's n-th fresh save, `<record>:repair` its first in-place repair save).
// Attempts are claimed with exclusive-create files in the directory, so the schedule is process-wide and does
// not replay when the subscription moves to another worker or a worker restarts. Each injected failure leaves
// `<dir>/failed-<record>-<n or repair>-<thread type>`.
//
// HARPER_TEST_WORKER_COMMANDS=1 — commands over a BroadcastChannel, sent by fixture-worker-exit:
//   { type: 'exit', threadId }            the named thread exits abruptly (no close handlers, no DOWN write)
//   { type: 'set-env', name, value }      every thread sets its own process.env[name], a HARPER_TEST_ name
// Every thread a command applies to answers with { ack: <command id>, threadId, threadType }.
import { createRequire } from 'node:module';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { BroadcastChannel, isMainThread, threadId, workerData } from 'node:worker_threads';

const COMMAND_CHANNEL = 'harper-test-worker-commands';
const threadType = workerData?.name;

const faultDir = process.env.HARPER_TEST_BLOB_FAULT_DIR;
if (faultDir && !isMainThread) installBlobFaults(faultDir);
if (process.env.HARPER_TEST_WORKER_COMMANDS === '1' && !isMainThread) listenForCommands();

function claim(name) {
	try {
		closeSync(openSync(join(faultDir, name), 'wx'));
		return true;
	} catch (error) {
		if (error.code === 'EEXIST') return false;
		throw error;
	}
}

const firstUnclaimed = new Map();
function nextAttempt(recordSeed, kind) {
	const key = `${recordSeed}-${kind}`;
	let n = firstUnclaimed.get(key) ?? 1;
	while (!claim(`attempt-${key}-${n}`)) n++;
	firstUnclaimed.set(key, n + 1);
	return n;
}

function installBlobFaults(dir) {
	const failSaves = new Set(
		(process.env.HARPER_TEST_BLOB_FAIL_SAVES || '')
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean)
	);
	const slowMs = Number.parseInt(process.env.HARPER_TEST_BLOB_SLOW_MS || '0', 10);
	const armedMarker = join(dir, 'armed');
	// The CJS module object: ESM namespaces are frozen.
	const fs = createRequire(import.meta.url)('node:fs');
	const realCreateWriteStream = fs.createWriteStream;
	fs.createWriteStream = function patchedCreateWriteStream(path) {
		if (typeof path !== 'string' || !path.includes('/blobs/data/') || !existsSync(armedMarker))
			return realCreateWriteStream.apply(this, arguments);
		const isRepair = path.endsWith('.repair');
		// The REAL stream (saveBlob reads fd/bytesWritten off it) with only write() patched.
		const real = realCreateWriteStream.apply(this, arguments);
		const realWrite = real.write.bind(real);
		const realEnd = real.end.bind(real);
		let writes = 0;
		let header;
		let recordSeed = -1;
		const flushHeader = () => {
			if (!header) return;
			realWrite(...header);
			header = undefined;
		};
		real.end = function () {
			flushHeader();
			return realEnd(...arguments);
		};
		real.write = function (chunk, enc, cb) {
			writes++;
			if (writes === 1) {
				// The size header, held until the payload identifies the record, so a failed save leaves an empty
				// file (the receiver stamps it PENDING), never a partial one.
				header = [chunk, enc, cb];
				return false;
			}
			if (writes === 2) {
				// By record, not save ordinal: the copy's post-walk log tail re-delivers records the walk already
				// copied. The fixture payload's first byte is (seed*131)&0xff, inverted with 131*43≡1 (mod 256).
				recordSeed = chunk?.length ? (chunk[0] * 43) & 0xff : -1;
				const attempt = isRepair
					? nextAttempt(recordSeed, 'repair') === 1 && `${recordSeed}:repair`
					: `${recordSeed}:${nextAttempt(recordSeed, 'fresh')}`;
				if (attempt && failSaves.has(attempt)) {
					claim(`failed-${attempt.replace(':', '-')}-${threadType}`);
					console.log(`[blob-fail-slow-injector] failing save ${attempt} ${path} thread=${threadId}/${threadType}`);
					const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
					Object.assign(error, { code: 'ENOENT', errno: -2, syscall: 'open', path });
					const heldHeaderCallback = header[2];
					header = undefined;
					process.nextTick(() => {
						real.emit('error', error);
						heldHeaderCallback?.(error);
						cb?.(error);
					});
					return false;
				}
				flushHeader();
				const accepted = realWrite(chunk, enc, cb);
				if (slowMs <= 0) return accepted;
				// Backpressure released by a manual 'drain': every save stays in flight across frames, in order.
				setTimeout(() => real.emit('drain'), slowMs);
				return false;
			}
			return realWrite(chunk, enc, cb);
		};
		return real;
	};
}

function listenForCommands() {
	const channel = new BroadcastChannel(COMMAND_CHANNEL);
	channel.unref();
	channel.onmessage = ({ data: command }) => {
		if (command?.type === 'set-env' && command.name?.startsWith('HARPER_TEST_')) {
			process.env[command.name] = command.value;
		} else if (command?.type === 'exit' && command.threadId === threadId) {
			// Deferred so the ack goes out first. Harper's worker guard turns process.exit() into a no-op.
			setTimeout(() => (process._realExit ?? process.exit)(0), 100).unref();
		} else return;
		channel.postMessage({ ack: command.id, threadId, threadType });
	};
}
