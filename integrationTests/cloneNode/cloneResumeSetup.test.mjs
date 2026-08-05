/**
 * A clone restarted after the sync wait began must skip setup and still converge; forceClone must
 * take the full path. The marker file cloneNode writes when the wait begins is the sentinel — wait
 * for it, kill, restart, assert convergence — rather than brittle log text.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

// Large and fat enough that the copy is still running when the marker appears, leaving a window to
// restart inside.
const RECORD_COUNT = 4000;
const PAYLOAD = 'x'.repeat(2048);
const MARKER_RELATIVE_PATH = join('tmp', 'clone-sync-started.json');

async function sendOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
		body: JSON.stringify(operation),
	});
	const responseData = await response.json();
	equal(response.status, 200, JSON.stringify(responseData));
	return responseData;
}

async function trySendOperation(node, operation) {
	try {
		return await sendOperation(node, operation);
	} catch {
		return undefined;
	}
}

async function countRows(node) {
	const rows = await trySendOperation(node, { operation: 'sql', sql: 'SELECT COUNT(*) AS c FROM data.test' });
	return rows?.[0]?.c ?? -1;
}

async function waitForMarker(dataRootDir, timeoutMs = 120000) {
	const markerPath = join(dataRootDir, MARKER_RELATIVE_PATH);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(markerPath)) return markerPath;
		await sleep(25);
	}
	throw new Error(`clone did not record ${MARKER_RELATIVE_PATH} within ${timeoutMs}ms`);
}

async function waitForAvailable(node, timeoutMs = 180000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await trySendOperation(node, { operation: 'get_status', id: 'availability' });
		if (response?.status === 'Available') return true;
		await sleep(500);
	}
	return false;
}

async function waitForRowCount(node, expected, timeoutMs = 60000) {
	const deadline = Date.now() + timeoutMs;
	let count = -1;
	while (Date.now() < deadline) {
		count = await countRows(node);
		if (count === expected) return count;
		await sleep(500);
	}
	return count;
}

function cloneOptionsFor(cloneCtx, leader, token, extraEnv = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false },
			replication: { port: cloneCtx.harper.hostname + ':9933', securePort: null },
		},
		env: {
			HDB_LEADER_URL: `http://${leader.hostname}:9925`,
			HDB_LEADER_TOKEN: token,
			ALLOW_SELF_SIGNED: true,
			HARPER_NO_FLUSH_ON_EXIT: true,
			// throttle the copy so it is still running when the marker appears
			REPLICATION_COPYCHECKPOINTRECORDS: 25,
			REPLICATION_RECEIVEEVENTHIGHWATERMARK: 5,
			...extraEnv,
		},
	};
}

suite('Clone Node - restart after sync starts skips setup', (ctx) => {
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
		for (let start = 0; start < RECORD_COUNT; start += 500) {
			const records = [];
			for (let i = start; i < Math.min(start + 500, RECORD_COUNT); i++)
				records.push({ id: String(i), payload: PAYLOAD });
			await sendOperation(ctx.leader, { operation: 'upsert', table: 'test', records });
		}
		equal(await countRows(ctx.leader), RECORD_COUNT, 'leader should hold all records');
	});

	after(async () => {
		const live = [ctx.leaderCtx, ctx.resumeCtx, ctx.forceCtx].filter((c) => c?.harper?.process);
		await Promise.all(live.map((c) => teardownHarper(c)));
	});

	async function leaderToken() {
		const response = await sendOperation(ctx.leader, {
			operation: 'create_authentication_tokens',
			authorization: ctx.leader.admin,
			expires_in: '15Minutes',
		});
		return response.operation_token;
	}

	test('a restart once the wait has begun resumes it and still converges', async () => {
		const cloneCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		ctx.resumeCtx = cloneCtx;
		const options = cloneOptionsFor(cloneCtx, ctx.leader, await leaderToken());
		await startHarper(cloneCtx, options);

		const markerPath = await waitForMarker(cloneCtx.harper.dataRootDir);
		// A resume monitors the URL recorded here; checkSyncStatus matches it exactly.
		const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
		equal(marker.leaderReplicationURL, `ws://${ctx.leader.hostname}:9933`);
		equal(marker.leaderURL, `http://${ctx.leader.hostname}:9925`);
		ok(marker.startedAt > 0, 'the marker must record when the wait began');

		await killHarper(cloneCtx);
		// cloneConfig rewrites harper-config.yaml on every full setup; an untouched mtime after the
		// restart is what proves the resume actually skipped setup rather than redoing it.
		const configPath = join(cloneCtx.harper.dataRootDir, 'harper-config.yaml');
		const configMtimeBeforeRestart = statSync(configPath).mtimeMs;
		await startHarper(cloneCtx, options);

		ok(await waitForAvailable(cloneCtx.harper), 'a resumed clone must still reach Available');
		equal(
			statSync(configPath).mtimeMs,
			configMtimeBeforeRestart,
			'resume must not rewrite the config — setup was supposed to be skipped'
		);
		equal(await waitForRowCount(cloneCtx.harper, RECORD_COUNT), RECORD_COUNT, 'all records must be present');
		equal(existsSync(markerPath), false, 'finalizing the clone must clear the marker');
	});

	test('forceClone takes the full setup path even with the marker present', async () => {
		const cloneCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		ctx.forceCtx = cloneCtx;
		await startHarper(cloneCtx, cloneOptionsFor(cloneCtx, ctx.leader, await leaderToken()));

		const markerPath = await waitForMarker(cloneCtx.harper.dataRootDir);
		await killHarper(cloneCtx);
		ok(existsSync(markerPath), 'the marker must be present for this to test the forceClone override');

		// FORCE_CLONE must discard the marker and re-run setup, then still converge.
		const configPath = join(cloneCtx.harper.dataRootDir, 'harper-config.yaml');
		const configMtimeBeforeRestart = statSync(configPath).mtimeMs;
		await startHarper(cloneCtx, cloneOptionsFor(cloneCtx, ctx.leader, await leaderToken(), { FORCE_CLONE: true }));
		ok(await waitForAvailable(cloneCtx.harper), 'a forced reclone must still reach Available');
		ok(
			statSync(configPath).mtimeMs > configMtimeBeforeRestart,
			'forceClone must re-run setup, which rewrites the config'
		);
		equal(await waitForRowCount(cloneCtx.harper, RECORD_COUNT), RECORD_COUNT, 'all records must be present');
	});
});
