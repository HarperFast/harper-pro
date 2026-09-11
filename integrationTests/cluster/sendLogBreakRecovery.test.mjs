/**
 * Recovery of a leg wedged at connected:true / RECEIVING_STATUS_WAITING by a stopped send iterable
 * (harper-pro#810).
 *
 * Both main-thread reconcile nets exclude this state by construction: `findWedgedNodeUrls` requires
 * `connected !== true`, and `isReceiveStalled` requires `RECEIVING_STATUS_RECEIVING` while a steady-state
 * subscription that stops receiving parks at `WAITING`. In the field it ran ~21h with `cluster_status`
 * green on every leg and the `system` database replicating over the same peer pair.
 *
 * The cause is a stale local. `endIteratorOnCorruptFrame` latches an iterator done when a frame is
 * corrupt, and the send loop caches one `auditLogIterable` for the whole session where the store marks
 * iterables reusable — so every later wake drains an already-finished iterator, no frames go out, and the
 * keepalive holds the socket open. The sender does not have to infer any of this: core hangs a
 * `corruptFrameStop` on the iterable it returns, and the send loop reads it after each drain.
 *
 * The two shapes are opposites, and each test pins one:
 *
 *   TORN TAIL — nothing was lost behind the break and the tail grows again, so a fresh iterator reads
 *   past it. The cached iterable is dropped and the SAME session resumes sending; nothing is closed,
 *   which the test asserts directly by requiring that neither side ever logs a disconnect.
 *
 *   MID-LOG BREAK — entries behind the break are unreadable and harper#2087 makes stopping there the
 *   intended policy. A fresh iterator stops at the same frame, so it is reported and the range is NOT
 *   rebuilt on first sight (a much longer floor governs re-checking, far beyond this test's window).
 *
 * `HARPER_TEST_DEAD_AUDIT_ITERABLE_ONCE_DB=<db>[:midlog]` serves the drained, corrupt-frame-stopped
 * iterable that `endIteratorOnCorruptFrame` leaves behind. It is one-shot, so the rebuilt range is a
 * healthy one and recovery is observed rather than merely asserted.
 *
 * Stress-gated (spawns two Harper child processes) like the other cluster tests.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';
const DB = 'data';
const TABLE = 'WedgeTest';
const RECOVERY_TIMEOUT_MS = 120_000;
// The mid-log case must outlast several send-loop wakes so "it never closed" is a real observation
// rather than a race with the first one.
const NO_RECOVERY_WINDOW_MS = 60_000;
const POLL_MS = 500;
const REPAIRED = /Rebuilding the send range from/;
const QUARANTINED = /stopped at a mid-log corrupt transaction-log frame/;
// The repair must not disturb the socket: it replaces a cached local, nothing more.
const DISCONNECTED = /Disconnected from wss:/;

function nodeConfig(hostname, env) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, console: true, level: 'debug' },
			replication: {
				securePort: hostname + ':9933',
				databases: [DB],
				// Healthy pings so the byte-level receive watchdog never false-fires on the wedged leg —
				// which is the field condition: keepalive traffic hides the silence from it.
				pingInterval: 1000,
				pingTimeout: 30_000,
			},
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
	};
}

// `signal` is waitForCondition's deadline: without forwarding it, a probe against a wedged node that
// accepts the request and never answers outlives the deadline it was meant to bound.
async function hasRow(node, id, signal) {
	try {
		const result = await sendOperation(
			node,
			{
				operation: 'search_by_hash',
				database: DB,
				table: TABLE,
				hash_values: [id],
				get_attributes: ['id'],
			},
			{ signal }
		);
		return Array.isArray(result) && result.length === 1;
	} catch {
		return false;
	}
}

async function dataSocket(node) {
	const status = await sendOperation(node, { operation: 'cluster_status' });
	for (const connection of status.connections ?? []) {
		for (const socket of connection.database_sockets ?? []) {
			if (socket.database === DB) return socket;
		}
	}
	return undefined;
}

/**
 * Bring up source + subscriber, converge them, then stop the source's outbound send iterable at a
 * corrupt frame of the given `shape`.
 */
async function startWedgedPair(ctx, name, shape) {
	const sourceHost = await getNextAvailableLoopbackAddress();
	const subscriberHost = await getNextAvailableLoopbackAddress();

	const sourceCtx = { name, harper: { hostname: sourceHost } };
	await startHarper(
		sourceCtx,
		nodeConfig(sourceHost, {
			HARPER_TEST_DEAD_AUDIT_ITERABLE_ONCE_DB: shape === 'midlog' ? `${DB}:midlog` : DB,
		})
	);
	const subscriberCtx = { name, harper: { hostname: subscriberHost } };
	await startHarper(subscriberCtx, nodeConfig(subscriberHost));
	const source = sourceCtx.harper;
	const subscriber = subscriberCtx.harper;
	ctx.nodes.push(source, subscriber);

	for (const node of [source, subscriber]) {
		await sendOperation(node, {
			operation: 'create_table',
			database: DB,
			table: TABLE,
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'v', type: 'String' },
			],
		});
	}
	await sendOperation(source, {
		operation: 'insert',
		database: DB,
		table: TABLE,
		records: [{ id: 'before-wedge', v: 'seed' }],
	});
	await sendOperation(subscriber, {
		operation: 'add_node',
		hostname: source.hostname,
		port: 9933,
		isLeader: true,
		rejectUnauthorized: false,
		authorization: source.admin,
	});

	// The base copy must land first: the iterable the injection replaces is the one created AFTER it.
	await waitForCondition((signal) => hasRow(subscriber, 'before-wedge', signal), {
		timeoutMs: RECOVERY_TIMEOUT_MS,
		pollMs: POLL_MS,
		description: 'the seed row to replicate before the send iterable is stopped',
	});

	// Written into the wedge: the source's loop now drains a stopped iterable and emits nothing.
	await sendOperation(source, {
		operation: 'insert',
		database: DB,
		table: TABLE,
		records: [{ id: 'after-wedge', v: 'written into the wedge' }],
	});
	return { source, subscriber };
}

suite('Send-log-break recovery (harper-pro#810)', { skip: !STRESS, timeout: 600_000 }, (ctx) => {
	before(() => {
		ctx.nodes = [];
	});

	after(async () => {
		for (const node of ctx.nodes ?? []) {
			await stopNodeProcess(node).catch(() => {});
			await teardownHarper({ harper: node }).catch(() => {});
		}
	});

	test('a torn tail is repaired in place — the same session resumes sending', async () => {
		const { source, subscriber } = await startWedgedPair(ctx, 'torn-tail', 'tail');

		await waitForCondition((signal) => hasRow(subscriber, 'after-wedge', signal), {
			timeoutMs: RECOVERY_TIMEOUT_MS,
			pollMs: POLL_MS,
			description: 'the row written into the wedge to replicate once the send range is rebuilt',
		});

		const log = await readLog(source);
		ok(REPAIRED.test(log), 'the source should say it rebuilt the send range');
		ok(/fire=\{mechanism: send-log-break/.test(log), 'the fire should be classified like every other net');
		// The whole point of repairing the cached local rather than closing: the socket is healthy and
		// bidirectional, and tearing it down would abort the peer's in-flight blob receives for nothing.
		equal(DISCONNECTED.test(log), false, 'repairing the send range must not disturb the socket');
		equal(DISCONNECTED.test(await readLog(subscriber)), false, 'the peer must not see a reconnect either');

		// And the leg is genuinely healthy afterwards, not merely caught up once.
		await sendOperation(source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: 'after-recovery', v: 'live' }],
		});
		await waitForCondition((signal) => hasRow(subscriber, 'after-recovery', signal), {
			timeoutMs: RECOVERY_TIMEOUT_MS,
			pollMs: POLL_MS,
			description: 'a live write after recovery to replicate over the reconnected leg',
		});
	});

	test('a mid-log break is reported and left alone — reconnecting cannot cross it', async () => {
		// The negative half, and the reason the shape has to be read rather than inferred: this state is
		// indistinguishable from the torn tail by every timing signal available to the sender, and closing
		// on it would reconnect a leg that cannot be repaired, once per interval, forever.
		const { source, subscriber } = await startWedgedPair(ctx, 'mid-log', 'midlog');

		const deadline = Date.now() + NO_RECOVERY_WINDOW_MS;
		while (Date.now() < deadline) {
			equal(REPAIRED.test(await readLog(source)), false, 'a mid-log break must not rebuild the send range');
			await delay(2_000);
		}

		const log = await readLog(source);
		ok(QUARANTINED.test(log), 'the source must report the quarantined break rather than silently doing nothing');
		equal(DISCONNECTED.test(log), false, 'and it must not churn the socket either');
		// The wedge itself is unchanged — which is the point: it is visible now, not recovered.
		equal(await hasRow(subscriber, 'after-wedge'), false, 'nothing can cross the break, so the row stays behind it');
		const socket = await dataSocket(subscriber);
		ok(socket, 'the subscriber should still report a data socket');
		equal(socket.connected, true, 'the leg stays up rather than churning');
		// Recorded honestly, because it is the operator-facing cost of the fail-stop policy: this leg is
		// permanently one-way and every health surface still reads green. Only the error log says otherwise.
		equal(socket.lastReceivedStatus, 'Waiting', 'and reports Waiting, which is why no reconcile net sees it');
	});
});
