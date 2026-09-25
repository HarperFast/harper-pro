import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { killHarper, startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TIMEOUT_MS = 30000;

function startOptions(node) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: { securePort: node.hostname + ':9933', databases: ['data'], ...node.replication },
			originLogFixture: { package: join(TEST_DIR, 'fixture-origin-log') },
		},
	};
}

/**
 * Starts nodes that load the fixture-origin-log component and have `table` in the data database. `replication`
 * adds replication config per node name.
 */
export async function startOriginLogNodes(suiteName, names, table, replication = {}) {
	const nodes = await Promise.all(
		names.map(async (name) => {
			const nodeCtx = {
				name: suiteName + '-' + name,
				harper: { hostname: await getNextAvailableLoopbackAddress(), replication: replication[name] },
			};
			await startHarper(nodeCtx, startOptions(nodeCtx.harper));
			return nodeCtx.harper;
		})
	);
	await Promise.all(
		nodes.map((node) =>
			sendOperation(node, {
				operation: 'create_table',
				database: 'data',
				table,
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'name', type: 'String' },
				],
			})
		)
	);
	// the fixture's resources are registered at boot, and a table created afterwards unregisters them
	return Promise.all(nodes.map(restartNode));
}

export async function restartNode(node) {
	await killHarper({ harper: node });
	return startNode(node);
}

export async function startNode(node) {
	const started = (await startHarper({ harper: node }, startOptions(node))).harper;
	started.replication = node.replication;
	return started;
}

export async function postToFixture(node, resource, body) {
	const deadline = Date.now() + TIMEOUT_MS;
	for (;;) {
		try {
			const response = await fetch(`${node.httpURL}/${resource}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
				},
				body: JSON.stringify(body),
			});
			if (response.ok) return response.json();
			if (Date.now() > deadline) throw new Error(`${resource} ${response.status}: ${await response.text()}`);
		} catch (error) {
			if (Date.now() > deadline) throw error;
		}
		await delay(250);
	}
}

/** Polls until every id has a version on `node`, and returns the versions by id. */
export async function waitForVersions(node, table, ids) {
	const deadline = Date.now() + TIMEOUT_MS;
	let versions;
	do {
		versions = await postToFixture(node, 'RecordVersions', { table, ids });
		if (ids.every((id) => versions[id] !== undefined)) break;
		await delay(250);
	} while (Date.now() < deadline);
	return versions;
}
