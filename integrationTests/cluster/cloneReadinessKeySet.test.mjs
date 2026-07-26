/**
 * Clone readiness gate: a clone that reports `availability: Available` must be able to serve the
 * leader's whole key set.
 *
 * WHAT THIS PINS (the invariant, one assertion): at the FIRST tick where production's own
 * `get_status(availability)` reports `Available`, a bidirectional key-set diff between leader and
 * clone must show 0 missing (and the clone must never report a key the leader lacks). If a future
 * change lets `cloneNode`'s `monitorSync` -> `checkSyncStatus` -> `setStatus` flip Available while
 * the bulk copy is still in flight, reads served by that clone are wrong-but-200 -- silent,
 * data-loss-shaped. That is the shape reported in #611.
 *
 * COVERAGE NAMED: lifecycle=clone-bootstrap x replication=full-copy x oracle=served-key-set, on
 * `storage.engine: 'lmdb'` -- the one path where the readiness watermark is genuinely computed
 * (see the RocksDB note below), so the comparison logic is actually exercised rather than
 * short-circuited. Complements addNodeFullCopy.test.mjs, which asserts POST-convergence state;
 * nothing in integrationTests/cluster/ previously asserted the readiness PREDICATE itself.
 *
 * requires-isolation: yes -- it drives a real cloneNode CLI bootstrap and mutates topology, and
 * its timing must not be perturbed by co-tenant tests in the same process.
 *
 * Lineage: exploratory QA scenario QA-762 (source: gh-pro#611). The qa711/qa739 specs referenced
 * below are untracked QA-scratch exploration specs, not tracked suite files -- their findings are
 * summarized here so this file stands alone.
 *
 * PRIOR EXPLORATION (why this targets the LMDB path specifically):
 *   - qa-scratch/qa711-clone-midcopy-available.test.mjs drives the real cloneNode CLI
 *     bootstrap (HDB_LEADER_TOKEN/HDB_LEADER_URL) and polls production `get_status`
 *     (availability) plus a bidirectional key-set oracle.
 *   - qa-scratch/qa739-clone-sync-status.test.mjs instead reimplements checkSyncStatus
 *     verbatim (cloneNode.ts:553-614) against a plain `add_node isLeader:true` bring-up (no
 *     real cloneNode bootstrap) and polls it at 120ms. FINDING: under the DEFAULT storage
 *     engine (RocksDB -- `STORAGE_IS_ROCKSDB` per replication/replicationConnection.ts:315 is
 *     true whenever storage.engine !== 'lmdb'), `RocksTransactionLogStore.getKeys()`
 *     (core/resources/RocksTransactionLogStore.ts:447) is an unimplemented stub returning
 *     `[]`. schemaDescribe.ts's describeTableObject (~line 227) falls through to the
 *     `__updatedtime__` secondary-index fallback, which assigns the RAW compound index key
 *     (`[timestamp, primaryKeyValue]`) to `last_updated_record` instead of `key[0]`.
 *     findMostRecentTimestamp's `tableObj.last_updated_record > mostRecent` then compares an
 *     array to a number (NaN via toString()), so `mostRecent` silently stays 0 for every
 *     table. checkSyncStatus treats a falsy targetTime as "no target, skip" -- so under
 *     RocksDB the predicate is vacuously TRUE from tick one. Worse than #611 describes (no
 *     window at all, the check never meaningfully runs) but it means neither qa739 nor qa711
 *     (which doesn't force an engine, so also defaults to RocksDB) ever exercised the
 *     watermark-comparison logic on a path where the target marker is genuinely computed.
 *
 * THE UNCOVERED CORNER THIS TEST TARGETS: force `storage.engine: 'lmdb'` on the leader (the
 * node getLastUpdatedRecord/describe_database/describe_all actually query), while driving the
 * REAL cloneNode CLI bootstrap (not a reimplementation, not plain add_node) so the actual
 * production `availability` flag is the signal under test. LMDB's audit store implements a
 * real getKeys(), so the primary path in schemaDescribe.ts should produce a genuine non-zero
 * last_updated_record/targetTimestamps, meaning checkSyncStatus's watermark comparison
 * actually executes instead of short-circuiting on "no target" -- the one code path where
 * hp#611's own hypothesis (the watermark itself races ahead of the copy) can be tested against
 * real numbers, and the one path relevant to whether fixing the RocksDB stub would produce a
 * sound check or just relocate the same defect onto real numbers.
 *
 * Method: qa711's real-bootstrap bring-up (HDB_LEADER_TOKEN/HDB_LEADER_URL), both nodes on
 * storage.engine:'lmdb', a larger dataset than qa711 (LMDB replication proved fast enough in an
 * initial run of this suite that a 40k/48MB set converged in under 2s -- scaled up here to
 * keep the copy open past cloneNode's pre-copy bootstrap steps and production's own 3s sync-
 * check cadence). Poll production get_status(availability) tightly; at the FIRST Available
 * tick, immediately take a real bidirectional key-set diff (never a count, never
 * cluster_status alone) between leader and clone. A side-channel verbatim port of
 * checkSyncStatus (from qa739) is also polled against the same cluster_status responses purely
 * as a diagnostic cross-check -- it is not what any assertion depends on.
 *
 * ORACLE ARMED: `selfTestComparator()` runs first and feeds the diff function a deliberately
 * truncated set with an injected extra key, asserting it reports exactly that gap -- so a
 * clean 0/0 result later is a proven-working comparator, not a broken one.
 *
 * DELIBERATELY DIAGNOSTIC, NOT ASSERTED: the non-zero `targetTimestamps` watermark is logged
 * rather than asserted. It was genuinely non-zero on this LMDB path when the scenario ran, but a
 * snapshot taken close to table creation could plausibly race it, and a flaky assertion here would
 * be worse than none. The invariant above does not depend on it. Whether a mid-copy window is
 * observed at all is likewise logged, not asserted -- on a fast runner the copy may complete before
 * the first poll, which makes the observation weaker but never makes the assertion wrong.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual as equal, ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const DATABASE = 'data';
const TABLE = 'qa762_bigitems';
const RECORD_COUNT = 250000;
const BATCH_SIZE = 5000;
const PAYLOAD_BYTES = 1200; // ~300MB total -- scaled up from qa711/qa739 (40k/48MB converged in <2s on LMDB)
const POLL_WINDOW_MS = 150000;
const FETCH_TIMEOUT_MS = 10000;

async function op(node, operation, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const data = await response.json();
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`operation ${operation.operation} failed: ${response.status} ${JSON.stringify(data)}`);
	}
	return data;
}

function makeRecords(startIdx, count) {
	const blob = 'z'.repeat(PAYLOAD_BYTES);
	const records = [];
	for (let i = startIdx; i < startIdx + count; i++) {
		records.push({ id: `item-${String(i).padStart(7, '0')}`, blob });
	}
	return records;
}

/** Verbatim port of cloneNode.ts findMostRecentTimestamp (~line 646) -- diagnostic only. */
function findMostRecentTimestamp(dbObj) {
	let mostRecent = 0;
	for (const table in dbObj) {
		const tableObj = dbObj[table];
		if (typeof tableObj !== 'object' || tableObj == null) continue;
		if (tableObj.last_updated_record > mostRecent) mostRecent = tableObj.last_updated_record;
	}
	return mostRecent;
}

/** Verbatim port of cloneNode.ts getLastUpdatedRecord (~line 621) -- diagnostic only. */
async function getTargetTimestamps(leaderNode) {
	const lastUpdated = {};
	const systemDb = await sendOperation(leaderNode, { operation: 'describe_database', database: 'system' });
	lastUpdated.system = findMostRecentTimestamp(systemDb);
	const allDb = await sendOperation(leaderNode, { operation: 'describe_all' });
	for (const db in allDb) {
		if (typeof allDb[db] !== 'object') continue;
		lastUpdated[db] = findMostRecentTimestamp(allDb[db]);
	}
	return lastUpdated;
}

/** Verbatim port of cloneNode.ts checkSyncStatus (~line 553) -- diagnostic only, not asserted on. */
function checkSyncStatusPredicate(targetTimestamps, clusterResponse, leaderHostname) {
	if (!clusterResponse?.connections?.length) return { synced: false, reason: 'no-response-or-connections' };
	const leaderConnection = clusterResponse.connections.find((conn) =>
		(conn.url ?? conn.name ?? '').includes(leaderHostname)
	);
	if (!leaderConnection?.database_sockets?.length) return { synced: false, reason: 'no-leader-connection-or-sockets' };
	for (const socket of leaderConnection.database_sockets) {
		const targetTime = targetTimestamps[socket.database];
		if (!targetTime) continue;
		const receivedVersion = socket.lastReceivedVersion;
		if (!receivedVersion || receivedVersion < targetTime) return { synced: false, reason: `behind:${socket.database}` };
	}
	return { synced: true };
}

/** Full id set for TABLE. Distinguishes a real empty result from a failed query. */
async function getIdSet(node) {
	try {
		const rows = await op(node, {
			operation: 'search_by_value',
			database: DATABASE,
			table: TABLE,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id'],
		});
		if (!Array.isArray(rows)) return { error: `non-array response: ${JSON.stringify(rows).slice(0, 200)}` };
		return { ids: new Set(rows.map((r) => r.id)) };
	} catch (err) {
		return { error: err.message };
	}
}

/** The oracle: a real bidirectional key-set diff -- never a count. */
function diffKeySets(sourceIds, cloneIds) {
	let missing = 0;
	for (const id of sourceIds) if (!cloneIds.has(id)) missing++;
	let extra = 0;
	for (const id of cloneIds) if (!sourceIds.has(id)) extra++;
	return { missing, extra };
}

/** Arm the oracle: prove diffKeySets can SEE a gap before trusting a later "0 missing" result. */
function selfTestComparator() {
	const source = new Set(Array.from({ length: 1000 }, (_, i) => `item-${String(i).padStart(7, '0')}`));
	const truncatedClone = new Set(source);
	let removedCount = 0;
	for (const id of source) {
		if (removedCount >= 37) break;
		truncatedClone.delete(id);
		removedCount++;
	}
	truncatedClone.add('item-9999999');
	const { missing, extra } = diffKeySets(source, truncatedClone);
	equal(missing, 37, `comparator self-test: expected 37 missing after deliberate truncation, got ${missing}`);
	equal(extra, 1, `comparator self-test: expected 1 injected extra key, got ${extra}`);
	console.log('[qa762] oracle self-test PASSED: comparator correctly detects a deliberately injected 37/1 gap');
}

suite('QA-762 clone checkSyncStatus / availability on LMDB leader', { timeout: 300000 }, (ctx) => {
	before(
		async () => {
			selfTestComparator();

			ctx.nodes = [];
			const hostnameA = await getNextAvailableLoopbackAddress();
			const nodeCtxA = { name: ctx.name, harper: { hostname: hostnameA } };
			await startHarper(nodeCtxA, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, console: true },
					replication: { port: hostnameA + ':9933', securePort: null, databases: [DATABASE] },
					storage: { engine: 'lmdb' },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			ctx.nodeA = nodeCtxA.harper;
			ctx.nodes.push(ctx.nodeA);

			await op(ctx.nodeA, { operation: 'create_table', database: DATABASE, table: TABLE, primary_key: 'id' });

			const seedStart = Date.now();
			for (let i = 0; i < RECORD_COUNT; i += BATCH_SIZE) {
				const records = makeRecords(i, Math.min(BATCH_SIZE, RECORD_COUNT - i));
				await op(ctx.nodeA, { operation: 'upsert', database: DATABASE, table: TABLE, records }, { timeoutMs: 30000 });
			}
			console.log(
				`[qa762] seeded ${RECORD_COUNT} records (~${Math.round((RECORD_COUNT * PAYLOAD_BYTES) / 1e6)}MB) on LMDB leader in ${Date.now() - seedStart}ms`
			);

			const sourceResult = await getIdSet(ctx.nodeA);
			ok(sourceResult.ids, `must be able to read back the leader id set after seeding: ${sourceResult.error}`);
			ctx.sourceIds = sourceResult.ids;
			equal(ctx.sourceIds.size, RECORD_COUNT, 'leader should hold every seeded record before cloning starts');

			const debugDescribe = await op(ctx.nodeA, { operation: 'describe_table', database: DATABASE, table: TABLE });
			console.log(
				`[qa762][debug] leader describe_table.last_updated_record=${JSON.stringify(debugDescribe.last_updated_record)} (type=${typeof debugDescribe.last_updated_record})`
			);
		},
		{ timeout: 150000 }
	);

	after(
		async () => {
			await Promise.all((ctx.nodes ?? []).map((node) => teardownHarper({ harper: node }).catch(() => {})));
		},
		{ timeout: 120000 }
	);

	test(
		'real cloneNode bootstrap: availability vs bidirectional key-set oracle (LMDB leader)',
		async () => {
			const { nodeA, sourceIds } = ctx;

			const tokenResponse = await op(nodeA, {
				operation: 'create_authentication_tokens',
				authorization: nodeA.admin,
				expires_in: '5Minutes',
			});

			const hostnameB = await getNextAvailableLoopbackAddress();
			const nodeCtxB = { name: ctx.name, harper: { hostname: hostnameB } };
			const cloneStart = Date.now();
			await startHarper(nodeCtxB, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, console: true },
					replication: { port: hostnameB + ':9933', securePort: null, databases: [DATABASE] },
					storage: { engine: 'lmdb' },
				},
				env: {
					HDB_LEADER_URL: `http://${nodeA.hostname}:9925`,
					HDB_LEADER_TOKEN: tokenResponse.operation_token,
					ALLOW_SELF_SIGNED: true,
					HARPER_NO_FLUSH_ON_EXIT: true,
				},
			});
			const nodeB = nodeCtxB.harper;
			ctx.nodes.push(nodeB);
			console.log(`[qa762] clone server reachable ${Date.now() - cloneStart}ms after start; beginning poll`);

			// Diagnostic-only targetTimestamps snapshot (not asserted on) -- confirms whether this run
			// reached the previously-unexercised LMDB code path (non-zero target) or is vacuous like qa739's
			// RocksDB finding (0).
			let targetTimestamps = null;
			try {
				targetTimestamps = await getTargetTimestamps(nodeA);
				console.log(`[qa762] diagnostic targetTimestamps=${JSON.stringify(targetTimestamps)}`);
			} catch (err) {
				console.log(`[qa762] diagnostic targetTimestamps fetch failed (non-fatal): ${err.message}`);
			}

			const deadline = Date.now() + POLL_WINDOW_MS;
			let becameAvailableAt = null;
			let availableSnapshot = null;
			let convergedAt = null;
			let sawExtra = false;
			let predicateFirstSyncedAt = null;
			let lastSample = null;

			while (Date.now() < deadline) {
				const tRel = Date.now() - cloneStart;
				let availability = 'unknown';
				try {
					const statusResp = await op(nodeB, { operation: 'get_status', id: 'availability' });
					availability = statusResp?.status ?? 'unknown';
				} catch (err) {
					availability = `error:${err.message}`;
				}

				// Diagnostic-only predicate cross-check against the same cluster_status the real
				// checkSyncStatus would see -- logged, not asserted on.
				if (targetTimestamps && predicateFirstSyncedAt === null) {
					try {
						const clusterResp = await op(nodeB, { operation: 'cluster_status' });
						const predicate = checkSyncStatusPredicate(targetTimestamps, clusterResp, nodeA.hostname);
						if (predicate.synced) {
							predicateFirstSyncedAt = tRel;
							console.log(`[qa762] diagnostic: verbatim checkSyncStatus predicate first synced at t=${tRel}ms`);
						}
					} catch {
						/* diagnostic only */
					}
				}

				const { ids: cloneIds, error: cloneIdsError } = await getIdSet(nodeB);
				let missing = sourceIds.size;
				let extra = 0;
				if (cloneIds) {
					({ missing, extra } = diffKeySets(sourceIds, cloneIds));
				}
				if (extra > 0) sawExtra = true;

				lastSample = { tRel, availability, cloneCount: cloneIds ? cloneIds.size : null, cloneIdsError, missing, extra };
				console.log(
					`[qa762] t=${tRel}ms availability=${availability} cloneKeys=${cloneIds ? cloneIds.size : `ERROR(${cloneIdsError})`}/${sourceIds.size} missing=${missing} extra=${extra}`
				);

				if (availability === 'Available' && becameAvailableAt === null) {
					becameAvailableAt = tRel;
					availableSnapshot = {
						missing,
						extra,
						cloneCount: cloneIds ? cloneIds.size : null,
						cloneIdsError,
						queryConfirmed: !!cloneIds,
					};
					console.log(
						`[qa762] *** availability flipped to Available at t=${tRel}ms with missing=${missing} extra=${extra} queryConfirmed=${!!cloneIds} ***`
					);
				}

				// Only check/declare convergence once we have actually observed Available -- otherwise an
				// early "0 missing" tick (before Available ever fires) would end the poll before the
				// production signal we're evaluating has had a chance to fire at all.
				if (becameAvailableAt !== null && cloneIds && missing === 0 && extra === 0 && convergedAt === null) {
					convergedAt = tRel;
					console.log(
						`[qa762] *** key sets converged (0 missing, 0 extra) at t=${tRel}ms (${tRel - becameAvailableAt}ms after Available) ***`
					);
					break;
				}

				await delay(tRel < 20000 ? 250 : 1000);
			}

			console.log(
				`[qa762] SUMMARY becameAvailableAt=${becameAvailableAt} availableSnapshot=${JSON.stringify(availableSnapshot)} ` +
					`predicateFirstSyncedAt=${predicateFirstSyncedAt} convergedAt=${convergedAt} sawExtra=${sawExtra} lastSample=${JSON.stringify(lastSample)}`
			);

			ok(becameAvailableAt !== null, `clone never reported Available within ${POLL_WINDOW_MS}ms poll window`);
			ok(!sawExtra, 'clone must never report a key the source does not have (bidirectional oracle, extra side)');

			if (targetTimestamps && !(targetTimestamps[DATABASE] > 0)) {
				console.log(
					`[qa762] NOTE: diagnostic targetTimestamps.${DATABASE}=${targetTimestamps?.[DATABASE]} was NOT a genuine non-zero ` +
						'value even on this LMDB leader -- the RocksDB-stub vacuity qa739 found may not be RocksDB-exclusive, or this ' +
						'snapshot raced the table being created. Treat the availability-vs-oracle result below as the authoritative ' +
						'finding regardless; this note only affects how the predicate diagnostic should be read.'
				);
			}

			// The defect-detecting assertion: if this fails, the REAL production availability flag
			// (cloneNode.ts's monitorSync -> checkSyncStatus -> setStatus) reported Available while the
			// bidirectional oracle still shows missing keys on the clone -- exactly QA-762/#611's shape,
			// now demonstrated against real production code on the LMDB leader path.
			equal(
				availableSnapshot?.missing,
				0,
				`checkSyncStatus reported Available while the clone was missing ${availableSnapshot?.missing} of ${sourceIds.size} keys (premature availability, LMDB leader)`
			);
		},
		{ timeout: 180000 }
	);
});
