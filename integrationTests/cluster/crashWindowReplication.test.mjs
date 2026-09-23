/**
 * Integration test: writes acknowledged in the last unflushed window before an UNCLEAN shutdown must
 * still replicate once the node comes back.
 *
 * The defect this pins (harper#1949; fixed in rocksdb-js 2.8.0 by rocksdb-js#723, which seeds the committed
 * watermark from the log tail when the log is opened):
 *   Harper appends every write's audit entry to the per-database transaction log, and readers of that
 *   log (replication's resume replay, `read_transaction_log`) are gated on the log's persisted
 *   *last committed position*. That position is only made durable by the `shutdown()` hook, which an
 *   unclean exit (SIGKILL, OOM kill, container kill, power loss — or `HARPER_NO_FLUSH_ON_EXIT`, which
 *   is how we simulate it) never runs. On the next boot:
 *     - `replayLogs` reads the log with `readUncommitted: true`, sees the entries past the stale
 *       watermark, and re-applies the RECORDS into the primary store — so the data is durable and
 *       queryable, exactly as the client's 200 response promised;
 *     - every normal reader still stops at the stale watermark, so those same entries are invisible.
 *   A peer that resumes its subscription in that window gets an audit replay that terminates before
 *   the recovered entries and then switches to live-notification mode — it never receives them.
 *   The gap closes only when some later local commit to that database advances the watermark past the
 *   whole recovered tail; on an idle database that never happens and the nodes stay diverged.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import {
	sendOperation,
	readLog,
	readNodePid,
	waitForNewPid,
	waitForCondition,
	stopAndTeardownNodes,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const SEED_RECORD_COUNT = 500;
const PADDING = 'x'.repeat(1024);
// The window between `restart` being acknowledged and the workers actually going down is only tens of
// milliseconds, so we keep writing for a few seconds and let the node close the door on us.
const WRITE_WINDOW_MS = 3000;

const nodeConfig = (hostname) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true },
		replication: { port: hostname + ':9933', securePort: null, databases: ['data', 'system'] },
	},
	// simulates an unclean exit: the rocksdb shutdown hook that persists the transaction log's
	// last-committed position never runs
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

async function hasRecord(node, id, signal) {
	const rows = await sendOperation(
		node,
		{
			operation: 'search_by_value',
			database: 'data',
			table: 'crash_window_test',
			search_attribute: 'id',
			search_value: id,
			get_attributes: ['id'],
		},
		{ signal }
	).catch(() => []);
	return Boolean((rows ?? [])[0]);
}

async function waitStablyHealthy(node, { stableFor = 5, intervalMs = 500, retries = 240 } = {}) {
	let consecutive = 0;
	for (let i = 0; i < retries; i++) {
		const healthy = await sendOperation(node, { operation: 'cluster_status' })
			.then((status) => Boolean(status?.node_name))
			.catch(() => false);
		consecutive = healthy ? consecutive + 1 : 0;
		if (consecutive >= stableFor) return;
		await delay(intervalMs);
	}
	throw new Error(`node ${node.hostname} never became stably healthy`);
}

suite('writes in the pre-crash window still replicate', { timeout: 600000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		const makeNodeCtx = (hostname) => ({ name: ctx.name, harper: { hostname } });

		const ctxA = makeNodeCtx(hostnameA);
		const ctxB = makeNodeCtx(hostnameB);
		// Record each node as soon as its own start resolves (rather than after Promise.all settles) so
		// that if one start fails, the other's already-running process is still recorded and gets torn
		// down instead of leaked.
		await Promise.all([
			startHarper(ctxA, nodeConfig(hostnameA)).then(() => {
				ctx.nodeA = ctxA.harper;
			}),
			startHarper(ctxB, nodeConfig(hostnameB)).then(() => {
				ctx.nodeB = ctxB.harper;
			}),
		]);

		await sendOperation(ctx.nodeA, {
			operation: 'create_table',
			database: 'data',
			table: 'crash_window_test',
			primary_key: 'id',
		});
		const records = Array.from({ length: SEED_RECORD_COUNT }, (_, i) => ({
			id: `seed-${i}`,
			value: `v${i}`,
			pad: PADDING,
		}));
		records.push({ id: 'seed-sentinel', value: 'seeded', pad: PADDING });
		for (let i = 0; i < records.length; i += 250) {
			await sendOperation(ctx.nodeA, {
				operation: 'upsert',
				database: 'data',
				table: 'crash_window_test',
				records: records.slice(i, i + 250),
			});
		}
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: ctx.nodeA.admin,
		});
		for (let i = 0; i < 90; i++) {
			if (await hasRecord(ctx.nodeB, 'seed-sentinel')) break;
			await delay(1000);
		}
		ok(await hasRecord(ctx.nodeB, 'seed-sentinel'), 'node B should have received the seeded data');
	});

	after(async () => {
		await stopAndTeardownNodes([ctx.nodeA, ctx.nodeB]);
	});

	test('records that survive an unclean restart on A converge to B', async () => {
		const { nodeA, nodeB } = ctx;

		// B stays DOWN from before A's first in-window write until A is back; a live B would receive those
		// writes as ordinary push replication, so the resume-replay path this test pins would never run.
		// Restarting B is not enough: its replacement boots while A still accepts writes. B has not been
		// restarted, so the harness's child handle is still its running process.
		await killHarper({ harper: nodeB });

		const pidA = await readNodePid(nodeA);
		await sendOperation(nodeA, { operation: 'restart' }).catch(() => {});

		const accepted = [];
		const deadline = Date.now() + WRITE_WINDOW_MS;
		for (let i = 0; Date.now() < deadline; i++) {
			const id = `window-${String(i).padStart(4, '0')}`;
			try {
				await sendOperation(
					nodeA,
					{
						operation: 'upsert',
						database: 'data',
						table: 'crash_window_test',
						records: [{ id, value: 'in-window', pad: PADDING }],
					},
					{ signal: AbortSignal.timeout(WRITE_WINDOW_MS) }
				);
				accepted.push(id);
			} catch {
				break; // node is down, or stalled going down
			}
		}
		ok(accepted.length > 0, 'no writes were accepted before A shut down; the window closed too fast');

		await waitForNewPid(nodeA, pidA);
		await waitStablyHealthy(nodeA);
		// logged by core/resources/replayLogs.ts only when boot finds log entries past the last flush
		ok(
			/replaying transaction logs/.test(await readLog(nodeA)),
			'A did not replay its transaction log on boot — its restart was not unclean, so the crash window this test pins was never exercised'
		);

		const durableOnA = [];
		for (const id of accepted) if (await hasRecord(nodeA, id)) durableOnA.push(id);
		ok(
			durableOnA.length > 0,
			`none of the ${accepted.length} accepted writes survived A's unclean restart; the crash-recovery scenario did not set up correctly`
		);

		const relaunchB = { name: ctx.name, harper: { dataRootDir: nodeB.dataRootDir, hostname: nodeB.hostname } };
		await startHarper(relaunchB, nodeConfig(nodeB.hostname));
		ctx.nodeB = relaunchB.harper;

		let missingOnB = durableOnA;
		await waitForCondition(
			async (signal) => {
				const stillMissing = [];
				for (const id of missingOnB) if (!(await hasRecord(ctx.nodeB, id, signal))) stillMissing.push(id);
				missingOnB = stillMissing;
				return missingOnB.length === 0;
			},
			{
				timeoutMs: 90000,
				pollMs: 1000,
				description: () =>
					`B to receive the ${durableOnA.length} records that survived A's unclean restart; still missing ${missingOnB.length}: ${missingOnB.join(', ')}`,
			}
		);
	});
});
