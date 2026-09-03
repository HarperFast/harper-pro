/**
 * A live decode drop forces one resubscribe so a structure fork cannot silence a table (harper-pro#810).
 *
 * The field signature behind the wedge report was an EMPTY `typedStructs` on the receiver's decoder, under
 * which every later record of that table fails value-decode the same way for the life of the connection.
 * Only a fresh subscription repairs it, because that is what makes the sender re-send
 * `TABLE_FIXED_STRUCTURE`.
 *
 * The dropped record is NOT recovered: the frame's resume cursor has advanced past it when the close
 * fires, which is harper-pro#545's skip-and-advance disposition. And COPY frames must not trigger it — a
 * copy stages its cursor from the last SUCCESSFULLY decoded record, so closing after a dropped copy record
 * would resume before it and re-deliver the same poison record forever. The base copy here carries a
 * poison record so that exclusion is exercised rather than assumed.
 *
 * Stress-gated (spawns two Harper child processes) like the other cluster tests.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog, readNodePid, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';
const DB = 'data';
const TABLE = 'ResyncTest';
const POISON_PREFIX = 'poison-';
const CONVERGE_TIMEOUT_MS = 120_000;
const POLL_MS = 500;

function nodeConfig(hostname, env) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, console: true, level: 'debug' },
			replication: { securePort: hostname + ':9933', databases: [DB] },
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
	};
}

async function hasRow(node, id) {
	try {
		const result = await sendOperation(node, {
			operation: 'search_by_hash',
			database: DB,
			table: TABLE,
			hash_values: [id],
			get_attributes: ['id'],
		});
		return Array.isArray(result) && result.length === 1;
	} catch {
		return false;
	}
}

function resyncCount(log) {
	return (log.match(/Resubscribing to .* to resync table structures/g) ?? []).length;
}

suite('Decode-drop structure resync (harper-pro#810)', { skip: !STRESS, timeout: 420_000 }, (ctx) => {
	before(async () => {
		const sourceHost = await getNextAvailableLoopbackAddress();
		const receiverHost = await getNextAvailableLoopbackAddress();

		const sourceCtx = { name: ctx.name, harper: { hostname: sourceHost } };
		await startHarper(sourceCtx, nodeConfig(sourceHost));
		ctx.source = sourceCtx.harper;

		const receiverCtx = { name: ctx.name, harper: { hostname: receiverHost } };
		await startHarper(receiverCtx, nodeConfig(receiverHost, { HARPER_TEST_DECODE_FAIL_RECORD_PREFIX: POISON_PREFIX }));
		ctx.receiver = receiverCtx.harper;

		for (const node of [ctx.source, ctx.receiver]) {
			await sendOperation(node, {
				operation: 'create_table',
				database: DB,
				table: TABLE,
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'v', type: 'String' },
				],
			});
		}
		// Seeded BEFORE the join, so these travel in the base copy — including a poison record, which the
		// copy exclusion must leave alone.
		await sendOperation(ctx.source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [
				{ id: 'copied-1', v: 'a' },
				{ id: POISON_PREFIX + 'copy', v: 'undecodable in the copy' },
				{ id: 'copied-2', v: 'b' },
			],
		});
	});

	after(async () => {
		for (const node of [ctx.source, ctx.receiver].filter(Boolean)) {
			await teardownHarper({ harper: node }).catch(() => {});
		}
	});

	test('a copy-frame drop does not resubscribe, and a live drop does — then the table keeps flowing', async () => {
		// Pinned so the resubscribe assertion below cannot be satisfied by a crashed-and-restarted worker:
		// a process that died in the error-handling path would also reconnect and resync.
		const receiverPidBefore = await readNodePid(ctx.receiver);
		await sendOperation(ctx.receiver, {
			operation: 'add_node',
			hostname: ctx.source.hostname,
			port: 9933,
			isLeader: true,
			rejectUnauthorized: false,
			authorization: ctx.source.admin,
		});
		await waitForCondition(() => hasRow(ctx.receiver, 'copied-2'), {
			timeoutMs: CONVERGE_TIMEOUT_MS,
			pollMs: POLL_MS,
			description: 'the base copy to land past its poison record',
		});
		equal(await hasRow(ctx.receiver, POISON_PREFIX + 'copy'), false, 'the copied poison record is skipped');
		equal(
			resyncCount(await readLog(ctx.receiver)),
			0,
			'a copy-frame drop must NOT resubscribe: the copy cursor would resume before the poison record'
		);

		// Now the live (non-copy) path, which is where a structure fork would otherwise silence the table.
		await sendOperation(ctx.source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: POISON_PREFIX + 'live', v: 'undecodable in a live frame' }],
		});
		await waitForCondition(async () => resyncCount(await readLog(ctx.receiver)) >= 1, {
			timeoutMs: CONVERGE_TIMEOUT_MS,
			pollMs: POLL_MS,
			description: 'the receiver to force one resubscribe after the live decode drop',
		});

		// The leg converges afterwards — the resubscribe is a repair, not a new wedge.
		await sendOperation(ctx.source, {
			operation: 'insert',
			database: DB,
			table: TABLE,
			records: [{ id: 'after-resync', v: 'live' }],
		});
		await waitForCondition(() => hasRow(ctx.receiver, 'after-resync'), {
			timeoutMs: CONVERGE_TIMEOUT_MS,
			pollMs: POLL_MS,
			description: 'a live write after the resync to replicate',
		});

		const log = await readLog(ctx.receiver);
		equal(await hasRow(ctx.receiver, POISON_PREFIX + 'live'), false, 'the dropped record is not re-delivered');
		ok(resyncCount(log) <= 2, `at most one resubscribe per dropped frame, saw ${resyncCount(log)}`);
		// The recovery must be the resubscribe, not a crash: same process throughout, and nothing escaped
		// the decode path as an unhandled error.
		equal(await readNodePid(ctx.receiver), receiverPidBefore, 'the receiver must not have restarted');
		equal(/uncaughtException|ReferenceError/.test(log), false, 'no unhandled error may escape the decode path');
	});
});
