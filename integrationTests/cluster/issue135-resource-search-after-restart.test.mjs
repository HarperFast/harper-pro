/**
 * Regression repro for serent-canopy issue #135.
 *
 * After a Harper Pro restart, tables.X.search() from inside a Resource returns a
 * subset (or zero) of the rows that SQL and search_by_value both see correctly.
 * A no-op update on each missing row restores visibility until the next restart.
 *
 * This test exercises Scenario A (write → graceful restart → Resource SDK search)
 * in a single-node environment, which is sufficient to reproduce if the bug is in
 * the search.ts regular-index path rather than requiring multi-node state.
 *
 * Repro steps mirror issue #135:
 *   1. Deploy fixture (defines ScoreEvidence @table with snapshotId @indexed +
 *      a SearchCount Resource that calls tables.ScoreEvidence.search).
 *   2. Insert N rows with a fixed snapshotId.
 *   3. Restart Harper gracefully.
 *   4. Query via search_by_value (ops API — known working) → expected count.
 *   5. Query via GET /SearchCount?snapshotId=… (Resource SDK path) → actual count.
 *   6. Assert they match. Failure = bug reproduced.
 */
import { suite, test, before, after } from 'node:test';
import { equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, targz } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, fetchWithRetry } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const PROJECT_NAME = 'issue135-app';
const ROW_COUNT = 100;
const SNAPSHOT_ID = 'test-snapshot-abc';

async function pollHealth(node, { retries = 40, intervalMs = 2000 } = {}) {
	let last;
	for (let i = 0; i < retries; i++) {
		try {
			// Health endpoint lives on the operations API port, not the REST port.
			const r = await fetch(`${node.operationsAPIURL}/health`);
			if (r.ok) return;
			last = new Error(`status ${r.status}`);
		} catch (err) {
			last = err;
		}
		await delay(intervalMs);
	}
	throw new Error(`Node ${node.hostname} never became healthy: ${last?.message}`);
}

suite('Issue #135: Resource SDK search after graceful restart (Scenario A)', { timeout: 300000 }, (ctx) => {
	before(async () => {
		await startHarper(ctx, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'info' },
			},
			// No HARPER_NO_FLUSH_ON_EXIT — we need normal flush so data persists across restart.
		});

		// Deploy the fixture component (defines ScoreEvidence schema + SearchCount resource).
		const payload = await targz(join(import.meta.dirname, 'issue135-fixture'));
		const deployResp = await sendOperation(ctx.harper, {
			operation: 'deploy_component',
			project: PROJECT_NAME,
			payload,
			restart: true,
		});
		console.log('deploy_component response:', deployResp);

		// Wait for Harper to restart after deploy and come back up.
		// 35s matches the delay used in replicationLoad.test.mjs after deploy_component.
		await delay(35000);
		await pollHealth(ctx.harper);

		// Poll until the schema has actually been applied (deploy + health-OK doesn't guarantee
		// the component finished loading the graphql schema — race seen in single-node tests
		// where `database 'data' does not exist` comes back from the first insert).
		let schemaReady = false;
		for (let i = 0; i < 30; i++) {
			const desc = await sendOperation(ctx.harper, {
				operation: 'describe_table',
				table: 'ScoreEvidence',
			}).catch((err) => ({ __error: err.message }));
			if (desc && !desc.__error && desc.name === 'ScoreEvidence') {
				schemaReady = true;
				break;
			}
			await delay(1000);
		}
		if (!schemaReady) throw new Error('ScoreEvidence table did not become available after deploy');
		console.log('Harper is up after initial deploy and schema is ready');
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('Resource SDK search returns same count as ops API after graceful restart', async () => {
		const node = ctx.harper;

		// Insert rows via ops API.
		const records = Array.from({ length: ROW_COUNT }, (_, i) => ({
			id: `row-${i}`,
			snapshotId: SNAPSHOT_ID,
			data: `payload-${i}`,
		}));
		await sendOperation(node, {
			operation: 'insert',
			table: 'ScoreEvidence',
			records,
		});

		// Sanity: ops API sees all rows before restart.
		const beforeRestart = await sendOperation(node, {
			operation: 'search_by_value',
			table: 'ScoreEvidence',
			search_attribute: 'snapshotId',
			search_value: SNAPSHOT_ID,
		});
		equal(beforeRestart.length, ROW_COUNT, `pre-restart ops count should be ${ROW_COUNT}`);

		// Graceful restart.
		await sendOperation(node, { operation: 'restart' }).catch(() => {}); // may disconnect before responding
		await delay(5000);
		await pollHealth(node, { retries: 40, intervalMs: 2000 });
		console.log('Harper is back up after restart');

		// Ops API after restart (known-working path; confirms data is durable).
		const opsAfter = await sendOperation(node, {
			operation: 'search_by_value',
			table: 'ScoreEvidence',
			search_attribute: 'snapshotId',
			search_value: SNAPSHOT_ID,
		});
		equal(opsAfter.length, ROW_COUNT, `ops API post-restart should still see ${ROW_COUNT} rows`);
		console.log(`Ops API post-restart: ${opsAfter.length} rows`);

		// Resource SDK path after restart — the buggy path from issue #135.
		const sdkResp = await fetchWithRetry(`${node.httpURL}/SearchCount?snapshotId=${encodeURIComponent(SNAPSHOT_ID)}`);
		const sdkBody = await sdkResp.json();
		console.log(`Resource SDK post-restart: ${sdkBody.count} rows`, sdkBody.error ?? '');

		// This assertion catches issue #135:
		// sdkBody.count < ROW_COUNT while opsAfter.length === ROW_COUNT means the bug is present.
		equal(
			sdkBody.count,
			ROW_COUNT,
			`Resource SDK tables.ScoreEvidence.search returned ${sdkBody.count} rows ` +
				`but ops API returned ${opsAfter.length} — issue #135 fingerprint: ` +
				`regular-index search drops rows after restart.`
		);
	});

	// Scenario B (multi-node replicated write → restart receiving node) is in a separate file:
	// issue135-replicated-search-after-restart.test.mjs. They're split because node --test runs
	// top-level suites concurrently, and the cluster startup interferes with this scenario's
	// single-node restart timing when colocated.
});
