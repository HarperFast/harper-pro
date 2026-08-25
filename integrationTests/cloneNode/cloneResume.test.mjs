import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

// Big enough (and fat enough per record) that the bulk copy spans many checkpoints and takes long
// enough to reliably catch it mid-copy before killing the follower.
// Loopback addresses are recycled between suite runs; this keeps one run's setup counts out of the next.
const RUN_ID = Date.now().toString(36);
const RECORD_COUNT = 4000;
const PAYLOAD = 'x'.repeat(2048);

async function sendOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		// close each connection so polling doesn't leave keep-alive sockets holding the event loop open
		headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
		body: JSON.stringify(operation),
	});
	const responseData = await response.json();
	equal(response.status, 200, JSON.stringify(responseData));
	return responseData;
}

// Count rows in data.test on a node; returns -1 if the query can't be served yet (mid-clone).
async function countRows(node) {
	try {
		const rows = await sendOperation(node, { operation: 'sql', sql: 'SELECT COUNT(*) AS c FROM data.test' });
		return rows?.[0]?.c ?? -1;
	} catch {
		return -1;
	}
}

async function waitForAvailableStatus(node, timeoutMs = 120000, checkInterval = 1000) {
	const timeoutAt = Date.now() + timeoutMs;
	while (Date.now() < timeoutAt) {
		await sleep(checkInterval);
		let response;
		try {
			response = await sendOperation(node, { operation: 'get_status', id: 'availability' });
		} catch {}
		if (response?.status === 'Available') return true;
	}
	throw new Error(`Node status did not become Available within ${timeoutMs}ms`);
}

suite('Clone Node - resume after mid-copy disconnect', (ctx) => {
	before(async () => {
		const leaderCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(leaderCtx, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false },
				replication: { port: leaderCtx.harper.hostname + ':9933', securePort: null },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		ctx.leaderCtx = leaderCtx;
		ctx.leader = leaderCtx.harper;

		await sendOperation(ctx.leader, {
			operation: 'create_table',
			table: 'test',
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'payload', type: 'String' },
			],
		});
		// Insert in batches so the leader's audit log holds RECORD_COUNT records to copy.
		for (let start = 0; start < RECORD_COUNT; start += 500) {
			const records = [];
			for (let i = start; i < Math.min(start + 500, RECORD_COUNT); i++)
				records.push({ id: String(i), payload: PAYLOAD });
			await sendOperation(ctx.leader, { operation: 'upsert', table: 'test', records });
		}
		equal(await countRows(ctx.leader), RECORD_COUNT, 'leader should hold all records');
	});

	after(async () => {
		// Tear down via the live ctx objects — `startHarper` on restart reassigns `cloneCtx.harper`, so a
		// snapshot captured before the restart would point at the dead process and leak the live one.
		const live = [ctx.leaderCtx, ctx.cloneCtx, ctx.partialCtx, ctx.reconcileCtx, ctx.forceCtx].filter(
			(c) => c?.harper?.process
		);
		await Promise.all(live.map((c) => teardownHarper(c)));
		for (const c of [ctx.cloneCtx, ctx.partialCtx, ctx.reconcileCtx, ctx.forceCtx]) {
			if (c?.harper?.hostname) rmSync(setupTraceFile(c), { force: true });
		}
	});

	// Counts establishReplicationSetup invocations across restarts. Without this the resume tests pass
	// whether or not setup was skipped, since a full replay also converges — convergence alone proves
	// nothing about whether the marker was honoured.
	function setupTraceFile(cloneCtx) {
		const host = cloneCtx.harper.hostname.replace(/[.:]/g, '-');
		return join(tmpdir(), `clone-setup-trace-${RUN_ID}-${host}`);
	}

	function setupRunCount(cloneCtx) {
		const file = setupTraceFile(cloneCtx);
		if (!existsSync(file)) return 0;
		return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
	}

	function cloneOptionsFor(cloneCtx, token, extraEnv = {}) {
		return {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false },
				replication: { port: cloneCtx.harper.hostname + ':9933', securePort: null },
			},
			env: {
				HDB_LEADER_URL: `http://${ctx.leader.hostname}:9925`,
				HDB_LEADER_TOKEN: token,
				ALLOW_SELF_SIGNED: true,
				HARPER_NO_FLUSH_ON_EXIT: true,
				// throttle the copy so it is still running when we interrupt it
				REPLICATION_COPYCHECKPOINTRECORDS: 25,
				REPLICATION_RECEIVEEVENTHIGHWATERMARK: 5,
				CLONE_SETUP_TRACE_FILE: setupTraceFile(cloneCtx),
				...extraEnv,
			},
		};
	}

	async function leaderToken() {
		const response = await sendOperation(ctx.leader, {
			operation: 'create_authentication_tokens',
			authorization: ctx.leader.admin,
			expires_in: '15Minutes',
		});
		return response.operation_token;
	}

	// The marker cloneNode writes as soon as replication is established (setNode() succeeds) — the
	// sentinel that replication setup itself must never be repeated. `setupComplete` flips true only
	// once JWT/custody/SSH key cloning also finishes; a kill before that leaves it false.
	function markerPathFor(dataRootDir) {
		return join(dataRootDir, 'tmp', 'clone-sync-started.json');
	}

	// The marker moves through stages (intent -> replication established -> setup complete), so a test
	// that needs a particular stage must wait for it: waiting for the file to merely exist now lands on
	// the intent write, which is recorded before replication setup even starts.
	async function waitForMarkerStage(dataRootDir, isReady, description, timeoutMs = 120000) {
		const markerPath = markerPathFor(dataRootDir);
		const deadline = Date.now() + timeoutMs;
		let last;
		while (Date.now() < deadline) {
			if (existsSync(markerPath)) {
				try {
					last = JSON.parse(readFileSync(markerPath, 'utf8'));
					if (isReady(last)) return markerPath;
				} catch {
					// marker is being rewritten; retry
				}
			}
			await sleep(25);
		}
		throw new Error(
			`clone did not reach ${description} within ${timeoutMs}ms; last marker: ${
				last ? JSON.stringify(last) : '(never written)'
			}`
		);
	}

	async function waitForMarker(dataRootDir, timeoutMs = 120000) {
		const markerPath = markerPathFor(dataRootDir);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (existsSync(markerPath)) return markerPath;
			await sleep(25);
		}
		throw new Error(`clone did not record its sync marker within ${timeoutMs}ms`);
	}

	test('resumes the bulk copy after a mid-copy kill instead of restarting from zero', async () => {
		const tokenResponse = await sendOperation(ctx.leader, {
			operation: 'create_authentication_tokens',
			authorization: ctx.leader.admin,
			expires_in: '15Minutes',
		});

		const cloneCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		// cloneOptionsFor rather than a literal: it already carries the copy throttling this test needs
		// and, critically, CLONE_SETUP_TRACE_FILE — without which setupRunCount below counts nothing and
		// the assertion passes vacuously.
		const cloneOptions = cloneOptionsFor(cloneCtx, tokenResponse.operation_token);
		ctx.cloneCtx = cloneCtx;
		await startHarper(cloneCtx, cloneOptions);

		// Wait until the follower has committed SOME but not all records, then kill it mid-copy.
		let caughtPartial = false;
		const partialDeadline = Date.now() + 60000;
		while (Date.now() < partialDeadline) {
			const count = await countRows(cloneCtx.harper);
			if (count > 0 && count < RECORD_COUNT) {
				caughtPartial = true;
				break;
			}
			if (count === RECORD_COUNT) break; // copy finished before we could interrupt
			await sleep(25);
		}
		await killHarper(cloneCtx);

		// Restart on the SAME data dir: cloneNode re-enters the clone flow (cloned flag isn't set yet)
		// and the persisted copy cursor must resume the copy rather than restart it from zero.
		await startHarper(cloneCtx, cloneOptions);
		await waitForAvailableStatus(cloneCtx.harper);

		// The key correctness property: every record is present after the interrupted+resumed copy.
		let finalCount = -1;
		for (let retries = 0; retries < 60; retries++) {
			finalCount = await countRows(cloneCtx.harper);
			if (finalCount === RECORD_COUNT) break;
			await sleep(500);
		}
		equal(finalCount, RECORD_COUNT, 'all records must be present after a mid-copy kill + resume (no skipped rows)');
		// Spot-check first/last records survived (guards against off-by-one at the resume boundary).
		const ends = await sendOperation(cloneCtx.harper, {
			operation: 'search_by_id',
			table: 'test',
			get_attributes: ['id'],
			ids: ['0', String(RECORD_COUNT - 1)],
		});
		equal(ends.length, 2, 'first and last records must both be present');
		ok(caughtPartial, 'test should have interrupted the copy mid-stream (tune RECORD_COUNT/throttle if this fails)');
		equal(
			setupRunCount(cloneCtx),
			1,
			'the restart must skip replication setup entirely, not replay cloneConfig/restartWorkers/setNode'
		);
	});

	test('a restart caught between replication setup and finishing key cloning does not redo replication setup', async () => {
		const partialCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		ctx.partialCtx = partialCtx;
		// finishCloneSetup (JWT/custody/SSH keys) normally finishes in milliseconds — too fast for the
		// 25ms marker poll below to reliably land before setupComplete flips true. The delay hook holds
		// that window open so this test deterministically exercises the setupComplete:false resume path
		// instead of vacuously passing via the already-covered setupComplete:true path.
		const firstBootOptions = cloneOptionsFor(partialCtx, await leaderToken(), {
			CLONE_SIMULATE_SETUP_DELAY_MS: 3000,
		});
		await startHarper(partialCtx, firstBootOptions);

		await waitForMarkerStage(
			partialCtx.harper.dataRootDir,
			(m) => m.replicationEstablished && !m.setupComplete,
			'replication established with key cloning still pending'
		);
		// installHarper() already wrote a self-generated .jwtPass before cloneNode reached the delay
		// hook, so its mere existence wouldn't prove anything — an mtime change is what shows
		// cloneJWTKeys actually ran (and overwrote it) during the resume, not just that install did.
		const jwtPassPath = join(partialCtx.harper.dataRootDir, 'keys', '.jwtPass');
		const jwtMtimeBeforeRestart = statSync(jwtPassPath).mtimeMs;
		await killHarper(partialCtx);
		// Resume without the delay hook so finishCloneSetup actually completes this time.
		await startHarper(partialCtx, cloneOptionsFor(partialCtx, await leaderToken()));

		await waitForAvailableStatus(partialCtx.harper);
		ok(
			statSync(jwtPassPath).mtimeMs > jwtMtimeBeforeRestart,
			'resume must still clone the JWT keys — setupComplete was false when killed'
		);
		let finalCount = -1;
		for (let retries = 0; retries < 60; retries++) {
			finalCount = await countRows(partialCtx.harper);
			if (finalCount === RECORD_COUNT) break;
			await sleep(500);
		}
		equal(finalCount, RECORD_COUNT, 'the clone must still converge after resuming the remaining setup stages');
		// The title of this test. Convergence and the JWT mtime above both pass after a full replay too,
		// so this is the only assertion that actually holds replication setup to running once.
		equal(setupRunCount(partialCtx), 1, 'the resume must re-run only finishCloneSetup, not replication setup');
	});

	test('an indeterminate marker replays setup and the clone still converges', async () => {
		const reconcileCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		ctx.reconcileCtx = reconcileCtx;
		// Same hook the staged test uses: hold setup open so the marker is observable rather than
		// racing a clone that finalizes and deletes it.
		await startHarper(
			reconcileCtx,
			cloneOptionsFor(reconcileCtx, await leaderToken(), { CLONE_SIMULATE_SETUP_DELAY_MS: 3000 })
		);
		const markerPath = await waitForMarkerStage(
			reconcileCtx.harper.dataRootDir,
			(m) => m.replicationEstablished && !m.setupComplete,
			'replication established with key cloning still pending'
		);
		const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
		await killHarper(reconcileCtx);

		// Rewind only the replication outcome, to what a crash inside establishReplicationSetup leaves:
		// intent recorded, outcome unknown. The clone replays setup rather than inferring from hdb_nodes
		// — a local peer row is not evidence the leader accepted this node, since setNode() catches a
		// failed exchange, writes the peer anyway and reports success. Replay is safe: ensureNode upserts
		// and the copy resumes from its cursor. The trace below pins that this is a replay, not a skip.
		writeFileSync(markerPath, JSON.stringify({ ...marker, replicationEstablished: false }));

		await startHarper(reconcileCtx, cloneOptionsFor(reconcileCtx, await leaderToken()));
		await waitForAvailableStatus(reconcileCtx.harper);
		let reconciledCount = -1;
		for (let retries = 0; retries < 60; retries++) {
			reconciledCount = await countRows(reconcileCtx.harper);
			if (reconciledCount === RECORD_COUNT) break;
			await sleep(500);
		}
		equal(reconciledCount, RECORD_COUNT, 'the clone must converge after replaying setup for an indeterminate marker');
		equal(setupRunCount(reconcileCtx), 2, 'an indeterminate marker must replay setup rather than trust hdb_nodes');
	});

	test('forceClone takes the full setup path even with the marker present', async () => {
		const forceCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		ctx.forceCtx = forceCtx;
		await startHarper(forceCtx, cloneOptionsFor(forceCtx, await leaderToken()));

		const markerPath = await waitForMarker(forceCtx.harper.dataRootDir);
		await killHarper(forceCtx);
		ok(existsSync(markerPath), 'the marker must be present for this to test the forceClone override');
		const jwtPassPath = join(forceCtx.harper.dataRootDir, 'keys', '.jwtPass');
		const jwtMtimeBeforeRestart = statSync(jwtPassPath).mtimeMs;

		await startHarper(forceCtx, cloneOptionsFor(forceCtx, await leaderToken(), { FORCE_CLONE: true }));
		await waitForAvailableStatus(forceCtx.harper);
		ok(
			statSync(jwtPassPath).mtimeMs > jwtMtimeBeforeRestart,
			'forceClone must re-run setup, which re-clones the JWT keys'
		);
		let forcedCount = -1;
		for (let retries = 0; retries < 60; retries++) {
			forcedCount = await countRows(forceCtx.harper);
			if (forcedCount === RECORD_COUNT) break;
			await sleep(500);
		}
		equal(forcedCount, RECORD_COUNT, 'all records must be present after the forced reclone');
	});
});
