/**
 * Recovery of a leg wedged at connected:true / WAITING with no receive progress (harper-pro#810).
 *
 * Both main-thread reconcile nets exclude this state by construction: `findWedgedNodeUrls` requires
 * `connected !== true`, and `isReceiveStalled` requires `RECEIVING_STATUS_RECEIVING` while a steady-state
 * subscription that stops receiving parks at `WAITING`. In the field it ran ~21h with `cluster_status`
 * green on every leg.
 *
 * `HARPER_TEST_DEAD_AUDIT_ITERABLE_ONCE_DB` reproduces the diagnosed cause on the SOURCE: the first
 * outbound live-replay iterable is replaced by a permanently-drained one, which is what a transaction-log
 * iterator stopped at a corrupt frame becomes. `HARPER_TEST_SUPPRESS_COMMITTED_UPDATE_DB` reproduces the
 * other stall shape on the SUBSCRIBER, and stops at the first reconnect. Each is spent by the recovery it
 * provokes, so the replacement session converges and recovery is observed rather than merely asserted.
 *
 * The negative control runs the wedge with the threshold beyond the test window, standing in for the
 * pre-fix build: the row never arrives and the leg still reports connected:true.
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
// The sending session evaluates the stall on its existing back-pressure tick (30s), so the recovery
// window is one tick plus the threshold plus a reconnect.
const SHORT_THRESHOLD_MS = 5_000;
const RECOVERY_TIMEOUT_MS = 120_000;
// The negative control must outlast several back-pressure ticks so "nothing happened" is a real
// observation rather than a race with the first one.
const NO_RECOVERY_WINDOW_MS = 90_000;
const POLL_MS = 500;

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

async function hasRow(node, id) {
	try {
		const result = await sendOperation(node, {
			operation: 'search_by_hash',
			database: DB,
			table: TABLE,
			hash_values: [id],
			get_attributes: ['id'],
		});
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
 * Bring up source + subscriber, converge them, then wedge the source's outbound live replay.
 * `thresholdMs` is the source's stall threshold: short for the recovery case, beyond the window for the
 * negative control.
 */
async function startWedgedPair(ctx, name, thresholdMs, { shape = 'send-path-stopped' } = {}) {
	const sourceHost = await getNextAvailableLoopbackAddress();
	const subscriberHost = await getNextAvailableLoopbackAddress();

	const sourceCtx = { name, harper: { hostname: sourceHost } };
	await startHarper(
		sourceCtx,
		nodeConfig(sourceHost, {
			// The source's send loop is only crippled for the send-path-stopped shape; for
			// peer-not-confirming it stays healthy and the SUBSCRIBER is the one that goes quiet.
			...(shape === 'send-path-stopped' ? { HARPER_TEST_DEAD_AUDIT_ITERABLE_ONCE_DB: DB } : undefined),
			HARPER_TEST_UNCONFIRMED_SEND_THRESHOLD_MS: String(thresholdMs),
		})
	);
	const subscriberCtx = { name, harper: { hostname: subscriberHost } };
	await startHarper(
		subscriberCtx,
		nodeConfig(
			subscriberHost,
			shape === 'peer-not-confirming' ? { HARPER_TEST_SUPPRESS_COMMITTED_UPDATE_DB: DB } : undefined
		)
	);
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

	// The base copy must land first: it is what establishes the confirmation the stall check ages, and it
	// is the iterable created AFTER it that the injection replaces.
	await waitForCondition(() => hasRow(subscriber, 'before-wedge'), {
		timeoutMs: RECOVERY_TIMEOUT_MS,
		pollMs: POLL_MS,
		description: 'the seed row to replicate before the wedge is armed',
	});

	// Written into the wedge. For send-path-stopped the source's loop now drains a permanently-empty
	// iterable and emits nothing; for peer-not-confirming the row is delivered and applied but never
	// confirmed, so the source holds data the peer will never acknowledge.
	await sendOperation(source, {
		operation: 'insert',
		database: DB,
		table: TABLE,
		records: [{ id: 'after-wedge', v: 'written into the wedge' }],
	});
	return { source, subscriber };
}

suite('Unconfirmed-send wedge recovery (harper-pro#810)', { skip: !STRESS, timeout: 600_000 }, (ctx) => {
	before(() => {
		ctx.nodes = [];
	});

	after(async () => {
		for (const node of ctx.nodes ?? []) {
			await stopNodeProcess(node).catch(() => {});
			await teardownHarper({ harper: node }).catch(() => {});
		}
	});

	test('without the stall check the leg stays silent AND reports connected:true', async () => {
		// Negative control for the fix: the threshold is set beyond the window, so the sending session
		// cannot act inside it. This is the pre-fix behavior — and the point of the issue is that it is
		// invisible, so the assertion is both "no data" and "every surface still green".
		const { source, subscriber } = await startWedgedPair(ctx, 'no-recovery', 10 * 60_000);

		const deadline = Date.now() + NO_RECOVERY_WINDOW_MS;
		while (Date.now() < deadline) {
			equal(await hasRow(subscriber, 'after-wedge'), false, 'nothing may recover the leg without the stall check');
			await delay(2_000);
		}

		const socket = await dataSocket(subscriber);
		ok(socket, 'the subscriber should still report a data socket');
		equal(socket.connected, true, 'the wedged leg reports connected:true — why both reconcile nets miss it');
		equal(
			socket.lastReceivedStatus,
			'Waiting',
			'the wedged leg parks at Waiting, not Receiving — why isReceiveStalled misses it'
		);
		const log = await readLog(source);
		equal(/Closing the sending side of/.test(log), false, 'the stall check must not fire before its threshold elapses');
	});

	test('a peer that applies but never confirms is closed too, on the other stall shape', async () => {
		// The second shape has no natural fault that reproduces on demand, and it is the one the field
		// report describes from the sender's side: `lastCommitConfirmed` frozen while the sender holds
		// newer commits. The subscriber here applies normally and simply never sends COMMITTED_UPDATE.
		const { source, subscriber } = await startWedgedPair(ctx, 'not-confirming', SHORT_THRESHOLD_MS, {
			shape: 'peer-not-confirming',
		});
		// The row itself arrives — this shape is about the acknowledgement, not the data.
		await waitForCondition(() => hasRow(subscriber, 'after-wedge'), {
			timeoutMs: RECOVERY_TIMEOUT_MS,
			pollMs: POLL_MS,
			description: 'the row written into the wedge to be applied by the subscriber',
		});
		await waitForCondition(
			async () => /Closing the sending side of .*peer-not-confirming/.test(await readLog(source)),
			{
				timeoutMs: RECOVERY_TIMEOUT_MS,
				pollMs: POLL_MS,
				description: 'the source to close its sending socket for the unconfirmed data',
			}
		);
		// Suppression stops at that close, so the replacement session confirms — proving the shape RECOVERS
		// rather than merely that it is detected, and leaving no close loop running into teardown.
		await sendOperation(source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: 'after-not-confirming', v: 'live' }],
		});
		await waitForCondition(() => hasRow(subscriber, 'after-not-confirming'), {
			timeoutMs: RECOVERY_TIMEOUT_MS,
			pollMs: POLL_MS,
			description: 'a live write after the close to replicate over the reconnected leg',
		});
	});

	test('the sending session closes its own socket and the peer resubscribes and converges', async () => {
		const { source, subscriber } = await startWedgedPair(ctx, 'recovery', SHORT_THRESHOLD_MS);

		await waitForCondition(() => hasRow(subscriber, 'after-wedge'), {
			timeoutMs: RECOVERY_TIMEOUT_MS,
			pollMs: POLL_MS,
			description: 'the row written into the wedge to replicate after the sender closes its sending socket',
		});

		const log = await readLog(source);
		ok(
			/Closing the sending side of .*send-path-stopped/.test(log),
			'the source should name the send-path-stopped shape in its fire log'
		);

		// And the leg is genuinely healthy afterwards, not merely caught up once.
		await sendOperation(source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: 'after-recovery', v: 'live' }],
		});
		await waitForCondition(() => hasRow(subscriber, 'after-recovery'), {
			timeoutMs: RECOVERY_TIMEOUT_MS,
			pollMs: POLL_MS,
			description: 'a live write after recovery to replicate over the reconnected leg',
		});
	});
});
