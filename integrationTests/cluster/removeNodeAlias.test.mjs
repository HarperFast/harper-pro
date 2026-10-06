/**
 * remove_node by the address a caller used for add_node, when the peer identifies by another name.
 *
 * add_node stores the peer's row under the name the peer reports (its node.hostname), not under the
 * IP or alias the caller typed. remove_node must resolve that alias to the stored row and send the
 * peer its real name in the full-replication remove_node_back, or the peer keeps its self row.
 * A reciprocal removal that fails must show in the remove_node result, not only in the log.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok, match, doesNotMatch } from 'node:assert/strict';
import {
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
	releaseLoopbackAddress,
} from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT =
	process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ||
	join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const PEER_NAME = 'peer-b.remove-node-alias.test';

function nodeStartOptions(hostname, extra = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true },
			...extra,
			replication: {
				port: hostname + ':9933',
				securePort: null,
				databases: ['data'],
				...extra.replication,
			},
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}

async function nodeRows(node) {
	return sendOperation(node, {
		operation: 'search_by_value',
		database: 'system',
		table: 'hdb_nodes',
		search_attribute: 'name',
		search_value: '*',
		get_attributes: ['name', 'url'],
	});
}

async function postOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	return { status: response.status, body: await response.json() };
}

suite('remove_node by an alias', { timeout: 180000 }, (ctx) => {
	before(async () => {
		const hostnameA = await getNextAvailableLoopbackAddress();
		const hostnameB = await getNextAvailableLoopbackAddress();
		ctx.offlineAddress = await getNextAvailableLoopbackAddress();
		const ctxA = { name: ctx.name, harper: { hostname: hostnameA } };
		const ctxB = { name: ctx.name, harper: { hostname: hostnameB } };
		const results = await Promise.allSettled([
			startHarper(ctxA, nodeStartOptions(hostnameA)).then(() => {
				ctx.nodeA = ctxA.harper;
			}),
			// B identifies as PEER_NAME but is only reachable at its loopback IP.
			startHarper(
				ctxB,
				nodeStartOptions(hostnameB, {
					node: { hostname: PEER_NAME },
					replication: { url: `ws://${hostnameB}:9933` },
				})
			).then(() => {
				ctx.nodeB = ctxB.harper;
			}),
		]);
		const rejected = results.find((result) => result.status === 'rejected');
		if (rejected) throw rejected.reason;
	});

	after(async () => {
		const nodes = [ctx.nodeA, ctx.nodeB].filter(Boolean);
		await Promise.all(nodes.map((node) => teardownHarper({ harper: node }).catch(() => {})));
		if (ctx.offlineAddress) await releaseLoopbackAddress(ctx.offlineAddress).catch(() => {});
	});

	test('removing a peer by the IP it was added with deletes its self row on the peer', async () => {
		const added = await sendOperation(ctx.nodeA, {
			operation: 'add_node',
			hostname: ctx.nodeB.hostname,
			authorization: ctx.nodeB.admin,
		});
		doesNotMatch(added.message, /error/i, JSON.stringify(added));

		const rowsOnA = await nodeRows(ctx.nodeA);
		ok(
			rowsOnA.some((row) => row.name === PEER_NAME),
			`A stores B under its reported name: ${JSON.stringify(rowsOnA)}`
		);
		ok(
			!rowsOnA.some((row) => row.name === ctx.nodeB.hostname),
			`A has no row keyed by the IP: ${JSON.stringify(rowsOnA)}`
		);
		ok(
			(await nodeRows(ctx.nodeB)).some((row) => row.name === PEER_NAME),
			'B has its self row before removal'
		);

		const { status, body } = await postOperation(ctx.nodeA, {
			operation: 'remove_node',
			hostname: ctx.nodeB.hostname,
		});
		equal(status, 200, JSON.stringify(body));
		doesNotMatch(body.message, /error/i, JSON.stringify(body));

		ok(
			!(await nodeRows(ctx.nodeA)).some((row) => row.name === PEER_NAME),
			'A no longer has a row for B after remove_node by IP'
		);
		await waitForCondition(async () => !(await nodeRows(ctx.nodeB)).some((row) => row.name === PEER_NAME), {
			timeoutMs: 15000,
			label: "remove_node_back deleting B's self row",
		});
	});

	test('a reciprocal removal that fails is reported in the remove_node result', async () => {
		// Nothing listens on this address, so add_node records the row locally under the typed address.
		const added = await sendOperation(ctx.nodeA, { operation: 'add_node', hostname: ctx.offlineAddress });
		match(added.message, /error updating target node/, JSON.stringify(added));

		const { status, body } = await postOperation(ctx.nodeA, {
			operation: 'remove_node',
			hostname: ctx.offlineAddress,
		});
		equal(status, 200, JSON.stringify(body));
		equal(body.message.split(' but ')[0], `Successfully removed '${ctx.offlineAddress}' from cluster`, body.message);
		match(body.message, /removal on the target node was not confirmed: .*ECONNREFUSED/, body.message);
		ok(
			!(await nodeRows(ctx.nodeA)).some((row) => row.name === ctx.offlineAddress),
			'the local row is removed even though the peer could not be reached'
		);
	});
});
