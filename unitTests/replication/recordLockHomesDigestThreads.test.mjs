/**
 * A peer's sockets to this node land on different threads, and a thread may hear only the handshake
 * digest on its socket. Agreement must not depend on which thread last heard from the peer.
 */
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const FIXTURE = require.resolve('./fixtures/homesDigestThread.cjs');
const { homesDigestThread } = require(FIXTURE);
const { homesDigestPrefix } = require('../../dist/replication/recordLockTransport.js');

const DATABASE = 'homes_digest_threads';
const HOMES = ['self', 'peer-a'];
const digest = (label) => createHash('sha256').update(label).digest('hex');

function startWorkerThread() {
	const worker = new Worker(
		`
		const { parentPort, workerData } = require('node:worker_threads');
		const { homesDigestThread } = require(workerData.fixture);
		const thread = homesDigestThread(workerData.database, workerData.homes);
		parentPort.on('message', async ({ id, method, args } = {}) => {
			if (id === undefined) return;
			try {
				parentPort.postMessage({ id, result: await thread[method](...args) });
			} catch (error) {
				parentPort.postMessage({ id, error: error?.stack ?? String(error) });
			}
		});
		parentPort.postMessage({ ready: true });
	`,
		{
			eval: true,
			execArgv: [],
			workerData: { noServerStart: true, fixture: FIXTURE, database: DATABASE, homes: HOMES },
		}
	);
	const pending = new Map();
	let nextId = 1;
	const ready = new Promise((resolve, reject) => {
		worker.once('error', reject);
		worker.on('message', (message) => {
			if (message?.ready) return resolve();
			const settle = pending.get(message?.id);
			if (!settle) return;
			pending.delete(message.id);
			settle(message);
		});
	});
	return {
		ready,
		call(method, ...args) {
			const id = nextId++;
			return new Promise((resolve, reject) => {
				pending.set(id, (message) => (message.error ? reject(new Error(message.error)) : resolve(message.result)));
				worker.postMessage({ id, method, args });
			});
		},
		terminate: () => worker.terminate(),
	};
}

describe('peer home-map digest agreement across threads of one node', function () {
	this.timeout(60_000);
	let here;
	let sibling;

	before(async () => {
		here = homesDigestThread(DATABASE, HOMES);
		sibling = startWorkerThread();
		await sibling.ready;
	});

	after(async () => {
		await sibling?.terminate();
		here?.dispose();
	});

	it('holds after a generation change the sibling thread heard only from its own cache', async () => {
		here.peerSupportsLocks('peer-a');
		await here.activate(1, digest('generation 1'));
		await sibling.call('activate', 1, digest('generation 1'));
		here.receive('peer-a', digest('generation 1'));
		await sibling.call('receive', 'peer-a', digest('generation 1'));
		assert.strictEqual(here.homeMapGeneration(), 1);
		assert.strictEqual(await sibling.call('homeMapGeneration'), 1);

		// The peer's push of generation 2 lands on this thread's socket; the sibling's socket hears nothing
		// more, and the sibling refreshes its own cache last.
		await here.activate(2, digest('generation 2'));
		here.receive('peer-a', digest('generation 2'));
		await sibling.call('activate', 2, digest('generation 2'));

		assert.strictEqual(here.homeMapGeneration(), 2);
		assert.strictEqual(await sibling.call('homeMapGeneration'), 2);
	});

	it('withholds the map on every thread once the peer advertises another digest', async () => {
		here.peerSupportsLocks('peer-a');
		await here.activate(4, digest('generation 4'));
		await sibling.call('activate', 4, digest('generation 4'));
		here.receive('peer-a', digest('generation 4'));
		assert.strictEqual(here.homeMapGeneration(), 4);
		assert.strictEqual(await sibling.call('homeMapGeneration'), 4);
		await sibling.call('receive', 'peer-a', digest('generation 5'));
		assert.strictEqual(here.homeMapGeneration(), undefined);
		assert.strictEqual(await sibling.call('homeMapGeneration'), undefined);
	});

	it('never reads a digest the peer did not publish while another thread writes the record', async () => {
		// Each published digest shares one 32-bit half with `own`; a read pairing halves of two writes equals it.
		const own = homesDigestPrefix('aaaaaaaabbbbbbbb' + '0'.repeat(48));
		const published = ['aaaaaaaacccccccc' + '0'.repeat(48), 'ddddddddbbbbbbbb' + '0'.repeat(48)];
		const read = here.peerDigestReader('peer-b');
		const writing = sibling.call('publishAlternating', 'peer-b', published, 2000);
		const seen = new Map();
		const seenEach = () => published.every((digest) => (seen.get(homesDigestPrefix(digest)) ?? 0) >= 1000);
		for (const end = Date.now() + 10_000; Date.now() < end && !seenEach();) {
			for (let i = 0; i < 1000; i++) {
				const prefix = read();
				seen.set(prefix, (seen.get(prefix) ?? 0) + 1);
			}
		}
		assert.ok((await writing) > 1000);
		assert.strictEqual(seen.get(own), undefined);
		for (const digest of published)
			assert.ok(seen.get(homesDigestPrefix(digest)) > 0, 'the writer ran during the reads');
	});
});
