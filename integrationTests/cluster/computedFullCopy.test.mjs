/**
 * HarperFast/harper#2359: response-only scalar computed values must not enter a
 * full-copy record payload. Before the fix, Structon's JSON projection encoded
 * `derived`; the receiver collided with its read-only resolver and dropped the row.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { sendOperation, fetchWithRetry, readLog, restartNode, stopNodeProcess } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const DATABASE = 'data';
const TABLE = 'ComputedCopyRecord';
const PROJECT = 'computed-full-copy';
const FIXTURE_PATH = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'fixture-computed-full-copy');

const config = (hostname) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true },
		replication: { port: hostname + ':9933', securePort: null, databases: [DATABASE] },
	},
});

async function deploy(node, payload) {
	await sendOperation(node, {
		operation: 'deploy_component',
		project: PROJECT,
		payload,
		replicated: false,
		restart: true,
	});
}

async function waitForTable(node, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await fetchWithRetry(`${node.httpURL}/${TABLE}/`, {
			headers: {
				Authorization: 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
			},
			retries: 0,
		}).catch(() => null);
		if (response && response.status !== 404) return;
		await delay(250);
	}
	throw new Error(`${TABLE} did not become ready on ${node.hostname}`);
}

async function getRecord(node, id) {
	const response = await fetchWithRetry(`${node.httpURL}/${TABLE}/${id}`, {
		headers: {
			Authorization: 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
		},
		retries: 0,
	});
	if (!response.ok) return null;
	return response.json();
}

async function waitForRecord(node, id, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const record = await getRecord(node, id).catch(() => null);
		if (record) return record;
		await delay(250);
	}
	return null;
}

suite('computed scalar full-copy durability (harper#2359)', { timeout: 300_000 }, (ctx) => {
	before(async () => {
		const [hostnameA, hostnameB] = await Promise.all([
			getNextAvailableLoopbackAddress(),
			getNextAvailableLoopbackAddress(),
		]);
		const nodeA = { name: ctx.name, harper: { hostname: hostnameA } };
		const nodeB = { name: ctx.name, harper: { hostname: hostnameB } };
		await Promise.all([startHarper(nodeA, config(hostnameA)), startHarper(nodeB, config(hostnameB))]);
		ctx.nodeA = nodeA.harper;
		ctx.nodeB = nodeB.harper;
		const payload = await targz(FIXTURE_PATH);
		await Promise.all([deploy(ctx.nodeA, payload), deploy(ctx.nodeB, payload)]);
		await Promise.all([waitForTable(ctx.nodeA), waitForTable(ctx.nodeB)]);
		await sendOperation(ctx.nodeA, {
			operation: 'insert',
			database: DATABASE,
			table: TABLE,
			records: [{ id: 'pre-existing', source: 'trusted' }],
		});
	});

	after(async () => {
		if (ctx.restartedB && ctx.nodeB) await stopNodeProcess(ctx.nodeB).catch(() => {});
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeB && teardownHarper({ harper: ctx.nodeB }),
		]);
	});

	test('full copy, computed index, mutation, and restart preserve the row', async () => {
		await sendOperation(ctx.nodeB, {
			operation: 'add_node',
			hostname: ctx.nodeA.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: ctx.nodeA.admin,
		});

		const source = await waitForRecord(ctx.nodeA, 'pre-existing');
		ok(source, 'source row must be present on node A');
		const copied = await waitForRecord(ctx.nodeB, 'pre-existing');
		ok(copied, 'pre-existing computed row must survive the full-copy decode');
		equal(copied.source, 'trusted');
		equal(copied.derived, 'trusted');
		const receiverLog = await readLog(ctx.nodeB);
		ok(receiverLog.length > 0, 'receiver log must be available for decode-drop verification');
		ok(!/Error decoding replication message/.test(receiverLog), 'receiver must not log a copy decode failure');

		const indexed = await sendOperation(ctx.nodeB, {
			operation: 'search_by_value',
			database: DATABASE,
			table: TABLE,
			search_attribute: 'derived',
			search_value: 'trusted',
			get_attributes: ['id', 'source', 'derived'],
		});
		deepEqual(indexed, [{ id: 'pre-existing', source: 'trusted', derived: 'trusted' }]);

		await sendOperation(ctx.nodeB, {
			operation: 'update',
			database: DATABASE,
			table: TABLE,
			records: [{ id: 'pre-existing', source: 'updated' }],
		});
		const updated = await getRecord(ctx.nodeB, 'pre-existing');
		ok(updated, 'updated row must remain readable before restart');
		equal(updated.derived, 'updated');

		ctx.restartedB = true;
		await restartNode(ctx.nodeB);
		let afterRestart;
		const deadline = Date.now() + 30_000;
		do {
			afterRestart = await getRecord(ctx.nodeB, 'pre-existing').catch(() => null);
			if (afterRestart?.derived === 'updated') break;
			await delay(250);
		} while (Date.now() < deadline);
		ok(afterRestart, 'copied row must remain readable after receiver restart');
		equal(afterRestart.derived, 'updated');
	});
});
