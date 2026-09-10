/**
 * Stale watchdog fires from superseded connection instances.
 *
 * Watchdog fires act on the SHARED NodeReplicationConnection, but the watchdogs live per
 * replicateOverWS instance. When an instance's teardown never runs (its socket's close never fires,
 * e.g. suppressed on a paused socket), the instance leaks with its timers armed. Its copy-progress
 * timer then fires up to blobTimeout later, logs "no base-copy progress ... terminating connection
 * and reconnecting", and forceReconnects the connection — tearing down the CURRENT healthy leg.
 *
 * Production evidence (a v5 migration cluster receiver, data leg, Aug 2026): 35 copy-progress fires claiming
 * 900000ms of silence on a 300s grid, exactly one reconnect between consecutive fires; every
 * receive-watchdog fire sat 299.3-299.4s after its leg's "Connected to" (silence-from-birth legs,
 * n=22), while the main-thread apply-watermark reconcile fired zero times and database-size grew
 * ~1.1GB per 15min. The killed sockets never carried a byte; the copy rode a different leg; the
 * 900s claims came from the leaked instances of reaped legs.
 *
 * This test builds one leaked instance deterministically via the env-gated
 * HARPER_TEST_LEAK_CONNECTION_AFTER_COPY_START_DB hook on the subscriber: right after COPY_START
 * (copy-progress timer armed) the leg's terminate/close are neutralized and its socket paused, and
 * the byte watchdog sees frozen bytes — so it reaps the leg at copyTimeout. The fix is layered:
 * forceReconnect explicitly retires the superseded session (retireInstance: every interval,
 * watchdog, subscription, and pending request), which must complete even though this leg's close
 * can never deliver — proven by the retirement completion log line ("superseded by forceReconnect",
 * printed after the full teardown body ran) and by the armed copy-progress timer being provably
 * dead (no fire at blobTimeout, when frames never resumed on that socket). The stale-fire
 * socket-identity guard remains as a backstop and must NOT be needed on this path. Without the fix
 * the leaked timer fires "no base-copy progress" against the healthy replacement and forces a third
 * connect; with it: exactly two connects, zero copy-progress kills, no backstop engagement.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
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
const TABLE = 'test';
const PING_INTERVAL_MS = 500;
const PING_TIMEOUT_MS = 3000;
// The byte watchdog reaps the leaked leg at copyTimeout; the leaked instance's copy-progress timer
// fires at blobTimeout. blobTimeout must leave room for the reap + reconnect + copy to finish first
// (~3s) so the stale fire provably lands on a healthy, superseded-from-its-view connection.
const COPY_TIMEOUT_MS = 2000;
const COPY_STALL_TIMEOUT_MS = 6000;
const SETTLE_MS = COPY_STALL_TIMEOUT_MS + 4000; // past the stale fire, with margin
const CONVERGENCE_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 250;

function nodeStartOptions(node, { leak = false } = {}) {
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
			},
		},
		env: leak ? { HARPER_TEST_LEAK_CONNECTION_AFTER_COPY_START_DB: DB } : undefined,
	};
}

async function subscriberLog(node) {
	const logRoot = node.logDir ?? join(node.dataRootDir, 'log');
	try {
		return await readFile(join(logRoot, 'hdb.log'), 'utf8');
	} catch {
		return '';
	}
}

suite('Stale watchdog fire from a superseded connection instance', { timeout: 120000 }, (ctx) => {
	before(async () => {
		// node[0] is the (healthy) source; node[1] is the subscriber whose first data leg leaks.
		ctx.nodes = [];
		for (let i = 0; i < 2; i++) {
			const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			ctx.nodes[i] = (await startHarper(nodeCtx, nodeStartOptions(nodeCtx.harper, { leak: i === 1 }))).harper;
		}
		await Promise.all(
			ctx.nodes.map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: DB,
					table: TABLE,
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'name', type: 'String' },
					],
				})
			)
		);
		await sendOperation(ctx.nodes[0], {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: Array.from({ length: 10 }, (_, i) => ({ id: `seed-${i}`, name: `seed-${i}` })),
		});
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('the stale fire stands down instead of killing the healthy replacement leg', async () => {
		await sendOperation(ctx.nodes[1], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.nodes[0].hostname,
			authorization: ctx.nodes[1].admin,
		});

		// The retried copy (on the replacement leg) must converge.
		const deadline = Date.now() + CONVERGENCE_TIMEOUT_MS;
		let converged = false;
		while (Date.now() < deadline) {
			const result = await sendOperation(ctx.nodes[1], {
				operation: 'search_by_id',
				database: DB,
				table: TABLE,
				ids: ['seed-9'],
				get_attributes: ['id'],
			});
			if (Array.isArray(result) && result.some((r) => r?.id === 'seed-9')) {
				converged = true;
				break;
			}
			await delay(POLL_INTERVAL_MS);
		}
		ok(converged, 'copy must converge on the replacement leg');

		// Let the leaked instance's copy-progress timer elapse and (with the guard) stand down.
		await delay(SETTLE_MS);

		const log = await subscriberLog(ctx.nodes[1]);

		// Preconditions: the leak armed, and the byte watchdog genuinely reaped the leaked leg.
		ok(log.includes('leaking replication connection after COPY_START'), 'precondition: leak hook must have armed');
		ok(
			log
				.split('\n')
				.some((line) => line.includes('Receive watchdog: no activity from') && line.includes(`db: "${DB}"`)),
			'precondition: the byte watchdog must have reaped the leaked leg'
		);

		// The leaked instance must have been retired EXPLICITLY: its close can never deliver (the leak
		// hook neutralized it), so this line only appears if forceReconnect drove retireInstance to
		// completion — it is the last statement of the teardown body, after every clearInterval and
		// watchdog stop.
		ok(
			log.includes('superseded by forceReconnect'),
			'forceReconnect must explicitly retire the superseded session despite the undeliverable close'
		);

		// Its armed copy-progress timer must be dead: no "no base-copy progress" kill at blobTimeout,
		// and exactly two data-leg connects (the leaked leg and its replacement). A third connect means
		// a stale fire tore down the healthy replacement.
		const staleKills = log.split('\n').filter((line) => line.includes('Copy-progress watchdog: no base-copy progress'));
		ok(
			staleKills.length === 0,
			`the leaked instance's timer must not fire and kill the healthy leg; got:\n${staleKills.join('\n')}`
		);
		const connects = log.split('\n').filter((line) => line.includes('Connected to') && line.includes(`db: ${DB}`));
		equal(
			connects.length,
			2,
			`expected exactly 2 data-leg connects (leaked + replacement); got:\n${connects.join('\n')}`
		);

		// The stale-fire guard is a backstop for leaks that escape explicit retirement; on this path
		// the primary teardown must make it unnecessary.
		ok(
			!log.includes('fired on a superseded connection instance'),
			'the backstop guard must not need to engage when forceReconnect retired the session'
		);
	});
});
