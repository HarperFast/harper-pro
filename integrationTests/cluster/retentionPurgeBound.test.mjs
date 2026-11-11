/**
 * A source forces a retention base copy only when it purged history the follower needs (harper-pro#1229).
 *
 * Two nodes on `data`, retention in seconds. B is stopped while A purges its own log past retention, so no live
 * traffic or certified floor can freshen B's resume point:
 * - when B had everything A wrote before the purge, and A writes again just before B returns, A resumes B
 *   incrementally: no forced copy;
 * - when B missed a tagged write that A has since purged, A forces the copy and B recovers the tag.
 * Before the fix the guard compared B's start against `now - auditRetention` alone and forced a full copy
 * in both cases.
 *
 * On RocksDB the purge bound is the largest key retention actually deleted, and retention deletes a segment only once
 * every entry in it is flushed, which an idle node may not do for minutes. Waiting past retention purges nothing
 * there, so A restarts cleanly (its exit flushes) and the tests wait for its log to have no segments left.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	sendOperation,
	stopAndTeardownNodes,
	stopNodeProcess,
	waitForCondition,
	logMark,
	readLogSince,
	logSegments,
	waitForLogPurged,
} from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'purge_bound';
// long enough for B to restart and subscribe while A still retains the write made just before
const RETENTION_S = 40;
// LMDB removes entries one by one: past retention plus two cleanup passes
const IDLE_MS = (RETENTION_S + 25) * 1000;
const FORCED_COPY = 'forcing a bounded base-copy resync';
const OWN_LOG_PURGED_THROUGH =
	/of database data, whose log local it would replay from \S+, under transaction-log history purged through (\S+);/;
// log keys come from a performance.now()-based clock, which can trail Date.now() by milliseconds
const CLOCK_SLACK_MS = 1000;

for (const engine of ['rocksdb', 'lmdb']) {
	suite(`retention base copy follows the purge bound (${engine})`, { timeout: 600_000 }, (ctx) => {
		let A, B;

		const options = (node) => ({
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: {
					colors: false,
					stdStreams: false,
					console: true,
					level: 'debug',
					auditRetention: RETENTION_S,
					// marks into hdb.log assume it is only appended to
					rotation: { enabled: false },
				},
				replication: { port: node.hostname + ':9933', securePort: null, databases: ['data'] },
			},
			env: engine === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {},
		});

		// the pid file's process too: one killed seconds after it started can outlive the spawned handle
		async function stop(node, killOptions) {
			await killHarper({ harper: node }, killOptions);
			await stopNodeProcess(node);
		}

		async function start(node) {
			const started = (await startHarper({ name: ctx.name, harper: node }, options(node))).harper;
			return Object.assign(node, started);
		}

		async function purgeOwnLog(node) {
			if (engine === 'lmdb') return delay(IDLE_MS);
			ok((await logSegments(node, 'local')).length > 0, `${node.hostname}'s own log has a segment to purge`);
			// a SIGKILL at the default grace would skip the exit flush
			await stop(node, { graceMs: 30_000 });
			await start(node);
			await waitForLogPurged(node, 'local');
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
		const forcedCopiesTo = (node, servedLog) =>
			servedLog.split('\n').filter((line) => line.includes(FORCED_COPY) && line.includes(`Peer ${node.hostname} `));

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

		test('a follower that missed nothing resumes from a source that purged its log without a copy', async () => {
			await upsert(A, 'caught-up');
			await arrives(B, 'caught-up');
			await stop(B);
			await purgeOwnLog(A);
			const mark = await logMark(A);
			await upsert(A, 'after-idle');
			await start(B);
			await arrives(B, 'after-idle');
			const served = await readLogSince(A, mark);
			ok(served.includes('subscription to'), 'the log read is of the process that served B');
			const forced = forcedCopiesTo(B, served);
			equal(forced.length, 0, `A forced a copy for B:\n${forced.join('\n')}`);
		});

		test('a follower that missed a write A has since purged gets a copy and the write', async () => {
			await stop(B);
			const beforeMissed = Date.now();
			await upsert(A, 'missed');
			await purgeOwnLog(A);
			const mark = await logMark(A);
			await start(B);
			await arrives(B, 'missed');
			const served = await readLogSince(A, mark);
			ok(served.includes('subscription to'), 'the log read is of the process that served B');
			const forced = forcedCopiesTo(B, served);
			ok(
				forced.some((line) => Date.parse(line.match(OWN_LOG_PURGED_THROUGH)?.[1]) >= beforeMissed - CLOCK_SLACK_MS),
				`A forced the copy for its own log, purged through the missed write:\n${forced.join('\n')}`
			);
		});
	});
}
