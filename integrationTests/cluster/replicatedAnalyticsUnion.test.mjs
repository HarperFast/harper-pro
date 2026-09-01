/**
 * Integration test: exact cross-node union for `get_analytics { replicated: true }`
 * (contract from HarperFast/harper#1130, peer-response materialization from #482).
 *
 * `analytics.replicate: false` is the default, so `hdb_analytics` does not replicate and a
 * cluster-wide analytics query has to fan out: core forwards the query to each peer with
 * `replicated` cleared and concatenates the responses (core/resources/analytics/read.ts),
 * and Pro's replication channel is what turns each peer's lazily-produced rows into
 * something encodable. Both halves fail quietly — a peer whose response never materialized
 * is logged and omitted, and a merge that re-counted the local rows just returns more rows —
 * so the only way to catch either is to compare the fan-out against the same two nodes'
 * local queries.
 *
 * Both nodes create the table BEFORE they are joined, so each node's db-write analytics come
 * from its own client writes rather than from applying the peer's replicated schema. The
 * write phases are asymmetric in both row count and payload width, so a node's rows can never
 * be mistaken for its peer's, and they straddle two aggregate periods so the union has to
 * hold across more than one aggregation flush.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const AGGREGATE_PERIOD_SECONDS = 2;
const CLUSTER_TIMEOUT_MS = 45_000;
const CONVERGE_TIMEOUT_MS = 45_000;
const ANALYTICS_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 250;
// Long enough for the clock to leave every already-written analytics row strictly behind an
// elapsed cutoff, on a platform whose `Date.now()` ticks coarsely; see where the window is chosen.
const CUTOFF_SETTLE_MS = 25;
const TABLE = 'analytics_union_events';
const PHASE_ONE_WRITES = { A: 2, B: 3 };
const PHASE_TWO_WRITES = { A: 3, B: 4 };

function nodeStartOptions(hostname) {
	return {
		config: {
			analytics: { aggregatePeriod: AGGREGATE_PERIOD_SECONDS, replicate: false },
			logging: { colors: false, stdStreams: false, console: true },
			replication: { securePort: `${hostname}:9933`, databases: ['data'] },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}

function waitForClusterConnection(nodes) {
	let statuses;
	return waitForCondition(
		async (signal) => {
			statuses = await Promise.all(
				nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }))
			);
			return statuses.every(
				(status) =>
					status.connections?.length === 1 &&
					status.connections[0].database_sockets?.length === 1 &&
					status.connections[0].database_sockets[0].connected
			);
		},
		{
			timeoutMs: CLUSTER_TIMEOUT_MS,
			pollMs: POLL_INTERVAL_MS,
			description: () => `both nodes to report a connected database socket; last saw ${JSON.stringify(statuses)}`,
		}
	);
}

async function writePhase(node, source, phase, count) {
	for (let index = 0; index < count; index++) {
		await sendOperation(node, {
			operation: 'upsert',
			database: 'data',
			table: TABLE,
			records: [
				{
					id: `${source}-${phase}-${index}`,
					source,
					phase,
					sequence: index,
					// distinct payload widths give the two nodes distinct db-write `mean` values
					payload: `${source}-${phase}-${'x'.repeat(source === 'A' ? 17 : 113)}`,
				},
			],
		});
	}
}

async function readTableIds(node, signal) {
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
	return rows.map(({ id }) => id).sort();
}

async function waitForExactRows(nodes, expectedIds) {
	let observed;
	await waitForCondition(
		async (signal) => {
			observed = await Promise.all(nodes.map((node) => readTableIds(node, signal)));
			return observed.every((ids) => ids.length === expectedIds.length);
		},
		{
			timeoutMs: CONVERGE_TIMEOUT_MS,
			pollMs: POLL_INTERVAL_MS,
			description: () =>
				`the replicated table to converge to ${expectedIds.length} rows on every node; ` +
				`last saw ${JSON.stringify(observed)}`,
		}
	);
	for (const ids of observed) deepStrictEqual(ids, expectedIds);
}

function getTableWriteAnalytics(node, { startTime, endTime, replicated, signal }) {
	return sendOperation(
		node,
		{
			operation: 'get_analytics',
			metric: 'db-write',
			start_time: startTime,
			...(endTime === undefined ? {} : { end_time: endTime }),
			get_attributes: ['id', 'node', 'path', 'type', 'count', 'mean', 'distribution'],
			conditions: [{ attribute: 'path', comparator: 'equals', value: TABLE }],
			replicated,
		},
		{ signal }
	);
}

function analyticsCount(rows) {
	return rows.reduce((total, row) => total + row.count, 0);
}

function originsOf(rows) {
	return new Set(rows.map(({ node }) => node));
}

// Aggregation writes one db-write row per path per period, so `minimumRows` is how many
// distinct aggregate periods this node's analytics have to span.
function waitForAnalytics(node, startTime, { minimumCount, minimumRows = 1 }) {
	let rows = [];
	return waitForCondition(
		async (signal) => {
			rows = await getTableWriteAnalytics(node, { startTime, replicated: false, signal });
			return rows.length >= minimumRows && analyticsCount(rows) >= minimumCount && rows;
		},
		{
			timeoutMs: ANALYTICS_TIMEOUT_MS,
			pollMs: POLL_INTERVAL_MS,
			description: () =>
				`${node.hostname} to aggregate at least ${minimumCount} ${TABLE} writes over ` +
				`${minimumRows} period(s); last saw ${analyticsCount(rows)} in ${JSON.stringify(rows)}`,
		}
	);
}

// Settled means a whole aggregate period passed and changed nothing, which is the only way to
// know the previous phase has finished flushing — elapsed time alone cannot promise it, and a
// straggling flush arriving after the baseline read would otherwise satisfy the next phase's
// growth on its own. Polling one period apart is what makes two equal reads mean that.
function waitForSettledAnalytics(node, startTime) {
	let previous;
	let rows = [];
	return waitForCondition(
		async (signal) => {
			rows = await getTableWriteAnalytics(node, { startTime, replicated: false, signal });
			const settled = previous?.length === rows.length && analyticsCount(previous) === analyticsCount(rows) && rows;
			previous = rows;
			return settled;
		},
		{
			timeoutMs: ANALYTICS_TIMEOUT_MS,
			pollMs: AGGREGATE_PERIOD_SECONDS * 1000,
			description: () => `${node.hostname}'s ${TABLE} analytics to stop changing; last saw ${JSON.stringify(rows)}`,
		}
	);
}

// Key order is not part of the response contract, so compare rows by content: the local and
// the fanned-out copy of the same row must be indistinguishable field for field.
function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])])
		);
	}
	return value;
}

function canonicalRows(rows) {
	return rows.map((row) => JSON.stringify(canonicalize(row))).sort();
}

suite('Replicated analytics union', { timeout: 180_000 }, (ctx) => {
	before(async () => {
		const [hostnameA, hostnameB] = await Promise.all([
			getNextAvailableLoopbackAddress(),
			getNextAvailableLoopbackAddress(),
		]);
		// `startHarper` replaces `nodeCtx.harper` with the started node, so `after` has to hold
		// the contexts rather than the nodes. It also has to see both starts SETTLE: a
		// fail-fast `Promise.all` would run teardown while the surviving start is still
		// spawning, and that Harper — not yet on its context — would outlive the suite.
		ctx.nodeCtxA = { name: ctx.name, harper: { hostname: hostnameA } };
		ctx.nodeCtxB = { name: ctx.name, harper: { hostname: hostnameB } };

		const starts = await Promise.allSettled([
			startHarper(ctx.nodeCtxA, nodeStartOptions(hostnameA)),
			startHarper(ctx.nodeCtxB, nodeStartOptions(hostnameB)),
		]);
		const failedStart = starts.find(({ status }) => status === 'rejected');
		if (failedStart) throw failedStart.reason;
		ctx.nodeA = ctx.nodeCtxA.harper;
		ctx.nodeB = ctx.nodeCtxB.harper;

		const createTable = {
			operation: 'create_table',
			database: 'data',
			table: TABLE,
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'source', type: 'String' },
				{ name: 'phase', type: 'String' },
				{ name: 'sequence', type: 'Int' },
				{ name: 'payload', type: 'String' },
			],
		};
		await Promise.all([sendOperation(ctx.nodeA, createTable), sendOperation(ctx.nodeB, createTable)]);

		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			rejectUnauthorized: false,
			authorization: ctx.nodeB.admin,
		});
		await waitForClusterConnection([ctx.nodeA, ctx.nodeB]);
		await waitForExactRows([ctx.nodeA, ctx.nodeB], []);
	});

	after(async () => {
		// allSettled for the same reason as startup: a rejected teardown must not abandon the
		// other node's, which would leak it and its ports into the rest of the run.
		const nodeCtxs = [ctx.nodeCtxA, ctx.nodeCtxB].filter(Boolean);
		const teardowns = await Promise.allSettled(nodeCtxs.map((nodeCtx) => teardownHarper(nodeCtx)));
		const failures = teardowns.flatMap(({ status, reason }, index) =>
			status === 'rejected'
				? [new Error(`teardown failed for ${nodeCtxs[index].harper?.hostname}`, { cause: reason })]
				: []
		);
		if (failures.length > 0) throw new AggregateError(failures, 'node teardown failed');
	});

	test("returns each node's local analytics exactly once after a second write phase", async () => {
		const { nodeA, nodeB } = ctx;
		const startTime = Date.now() - AGGREGATE_PERIOD_SECONDS * 2 * 1000;

		await writePhase(nodeA, 'A', 'before-boundary', PHASE_ONE_WRITES.A);
		await writePhase(nodeB, 'B', 'before-boundary', PHASE_ONE_WRITES.B);
		const phaseOneIds = [
			...Array.from({ length: PHASE_ONE_WRITES.A }, (_, index) => `A-before-boundary-${index}`),
			...Array.from({ length: PHASE_ONE_WRITES.B }, (_, index) => `B-before-boundary-${index}`),
		].sort();
		await waitForExactRows([nodeA, nodeB], phaseOneIds);

		await Promise.all([
			waitForAnalytics(nodeA, startTime, { minimumCount: 1 }),
			waitForAnalytics(nodeB, startTime, { minimumCount: 1 }),
		]);

		// Cross the boundary rather than infer it, and take the baseline only once each node has
		// gone a full period without aggregating anything new: phase two then cannot share phase
		// one's bucket, and nothing of phase one is left to flush into phase two's growth.
		const [baseA, baseB] = await Promise.all([
			waitForSettledAnalytics(nodeA, startTime),
			waitForSettledAnalytics(nodeB, startTime),
		]);

		await writePhase(nodeA, 'A', 'after-boundary', PHASE_TWO_WRITES.A);
		await writePhase(nodeB, 'B', 'after-boundary', PHASE_TWO_WRITES.B);
		const allIds = [
			...phaseOneIds,
			...Array.from({ length: PHASE_TWO_WRITES.A }, (_, index) => `A-after-boundary-${index}`),
			...Array.from({ length: PHASE_TWO_WRITES.B }, (_, index) => `B-after-boundary-${index}`),
		].sort();
		await waitForExactRows([nodeA, nodeB], allIds);

		// Both a NEW row and a higher count, measured against the settled baseline: either alone
		// could be satisfied by phase one's own rows, and it is phase two's aggregation — in its
		// own period — that the union then has to carry.
		await Promise.all([
			waitForAnalytics(nodeA, startTime, {
				minimumCount: analyticsCount(baseA) + 1,
				minimumRows: baseA.length + 1,
			}),
			waitForAnalytics(nodeB, startTime, {
				minimumCount: analyticsCount(baseB) + 1,
				minimumRows: baseB.length + 1,
			}),
		]);

		// The window has to be closed for all four reads at once: a flush landing inside it while
		// they are in flight reaches some and not others, and reads as a union mismatch. Rows carry
		// the write's monotonic time, so an ELAPSED cutoff excludes every later flush — and settling
		// first is what makes it elapsed with respect to the rows just observed, which a bare
		// `Date.now() - 1` cannot promise for a row written in this same millisecond.
		await delay(CUTOFF_SETTLE_MS);
		const endTime = Date.now() - 1;
		const signal = AbortSignal.timeout(ANALYTICS_TIMEOUT_MS);
		const [localA, localB, distributedFromA, distributedFromB] = await Promise.all([
			getTableWriteAnalytics(nodeA, { startTime, endTime, replicated: false, signal }),
			getTableWriteAnalytics(nodeB, { startTime, endTime, replicated: false, signal }),
			getTableWriteAnalytics(nodeA, { startTime, endTime, replicated: true, signal }),
			getTableWriteAnalytics(nodeB, { startTime, endTime, replicated: true, signal }),
		]);

		ok(analyticsCount(localA) > analyticsCount(baseA), 'node A must have aggregated its second write phase');
		ok(analyticsCount(localB) > analyticsCount(baseB), 'node B must have aggregated its second write phase');
		equal(analyticsCount(distributedFromA), analyticsCount(localA) + analyticsCount(localB));
		equal(analyticsCount(distributedFromB), analyticsCount(localA) + analyticsCount(localB));
		ok(new Set(localA.map(({ id }) => id)).size >= 2, 'node A must span at least two aggregate periods');
		ok(new Set(localB.map(({ id }) => id)).size >= 2, 'node B must span at least two aggregate periods');

		const nodeAIdentity = originsOf(localA);
		const nodeBIdentity = originsOf(localB);
		equal(nodeAIdentity.size, 1, `node A's rows must carry one origin: ${JSON.stringify([...nodeAIdentity])}`);
		equal(nodeBIdentity.size, 1, `node B's rows must carry one origin: ${JSON.stringify([...nodeBIdentity])}`);
		notEqual([...nodeAIdentity][0], [...nodeBIdentity][0]);

		// Origins first, so a dropped peer names which half went missing before the row diff.
		const bothOrigins = new Set([...nodeAIdentity, ...nodeBIdentity]);
		deepStrictEqual(originsOf(distributedFromA), bothOrigins);
		deepStrictEqual(originsOf(distributedFromB), bothOrigins);

		const expectedUnion = canonicalRows([...localA, ...localB]);
		deepStrictEqual(canonicalRows(distributedFromA), expectedUnion);
		deepStrictEqual(canonicalRows(distributedFromB), expectedUnion);
	});
});
