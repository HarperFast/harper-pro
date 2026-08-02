/**
 * harper-pro#642 end-to-end regression: the sender's dynamic authorization setup never settles for the
 * first data subscription, so DB_SCHEMA/replay never start while ping/pong keeps the WebSocket alive.
 * The receiver's application-level setup watchdog must reconnect from the durable cursor; the one-shot
 * sender fault then clears and replication converges without a process restart.
 */

import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const DB = 'data';
const TABLE = 'setup_recovery';
const SETUP_TIMEOUT_MS = 3000;
const RECOVERY_TIMEOUT_MS = 30000;

function optionsFor(node, env) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
			replication: {
				securePort: node.hostname + ':9933',
				databases: [DB],
				pingInterval: 1000,
				pingTimeout: 3000,
			},
		},
		env,
	};
}

async function hasRecord(node, id) {
	const result = await sendOperation(node, {
		operation: 'search_by_id',
		database: DB,
		table: TABLE,
		ids: [id],
		get_attributes: ['id'],
	}).catch(() => null);
	return Array.isArray(result) && result.some((record) => record?.id === id);
}

async function waitForRecord(node, id, timeoutMs = RECOVERY_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await hasRecord(node, id)) return true;
		await delay(250);
	}
	return false;
}

async function dataSocketConnected(node) {
	const status = await sendOperation(node, { operation: 'cluster_status' });
	return status.connections.some((connection) =>
		connection.database_sockets?.some((socket) => socket.database === DB && socket.connected === true)
	);
}

suite('subscription setup recovery', { timeout: 120000 }, (ctx) => {
	before(async () => {
		const sourceCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const receiverCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await Promise.all([
			startHarper(sourceCtx, optionsFor(sourceCtx.harper, { HARPER_TEST_SUBSCRIPTION_SETUP_STALL_ONCE_DB: DB })),
			startHarper(
				receiverCtx,
				optionsFor(receiverCtx.harper, {
					HARPER_TEST_SUBSCRIPTION_SETUP_TIMEOUT_MS: String(SETUP_TIMEOUT_MS),
				})
			),
		]);
		ctx.source = sourceCtx.harper;
		ctx.receiver = receiverCtx.harper;

		await Promise.all(
			[ctx.source, ctx.receiver].map((node) =>
				sendOperation(node, {
					operation: 'create_table',
					database: DB,
					table: TABLE,
					primary_key: 'id',
					attributes: [{ name: 'id', type: 'ID' }],
				})
			)
		);
	});

	after(async () => {
		await Promise.all([ctx.source, ctx.receiver].filter(Boolean).map((node) => teardownHarper({ harper: node })));
	});

	test('a ping-alive setup hang reconnects and converges without a restart', async () => {
		await sendOperation(ctx.receiver, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: ctx.source.hostname,
			authorization: ctx.receiver.admin,
		});

		// The first request is parked before DB_SCHEMA. Wait past the test-only setup bound and reconnect
		// backoff so the write below can only arrive over the replacement subscription.
		await delay(SETUP_TIMEOUT_MS + 5000);

		const first = `after-setup-watchdog-${Date.now()}`;
		await sendOperation(ctx.source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: first }],
		});
		assert.equal(
			await waitForRecord(ctx.receiver, first),
			true,
			'a record written after the setup hang must arrive over the recovered subscription'
		);
		assert.equal(await dataSocketConnected(ctx.receiver), true, 'the recovered data socket must be connected');

		// Once DB_SCHEMA completed the one-shot watchdog is retired. A caught-up idle connection can stay
		// quiet for several setup windows without reconnect churn, then deliver the next write normally.
		await delay(SETUP_TIMEOUT_MS * 3);
		const second = `after-idle-${Date.now()}`;
		await sendOperation(ctx.source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: second }],
		});
		assert.equal(await waitForRecord(ctx.receiver, second), true, 'healthy idle must not rearm setup recovery');
	});
});
