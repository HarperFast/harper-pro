/**
 * Recovery of a leg wedged at connected:true / RECEIVING_STATUS_WAITING by a stopped send iterable
 * (harper-pro#810).
 *
 * Both main-thread reconcile nets exclude this state by construction: `findWedgedNodeUrls` requires
 * `connected !== true`, and `isReceiveStalled` requires `RECEIVING_STATUS_RECEIVING` while a steady-state
 * subscription that stops receiving parks at `WAITING`. In the field it ran ~21h with `cluster_status`
 * green on every leg and the `system` database replicating over the same peer pair.
 *
 * The cause is the SENDER's transaction-log stream. `endIteratorOnCorruptFrame` latches an iterator done
 * when a frame is corrupt, and the send loop reuses one `auditLogIterable` for the whole session on
 * RocksDB — so every later wake drains an already-finished iterator, no frames go out, and the keepalive
 * holds the socket open. The sender does not have to infer any of this: core hangs a `corruptFrameStop`
 * on the iterable it returns, and the send loop reads it after each drain.
 *
 * The two shapes are opposites, and each test pins one:
 *
 *   TORN TAIL — nothing was lost behind the break and the tail grows again, so a fresh iterator reads
 *   past it. The leg must close and the peer must resubscribe and converge.
 *
 *   MID-LOG BREAK — entries behind the break are unreadable and harper#2087 makes stopping there the
 *   intended policy. A reconnect stops at the same frame, so the leg must NOT close; it reports and
 *   stays up rather than looping.
 *
 * `HARPER_TEST_DEAD_AUDIT_ITERABLE_ONCE_DB=<db>[:midlog]` serves the drained, corrupt-frame-stopped
 * iterable that `endIteratorOnCorruptFrame` leaves behind. It is one-shot, so the replacement session
 * converges and recovery is observed rather than merely asserted.
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
const CLOSING = /transaction-log frame break; resubscribe|stopped at a torn transaction-log frame/;

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

	test('a torn tail closes the sending socket and the peer resubscribes and converges', async () => {
		const { source, subscriber } = await startWedgedPair(ctx, 'torn-tail', 'tail');

		await waitForCondition((signal) => hasRow(subscriber, 'after-wedge', signal), {
			timeoutMs: RECOVERY_TIMEOUT_MS,
			pollMs: POLL_MS,
			description: 'the row written into the wedge to replicate after the sender closes its socket',
		});

		const log = await readLog(source);
		ok(
			/stopped at a torn transaction-log frame/.test(log),
			'the source should name the torn-tail shape in its fire log'
		);
		ok(/fire=\{mechanism: send-log-break/.test(log), 'the fire should be classified like every other net');

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
			equal(CLOSING.test(await readLog(source)), false, 'a mid-log break must not close the sending socket');
			await delay(2_000);
		}

		const log = await readLog(source);
		ok(
			/stopped at a mid-log corrupt transaction-log frame/.test(log),
			'the source must report the quarantined break rather than silently doing nothing'
		);
		// The wedge itself is unchanged — which is the point: it is visible now, not recovered.
		equal(await hasRow(subscriber, 'after-wedge'), false, 'nothing can cross the break, so the row stays behind it');
		const socket = await dataSocket(subscriber);
		ok(socket, 'the subscriber should still report a data socket');
		equal(socket.connected, true, 'the leg stays up rather than churning');
	});
});
