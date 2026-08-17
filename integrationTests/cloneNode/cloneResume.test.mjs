import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import {
	startHarper,
	teardownHarper,
	killHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
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
		const live = [ctx.leaderCtx, ctx.cloneCtx].filter((c) => c?.harper?.process);
		await Promise.all(live.map((c) => teardownHarper(c)));
	});

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
				HARPER_TEST_PAUSE_AFTER_CLONE_SYNC_ONCE: true,
			},
		};
		ctx.cloneCtx = cloneCtx;
		await startHarper(cloneCtx, cloneOptions);
		const baselinePath = join(cloneCtx.harper.dataRootDir, '.cloneSyncBaseline.json');
		const availabilityFinalizationPath = join(cloneCtx.harper.dataRootDir, '.cloneAvailabilityFinalization');
		const postSyncPausePath = join(cloneCtx.harper.dataRootDir, '.testPauseAfterCloneSync');
		const cloneAttemptPath = join(cloneCtx.harper.dataRootDir, '.cloneAttempt.json');

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
		ok(existsSync(baselinePath), 'the pre-copy synchronization baseline must remain durable during the copy');
		await killHarper(cloneCtx);

		// Restart on the SAME data dir: cloneNode re-enters the clone flow (cloned flag isn't set yet)
		// and the persisted copy cursor must resume the copy rather than restart it from zero.
		await startHarper(cloneCtx, cloneOptions);
		let observedResumeUnavailable = false;
		const resumeStatusDeadline = Date.now() + 5000;
		while (Date.now() < resumeStatusDeadline) {
			let availability;
			try {
				availability = await sendOperation(cloneCtx.harper, { operation: 'get_status', id: 'availability' });
			} catch {}
			const count = await countRows(cloneCtx.harper);
			if (count < RECORD_COUNT) {
				ok(availability?.status !== 'Available', 'A resumed clone must stay Unavailable while rows are still missing');
				if (availability?.status === 'Unavailable') observedResumeUnavailable = true;
			}
			if (count === RECORD_COUNT) break;
			await sleep(50);
		}
		ok(observedResumeUnavailable, 'A resumed clone should publish Unavailable before continuing its copy');
		const postSyncPauseDeadline = Date.now() + 120000;
		while (!existsSync(postSyncPausePath) && Date.now() < postSyncPauseDeadline) await sleep(100);
		ok(existsSync(postSyncPausePath), 'the resumed clone should pause after its durable copies complete');
		equal(
			await countRows(cloneCtx.harper),
			RECORD_COUNT,
			'all copied rows should be visible before the post-copy restart'
		);
		await killHarper(cloneCtx);

		// Restart after every copy cursor is gone: completion for this persisted attempt must restore
		// the worker watermark without starting another base copy.
		await startHarper(cloneCtx, cloneOptions);
		await waitForAvailableStatus(cloneCtx.harper);
		ok(!existsSync(baselinePath), 'the persisted synchronization baseline should be removed after clone completion');
		ok(!existsSync(cloneAttemptPath), 'the persisted clone attempt should be removed after clone completion');

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

		await sendOperation(cloneCtx.harper, { operation: 'set_status', id: 'availability', status: 'Unavailable' });
		await killHarper(cloneCtx);
		writeFileSync(
			baselinePath,
			JSON.stringify({ version: 1, leaderURL: cloneOptions.env.HDB_LEADER_URL, leaderBaseline: 1 })
		);
		await startHarper(cloneCtx, cloneOptions);
		await sleep(1000);
		const availability = await sendOperation(cloneCtx.harper, { operation: 'get_status', id: 'availability' });
		equal(availability.status, 'Unavailable', 'an in-progress baseline must not finalize an already-cloned node');
		ok(existsSync(baselinePath), 'the in-progress baseline must remain available for a forced clone to resume');
		ok(
			!existsSync(availabilityFinalizationPath),
			'only a confirmed sync may create an availability finalization marker'
		);
	});
});
