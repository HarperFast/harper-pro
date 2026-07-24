/**
 * QA-692 (source:gh-pro:537 "Interrupted bulk copies can persist a resume cursor over an
 * undelivered range"; [cluster-tier]). QA-689 (qa689-copy-resume-gap.test.mjs, same
 * mechanism) already cleared the single-source, NON-blob shape: 30k plain records, receiver
 * SIGKILLed at 11 points across 5-95% copy progress, bidirectional key-set oracle, 0 missing
 * either direction. That does not close #537 — this test is residual arm B: BLOB-TABLE copy
 * interruption, where a full copy of a blob-backed table is interrupted mid-flight.
 *
 * Code-read lead (from QA-689): `outstandingBlobsToFinish` / `hasBlobGap` make blob commits
 * the likeliest source of out-of-order `onCommit` completion during copy — i.e. a persisted
 * resume cursor advancing past a record whose blob bytes were never durably written. Unlike
 * the plain-record case, a defect here can ALSO manifest as a present-but-empty/truncated blob
 * (record committed, backing file short or missing) rather than a missing key — hence the
 * three-layer oracle below, not just a key-set diff.
 *
 * Table shape: BlobCopyRecord is a plain @table @export with NO sourcedFrom (authoritative —
 * the blob bytes ARE the replicated data; a read on the receiver can not re-source and mask a
 * gap). Each id's ~1 MiB blob is a pure deterministic function of id (fixture's blobForId),
 * mirrored here as expectedBytesForId, so bytes can be verified without round-tripping through
 * the source.
 *
 * Oracle (all three, not just one):
 *   1. Bidirectional primary-key-set comparison, source vs receiver (not counts, not
 *      cluster_status — same rationale as QA-689: the cursor and cluster_status can both read
 *      "caught up" over a gap).
 *   2. Blob CONTENT verification: GET every id's blob back over HTTP and compare bytes
 *      exactly to the deterministic expected content — catches a present-but-empty or
 *      truncated blob that a key-set diff alone would miss.
 *   3. Direct blob-store file-system inspection on both nodes ({dataRootDir}/blobs/data/p/p/
 *      fileId): every file's body is content-hashed and matched against the expected hash for
 *      each seeded id. This independently (of the HTTP layer) checks (a) every live id has at
 *      least one on-disk file with its correct content, and (b) zero files carry content that
 *      matches NO seeded id (an orphan/corrupt file). Extra files whose content DOES match a
 *      known id (benign duplicates from a resumed/re-streamed record minting a fresh node-local
 *      fileId) are logged, not failed — that surplus is expected precedent
 *      (replicationBlobResyncOnFailure.test.mjs).
 *
 * Coverage anchored: factor axes B (value type = large external blob) x D (replication
 * topology = full-copy join) x F (lifecycle = repeated mid-copy restart) — the highest-weight
 * interaction row in the QA factor-axis library. Non-duplicative vs the existing blob cluster
 * tests: blobGapDeadlock / blobSaveRejectionContainment never kill a node, and
 * replicationBlobResyncOnFailure / replicationBlobRepairAuthoritative each kill once during
 * LIVE replication with an injected save-failure — none interrupts a bulk full copy, and none
 * walks the blob store for orphans across the copy.
 *
 * Precondition (hard-asserted at every kill, so a clean negative is non-vacuous): the
 * receiver's row count must be strictly between 0 and the seeded total — i.e. genuinely
 * mid-copy, not before start or after finish.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { concurrent, fetchWithRetry, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';

// ── Tunables ────────────────────────────────────────────────────────────────────────────────
const RECORD_COUNT = Number.parseInt(process.env.QA692_RECORDS || '120', 10);
const SEED_CONCURRENCY = Number.parseInt(process.env.QA692_SEED_CONCURRENCY || '12', 10);
// Fractions of RECORD_COUNT at which we attempt a SIGKILL interruption of the receiver.
const INTERRUPT_FRACTIONS = [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
const POLL_MS = 30;
const PER_CHECKPOINT_WAIT_MS = 45000;
const FINAL_CONVERGENCE_TIMEOUT_MS = 150000;
const FINAL_STAGNATION_MS = 20000;
const OP_TIMEOUT_MS = 20000;
const FIXTURE_PATH = join(import.meta.dirname, 'fixture-qa692-blob-authoritative');
const PROJECT = 'qa692-blob-authoritative';

// Must match fixture-qa692-blob-authoritative/resources.js blobForId exactly.
const CHUNK = 1024;
const CHUNKS = 1024; // 1 MiB
const BLOB_SIZE = CHUNK * CHUNKS;
function expectedBytesForId(id) {
	const seed = Number(id) | 0;
	const out = Buffer.allocUnsafe(BLOB_SIZE);
	for (let c = 0; c < CHUNKS; c++) {
		for (let i = 0; i < CHUNK; i++) out[c * CHUNK + i] = (seed * 131 + c * 31 + i) & 0xff;
	}
	return out;
}

// ── Blob-store header parsing (core/resources/blob.ts: 8-byte header, top 16 bits = storage
// type, low 48 bits = uncompressed content length). Our fixture never sets `compress`, so a
// well-formed file is always UNCOMPRESSED_TYPE and its body is the raw content.
const HEADER_SIZE = 8;
const UNCOMPRESSED_TYPE = 0;
const ERROR_TYPE = 0xff;
const PENDING_TYPE = 0xfe;

function parseBlobFile(filePath) {
	let buf;
	try {
		buf = readFileSync(filePath);
	} catch (e) {
		return { status: 'read-error', path: filePath, error: String(e) };
	}
	if (buf.length < HEADER_SIZE) return { status: 'too-small', path: filePath, length: buf.length };
	const headerValue = buf.readBigUInt64BE(0);
	const type = Number(headerValue >> 48n);
	const size = Number(headerValue & 0xffffffffffffn);
	if (type === ERROR_TYPE) return { status: 'error-stub', path: filePath };
	if (type === PENDING_TYPE) return { status: 'pending-stub', path: filePath };
	if (type !== UNCOMPRESSED_TYPE) return { status: 'unexpected-compressed', path: filePath, type };
	if (buf.length < HEADER_SIZE + size) {
		return { status: 'truncated', path: filePath, size, actualBodyLength: buf.length - HEADER_SIZE };
	}
	return { status: 'ok', path: filePath, size, body: buf.subarray(HEADER_SIZE, HEADER_SIZE + size) };
}

function walkBlobFiles(dataRootDir, db = 'data') {
	const root = join(dataRootDir, 'blobs', db);
	if (!existsSync(root)) return [];
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) walk(p);
			else files.push(p);
		}
	};
	walk(root);
	return files;
}

/**
 * Build a content-hash index of a node's on-disk blob store and match every file against
 * the universe of expected per-id hashes. Returns per-id file counts (0 = no matching file
 * anywhere on disk for that id) and a list of files whose content matches NO expected id
 * (orphan/corrupt candidates) plus any structurally bad files (truncated/error/pending stubs).
 */
function inspectBlobStore(dataRootDir, expectedHashById) {
	const files = walkBlobFiles(dataRootDir);
	const idFileCounts = new Map(); // id -> count of on-disk files whose content matches it
	const unrecognized = []; // files whose content hash matches no known id
	const structurallyBad = []; // truncated / error-stub / pending-stub / unreadable
	const hashToId = new Map();
	for (const [id, hash] of expectedHashById) hashToId.set(hash, id);

	for (const filePath of files) {
		const parsed = parseBlobFile(filePath);
		if (parsed.status !== 'ok') {
			structurallyBad.push(parsed);
			continue;
		}
		const hash = createHash('sha256').update(parsed.body).digest('hex');
		const id = hashToId.get(hash);
		if (id === undefined) {
			unrecognized.push({ path: filePath, size: parsed.size });
		} else {
			idFileCounts.set(id, (idFileCounts.get(id) ?? 0) + 1);
		}
	}
	return { totalFiles: files.length, idFileCounts, unrecognized, structurallyBad };
}

/** Abrupt SIGKILL of the whole process group — no graceful shutdown, no flush-on-exit. */
async function hardKill(node) {
	const proc = node.process;
	if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
	await new Promise((resolve) => {
		proc.once('exit', resolve);
		try {
			process.kill(-proc.pid, 'SIGKILL');
		} catch {
			try {
				proc.kill('SIGKILL');
			} catch {
				resolve();
			}
		}
	});
}

async function op(node, operation, timeoutMs = OP_TIMEOUT_MS) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const data = await response.json();
	equal(response.status, 200, JSON.stringify(data));
	return data;
}

async function recordCount(node) {
	try {
		const desc = await op(node, { operation: 'describe_table', database: 'data', table: 'BlobCopyRecord' });
		return desc?.record_count ?? 0;
	} catch {
		return -1; // node unreachable (mid-restart)
	}
}

async function fetchAllIds(node) {
	const result = await op(
		node,
		{
			operation: 'search_by_value',
			database: 'data',
			table: 'BlobCopyRecord',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id'],
		},
		60000
	);
	return new Set((result ?? []).map((r) => r.id));
}

const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, stdStreams: false, console: true, level: 'warn' },
	replication: { securePort: host + ':9933', databases: ['data'] },
});

function nodeOptions(hostname) {
	return { config: sharedConfig(hostname), env: { HARPER_NO_FLUSH_ON_EXIT: true } };
}

// GET the blob back over HTTP and compare bytes exactly to the deterministic expected content.
async function verifyBlobContent(node, id) {
	try {
		const resp = await fetchWithRetry(node.httpURL + '/BlobCopyImage/' + id, { retries: 5 });
		if (resp.status !== 200) return { id, ok: false, reason: `status=${resp.status}` };
		const bytes = Buffer.from(await resp.arrayBuffer());
		if (bytes.length !== BLOB_SIZE) return { id, ok: false, reason: `length=${bytes.length} expected=${BLOB_SIZE}` };
		if (!bytes.equals(expectedBytesForId(id))) return { id, ok: false, reason: 'bytes-mismatch' };
		return { id, ok: true };
	} catch (e) {
		return { id, ok: false, reason: `threw ${(e && e.message) || e}` };
	}
}

suite(
	'QA-692: interrupted BLOB-TABLE full copy vs. an undelivered range',
	{ skip: !STRESS, timeout: 900000 },
	(ctx) => {
		before(async () => {
			const hostnameA = await getNextAvailableLoopbackAddress();
			const source = { name: ctx.name, harper: { hostname: hostnameA } };
			await startHarper(source, nodeOptions(hostnameA));
			ctx.source = source.harper;

			// Deploy the authoritative blob fixture to A (local, non-replicated — B gets its own
			// copy below so it can serve BlobCopyImage reads independent of A after convergence).
			const payload = await targz(FIXTURE_PATH);
			const deployResp = await op(
				ctx.source,
				{ operation: 'deploy_component', project: PROJECT, payload, restart: true },
				30000
			);
			equal(deployResp.message, `Successfully deployed: ${PROJECT}, restarting Harper`);
			await delay(20000);

			// Seed ALL records BEFORE add_node so the entire table rides the full copy (startTime=0),
			// not live audit-replay.
			console.log(`[qa692] seeding ${RECORD_COUNT} authoritative blob records (${BLOB_SIZE} bytes each) on A...`);
			let nextSeedId = 0;
			const { execute, finish } = concurrent(
				() => fetchWithRetry(ctx.source.httpURL + '/SeedBlobCopyRecord/' + nextSeedId++, { retries: 20 }),
				SEED_CONCURRENCY
			);
			for (let i = 0; i < RECORD_COUNT; i++) await execute();
			await finish();

			const seeded = await recordCount(ctx.source);
			equal(seeded, RECORD_COUNT, `expected ${RECORD_COUNT} seeded rows on source, got ${seeded}`);
			console.log(`[qa692] A seeded ${seeded} blob records`);
		});

		after(async () => {
			await Promise.all(
				[
					ctx.source && teardownHarper({ harper: ctx.source }),
					ctx.receiver && teardownHarper({ harper: ctx.receiver }),
				].filter(Boolean)
			);
		});

		test('repeated mid-copy SIGKILL of a blob-table full copy converges with no missing/orphaned blobs', async () => {
			const hostnameB = await getNextAvailableLoopbackAddress();
			const receiverCtx = { name: ctx.name, harper: { hostname: hostnameB } };
			await startHarper(receiverCtx, nodeOptions(hostnameB));
			ctx.receiver = receiverCtx.harper;

			// Deploy the SAME fixture to B (local, non-replicated) BEFORE add_node, so B can serve
			// BlobCopyImage reads for the oracle immediately once records land (qa311-proven pattern:
			// a pre-existing identical schema on the receiver does not block the full copy from
			// delivering pre-existing rows).
			const payload = await targz(FIXTURE_PATH);
			const deployResp = await op(
				ctx.receiver,
				{ operation: 'deploy_component', project: PROJECT, payload, restart: true },
				30000
			);
			equal(deployResp.message, `Successfully deployed: ${PROJECT}, restarting Harper`);
			await delay(20000);

			console.log(
				`[qa692] B ready; issuing add_node isLeader:true to trigger full copy of ${RECORD_COUNT} blob records`
			);
			await op(ctx.receiver, {
				operation: 'add_node',
				hostname: ctx.source.hostname,
				rejectUnauthorized: false,
				isLeader: true,
				authorization: ctx.source.admin,
			});

			const interruptions = [];
			for (const frac of INTERRUPT_FRACTIONS) {
				const target = Math.floor(RECORD_COUNT * frac);
				const deadline = Date.now() + PER_CHECKPOINT_WAIT_MS;
				let count = 0;
				while (Date.now() < deadline) {
					count = await recordCount(ctx.receiver);
					if (count >= target || count >= RECORD_COUNT) break;
					await delay(POLL_MS);
				}
				if (count >= RECORD_COUNT) {
					console.log(
						`[qa692] checkpoint frac=${frac}: copy already reached ${count}/${RECORD_COUNT}; stopping interruption loop`
					);
					break;
				}
				// Hard precondition: genuinely interrupted mid-range, not before start or after finish.
				ok(
					count > 0 && count < RECORD_COUNT,
					`precondition failed at frac=${frac}: receiver count must be strictly between 0 and ${RECORD_COUNT}, got ${count}`
				);
				interruptions.push({ frac, countAtKill: count });
				console.log(`[qa692] SIGKILL at frac=${frac}, receiver count=${count}/${RECORD_COUNT}`);
				await hardKill(ctx.receiver);
				// CRITICAL: restart MUST re-pass the original config — omitting it wipes
				// replication.databases and silently breaks replication.
				ctx.receiver = (
					await startHarper(
						{ harper: { dataRootDir: ctx.receiver.dataRootDir, hostname: ctx.receiver.hostname } },
						nodeOptions(ctx.receiver.hostname)
					)
				).harper;
			}

			ok(
				interruptions.length > 0,
				'precondition never armed: never observed a genuine mid-copy interruption (harness/timing issue)'
			);

			// Let the (resumed / restarted-from-persisted-cursor) copy run to completion, or until
			// it visibly stagnates.
			const finalDeadline = Date.now() + FINAL_CONVERGENCE_TIMEOUT_MS;
			let lastCount = -1;
			let stableSince = Date.now();
			let finalCount = 0;
			while (Date.now() < finalDeadline) {
				finalCount = await recordCount(ctx.receiver);
				if (finalCount !== lastCount) {
					lastCount = finalCount;
					stableSince = Date.now();
				}
				if (finalCount >= RECORD_COUNT) break;
				if (Date.now() - stableSince > FINAL_STAGNATION_MS) {
					console.log(
						`[qa692] receiver count stagnated at ${finalCount}/${RECORD_COUNT} for >${FINAL_STAGNATION_MS}ms`
					);
					break;
				}
				await delay(250);
			}
			console.log(
				`[qa692] final receiver record_count=${finalCount}/${RECORD_COUNT} after ${interruptions.length} interruption(s): ${JSON.stringify(interruptions)}`
			);

			// Extra settle time for the durability watermark / outstandingBlobsToFinish to drain
			// before scanning — the count reaching RECORD_COUNT does not by itself prove every blob
			// is durably saved.
			await delay(5000);

			// ═══ LAYER 1: bidirectional primary-key-set comparison ═══
			const sourceIds = await fetchAllIds(ctx.source);
			const receiverIds = await fetchAllIds(ctx.receiver);
			equal(sourceIds.size, RECORD_COUNT, `sanity: source itself should still have all ${RECORD_COUNT} rows`);
			const missingOnReceiver = [...sourceIds].filter((id) => !receiverIds.has(id));
			const missingOnSource = [...receiverIds].filter((id) => !sourceIds.has(id));

			// ═══ LAYER 2: blob content verification (bytes/hash, not just presence) ═══
			// Every seeded id, checked on both nodes — a present-but-empty/truncated blob is caught
			// here even when the key exists.
			const allIds = Array.from({ length: RECORD_COUNT }, (_, i) => i);
			const aContentResults = await Promise.all(allIds.map((id) => verifyBlobContent(ctx.source, id)));
			const bContentResults = await Promise.all(
				allIds.filter((id) => receiverIds.has(id)).map((id) => verifyBlobContent(ctx.receiver, id))
			);
			const aContentFailures = aContentResults.filter((r) => !r.ok);
			const bContentFailures = bContentResults.filter((r) => !r.ok);

			// ═══ LAYER 3: direct blob-store file-system inspection (both nodes) ═══
			const expectedHashById = new Map(
				allIds.map((id) => [id, createHash('sha256').update(expectedBytesForId(id)).digest('hex')])
			);
			const aStore = inspectBlobStore(ctx.source.dataRootDir, expectedHashById);
			const bStore = inspectBlobStore(ctx.receiver.dataRootDir, expectedHashById);
			// (a) missing blob files backing a LIVE record: for every id the receiver currently has,
			// at least one on-disk file must carry that id's content.
			const bMissingBackingFile = [...receiverIds].filter((id) => !(bStore.idFileCounts.get(id) > 0));
			// (b) orphaned blob files with no referring record: content matches no seeded id at all.
			const bOrphanFiles = bStore.unrecognized;
			const bStructurallyBad = bStore.structurallyBad;
			// Benign surplus: duplicate files for the same id from a resumed/re-streamed record
			// minting a fresh node-local fileId (expected precedent, not a failure).
			const bDuplicateSurplus = [...bStore.idFileCounts.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);

			console.log(`\n=== QA-692 RESULTS ===`);
			console.log(
				`Seeded: ${RECORD_COUNT} records x ${BLOB_SIZE} bytes = ${((RECORD_COUNT * BLOB_SIZE) / 1e6).toFixed(1)} MB`
			);
			console.log(`Interruptions (${interruptions.length}): ${JSON.stringify(interruptions)}`);
			console.log(
				`--- Layer 1: key-set --- source=${sourceIds.size} receiver=${receiverIds.size} missingOnReceiver=${missingOnReceiver.length} missingOnSource=${missingOnSource.length}`
			);
			if (missingOnReceiver.length)
				console.log(`  missing-on-receiver ids (first 20): ${missingOnReceiver.slice(0, 20).join(', ')}`);
			console.log(
				`--- Layer 2: blob content --- A failures=${aContentFailures.length}/${RECORD_COUNT} B failures=${bContentFailures.length}/${receiverIds.size}`
			);
			if (bContentFailures.length)
				console.log(
					`  B content failures: ${bContentFailures
						.map((f) => `id=${f.id}:${f.reason}`)
						.slice(0, 20)
						.join(' | ')}`
				);
			console.log(
				`--- Layer 3: blob-store file inspection --- A totalFiles=${aStore.totalFiles} B totalFiles=${bStore.totalFiles}`
			);
			console.log(
				`  B missing-backing-file for live id (defect signal): ${bMissingBackingFile.length} ${bMissingBackingFile.slice(0, 20).join(', ')}`
			);
			console.log(
				`  B orphan files (content matches no seeded id, defect signal): ${bOrphanFiles.length} ${JSON.stringify(bOrphanFiles.slice(0, 10))}`
			);
			console.log(
				`  B structurally-bad files (truncated/error/pending stub): ${bStructurallyBad.length} ${JSON.stringify(bStructurallyBad.slice(0, 10))}`
			);
			console.log(
				`  B benign duplicate-file surplus (expected from resume re-streams, not a failure): ${bDuplicateSurplus}`
			);
			console.log(`======================`);

			const blobGapMentions = ((await readLog(ctx.receiver)).match(/hasBlobGap|outstandingBlobsToFinish/g) ?? [])
				.length;
			console.log(`[qa692] receiver log mentions of hasBlobGap/outstandingBlobsToFinish: ${blobGapMentions}`);

			// ═══ Assertions (all diagnostics above are already logged, so a failure here still
			// leaves the full three-layer picture in the run log) ═══
			equal(
				missingOnReceiver.length,
				0,
				`DEFECT SIGNATURE (layer 1 - key set): receiver permanently missing ${missingOnReceiver.length}/${RECORD_COUNT} rows after ` +
					`${interruptions.length} genuine mid-copy interruption(s) of a BLOB table — harper-pro#537 blob-table arm.`
			);
			equal(missingOnSource.length, 0, `unexpected: receiver has ${missingOnSource.length} rows not present on source`);

			equal(
				aContentFailures.length,
				0,
				`sanity failed: source A itself has ${aContentFailures.length} corrupt/missing blobs — not a receiver defect, investigate seeding`
			);
			equal(
				bContentFailures.length,
				0,
				`DEFECT SIGNATURE (layer 2 - blob bytes): receiver has ${bContentFailures.length} present-but-wrong blob(s) — a record's key ` +
					`exists but its blob content is empty/truncated/corrupt: ${bContentFailures.map((f) => `id=${f.id}:${f.reason}`).join(', ')}`
			);

			equal(
				bMissingBackingFile.length,
				0,
				`DEFECT SIGNATURE (layer 3a - missing blob file): ${bMissingBackingFile.length} live receiver record(s) have NO on-disk blob ` +
					`file with matching content: ${bMissingBackingFile.join(', ')}`
			);
			equal(
				bOrphanFiles.length,
				0,
				`DEFECT SIGNATURE (layer 3b - orphaned blob file): ${bOrphanFiles.length} on-disk blob file(s) on the receiver match NO seeded ` +
					`id's content (orphan/corrupt): ${JSON.stringify(bOrphanFiles.slice(0, 10))}`
			);
		});
	}
);
