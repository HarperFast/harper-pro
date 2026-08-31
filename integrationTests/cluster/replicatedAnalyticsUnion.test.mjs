/**
 * Integration test: `get_analytics { replicated: true }` returns an exact union of the
 * cluster's analytics — every node's rows exactly once, none duplicated, none lost
 * (contract from HarperFast/harper#1130, peer-response materialization from #482).
 *
 * `analytics.replicate: false` is the default, so `hdb_analytics` does not replicate and a
 * cluster-wide analytics query has to fan out. Core forwards the same query to each peer
 * with `replicated` cleared so peers answer locally only, then concatenates
 * (core/resources/analytics/read.ts); Pro's replication channel is what materializes each
 * peer's response. A merge that re-counted the local rows, or that dropped a peer whose
 * response was still a promise, shows up here as a row/count mismatch against the two
 * nodes' own local queries.
 *
 * Both nodes create the table BEFORE they are joined, so each node's db-write analytics come
 * from its own client writes rather than from applying the peer's replicated schema. The
 * write phases are asymmetric in both row count and payload size, so a node's rows can never
 * be mistaken for its peer's, and they straddle two aggregate periods so the union has to
 * hold across more than one aggregation flush.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
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
					status.connections.length === 1 &&
					status.connections[0].database_sockets.length === 1 &&
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
	let lastError;
	await waitForCondition(
		async (signal) => {
			// A node whose copy of the schema has not landed yet answers with an error rather
			// than an empty result, so a failed read here is a not-ready, not a test failure.
			observed = await Promise.all(
				nodes.map((node) =>
					readTableIds(node, signal).catch((error) => {
						lastError = error;
						return null;
					})
				)
			);
			return observed.every((ids) => ids?.length === expectedIds.length);
		},
		{
			timeoutMs: CONVERGE_TIMEOUT_MS,
			pollMs: POLL_INTERVAL_MS,
			description: () =>
				`the replicated table to converge to ${expectedIds.length} rows on every node; ` +
				`last saw ${JSON.stringify(observed)}${lastError ? ` (last error: ${lastError.message})` : ''}`,
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

function waitForAnalyticsGrowth(node, startTime, minimumCount) {
	let rows = [];
	return waitForCondition(
		async (signal) => {
			rows = await getTableWriteAnalytics(node, { startTime, replicated: false, signal });
			return analyticsCount(rows) >= minimumCount && rows;
		},
		{
			timeoutMs: ANALYTICS_TIMEOUT_MS,
			pollMs: POLL_INTERVAL_MS,
			description: () =>
				`${node.hostname} to aggregate at least ${minimumCount} ${TABLE} writes; ` +
				`last saw ${analyticsCount(rows)} in ${JSON.stringify(rows)}`,
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
		const nodeCtxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const nodeCtxB = { name: ctx.name, harper: { hostname: hostnameB } };

		await Promise.all([
			startHarper(nodeCtxA, nodeStartOptions(hostnameA)),
			startHarper(nodeCtxB, nodeStartOptions(hostnameB)),
		]);
		ctx.nodeA = nodeCtxA.harper;
		ctx.nodeB = nodeCtxB.harper;

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
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
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

		const [phaseOneA, phaseOneB] = await Promise.all([
			waitForAnalyticsGrowth(nodeA, startTime, 1),
			waitForAnalyticsGrowth(nodeB, startTime, 1),
		]);
		const phaseOneCountA = analyticsCount(phaseOneA);
		const phaseOneCountB = analyticsCount(phaseOneB);

		await writePhase(nodeA, 'A', 'after-boundary', PHASE_TWO_WRITES.A);
		await writePhase(nodeB, 'B', 'after-boundary', PHASE_TWO_WRITES.B);
		const allIds = [
			...phaseOneIds,
			...Array.from({ length: PHASE_TWO_WRITES.A }, (_, index) => `A-after-boundary-${index}`),
			...Array.from({ length: PHASE_TWO_WRITES.B }, (_, index) => `B-after-boundary-${index}`),
		].sort();
		await waitForExactRows([nodeA, nodeB], allIds);

		// A growing count can only come from a later aggregation flush, so waiting for one
		// past each node's phase-one total is what puts the union across a period boundary.
		await Promise.all([
			waitForAnalyticsGrowth(nodeA, startTime, phaseOneCountA + 1),
			waitForAnalyticsGrowth(nodeB, startTime, phaseOneCountB + 1),
		]);

		// A closed window pins all four queries to the same set of aggregation rows; without it
		// a flush landing between the local and the fanned-out read would look like a mismatch.
		const endTime = Date.now() + 1;
		const [localA, localB, distributedFromA, distributedFromB] = await Promise.all([
			getTableWriteAnalytics(nodeA, { startTime, endTime, replicated: false }),
			getTableWriteAnalytics(nodeB, { startTime, endTime, replicated: false }),
			getTableWriteAnalytics(nodeA, { startTime, endTime, replicated: true }),
			getTableWriteAnalytics(nodeB, { startTime, endTime, replicated: true }),
		]);

		ok(analyticsCount(localA) > phaseOneCountA, 'node A must have aggregated its second write phase');
		ok(analyticsCount(localB) > phaseOneCountB, 'node B must have aggregated its second write phase');
		equal(analyticsCount(distributedFromA), analyticsCount(localA) + analyticsCount(localB));
		equal(analyticsCount(distributedFromB), analyticsCount(localA) + analyticsCount(localB));
		// Aggregation writes one db-write row per path per period, so two rows for this table
		// on one node means that node's analytics really do span two aggregate periods.
		ok(new Set(localA.map(({ id }) => id)).size >= 2, 'node A must span at least two aggregate periods');
		ok(new Set(localB.map(({ id }) => id)).size >= 2, 'node B must span at least two aggregate periods');

		const nodeAIdentity = new Set(localA.map(({ node }) => node));
		const nodeBIdentity = new Set(localB.map(({ node }) => node));
		equal(nodeAIdentity.size, 1, `node A's rows must carry one origin: ${JSON.stringify([...nodeAIdentity])}`);
		equal(nodeBIdentity.size, 1, `node B's rows must carry one origin: ${JSON.stringify([...nodeBIdentity])}`);
		notEqual([...nodeAIdentity][0], [...nodeBIdentity][0]);

		const expectedUnion = canonicalRows([...localA, ...localB]);
		deepStrictEqual(canonicalRows(distributedFromA), expectedUnion);
		deepStrictEqual(canonicalRows(distributedFromB), expectedUnion);
	});
});
