/**
 * Copy-progress watchdog vs. a transport-dark source (harper-pro#697, 2026-08-29 nightly).
 *
 * The copy-progress watchdog's signature (#453) is ping-alive-but-frame-dead: the peer keeps the
 * socket byte-active while base-copy frames stop. The 2026-08-29 nightly false fire was a
 * different state: the source's whole event loop went dark for 4.4s (starved CI runner), so the
 * subscriber saw ZERO bytes — not even pongs — for a full unpaused watchdog window and killed a
 * connection that would have resumed on its own. That silence is transport-level and belongs to
 * the byte-silence machinery (receive watchdog / keepalive idle terminate at copyTimeout), which
 * budgets it correctly; the copy-progress watchdog must stand down without transport evidence.
 *
 * Reproduced deterministically by SIGSTOPping the source process:
 *   - the subscriber runs recordConcurrency=1 plus the one-shot commit-delay hook, so the copy
 *     reliably parks mid-flight (source blocked on socket drain, most of the copy unsent) exactly
 *     as on the incident night;
 *   - the source is SIGSTOPped while the delayed commit holds the pause open, so when the commit
 *     lands and the subscriber resumes (re-arming the watchdog), the kernel-buffered frames drain
 *     and then nothing more can arrive — an armed, unpaused, fully dark window;
 *   - suite 1 keeps the darkness under copyTimeout: nothing may fire, and the copy must converge
 *     on the SAME connection after SIGCONT (no restart-from-scratch for a transient peer stall);
 *   - suite 2 keeps the source dark past copyTimeout: the byte-level machinery must take the
 *     connection (reconnect), proving the deferral hands ownership over instead of disarming
 *     recovery — while the copy-progress line still never appears.
 *
 * On pre-fix code suite 1 fails with the exact nightly line ("no base-copy progress ... for
 * 1500ms"), fired 1500ms into the dark window.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog, readNodePid } from './clusterShared.mjs';

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
const ROW_PADDING = 'x'.repeat(20000); // fat rows so the parked copy leaves real data unsent
const PING_INTERVAL_MS = 1000;
// Above suite 1's ENTIRE SIGSTOP interval (COMMIT_DELAY_MS + 2.5 × blobTimeout ≈ 6.75s) with wide
// CI-scheduling margin, so no ping-timeout path — the reverse leg's server-side watchdog included —
// acts anywhere in that suite's log. Suite 2 tolerates reverse-leg fires (its stop spans ~13s).
const PING_TIMEOUT_MS = 15000;
const COPY_STALL_TIMEOUT_MS = 1500; // blobTimeout = the copy-progress watchdog budget
const COMMIT_DELAY_MS = 3000; // one-shot commit hold; SIGSTOP lands inside this window
const CONVERGENCE_TIMEOUT_MS = 90000;
const POLL_INTERVAL_MS = 500;

const LOG_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/;

function nodeStartOptions(node, { copyTimeoutMs, delayCommits = false }) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false },
			replication: {
				securePort: node.hostname + ':9933',
				databases: [DB],
				pingInterval: PING_INTERVAL_MS,
				pingTimeout: PING_TIMEOUT_MS,
				copyTimeout: copyTimeoutMs,
				blobTimeout: COPY_STALL_TIMEOUT_MS,
				recordConcurrency: 1,
			},
		},
		env: delayCommits
			? { HARPER_TEST_COPY_COMMIT_DELAY_ONCE_DB: DB, HARPER_TEST_COPY_COMMIT_DELAY_MS: String(COMMIT_DELAY_MS) }
			: undefined,
	};
}

async function startStallCluster(ctx, { copyTimeoutMs }) {
	ctx.nodes = [];
	for (let i = 0; i < 2; i++) {
		const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		ctx.nodes[i] = (
			await startHarper(nodeCtx, nodeStartOptions(nodeCtx.harper, { copyTimeoutMs, delayCommits: i === 1 }))
		).harper;
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
}

function signalSourceTree(pid, signal) {
	try {
		process.kill(-pid, signal); // Harper is spawned detached: negative pid signals the whole group
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// process already gone; teardown's port assertion is the safety net
		}
	}
}

async function waitForLogLine(node, needle, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await readLog(node)).includes(needle)) return;
		await delay(100);
	}
	throw new Error(`timed out waiting for ${label} ("${needle}") in ${node.hostname}'s log`);
}

async function subscriberHasRow(node, table, id) {
	const result = await sendOperation(node, {
		operation: 'search_by_id',
		database: DB,
		table,
		ids: [id],
		get_attributes: ['id'],
	}).catch(() => []);
	return Array.isArray(result) && result.some((r) => r?.id === id);
}

async function waitForConvergence(node) {
	const lastIds = TABLES.map((table) => `${table}-${ROWS_PER_TABLE - 1}`);
	const deadline = Date.now() + CONVERGENCE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const found = await Promise.all(TABLES.map((table, i) => subscriberHasRow(node, table, lastIds[i])));
		if (found.every(Boolean)) return true;
		await delay(POLL_INTERVAL_MS);
	}
	return false;
}

function lastLineTimeBefore(log, needle, beforeMs) {
	let last;
	for (const line of log.split('\n')) {
		if (!line.includes(needle)) continue;
		const match = LOG_TS.exec(line);
		if (!match) continue;
		const time = Date.parse(match[1]);
		if (time < beforeMs && (last === undefined || time > last)) last = time;
	}
	return last;
}

// Parks the copy via the delayed commit, SIGSTOPs the source inside the hold, keeps it dark for
// `darkMs` after the resume, SIGCONTs.
async function runStallScenario(ctx, { darkMs }) {
	const [source, subscriber] = ctx.nodes;
	await sendOperation(subscriber, {
		operation: 'add_node',
		rejectUnauthorized: false,
		hostname: source.hostname,
		authorization: subscriber.admin,
	});

	await waitForLogLine(
		subscriber,
		'[test] delaying first base-copy commit',
		30000,
		'the copy to park on the held commit'
	);
	const sourcePid = await readNodePid(source);
	ok(sourcePid !== undefined, 'source pid file must exist while the copy is in flight');

	let sigcontAt;
	ctx.resumeSource = () => {
		if (sigcontAt === undefined) {
			sigcontAt = Date.now();
			signalSourceTree(sourcePid, 'SIGCONT');
		}
		return sigcontAt;
	};
	signalSourceTree(sourcePid, 'SIGSTOP');
	try {
		// Mid-hold: the copy must be provably incomplete, else the dark window would prove nothing.
		await delay(COMMIT_DELAY_MS / 2);
		const lastBetaRow = `${TABLES[1]}-${ROWS_PER_TABLE - 1}`;
		ok(
			!(await subscriberHasRow(subscriber, TABLES[1], lastBetaRow)),
			'precondition: the base copy must still be in flight when the source goes dark'
		);
		// Ride out the rest of the hold, then keep the source dark for the requested armed window.
		await delay(COMMIT_DELAY_MS / 2 + darkMs);
	} finally {
		sigcontAt = ctx.resumeSource();
	}

	ok(await waitForConvergence(subscriber), 'base copy must converge on the subscriber after the source resumes');
	await delay(COPY_STALL_TIMEOUT_MS + 1000); // let a late-armed watchdog window elapse before reading the log

	return { sigcontAt, log: await readLog(subscriber), sourceHostname: source.hostname };
}

// The vacuity guard both suites share: an armed (unpaused), copy-frame-silent window at least
// `minDarkMs` long must have preceded SIGCONT, or the scenario never exercised the watchdog.
function assertDarkArmedWindow(log, sigcontAt, minDarkMs) {
	const lastFrameAt = lastLineTimeBefore(log, 'received replication message', sigcontAt);
	const lastResumeAt = lastLineTimeBefore(log, 'Replication resuming', sigcontAt);
	ok(lastFrameAt !== undefined, 'precondition: copy frames must have been received before the dark window');
	ok(lastResumeAt !== undefined, 'precondition: the commit-backlog pause must have resumed (re-arming the watchdog)');
	const windowStart = Math.max(lastFrameAt, lastResumeAt);
	ok(
		sigcontAt - windowStart >= minDarkMs,
		`precondition: the armed dark window must span at least ${minDarkMs}ms (got ${sigcontAt - windowStart}ms)`
	);
	const pausedInWindow = lastLineTimeBefore(log, 'Commit backlog causing replication back-pressure', sigcontAt);
	ok(
		pausedInWindow === undefined || pausedInWindow <= windowStart,
		'precondition: the dark window must be unpaused (a pause would stop the watchdog and prove nothing)'
	);
}

suite(
	'Copy-progress watchdog stands down for a transport-dark source below copyTimeout',
	{ timeout: 240000 },
	(ctx) => {
		before(() => startStallCluster(ctx, { copyTimeoutMs: 30000 }));

		after(async () => {
			ctx.resumeSource?.(); // never tear down a SIGSTOPped process tree
			if (!ctx.nodes) return;
			await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
		});

		test('a source stalled past blobTimeout but below copyTimeout causes no fire and no reconnect', async () => {
			// 2.5 watchdog windows of darkness: enough for a false fire, well under copyTimeout (30s).
			const { sigcontAt, log, sourceHostname } = await runStallScenario(ctx, {
				darkMs: Math.round(COPY_STALL_TIMEOUT_MS * 2.5),
			});

			assertDarkArmedWindow(log, sigcontAt, COPY_STALL_TIMEOUT_MS);

			const fires = log.split('\n').filter((line) => line.includes('Copy-progress watchdog'));
			ok(
				fires.length === 0,
				`copy-progress watchdog must not fire on a transport-dark window; got:\n${fires.join('\n')}`
			);
			ok(!log.includes('Receive watchdog'), 'no byte-level watchdog may fire either — the stall is below copyTimeout');
			const connects = log.split('\n').filter((line) => line.includes(`Connected to wss://${sourceHostname}`));
			ok(
				connects.length === 1,
				`the copy must ride out the stall on its original connection; got ${connects.length} connects:\n${connects.join('\n')}`
			);
			ok(
				!log.includes(`Disconnected from wss://${sourceHostname}`),
				'the copy connection must not be torn down by a transient peer stall'
			);
		});
	}
);

suite('Byte-level watchdogs own a source dark past copyTimeout', { timeout: 240000 }, (ctx) => {
	const COPY_TIMEOUT_MS = 4000;

	before(() => startStallCluster(ctx, { copyTimeoutMs: COPY_TIMEOUT_MS }));

	after(async () => {
		ctx.resumeSource?.();
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	test('darkness past copyTimeout is recovered by reconnect, never by a copy-progress fire', async () => {
		// 2.5 byte-watchdog windows: the copy-progress watchdog (1.5s budget) must repeatedly stand
		// down while the byte-level machinery reaches its own budget and takes the connection.
		const { sigcontAt, log, sourceHostname } = await runStallScenario(ctx, { darkMs: COPY_TIMEOUT_MS * 2.5 });

		assertDarkArmedWindow(log, sigcontAt, COPY_TIMEOUT_MS);

		const fires = log.split('\n').filter((line) => line.includes('Copy-progress watchdog'));
		ok(fires.length === 0, `deferral must hold even when the darkness outlives copyTimeout; got:\n${fires.join('\n')}`);
		const connects = log.split('\n').filter((line) => line.includes(`Connected to wss://${sourceHostname}`));
		ok(
			connects.length >= 2,
			`the byte-level machinery must have reconnected the copy leg (expected >= 2 connects, got ${connects.length})`
		);
	});
});
