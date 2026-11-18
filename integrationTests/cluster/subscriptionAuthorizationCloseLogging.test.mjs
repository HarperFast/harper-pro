import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { ensureTableExists, readLog, sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DATABASE = 'data';
const TABLE = 'subscription_auth_logging';
const CLOSE_REASON = 'Unauthorized replication principal';
const LOG_TIMEOUT_MS = 30_000;
const ADMISSION_TIMEOUT_MS = 10_000;

function optionsFor(port, routes = []) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true, level: 'warn' },
			replication: {
				port,
				securePort: null,
				databases: [DATABASE],
				routes,
			},
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true },
	};
}

async function waitForLog(node, expected) {
	const deadline = Date.now() + LOG_TIMEOUT_MS;
	let log = '';
	while (Date.now() < deadline) {
		log = await readLog(node);
		if (log.includes(expected)) return log;
		await delay(250);
	}
	throw new Error(`Timed out waiting for ${JSON.stringify(expected)} in ${node.hostname}'s log:\n${log}`);
}

function observeReplicationAdmission(url, localAddress, username, password) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, 'harperdb-replication-v1', {
			headers: { Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') },
			localAddress,
		});
		const timeout = setTimeout(() => {
			socket.terminate();
			reject(new Error('Timed out waiting for replication admission to close'));
		}, ADMISSION_TIMEOUT_MS);
		socket.once('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		socket.once('close', (code, reason) => {
			clearTimeout(timeout);
			resolve({ code, reason: reason.toString() });
		});
		socket.once('message', () => {
			clearTimeout(timeout);
			socket.terminate();
			reject(new Error('Received a message before replication admission closed'));
		});
	});
}

async function assertConnectionAdmission(node, url, clientHostname) {
	const role = 'replication-principal-role';
	const username = 'replication-principal-user';
	const password = 'replication-principal-password';
	await sendOperation(node, { operation: 'add_role', role, permission: { super_user: false } });
	await sendOperation(node, { operation: 'add_user', username, password, role, active: true });

	const close = await observeReplicationAdmission(url, clientHostname, username, password);
	assert.deepEqual(close, { code: 1008, reason: CLOSE_REASON });
	await waitForLog(node, `Credential ${JSON.stringify(username)} is not authorized for replication`);
}

suite('replication authorization close logging', { timeout: 120_000 }, (ctx) => {
	before(async () => {
		const sourceHostname = await getNextAvailableLoopbackAddress();
		const subscriberHostname = await getNextAvailableLoopbackAddress();
		const clientHostname = await getNextAvailableLoopbackAddress();
		const sourceContext = { name: ctx.name, harper: { hostname: sourceHostname } };
		const subscriberContext = { name: ctx.name, harper: { hostname: subscriberHostname } };

		await Promise.all([
			startHarper(
				sourceContext,
				optionsFor(sourceHostname + ':9933', [
					{ hostname: subscriberHostname, port: 9933, replicates: { sends: false, receives: false } },
				])
			),
			startHarper(
				subscriberContext,
				optionsFor(subscriberHostname + ':9933', [
					{ hostname: sourceHostname, port: 9933, replicates: { sends: false, receives: true } },
				])
			),
		]);
		ctx.source = sourceContext.harper;
		ctx.subscriber = subscriberContext.harper;
		ctx.sourceHostname = sourceHostname;
		ctx.subscriberHostname = subscriberHostname;
		ctx.clientHostname = clientHostname;

		await Promise.all(
			[ctx.source, ctx.subscriber].map((node) =>
				ensureTableExists(node, {
					database: DATABASE,
					table: TABLE,
					primary_key: 'id',
					attributes: [{ name: 'id', type: 'ID' }],
				})
			)
		);
	});

	after(async () => {
		await Promise.all([ctx.source, ctx.subscriber].filter(Boolean).map((node) => teardownHarper({ harper: node })));
	});

	test('logs when a directional config route denies sending', async () => {
		await waitForLog(
			ctx.source,
			`Config route does not authorize sending ${JSON.stringify(DATABASE)} to declared peer ${JSON.stringify(ctx.subscriberHostname)} (authenticated as ${JSON.stringify(ctx.subscriberHostname)}); closing the subscription`
		);
	});

	test('requires a replication principal at setup on the dedicated listener', () =>
		assertConnectionAdmission(ctx.source, `ws://${ctx.source.hostname}:9933`, ctx.clientHostname));

	test('requires a replication principal at setup on the operations listener', async () => {
		const context = {
			name: `${ctx.name}-operations-listener`,
			harper: { hostname: await getNextAvailableLoopbackAddress() },
		};
		try {
			const options = optionsFor(null);
			await startHarper(context, { ...options, config: { ...options.config, threads: { count: 0 } } });
			const node = context.harper;
			await assertConnectionAdmission(node, node.operationsAPIURL.replace(/^http/, 'ws'), ctx.clientHostname);
		} finally {
			await teardownHarper(context);
		}
	});
});
