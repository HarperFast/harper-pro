/**
 * Copy-cursor banking under sustained transient blob faults (harper-pro#699).
 *
 * Field failure this reproduces: a blob-dense base copy on a link with a sustained transient
 * blob-fault supply (kohls: copy-vs-copy PENDING-placeholder collisions, ~39 faults/min) never
 * advances its durable copy cursor. The pre-#699 receiver clamps on a per-connection boolean
 * (`hasBlobGap`), and its pre-gap snapshot is captured only at an instant with ZERO blobs in
 * flight — which a blob-dense copy never reaches — so every blob-gap watchdog reconnect (#683)
 * restarts the copy from the same cursor: bounded, but zero progress, indefinitely.
 *
 * Setup: A seeds file-backed blob records, then B joins (add_node → base copy A→B). B's
 * fault injector makes every /blobs/ save SLOW (kept in flight across frames — the condition
 * that starves the old snapshot) and fails every Nth save (the sustained transient fault
 * supply). `replication.blobGapReconnectMs` shortens the #683 watchdog so gap cycles take
 * seconds instead of 15 minutes.
 *
 * Oracles (the resume trail is the discriminating one):
 *  1. The blob-gap watchdog fires repeatedly (the fault supply and reconnect cycles are real).
 *  2. B's "Resuming interrupted copy … after key K" trail shows ≥2 distinct, monotonically
 *     advancing keys: each cycle banked the prefix walked before that cycle's first fault.
 *     Without per-position banking, no mid-walk cursor is persisted under these conditions, so
 *     reconnects re-request a full copy and this assertion fails.
 *  3. The copy converges: B reaches A's record count and at least A's count of full-size blob
 *     files — per-cycle banking strictly shrinks the remaining tail, so even a permanent
 *     every-Nth fault supply terminates.
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
	startHarper,
	teardownHarper,
	setupHarperWithFixture,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import { sendOperation, fetchWithRetry, concurrent, readLog, restartNode, stopNodeProcess } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const BLOB_RECORDS = 40; // /LargeLocation/{n} on A — each a deterministic ~50 KB file-backed blob
const BLOB_BYTES = 50 * 1024;
const FAIL_INTERVAL = 15; // mean fault spacing (fixture jitters ±3) — sustained but survivable supply
const INITIAL_DAMAGED_RECORDS = 2;
const BLOB_SLOW_MS = 400; // every save held in flight, so the pre-#699 snapshot instant never occurs
const GAP_RECONNECT_MS = 3000; // #683 watchdog cycle, shortened from the 900s default

// The fixture's blob content is deterministic per record id, so the expected payload hash of every
// record is computable here — presence of each record's exact bytes on disk is the integrity
// oracle. Re-streams mint fresh fileIds (raw file counts inflate with orphaned duplicates) and
// failed-save header stubs sit below the size floor; hashing sidesteps both. Mirrors
// fixture-large-blob-deterministic/resources.js.
const CHUNK = 1024;
const CHUNKS = 50;
function expectedPayloadHash(id) {
	const seed = Number(id) | 0;
	const hash = createHash('sha1');
	// saveBlob prefixes an 8-byte size header; hash only the payload below via subarray at read time,
	// so generate the raw payload here.
	for (let c = 0; c < CHUNKS; c++) {
		const buf = Buffer.allocUnsafe(CHUNK);
		for (let i = 0; i < CHUNK; i++) buf[i] = (seed * 131 + c * 31 + i) & 0xff;
		hash.update(buf);
	}
	return hash.digest('hex');
}

// Record ids whose exact payload bytes are present in B's blob store (blob files carry an 8-byte
// header before the payload).
function missingPayloadIds(dataRootDir, totalRecords, db = 'data') {
	const root = join(dataRootDir, 'blobs', db);
	const onDisk = new Set();
	if (existsSync(root)) {
		const walk = (dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, entry.name);
				try {
					if (entry.isDirectory()) walk(p);
					else if (statSync(p).size >= BLOB_BYTES) {
						const bytes = readFileSync(p);
						onDisk.add(createHash('sha1').update(bytes.subarray(8)).digest('hex'));
					}
				} catch {
					// the orphan sweep can unlink files between readdir and stat/read; a vanished file
					// is simply not a payload on disk
				}
			}
		};
		walk(root);
	}
	const missing = [];
	for (let id = 0; id < totalRecords; id++) if (!onDisk.has(expectedPayloadHash(id))) missing.push(id);
	return missing;
}

async function missingReferencedPayloadIds(node, totalRecords) {
	const missing = [];
	for (let id = 0; id < totalRecords; id++) {
		try {
			const response = await fetchWithRetry(node.httpURL + '/LargeLocationImage/' + id, { retries: 3 });
			if (!response.ok) {
				missing.push(`${id}:status=${response.status}`);
				continue;
			}
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.length !== BLOB_BYTES || createHash('sha1').update(bytes).digest('hex') !== expectedPayloadHash(id)) {
				missing.push(`${id}:bytes=${bytes.length}`);
			}
		} catch (error) {
			missing.push(`${id}:error=${error?.message ?? error}`);
		}
	}
	return missing;
}

const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, console: true, level: 'warn' },
	replication: { securePort: host + ':9933' },
});

suite('Copy-cursor banking under sustained transient blob faults (#699)', { timeout: 600000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(nodeA, { config: sharedConfig(nodeA.harper.hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		await setupHarperWithFixture(nodeB, join(import.meta.dirname, 'fixture-blob-fail-slow-injector'), {
			config: {
				...sharedConfig(nodeB.harper.hostname),
				replication: { securePort: nodeB.harper.hostname + ':9933', blobGapReconnectMs: GAP_RECONNECT_MS },
			},
			env: {
				HARPER_NO_FLUSH_ON_EXIT: true,
				HARPER_TEST_BLOB_FAIL_INTERVAL: String(FAIL_INTERVAL),
				HARPER_TEST_BLOB_SLOW_MS: String(BLOB_SLOW_MS),
			},
		});
		ctx.nodes = [nodeA.harper, nodeB.harper];

		// Seed the blob table on A BEFORE B joins, so the blobs arrive via the base copy, not live
		// replication — the copy path is what #699 is about.
		const payload = await targz(join(import.meta.dirname, 'fixture-large-blob-deterministic'));
		await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project: 'large-blob-deterministic',
			payload,
			restart: false,
		});
		await restartNode(ctx.nodes[0]);
		// Seed with count-verified retries: under load the deploy restart can race the first GETs, so
		// re-request every id until describe_table confirms the full set (GETs are idempotent).
		for (let attempt = 0; attempt < 20; attempt++) {
			let nextId = 0;
			const { execute, finish } = concurrent(
				() => fetchWithRetry(ctx.nodes[0].httpURL + '/LargeLocation/' + nextId++).catch(() => null),
				10
			);
			for (let i = 0; i < BLOB_RECORDS; i++) await execute();
			await finish();
			const seeded =
				(await sendOperation(ctx.nodes[0], { operation: 'describe_table', table: 'LargeLocation' }).catch(() => ({})))
					.record_count ?? 0;
			if (seeded >= BLOB_RECORDS) break;
			await delay(2000);
		}

		const bootLog = await readLog(ctx.nodes[1]);
		ok(
			bootLog.includes('[blob-fail-slow-injector] installed'),
			'fault injector did not load on B — the test would not exercise the failure path'
		);
	});

	after(async () => {
		if (ctx.nodes) {
			await stopNodeProcess(ctx.nodes[0]).catch(() => null);
			await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
		}
	});

	test('each gap cycle banks the prefix walked before its first fault, and the copy converges', async () => {
		const [A, B] = ctx.nodes;
		const aCount = (await sendOperation(A, { operation: 'describe_table', table: 'LargeLocation' })).record_count;
		ok(aCount === BLOB_RECORDS, `seeding failed: A has ${aCount}/${BLOB_RECORDS} records`);

		const tokenResp = await sendOperation(A, {
			operation: 'create_authentication_tokens',
			authorization: A.admin,
		});
		await sendOperation(B, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: A.hostname,
			authorization: 'Bearer ' + tokenResp.operation_token,
		});

		// Each watchdog cycle banks the prefix walked before its first fault and strictly shrinks the
		// remaining tail, so with a fault guaranteed in every full-size pass the copy needs SEVERAL
		// banked cycles to complete. Wait until the resume trail shows at least two banked cycles (plus
		// record convergence) rather than gating on blob-file counts — re-streams mint fresh fileIds, so
		// file counts pass long before the cycles under test have run. Pre-#699 this loop times out:
		// no mid-walk cursor is ever persisted, so the resume trail never materializes.
		let bCount = 0;
		let bLog = '';
		let resumeKeys = [];
		let inPlaceRepairs = 0;
		const deadline = Date.now() + 360000;
		while (Date.now() < deadline) {
			bCount =
				(await sendOperation(B, { operation: 'describe_table', table: 'LargeLocation' }).catch(() => ({})))
					.record_count ?? 0;
			bLog = await readLog(B);
			resumeKeys = [...bLog.matchAll(/Resuming interrupted copy of database data .* after key (\S+)/g)].map((m) =>
				Number(m[1])
			);
			inPlaceRepairs = (bLog.match(/Repaired blob file in place/g) ?? []).length;
			if (
				bCount >= aCount &&
				new Set(resumeKeys).size >= 2 &&
				inPlaceRepairs >= INITIAL_DAMAGED_RECORDS &&
				missingPayloadIds(B.dataRootDir, aCount).length === 0
			)
				break;
			await delay(2000);
		}

		const missing = await missingReferencedPayloadIds(B, aCount);
		const injected = (bLog.match(/\[blob-fail-slow-injector\] failing save /g) ?? []).length;
		const watchdogFires = (bLog.match(/Blob-gap watchdog/g) ?? []).length;
		const bankedReconnects = (bLog.match(/reconnecting immediately to re-stream/g) ?? []).length;
		console.log(
			`banking test: injected=${injected} watchdogFires=${watchdogFires} bankedReconnects=${bankedReconnects} ` +
				`resumeKeys=[${resumeKeys}] B records=${bCount}/${aCount} missingReferencedPayloadIds=[${missing}] ` +
				`inPlaceRepairs=${inPlaceRepairs}`
		);

		ok(injected >= 2, `fault supply never materialized (${injected} injected failures)`);
		// A banked cycle reconnects immediately after its final barrier persist; the watchdog only
		// paces cycles that banked nothing. Either signal proves gap cycles occurred.
		ok(
			watchdogFires + bankedReconnects >= 1,
			`no gap cycle occurred (watchdog=${watchdogFires}, bankedReconnects=${bankedReconnects}) — test exercised nothing`
		);
		// The #699 signal: reconnect cycles resume from persisted mid-walk cursors that ADVANCE.
		ok(
			resumeKeys.length >= 2,
			`fewer than 2 cursor-based copy resumes (${resumeKeys.length}) — cycles are not banking progress`
		);
		const distinct = new Set(resumeKeys);
		ok(distinct.size >= 2, `resume keys never advanced across cycles: [${resumeKeys}]`);
		for (let i = 1; i < resumeKeys.length; i++) {
			ok(
				resumeKeys[i] >= resumeKeys[i - 1],
				`resume cursor regressed across cycles: [${resumeKeys}] — banked progress was lost`
			);
		}
		ok(
			bCount >= aCount && missing.length === 0,
			`copy did not converge under the sustained fault supply: B records=${bCount}/${aCount}, ` +
				`records missing their blob payload: [${missing}] (final banked cursor: ${resumeKeys.at(-1)})`
		);
		// The dangling-reference heal (#699's data-loss half): at least one committed record whose blob
		// save failed must have had its re-delivered bytes streamed INTO its existing fileId. Without
		// the repair, that record's reference stays dangling and the payload oracle above fails once
		// the orphan sweep runs — this assertion makes the repair path's engagement explicit.
		ok(
			inPlaceRepairs >= INITIAL_DAMAGED_RECORDS,
			`only ${inPlaceRepairs}/${INITIAL_DAMAGED_RECORDS} initially damaged records were repaired in place`
		);
	});
});
