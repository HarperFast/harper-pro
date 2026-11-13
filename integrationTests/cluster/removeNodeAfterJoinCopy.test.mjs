// A node that joins a leader whose database it does not have yet subscribes before that database exists here, so
// its connection has no node ids until the leader's schema frame creates it. It must still record its resume cursor
// and the leader's certified floors: without them it copies the database again after a restart, and remove_node of
// the leader on it waits out its timeout ("has recorded no certified floor") (harper-pro#1348).
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	logMark,
	postOperation,
	readLogSince,
	restartNode,
	sendOperation,
	stopAndTeardownNodes,
	waitForCondition,
} from './clusterShared.mjs';
import { isLMDB } from './nodeDrainShared.mjs';

const TABLE = 'join_copy_test';

const nodeConfig = (hostname) => ({
	env: { HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: '500' },
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, level: 'warn' },
		replication: { port: hostname + ':9933', securePort: null, databases: ['data'] },
	},
});

const ids = (node, signal) =>
	sendOperation(
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
	).then(
		(rows) => rows.map((row) => row.id),
		() => []
	);

const holds = (node, id) =>
	waitForCondition(async (signal) => (await ids(node, signal)).includes(id), {
		description: `${node.hostname} to hold ${id}`,
	});

suite(
	'a node that joined by copying a database it lacked',
	{ timeout: 300_000, skip: isLMDB && 'RocksDB floors' },
	(ctx) => {
		let leader, joiner;

		before(async () => {
			const contexts = await Promise.all(
				[0, 1].map(async () => {
					const hostname = await getNextAvailableLoopbackAddress();
					const nodeCtx = { name: ctx.name, harper: { hostname } };
					await startHarper(nodeCtx, nodeConfig(hostname));
					return nodeCtx.harper;
				})
			);
			[leader, joiner] = contexts;
			await sendOperation(leader, { operation: 'create_table', database: 'data', table: TABLE, primary_key: 'id' });
			await sendOperation(leader, {
				operation: 'upsert',
				database: 'data',
				table: TABLE,
				records: [{ id: 'before-join' }],
			});
			await sendOperation(joiner, {
				operation: 'add_node',
				hostname: leader.hostname,
				rejectUnauthorized: false,
				isLeader: true,
				authorization: leader.admin,
			});
			await holds(joiner, 'before-join');
		});

		after(() => stopAndTeardownNodes([leader, joiner].filter(Boolean)));

		// before any restart: a reconnect sends a new request, which resolves the ids itself now that the database exists
		test('records the leader certified floor on the connection that copied the database', async () => {
			await waitForCondition(
				async (signal) => {
					const receipt = await sendOperation(
						joiner,
						{ operation: 'get_received_origin_floors', origin: leader.hostname, databases: ['data'] },
						{ signal }
					);
					return typeof receipt?.data?.closedFloor === 'number';
				},
				{ timeoutMs: 30_000, description: `${joiner.hostname} to record a certified floor for ${leader.hostname}` }
			);
		});

		test('resumes from its cursor after a restart instead of copying again', async () => {
			await sendOperation(leader, { operation: 'upsert', database: 'data', table: TABLE, records: [{ id: 'live' }] });
			await holds(joiner, 'live');
			const mark = await logMark(joiner);
			await restartNode(joiner);
			await sendOperation(leader, {
				operation: 'upsert',
				database: 'data',
				table: TABLE,
				records: [{ id: 'after-restart' }],
			});
			await holds(joiner, 'after-restart');
			assert.doesNotMatch(await readLogSince(joiner, mark), /Requesting full copy of database data/);
		});

		test('removes the leader without force once the leader has fenced and its floor reached the joiner', async () => {
			const result = await postOperation(
				joiner,
				{ operation: 'remove_node', hostname: leader.hostname, timeout: 60_000 },
				{ signal: AbortSignal.timeout(120_000) }
			);
			assert.equal(result.status, 200, JSON.stringify(result));
		});
	}
);
