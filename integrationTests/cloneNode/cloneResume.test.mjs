import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

// Big enough (and fat enough per record) that the bulk copy spans many checkpoints and takes long
// enough to reliably catch it mid-copy before killing the follower.
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
		const live = [ctx.leaderCtx, ctx.cloneCtx, ctx.resumeCtx, ctx.partialCtx, ctx.forceCtx].filter(
			(c) => c?.harper?.process
		);
		await Promise.all(live.map((c) => teardownHarper(c)));
	});

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

	async function waitForMarker(dataRootDir, timeoutMs = 120000) {
		const markerPath = markerPathFor(dataRootDir);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (existsSync(markerPath)) return markerPath;
			await sleep(25);
		}
		throw new Error(`clone did not record its sync marker within ${timeoutMs}ms`);
	}

	async function waitForMarkerSetupComplete(dataRootDir, timeoutMs = 120000) {
		const markerPath = markerPathFor(dataRootDir);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (existsSync(markerPath)) {
				try {
					if (JSON.parse(readFileSync(markerPath, 'utf8')).setupComplete) return markerPath;
				} catch {
					// marker is being rewritten; retry
				}
			}
			await sleep(25);
		}
		throw new Error(`clone did not finish setup (setupComplete marker) within ${timeoutMs}ms`);
	}

	test('resumes the bulk copy after a mid-copy kill instead of restarting from zero', async () => {
		const tokenResponse = await sendOperation(ctx.leader, {
			operation: 'create_authentication_tokens',
			authorization: ctx.leader.admin,
			expires_in: '15Minutes',
		});

		const cloneCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const cloneOptions = {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false },
				replication: { port: cloneCtx.harper.hostname + ':9933', securePort: null },
			},
			env: {
				HDB_LEADER_URL: `http://${ctx.leader.hostname}:9925`,
				HDB_LEADER_TOKEN: tokenResponse.operation_token,
				ALLOW_SELF_SIGNED: true,
				HARPER_NO_FLUSH_ON_EXIT: true,
				// frequent checkpoints + aggressive receive throttling so the copy is slow enough to
				// reliably catch (and kill) mid-stream before it finishes
				REPLICATION_COPYCHECKPOINTRECORDS: 25,
				REPLICATION_RECEIVEEVENTHIGHWATERMARK: 5,
			},
		};
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
	});

	test('a restart once the sync wait has begun skips setup and still converges', async () => {
		const resumeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		ctx.resumeCtx = resumeCtx;
		const options = cloneOptionsFor(resumeCtx, await leaderToken());
		await startHarper(resumeCtx, options);

		// Wait for setupComplete specifically (not just the marker's first appearance): JWT/custody/SSH
		// key cloning still runs after the marker is first written, and this test's claim is about a
		// restart once ALL of setup — not just replication — has finished.
		const markerPath = await waitForMarkerSetupComplete(resumeCtx.harper.dataRootDir);
		// A resume monitors the URL recorded here; checkSyncStatus matches it exactly.
		const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
		equal(marker.leaderReplicationURL, `ws://${ctx.leader.hostname}:9933`);
		equal(marker.leaderURL, `http://${ctx.leader.hostname}:9925`);
		ok(marker.startedAt > 0, 'the marker must record when the wait began');
		equal(marker.setupComplete, true);

		await killHarper(resumeCtx);
		// cloneJWTKeys rewrites the key trio, and cloneConfig rewrites harper-config.yaml, only on
		// (re-)running setup — a boot merely regenerates missing keys — so untouched mtimes after the
		// restart prove the resume skipped setup entirely.
		const jwtPassPath = join(resumeCtx.harper.dataRootDir, 'keys', '.jwtPass');
		const configPath = join(resumeCtx.harper.dataRootDir, 'harper-config.yaml');
		const jwtMtimeBeforeRestart = statSync(jwtPassPath).mtimeMs;
		const configMtimeBeforeRestart = statSync(configPath).mtimeMs;
		await startHarper(resumeCtx, options);

		await waitForAvailableStatus(resumeCtx.harper);
		equal(
			statSync(jwtPassPath).mtimeMs,
			jwtMtimeBeforeRestart,
			'resume must not re-clone the JWT keys — setup was supposed to be skipped'
		);
		equal(
			statSync(configPath).mtimeMs,
			configMtimeBeforeRestart,
			'resume must not rewrite the config — replication setup was supposed to be skipped'
		);
		let finalCount = -1;
		for (let retries = 0; retries < 60; retries++) {
			finalCount = await countRows(resumeCtx.harper);
			if (finalCount === RECORD_COUNT) break;
			await sleep(500);
		}
		equal(finalCount, RECORD_COUNT, 'all records must be present after the resumed wait');
		equal(existsSync(markerPath), false, 'finalizing the clone must clear the marker');
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

		const markerPath = await waitForMarker(partialCtx.harper.dataRootDir);
		const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
		equal(
			marker.setupComplete,
			false,
			'must catch the marker before key cloning finishes to exercise this resume path'
		);
		const configPath = join(partialCtx.harper.dataRootDir, 'harper-config.yaml');
		const configMtimeBeforeRestart = statSync(configPath).mtimeMs;
		await killHarper(partialCtx);
		// Resume without the delay hook so finishCloneSetup actually completes this time.
		await startHarper(partialCtx, cloneOptionsFor(partialCtx, await leaderToken()));

		await waitForAvailableStatus(partialCtx.harper);
		equal(
			statSync(configPath).mtimeMs,
			configMtimeBeforeRestart,
			'resume must not redo replication setup — setNode()/cloneConfig() only run on a fresh attempt'
		);
		let finalCount = -1;
		for (let retries = 0; retries < 60; retries++) {
			finalCount = await countRows(partialCtx.harper);
			if (finalCount === RECORD_COUNT) break;
			await sleep(500);
		}
		equal(finalCount, RECORD_COUNT, 'the clone must still converge after resuming the remaining setup stages');
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
		equal(await countRows(forceCtx.harper), RECORD_COUNT, 'all records must be present after the forced reclone');
	});
});
