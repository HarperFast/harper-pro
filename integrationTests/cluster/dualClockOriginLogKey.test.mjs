/**
 * A replicated source fill keeps the origin's record version on every peer, and every peer keys that
 * write in its per-origin log at the origin's log key (harper-pro#790, harper#2412 stage 0b).
 *
 * Two clocks, and until stage 0b they were conflated on RocksDB:
 *
 *   record version — what the source reported (core #2065 caps it at now). LWW ordering, ETag.
 *   log key        — the fill transaction's commit timestamp, and the batch key in the origin's log.
 *
 * A fill is the only ordinary write where they differ, which is why this fixture's source reports a
 * `lastModified` an hour in the past. Before this change the receiver put the record version on the
 * apply event as its transaction timestamp, so a peer keyed the origin's write in its own copy of the
 * origin's log at the *source's* clock. Leaf state looked right; a third node resuming through that
 * peer read cursors in a domain the relay's log no longer used.
 *
 * Topology — a chain, so the target only ever sees O's rows relayed:
 *
 *   O (origin, fills from source)  <-leader-  R (relay)  <-leader-  T (target)
 *
 * Red on base: T's (and R's) log key for the fill is the source version, not O's log key.
 * The version half is green on base and must stay green — it is the regression guard for applying
 * the origin's record version per write once the transaction timestamp stops carrying it.
 *
 * Phase 2 takes T down uncleanly across further origin writes and brings it back, so the same two
 * words are re-checked after a resume through the relay and after transaction-log replay.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import {
	killHarper,
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = resolve(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const FIXTURE = resolve(import.meta.dirname ?? module.path, 'fixture-dual-clock');
const TABLE = 'DualClock';
const SEED_ID = 'seed-0';
const FILL_ID = 'fill-1';
const LATE_IDS = ['late-1', 'late-2', 'late-3'];
const CONVERGE_TIMEOUT_MS = 90000;
// the fixture's source reports a lastModified this far back, so version << log key
const SOURCE_BACKDATE_MS = 3600_000;

const nodeConfig = (hostname) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true },
		replication: { port: hostname + ':9933', securePort: null, databases: ['data'] },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

const addLeader = (node, leader) =>
	sendOperation(node, {
		operation: 'add_node',
		hostname: leader.hostname,
		rejectUnauthorized: false,
		authorization: leader.admin,
		isLeader: true,
	});

/** Both clocks for one record as `node` holds them, via the fixture's Clocks endpoint. */
async function clocksOn(node, id, signal) {
	const response = await fetch(`${node.httpURL}/Clocks/${id}`, {
		headers: { Accept: 'application/json' },
		signal,
	});
	if (!response.ok) throw new Error(`Clocks/${id} on ${node.hostname} returned ${response.status}`);
	return response.json();
}

/** The one audit entry a fill leaves for its record on a node it reached directly. */
function soleAuditEntry(clocks, label) {
	equal(
		clocks.audit.length,
		1,
		`${label} must hold exactly one audit entry for ${clocks.id}, saw ${JSON.stringify(clocks.audit)}`
	);
	return clocks.audit[0];
}

/**
 * Both clocks as every audit entry on this node records them. A resumed relay hop can re-deliver a
 * write the receiver already applied — its per-origin dedup looks the entry up in the origin's log,
 * which a relayed entry is not filed under; that is pre-existing and unchanged here — so the oracle
 * is that every entry AGREES on both words, not that there is only one.
 */
function auditClocks(clocks, label) {
	ok(clocks.audit.length > 0, `${label} must hold an audit entry for ${clocks.id}`);
	const distinct = new Set(clocks.audit.map((entry) => `${entry.version}/${entry.localTime}`));
	equal(
		distinct.size,
		1,
		`${label}'s audit entries for ${clocks.id} must agree on both clocks, saw ${JSON.stringify(clocks.audit)}`
	);
	return clocks.audit[0];
}

async function idsOn(node, signal) {
	const rows = await sendOperation(
		node,
		{
			operation: 'search_by_value',
			database: 'data',
			table: TABLE,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id'],
		},
		{ signal }
	);
	return new Set(rows.map((row) => row.id));
}

function waitForIds(nodes, expected, what) {
	let last;
	return waitForCondition(
		async (signal) => {
			last = {};
			for (const [label, node] of Object.entries(nodes)) {
				try {
					const ids = await idsOn(node, signal);
					last[label] = [...ids].sort();
				} catch (error) {
					if (signal?.aborted) throw error;
					last[label] = 'unreachable';
					return false;
				}
			}
			return Object.values(last).every(
				(ids) => Array.isArray(ids) && expected.every((id) => ids.includes(id)) && ids.length === expected.length
			);
		},
		{
			timeoutMs: CONVERGE_TIMEOUT_MS,
			description: () => `${what}: expected ${JSON.stringify(expected.sort())}, last saw ${JSON.stringify(last)}`,
		}
	);
}

suite(
	'Replicated source fill keeps the origin version and the origin log key (harper-pro#790)',
	{ timeout: 480000 },
	(ctx) => {
		before(async () => {
			const roles = ['O', 'R', 'T'];
			const hostnames = await Promise.all(roles.map(() => getNextAvailableLoopbackAddress()));
			const dataRootDirs = await Promise.all(roles.map(() => mkdtemp(join(tmpdir(), 'harper-integration-test-'))));
			const fixtureBasename = basename(FIXTURE);
			await Promise.all(
				dataRootDirs.map((dataRootDir) =>
					cp(FIXTURE, join(dataRootDir, 'components', fixtureBasename), { recursive: true, dereference: true })
				)
			);
			const contexts = hostnames.map((hostname, i) => ({
				name: ctx.name,
				harper: { hostname, dataRootDir: dataRootDirs[i] },
			}));
			await Promise.all(contexts.map((nodeCtx, i) => startHarper(nodeCtx, nodeConfig(hostnames[i]))));
			[ctx.O, ctx.R, ctx.T] = contexts.map((nodeCtx) => nodeCtx.harper);
			ctx.dataRootDirs = Object.fromEntries(roles.map((role, i) => [role, dataRootDirs[i]]));

			// One hop at a time, so each copy has a complete source.
			await addLeader(ctx.R, ctx.O);
			await addLeader(ctx.T, ctx.R);

			// Settle both base copies before the fill. A row delivered by a base copy is applied as a
			// snapshot with no audit entry at all (harper-pro#480), so a fill that raced the copy would
			// leave nothing for this suite's oracle to read — and which path it took would be a coin flip.
			await sendOperation(ctx.O, {
				operation: 'upsert',
				database: 'data',
				table: TABLE,
				records: [{ id: SEED_ID, value: 'seed' }],
			});
			await waitForIds({ O: ctx.O, R: ctx.R, T: ctx.T }, [SEED_ID], 'the base copies finish before the fill');
		});

		after(async () => {
			const errors = [];
			for (const [label, node] of [
				['O', ctx.O],
				['R', ctx.R],
				['T', ctx.T],
			]) {
				if (!node) continue;
				try {
					await stopNodeProcess(node);
				} catch (error) {
					errors.push(new Error(`Failed to stop ${label}`, { cause: error }));
				}
				try {
					await teardownHarper({ harper: node });
				} catch (error) {
					errors.push(new Error(`Failed to tear down ${label}`, { cause: error }));
				}
			}
			if (errors.length) throw new AggregateError(errors, 'Failed to tear down dual-clock nodes');
		});

		test('a fill replicates with its version preserved and the origin log key intact on every hop', async () => {
			const { O, R, T } = ctx;
			const before = Date.now();
			// A read on O is a cache miss, so O fills from the source and stores the backdated version.
			const filled = await fetch(`${O.httpURL}/${TABLE}/${FILL_ID}`);
			ok(filled.ok, `the fill request on O returned ${filled.status}`);
			await waitForIds({ O, R, T }, [SEED_ID, FILL_ID], 'the fill reaches every hop');

			const origin = await clocksOn(O, FILL_ID);
			const originEntry = soleAuditEntry(origin, 'O');
			// Preconditions: this really is a two-clock write, or every assertion below is vacuous.
			ok(
				origin.version <= before - SOURCE_BACKDATE_MS + 1000,
				`O must store the backdated source version (stored ${origin.version}, request at ${before})`
			);
			ok(
				originEntry.localTime > origin.version,
				`O's log key must be its fill commit, not the source version (log key ${originEntry.localTime}, version ${origin.version})`
			);
			equal(originEntry.version, origin.version, "O's audit entry carries the record version");

			for (const [label, node] of [
				['R', R],
				['T', T],
			]) {
				const peer = await clocksOn(node, FILL_ID);
				const entry = soleAuditEntry(peer, label);
				equal(peer.value, origin.value, `${label} must hold the same record as O`);
				equal(peer.version, origin.version, `${label} must store the version O stored, not O's log key`);
				equal(entry.version, originEntry.version, `${label}'s audit entry must carry the origin's record version`);
				equal(
					entry.localTime,
					originEntry.localTime,
					`${label}'s log key for O's write must be O's log key, not the source version`
				);
			}
		});

		test('an unclean restart and a resume through the relay leave both clocks unchanged', async () => {
			const { O, R, T } = ctx;
			const beforeRestart = await clocksOn(T, FILL_ID);

			// T goes down without a graceful flush, so its restart replays the transaction log.
			await killHarper({ harper: T }, { graceMs: 0 });

			// Writes T cannot see: more fills, each with its own backdated version.
			for (const id of LATE_IDS) {
				const response = await fetch(`${O.httpURL}/${TABLE}/${id}`);
				ok(response.ok, `the fill request for ${id} on O returned ${response.status}`);
			}
			await waitForIds({ R }, [SEED_ID, FILL_ID, ...LATE_IDS], 'R receives the backlog while T is down');

			const restartCtx = { name: ctx.name, harper: { hostname: T.hostname, dataRootDir: ctx.dataRootDirs.T } };
			const restarted = await startHarper(restartCtx, nodeConfig(T.hostname));
			ctx.T = restarted?.harper ?? restartCtx.harper;

			await waitForIds({ T: ctx.T }, [SEED_ID, FILL_ID, ...LATE_IDS], 'T catches up through R after its restart');

			const afterRestart = await clocksOn(ctx.T, FILL_ID);
			const entry = auditClocks(afterRestart, 'T after restart');
			equal(afterRestart.version, beforeRestart.version, 'replay must not restamp the record at its log key');
			deepEqual(
				{ version: entry.version, localTime: entry.localTime },
				{ version: beforeRestart.audit[0].version, localTime: beforeRestart.audit[0].localTime },
				'neither the replay nor the resume may change either clock'
			);

			// And every late fill agrees hop for hop, so the resume skipped nothing and moved no clock.
			for (const id of LATE_IDS) {
				const origin = await clocksOn(O, id);
				const originEntry = soleAuditEntry(origin, `O/${id}`);
				for (const [label, node] of [
					['R', R],
					['T', ctx.T],
				]) {
					const peer = await clocksOn(node, id);
					const peerEntry = auditClocks(peer, `${label}/${id}`);
					equal(peer.version, origin.version, `${label} must store O's version for ${id}`);
					equal(peerEntry.version, originEntry.version, `${label} must record O's version for ${id}`);
					equal(peerEntry.localTime, originEntry.localTime, `${label} must key ${id} at O's log key`);
				}
			}
		});
	}
);
