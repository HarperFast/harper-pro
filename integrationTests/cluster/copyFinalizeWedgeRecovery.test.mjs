/**
 * Copy-finalization wedge recovery.
 *
 * COPY_COMPLETE is not the end of a base copy: the receiver still has to drain outstanding commits,
 * finish blobs, flush the WAL-off copy-apply rows and clear the copy cursor before it leaves copy mode,
 * and until then its received-version watermark stays suppressed so it can never become available. No
 * other watchdog covers that window — `copyProgressWatchdog` stops at COPY_COMPLETE (#453),
 * `receiveWatchdog` is widened to `copyTimeout` while copying and the sender has nothing left to send
 * (#460), and `subscriptionSetupWatchdog` is paused for the copy — so a finalization that cannot complete
 * used to park the receiver there permanently, connected and subscribed, with nothing logged. That is the
 * shape the recurring `blockCacheEviction` failure took (rocksdb-js#755, fixed in 2.7.1).
 *
 * The one-shot `HARPER_TEST_COPY_FINALIZE_STALL_ONCE_DB` hook stalls the receiver's first copy-cursor
 * flush forever while the socket stays ping-alive. Both halves of the invariant are asserted: the stall is
 * reported, and it recovers.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const NODE_COUNT = 2;
const STALL_DB = 'data';
// Pings every 1s so the byte watchdog can never be what recovers this: bytes keep moving, and copy mode
// widens its threshold to copyTimeout anyway.
const PING_INTERVAL_MS = 1000;
const PING_TIMEOUT_MS = 3000;
// The threshold under test, injected on the receiver so the wait is seconds rather than the production
// default (copyTimeout). Kept well above pingTimeout so a firing here is provably the finalization
// watchdog and not a byte-silence timeout. Detection can take up to 2x it, because the watchdog re-arms
// once on the progress the copy itself made before stalling.
const COPY_FINALIZE_TIMEOUT_MS = 5000;
// Above 2x COPY_FINALIZE_TIMEOUT_MS: neither the copy-phase byte watchdog nor the copy-progress watchdog
// may pre-empt the one being tested.
const COPY_TIMEOUT_MS = 30000;
const BLOB_TIMEOUT_MS = 30000;
const RECOVERY_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 250;

function nodeStartOptions(node, { stall = false } = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true },
			replication: {
				port: node.hostname + ':9933',
				securePort: null,
				databases: [STALL_DB],
				pingInterval: PING_INTERVAL_MS,
				pingTimeout: PING_TIMEOUT_MS,
				copyTimeout: COPY_TIMEOUT_MS,
				blobTimeout: BLOB_TIMEOUT_MS,
			},
		},
		// The stall hook is per-process and one-shot; arming it only on the RECEIVER pins which side's copy
		// fails to finalize. The threshold override rides along so the wait is seconds, not copyTimeout.
		env: stall
			? {
					HARPER_TEST_COPY_FINALIZE_STALL_ONCE_DB: STALL_DB,
					HARPER_TEST_COPY_FINALIZE_TIMEOUT_MS: String(COPY_FINALIZE_TIMEOUT_MS),
				}
			: undefined,
	};
}

async function pollUntil(predicate, timeoutMs = RECOVERY_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await delay(POLL_INTERVAL_MS);
	}
	return false;
}

/**
 * The receiver's watermark for what it has applied from the source. It is deliberately suppressed while
 * in copy mode, so it advancing past zero is the observable that the copy actually FINALIZED — not merely
 * that rows arrived (they are visible as soon as their batch commits, wedge or no wedge).
 */
async function receivedVersion(node) {
	const status = await sendOperation(node, { operation: 'cluster_status' }).catch(() => null);
	for (const connection of status?.connections ?? []) {
		for (const socket of connection.database_sockets ?? []) {
			if (socket.database === STALL_DB && socket.lastReceivedVersion > 0) return socket.lastReceivedVersion;
		}
	}
	return 0;
}

suite('Replication copy-finalization wedge recovery', { timeout: 180000 }, (ctx) => {
	before(async () => {
		// node[0] is the source; node[1] is the subscriber whose copy cannot finalize.
		ctx.nodes = [];
		for (let i = 0; i < NODE_COUNT; i++) {
			const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			ctx.nodes[i] = (await startHarper(nodeCtx, nodeStartOptions(nodeCtx.harper, { stall: i === 1 }))).harper;
		}
		await sendOperation(ctx.nodes[0], {
			operation: 'create_table',
			database: STALL_DB,
			table: 'test',
			primary_key: 'id',
		});
		// Seeded before the subscription so the base copy carries content and the stalled flush is a real
		// copy-cursor flush rather than a no-op on an empty copy.
		await sendOperation(ctx.nodes[0], {
			operation: 'insert',
			database: STALL_DB,
			table: 'test',
			records: [{ id: 'seed-1', name: 'seed' }],
		});
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('a base copy that cannot finalize is reported and retried, not sat on in silence', async () => {
		// add_node can land before the http worker has registered its replication listener ("No listener
		// registered for worker message type subscribe-to-node") on a loaded runner, leaving the
		// subscription unset. Re-issue until the base copy is actually observed starting — fixture setup,
		// not part of what is being asserted.
		for (let attempt = 0; attempt < 3; attempt++) {
			await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				isLeader: true,
				authorization: ctx.nodes[1].admin,
			}).catch(() => {});
			const copying = await pollUntil(
				async () => /Requesting full copy of database data/.test(await readLog(ctx.nodes[1]).catch(() => '')),
				30000
			);
			if (copying) break;
		}

		// Half the invariant: the wedge must be LOUD, or an operator cannot tell a copy that will never
		// finish from one that is merely slow.
		const reported = await pollUntil(async () =>
			/Copy-finalization watchdog/.test(await readLog(ctx.nodes[1]).catch(() => ''))
		);
		ok(reported, 'a base copy stuck after COPY_COMPLETE must be reported at error level, not silently');

		// The other half: it must RECOVER. Asserting on arriving rows would not prove it — copied rows are
		// visible as soon as their batch commits, wedge or no wedge.
		const finalized = await pollUntil(async () => (await receivedVersion(ctx.nodes[1])) > 0);
		ok(finalized, 'the retried copy must finalize and leave copy mode (received version advances)');

		await sendOperation(ctx.nodes[0], {
			operation: 'insert',
			database: STALL_DB,
			table: 'test',
			records: [{ id: 'after-stall-1', name: 'recovered' }],
		});
		const replicated = await pollUntil(async () => {
			const result = await sendOperation(ctx.nodes[1], {
				operation: 'search_by_id',
				database: STALL_DB,
				table: 'test',
				ids: ['after-stall-1'],
				get_attributes: ['*'],
			}).catch(() => []);
			return Array.isArray(result) && result.some((record) => record?.id === 'after-stall-1');
		});
		ok(replicated, 'a write made after the stall must replicate to the recovered subscriber (no restart)');
	});
});
