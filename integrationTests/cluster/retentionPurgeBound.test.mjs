/**
 * A source forces a retention base copy only when it purged history the follower needs (harper-pro#1229).
 *
 * Two nodes on `data`, retention in seconds. B is stopped while A sits idle past retention, so no live
 * traffic or certified floor can freshen B's resume point:
 * - when B had everything A wrote, A resumes B incrementally: no forced copy;
 * - when B missed a tagged write that A has since aged out, A forces the copy and B recovers the tag.
 * Before the fix the guard compared B's start against `now - auditRetention` alone and forced a full copy
 * in both cases.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition, readLog } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'purge_bound';
const RETENTION_S = 20;
// past retention plus two cleanup passes (the RocksDB pass runs at least every 10 s)
const IDLE_MS = (RETENTION_S + 25) * 1000;
const FORCED_COPY = 'forcing a bounded base-copy resync';

for (const engine of ['rocksdb', 'lmdb']) {
	suite(`retention base copy follows the purge bound (${engine})`, { timeout: 600_000 }, (ctx) => {
		let A, B;

		const options = (node) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, console: true, level: 'debug', auditRetention: RETENTION_S },
				replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'] },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true, ...(engine === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {}) },
		});

		async function start(node) {
			const started = (await startHarper({ name: ctx.name, harper: node }, options(node))).harper;
			return Object.assign(node, started);
		}

		const upsert = (node, id) =>
			sendOperation(node, { operation: 'upsert', database: 'data', table: TABLE, records: [{ id, tag: id }] });
		const has = async (node, id, signal) =>
			(
				await sendOperation(
					node,
					{ operation: 'search_by_id', database: 'data', table: TABLE, ids: [id], get_attributes: ['id'] },
					{ signal }
				)
			).length === 1;
		const arrives = (node, id) =>
			waitForCondition((signal) => has(node, id, signal), {
				timeoutMs: 90_000,
				description: `${id} on ${node.hostname}`,
			});
		const connected = (node, peer) =>
			waitForCondition(
				async (signal) => {
					const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
					return status.connections
						?.find((connection) => connection.name === peer.hostname)
						?.database_sockets?.some((socket) => socket.database === 'data' && socket.connected);
				},
				{ timeoutMs: 60_000, description: `${node.hostname} connected to ${peer.hostname}` }
			);
		const forcedCopiesTo = async (node, since) =>
			(await readLog(A))
				.slice(since)
				.split('\n')
				.filter((line) => line.includes(FORCED_COPY) && line.includes(`Peer ${node.hostname} `));

		before(async () => {
			A = await start({ hostname: await getNextAvailableLoopbackAddress() });
			B = await start({ hostname: await getNextAvailableLoopbackAddress() });
			for (const node of [A, B])
				await sendOperation(node, { operation: 'create_table', database: 'data', table: TABLE, primary_key: 'id' });
			await sendOperation(B, {
				operation: 'add_node',
				hostname: A.hostname,
				rejectUnauthorized: false,
				authorization: A.admin,
			});
			await upsert(A, 'warmup');
			await arrives(B, 'warmup');
		});

		after(() => stopAndTeardownNodes([A, B]));

		test('a follower that missed nothing resumes from an idle source without a copy', async () => {
			await upsert(A, 'caught-up');
			await arrives(B, 'caught-up');
			await killHarper({ harper: B });
			await delay(IDLE_MS);
			const mark = (await readLog(A)).length;
			await start(B);
			// a write before A has decided B's start would leave A's log written above its bound
			await connected(B, A);
			await delay(3000);
			await upsert(A, 'after-idle');
			await arrives(B, 'after-idle');
			const forced = await forcedCopiesTo(B, mark);
			equal(forced.length, 0, `A forced a copy for B:\n${forced.join('\n')}`);
		});

		test('a follower that missed a write A has since aged out gets a copy and the write', async () => {
			await killHarper({ harper: B });
			await upsert(A, 'missed');
			await delay(IDLE_MS);
			const mark = (await readLog(A)).length;
			await start(B);
			await arrives(B, 'missed');
			ok((await forcedCopiesTo(B, mark)).length >= 1, 'A forced the copy that carries the missed write');
		});
	});
}
