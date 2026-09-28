/**
 * The coordinating worker's side of `transport.bench.mjs`: answers an acquire over the direct
 * worker-to-worker port and over `notify()`, so the two transports are measured against the same
 * handler doing the same work.
 *
 * `busyMs` is the point of the file. A relayed acquire is answered from the owner's event loop, so
 * it waits out whatever turn that worker is already in — the spin loop is a stand-in for the owner
 * serving its own requests, which is the normal state of a worker at `threads.count > 1`.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { RocksDatabase } from '@harperfast/rocksdb-js';

const db = new RocksDatabase(workerData.path);
db.open();

const peer = workerData.port;
let admissionId = 1;
let busyMs = 0;

const mint = (message) => ({
	requestId: message.requestId,
	database: message.database,
	table: message.table,
	key: message.key,
	round: { tsR: Date.now(), mintedMono: performance.now(), admissionId: admissionId++ },
	session: workerData.session,
});

const spin = () => {
	if (busyMs > 0) {
		const until = performance.now() + busyMs;
		while (performance.now() < until);
	}
	setImmediate(spin);
};
setImmediate(spin);

peer.on('message', (message) => {
	if (message.type === 'load') {
		busyMs = message.busyMs;
		peer.postMessage({ type: 'load-ack', requestId: message.requestId });
	} else if (message.type === 'acquire') {
		peer.postMessage({ type: 'acquire-reply', ...mint(message) });
	}
});

db.on('lock-acquire', (message) => db.notify('lock-acquire-reply', mint(message)));

parentPort.postMessage({ ready: true });
