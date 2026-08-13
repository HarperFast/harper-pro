/**
 * Copy-progress watchdog vs. commit-backlog back-pressure.
 *
 * The copy-progress watchdog (see copyProgressWedgeRecovery.test.mjs) must be suspended while the
 * receive socket is intentionally paused for back-pressure: paused means no copy frames arrive BY
 * DESIGN, so frame silence is not evidence of a stalled copy. `addPauseReason()` stops it for
 * exactly that reason — but the commit-backlog pause trips MID-frame (the outstandingCommits
 * check), and the same frame's `noteCopyProgress()` then re-armed the watchdog unconditionally,
 * ten lines later. If the backlog then took longer than blobTimeout to drain, the watchdog fired
 * "no base-copy progress" and forceReconnected a healthy, actively-committing copy.
 *
 * Field signature (a v5 migration cluster, Aug 2026): the receiver's `data` DB grew ~1.1 GB per
 * 15-minute interval (hdb_analytics database-size) while the same node logged "Copy-progress
 * watchdog: no base-copy progress ... for 900000ms" and killed the connection, repeatedly, for
 * 17 hours. Both instruments were right: frames had stopped (the receiver had paused the socket
 * itself), data kept landing (the buffered backlog draining through commits). The copy only
 * completed because each restart resumed from the persisted cursor.
 *
 * This test reproduces that deterministically on a two-node cluster:
 *   - the receiver runs with replication.recordConcurrency=1, so two outstanding copy batches trip
 *     the commit-backlog pause; the source seeds two tables of fat rows with a small
 *     copyCheckpointRecords so the copy spans many frames and outruns the socket buffers (the
 *     pause must produce a real gap in received frames, with COPY_COMPLETE still unsent);
 *   - the env-gated HARPER_TEST_COPY_COMMIT_DELAY_ONCE_DB hook holds the first copy-batch commit
 *     open for 4000ms, so the pause outlasts blobTimeout (1500ms) while commits progress;
 *   - the source is perfectly healthy — it never stalls — so ANY "Copy-progress watchdog" fire on
 *     the receiver is by construction a false positive.
 * On the buggy code the fire line appears in the receiver's log (this test fails, printing it).
 * With the fix (noteCopyProgress does not re-arm while paused) the copy completes with no fire.
 * The commit-backlog debug line is asserted as a precondition so the test cannot pass vacuously
 * without the pause ever engaging.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const DB = 'data';
const TABLES = ['alpha', 'beta'];
const ROWS_PER_TABLE = 200;
const ROW_PADDING = 'x'.repeat(20000); // ~20KB rows so the copy outruns socket buffering once paused
const PING_INTERVAL_MS = 1000;
const PING_TIMEOUT_MS = 3000;
// The copy-progress watchdog threshold. The injected commit delay (4000ms) must exceed it so the
// commit-backlog pause outlasts the watchdog window; both must stay under the pause-stall threshold
// (max(pingTimeout, blobTimeout) * 2 = 6000ms) so that watchdog correctly stays quiet (the delayed
// commit still ticks consumerProgress when it lands).
const COPY_STALL_TIMEOUT_MS = 1500;
const COMMIT_DELAY_MS = 4000;
const COPY_TIMEOUT_MS = 30000; // byte watchdog copy-phase window, wide so it can never be the actor
const COPY_CHECKPOINT_RECORDS = 25; // many small copy frames instead of one big one
const CONVERGENCE_TIMEOUT_MS = 90000;
const POLL_INTERVAL_MS = 500;

function nodeStartOptions(node, { delayCommits = false } = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false },
			replication: {
				securePort: node.hostname + ':9933',
				databases: [DB],
				pingInterval: PING_INTERVAL_MS,
				pingTimeout: PING_TIMEOUT_MS,
				copyTimeout: COPY_TIMEOUT_MS,
				blobTimeout: COPY_STALL_TIMEOUT_MS,
				recordConcurrency: 1,
				copyCheckpointRecords: COPY_CHECKPOINT_RECORDS,
			},
		},
		env: delayCommits
			? { HARPER_TEST_COPY_COMMIT_DELAY_ONCE_DB: DB, HARPER_TEST_COPY_COMMIT_DELAY_MS: String(COMMIT_DELAY_MS) }
			: undefined,
	};
}

async function receiverLog(node) {
	const logRoot = node.logDir ?? join(node.dataRootDir, 'log');
	try {
		return await readFile(join(logRoot, 'hdb.log'), 'utf8');
	} catch {
		return '';
	}
}

suite('Copy-progress watchdog stays quiet during commit-backlog back-pressure', { timeout: 240000 }, (ctx) => {
	before(async () => {
		// node[0] is the (healthy) source; node[1] is the subscriber whose first copy commit is delayed.
		ctx.nodes = [];
		for (let i = 0; i < 2; i++) {
			const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			ctx.nodes[i] = (await startHarper(nodeCtx, nodeStartOptions(nodeCtx.harper, { delayCommits: i === 1 }))).harper;
		}
		for (const table of TABLES) {
			await Promise.all(
				ctx.nodes.map((node) =>
					sendOperation(node, {
						operation: 'create_table',
						database: DB,
						table,
						primary_key: 'id',
						attributes: [
							{ name: 'id', type: 'ID' },
							{ name: 'name', type: 'String' },
						],
					})
				)
			);
			// Insert in chunks so no single operation body gets unwieldy.
			for (let start = 0; start < ROWS_PER_TABLE; start += 50) {
				await sendOperation(ctx.nodes[0], {
					operation: 'insert',
					database: DB,
					table,
					records: Array.from({ length: 50 }, (_, i) => ({
						id: `${table}-${start + i}`,
						name: `seed-${start + i}-${ROW_PADDING}`,
					})),
				});
			}
		}
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('a healthy copy under slow commits converges without a copy-progress fire', async () => {
		await sendOperation(ctx.nodes[1], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodes[0].hostname,
			authorization: ctx.nodes[1].admin,
		});

		// Wait for the base copy to converge on the subscriber: the last seeded row of each table.
		const lastIds = TABLES.map((table) => `${table}-${ROWS_PER_TABLE - 1}`);
		const deadline = Date.now() + CONVERGENCE_TIMEOUT_MS;
		let converged = false;
		while (Date.now() < deadline) {
			const found = await Promise.all(
				TABLES.map(async (table, i) => {
					const result = await sendOperation(ctx.nodes[1], {
						operation: 'search_by_id',
						database: DB,
						table,
						ids: [lastIds[i]],
						get_attributes: ['id'],
					});
					return Array.isArray(result) && result.some((r) => r?.id === lastIds[i]);
				})
			);
			if (found.every(Boolean)) {
				converged = true;
				break;
			}
			await delay(POLL_INTERVAL_MS);
		}
		ok(converged, 'base copy must converge on the subscriber');

		// Give any in-flight watchdog window a chance to elapse before reading the log, so a fire
		// armed late in the copy cannot slip in after the assertion.
		await delay(COPY_STALL_TIMEOUT_MS + 1000);

		const log = await receiverLog(ctx.nodes[1]);
		ok(
			log.includes('Commit backlog causing replication back-pressure'),
			'precondition: the commit-backlog pause must have engaged on the subscriber (else this test proves nothing)'
		);

		const fires = log.split('\n').filter((line) => line.includes('Copy-progress watchdog'));
		ok(
			fires.length === 0,
			`copy-progress watchdog must not fire on a healthy back-pressured copy; got:\n${fires.join('\n')}`
		);
	});
});
