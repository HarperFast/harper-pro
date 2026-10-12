// Test-only `threads.preload` module: fault injection that reaches every worker thread, the `replication`
// pool's included. Pool workers load no application code, so an injector shipped as a component never runs
// on the thread that owns a replication socket once `replication.threads` is set; a preload runs on every
// worker before its entry script.
//
// Two independent features, each inert unless its environment variable is set:
//
// HARPER_TEST_BLOB_FAULT_DIR — blob save faults (copyGapCursorBanking.test.mjs, harper-pro#699). Armed by the
// test creating `<dir>/armed`; while armed, every data-database /blobs/ save is SLOW (each held in flight
// HARPER_TEST_BLOB_SLOW_MS) and selected saves FAIL asynchronously with ENOENT (HARPER_TEST_BLOB_FAIL_SAVES:
// `<record>:<n>` fails that record's n-th fresh save, `<record>:repair` its first in-place repair save).
// Attempts are counted by exclusive-create claim files in the directory, not per-thread memory, so the count
// is process-wide: a reconnect that re-places the subscription on another worker, or a restarted worker,
// continues the schedule rather than replaying it. Each injected failure leaves
// `<dir>/failed-<record>-<n or repair>-<thread type>`.
//
// HARPER_TEST_WORKER_COMMANDS=1 — thread-targeted commands over a BroadcastChannel (truthResiduals.test.mjs,
// harper-pro#431), sent from fixture-worker-exit's endpoints on an HTTP worker:
//   { type: 'exit', threadId }            the named thread exits abruptly (no close handlers, no DOWN write)
//   { type: 'set-env', name, value }      every thread sets process.env[name] (per-thread copy in a worker)
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

function nextAttempt(recordSeed, kind) {
	for (let n = 1; ; n++) if (claim(`attempt-${recordSeed}-${kind}-${n}`)) return n;
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
	// Patches the CJS module object (ESM namespaces are frozen); Harper resolves `createWriteStream` off the
	// live module object at call time.
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
				// The size header (core's writeBlobWithStream writes it before piping the body): held until the
				// record is known from the payload, so a failed save leaves an empty file (the receiver stamps it
				// PENDING), never a partial one.
				header = [chunk, enc, cb];
				return false;
			}
			if (writes === 2) {
				// Faults are selected by record, not by a save ordinal: the copy's post-walk log tail can re-deliver
				// records the walk already copied. The fixture payload's first byte is (seed*131)&0xff — inverted
				// with 131*43≡1 (mod 256).
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
				// Reports backpressure and releases the pipe with a manual 'drain' after slowMs, so every save is
				// held in flight across frames without reordering data.
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
		if (command?.type === 'set-env') {
			process.env[command.name] = command.value;
		} else if (command?.type === 'exit' && command.threadId === threadId) {
			// After the ack is posted, so the sender learns which thread and pool it killed. `_realExit` because
			// Harper's worker guard turns process.exit() into a no-op inside a worker.
			setTimeout(() => (process._realExit ?? process.exit)(0), 100).unref();
		} else return;
		channel.postMessage({ ack: command.id, threadId, threadType });
	};
}
