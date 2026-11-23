/**
 * harper-pro#1487: a node cloned from a clone must learn that clone's own leader.
 *
 *     A (leader)  <-- clone --  B  <-- clone --  C
 *
 * B's hdb_nodes row for A is the only way C can learn A: nothing joins after C, so A never rewrites
 * its own row. While B kept that row local-only after its clone completed, C never received it,
 * refused A's connections ("no hdb_nodes entry"), and reached A only through B, so stopping B split
 * the cluster.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	readLog,
	sendOperation,
	stopAndTeardownNodes,
	stopNodeProcess,
	waitForCondition,
} from '../cluster/clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DATABASE = 'data';
const TABLE = 'MeshProbe';

const nodeConfig = (hostname) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false },
	replication: { port: hostname + ':9933', securePort: null },
});

function waitForAvailable(node) {
	return waitForCondition(
		async (signal) => {
			const status = await sendOperation(node, { operation: 'get_status', id: 'availability' }, { signal }).catch(
				() => null
			);
			return status?.status === 'Available';
		},
		{ timeoutMs: 180_000, pollMs: 2_000, description: `${node.hostname} to become Available` }
	);
}

async function startClone(ctx, source) {
	const token = await sendOperation(source, {
		operation: 'create_authentication_tokens',
		username: ctx.leader.admin.username,
		password: ctx.leader.admin.password,
	});
	const cloneCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
	await startHarper(cloneCtx, {
		config: nodeConfig(cloneCtx.harper.hostname),
		env: {
			HDB_LEADER_URL: `http://${source.hostname}:9925`,
			HDB_LEADER_TOKEN: token.operation_token,
			ALLOW_SELF_SIGNED: true,
			HARPER_NO_FLUSH_ON_EXIT: true,
		},
	});
	return cloneCtx.harper;
}

async function nodeNames(node, signal) {
	const rows = await sendOperation(
		node,
		{
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_nodes',
			search_attribute: 'name',
			search_value: '*',
			get_attributes: ['name'],
		},
		{ signal }
	).catch(() => []);
	return rows.map((row) => row.name);
}

function waitForPeerRow(node, peer) {
	return waitForCondition(async (signal) => (await nodeNames(node, signal)).includes(peer.hostname), {
		timeoutMs: 60_000,
		description: `${node.hostname} to hold an hdb_nodes row for ${peer.hostname}`,
	});
}

function waitForConnected(node, peer) {
	return waitForCondition(
		async (signal) => {
			const status = await sendOperation(node, { operation: 'cluster_status' }, { signal }).catch(() => null);
			const sockets = status?.connections?.find((connection) => connection.name === peer.hostname)?.database_sockets;
			return sockets?.length > 0 && sockets.every((socket) => socket.connected);
		},
		{ timeoutMs: 90_000, description: `${node.hostname} to be connected to ${peer.hostname} on every database` }
	);
}

function waitForRecord(node, id) {
	return waitForCondition(
		async (signal) => {
			const rows = await sendOperation(
				node,
				{ operation: 'search_by_id', database: DATABASE, table: TABLE, ids: [id], get_attributes: ['id'] },
				{ signal }
			).catch(() => []);
			return rows.some((row) => row?.id === id);
		},
		{ timeoutMs: 90_000, description: `${TABLE}/${id} to arrive on ${node.hostname}` }
	);
}

function insert(node, id) {
	return sendOperation(node, { operation: 'insert', database: DATABASE, table: TABLE, records: [{ id }] });
}

suite('Clone Node - a clone of a clone learns the first leader (harper-pro#1487)', { timeout: 600_000 }, (ctx) => {
	before(async () => {
		const leaderCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(leaderCtx, {
			config: nodeConfig(leaderCtx.harper.hostname),
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		ctx.leader = leaderCtx.harper;
		await sendOperation(ctx.leader, {
			operation: 'create_table',
			database: DATABASE,
			table: TABLE,
			primary_key: 'id',
		});
		await insert(ctx.leader, 'seed');
	});

	after(async () => {
		await stopAndTeardownNodes([ctx.leader, ctx.follower, ctx.second]);
	});

	test('C, cloned from B, holds a row for A, connects to it, and still replicates with A once B is gone', async () => {
		const { leader } = ctx;
		const follower = (ctx.follower = await startClone(ctx, leader));
		await waitForAvailable(follower);
		await waitForRecord(follower, 'seed');

		const second = (ctx.second = await startClone(ctx, follower));
		await waitForAvailable(second);

		ok(
			/Published this node's record of leader/.test(await readLog(follower)),
			'premise: B published its record of A when its clone completed'
		);

		await waitForPeerRow(second, leader);
		await waitForPeerRow(leader, second);
		await Promise.all([waitForConnected(second, leader), waitForConnected(leader, second)]);

		// With B stopped, only a direct A <-> C link can carry these.
		await stopNodeProcess(follower);
		await insert(leader, 'from-leader');
		await insert(second, 'from-second');
		await Promise.all([waitForRecord(second, 'from-leader'), waitForRecord(leader, 'from-second')]);

		const names = await nodeNames(second);
		ok(names.includes(follower.hostname), 'C keeps its row for B, its own clone source');
		equal(names.length, 3, `C knows exactly A, B and itself; found: ${names.join(', ')}`);
	});
});
