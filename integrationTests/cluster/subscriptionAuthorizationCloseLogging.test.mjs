import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { encode } from 'msgpackr';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { ensureTableExists, readLog, sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DATABASE = 'data';
const TABLE = 'subscription_auth_logging';
const CLOSE_REASON = `Unauthorized database subscription to ${DATABASE}`;
const LOG_TIMEOUT_MS = 30_000;

function optionsFor(hostname, peerHostname, replicates) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true, level: 'warn' },
			replication: {
				port: hostname + ':9933',
				securePort: null,
				databases: [DATABASE],
				routes: [{ hostname: peerHostname, port: 9933, replicates }],
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

function requestUnauthorizedSubscription(node, localAddress, username, password) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://${node.hostname}:9933`, 'harperdb-replication-v1', {
			headers: { Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') },
			localAddress,
		});
		const timeout = setTimeout(() => {
			socket.terminate();
			reject(new Error('Timed out waiting for unauthorized replication subscription to close'));
		}, LOG_TIMEOUT_MS);
		socket.once('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		socket.once('close', (code, reason) => {
			clearTimeout(timeout);
			resolve({ code, reason: reason.toString() });
		});
		socket.once('open', () => {
			socket.send(encode([140, 'unprivileged-replication-client', DATABASE]));
			socket.send(encode([129, [], []]));
		});
	});
}

suite('subscription authorization close logging', { timeout: 120_000 }, (ctx) => {
	before(async () => {
		const sourceHostname = await getNextAvailableLoopbackAddress();
		const subscriberHostname = await getNextAvailableLoopbackAddress();
		const clientHostname = await getNextAvailableLoopbackAddress();
		const sourceContext = { name: ctx.name, harper: { hostname: sourceHostname } };
		const subscriberContext = { name: ctx.name, harper: { hostname: subscriberHostname } };

		await Promise.all([
			startHarper(sourceContext, optionsFor(sourceHostname, subscriberHostname, { sends: false, receives: false })),
			startHarper(subscriberContext, optionsFor(subscriberHostname, sourceHostname, { sends: false, receives: true })),
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

	test('logs and preserves the 1008 reason when a non-replicating user subscribes', async () => {
		const role = `subscription-log-unprivileged-role-${Date.now()}`;
		const username = `subscription-log-unprivileged-user-${Date.now()}`;
		const password = 'subscription-log-unprivileged-password';
		await sendOperation(ctx.source, { operation: 'add_role', role, permission: { super_user: false } });
		await sendOperation(ctx.source, { operation: 'add_user', username, password, role, active: true });

		const close = await requestUnauthorizedSubscription(ctx.source, ctx.clientHostname, username, password);
		assert.deepEqual(close, { code: 1008, reason: CLOSE_REASON });
		await waitForLog(
			ctx.source,
			`Credential ${JSON.stringify(username)} is not authorized to subscribe to ${JSON.stringify(DATABASE)}: no super_user permission and no replicates grant; closing the subscription`
		);
	});
});
