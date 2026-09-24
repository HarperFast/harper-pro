/**
 * An echoed delete run (harper-pro#826; replication/DESIGN.md item 20) is repaired offline and no longer
 * re-logs on the receiver. The fixture plants the log state older releases left on A while B is offline,
 * so B resumes from a cursor below both runs — a connected B's cursor would already be past them:
 *  - `z` × 20,000 under z's delete key, far above A's 256 KiB cap: one frame no sender can ship. A is
 *    stopped and repaired with dist/bin/repairDeleteEchoRuns.js; otherwise the later marker never reaches B.
 *  - `[x, y]` × 40 under their shared delete key, planted after the repair and below the cap, so B receives
 *    all 82 in one frame. B's apply must log one delete per record.
 */
import { suite, test, before, after } from 'node:test';
import { equal, match } from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
	killHarper,
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { sendOperation, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = resolve(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const FIXTURE = resolve(import.meta.dirname ?? module.path, 'fixture-delete-echo-run');
const REPAIR_TOOL = resolve(import.meta.dirname ?? module.path, '..', '..', 'dist', 'bin', 'repairDeleteEchoRuns.js');
const TABLE = 'EchoTarget';
const MAX_PAYLOAD = 256 * 1024;
const Z_COPIES = 20_000;
const XY_ROUNDS = 40;

const nodeConfig = (hostname) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true },
		replication: { port: hostname + ':9933', securePort: null, databases: ['data'], maxPayload: MAX_PAYLOAD },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

async function fixtureRequest(node, path, init) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		...init,
		headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...init?.headers },
	});
	if (!response.ok)
		throw new Error(`${path} on ${node.hostname} returned ${response.status}: ${await response.text()}`);
	return response.json();
}

const deleteEntryCount = async (node, id) => (await fixtureRequest(node, `DeleteEntries/${id}`)).count;

function runRepairTool(...args) {
	const result = spawnSync(process.execPath, [REPAIR_TOOL, ...args], { encoding: 'utf8', timeout: 120000 });
	equal(result.status, 0, `repair tool ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

async function hasRecord(node, id, signal) {
	const rows = await sendOperation(
		node,
		{ operation: 'search_by_id', database: 'data', table: TABLE, ids: [id], get_attributes: ['id'] },
		{ signal }
	);
	return rows.length > 0;
}

// while a node is still coming up, an unanswered probe means "not yet"
const eventuallyHasRecord = (node, id) => (signal) =>
	hasRecord(node, id, signal).catch((error) => {
		if (signal.aborted) throw error;
		return false;
	});

suite(
	'An echoed delete run neither wedges the sender nor re-logs on the receiver (harper-pro#826)',
	{ timeout: 300000 },
	(ctx) => {
		before(async () => {
			const hostnames = await Promise.all([getNextAvailableLoopbackAddress(), getNextAvailableLoopbackAddress()]);
			const dataRootDirs = await Promise.all(hostnames.map(() => mkdtemp(join(tmpdir(), 'harper-integration-test-'))));
			await Promise.all(
				dataRootDirs.map((dataRootDir) =>
					cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true })
				)
			);
			const contexts = hostnames.map((hostname, i) => ({
				name: ctx.name,
				harper: { hostname, dataRootDir: dataRootDirs[i] },
			}));
			await Promise.all(contexts.map((nodeCtx, i) => startHarper(nodeCtx, nodeConfig(hostnames[i]))));
			[ctx.A, ctx.B] = contexts.map((nodeCtx) => nodeCtx.harper);
			ctx.rootOfA = dataRootDirs[0];

			await sendOperation(ctx.B, {
				operation: 'add_node',
				hostname: ctx.A.hostname,
				rejectUnauthorized: false,
				authorization: ctx.A.admin,
				isLeader: true,
			});
			await sendOperation(ctx.A, {
				operation: 'upsert',
				database: 'data',
				table: TABLE,
				records: ['x', 'y', 'z'].map((id) => ({ id, name: id })),
			});
			await waitForCondition(
				async (signal) =>
					(await eventuallyHasRecord(ctx.B, 'z')(signal)) && (await eventuallyHasRecord(ctx.B, 'x')(signal)),
				{
					timeoutMs: 90000,
					description: 'the seed rows reach B',
				}
			);
		});

		after(async () => {
			await Promise.all([ctx.A, ctx.B].filter(Boolean).map((node) => teardownHarper({ harper: node })));
		});

		test('B catches up past both runs and logs one delete per record', async () => {
			await killHarper({ harper: ctx.B });

			// Each delete is planted straight after it commits, so its copies follow it under the same key.
			await sendOperation(ctx.A, { operation: 'delete', database: 'data', table: TABLE, ids: ['z'] });
			await fixtureRequest(ctx.A, 'PlantDeleteRun', {
				method: 'POST',
				body: JSON.stringify({ ids: ['z'], copies: Z_COPIES }),
			});
			equal(await deleteEntryCount(ctx.A, 'z'), Z_COPIES + 1, 'premise: A holds the planted run');

			await killHarper({ harper: ctx.A });
			match(runRepairTool(ctx.rootOfA), new RegExp(`log local: .* would drop ${Z_COPIES} echoed deletes`));
			match(runRepairTool(ctx.rootOfA, '--apply'), new RegExp(`log local: .* dropped ${Z_COPIES} echoed deletes`));
			ctx.A = (await startHarper({ harper: ctx.A }, nodeConfig(ctx.A.hostname))).harper;
			const { A } = ctx;
			equal(await deleteEntryCount(A, 'z'), 1, 'the repair kept one z delete');
			equal(await hasRecord(A, 'z'), false, 'z is still deleted on A after the repair and restart');

			await sendOperation(A, { operation: 'delete', database: 'data', table: TABLE, ids: ['x', 'y'] });
			await fixtureRequest(A, 'PlantDeleteRun', {
				method: 'POST',
				body: JSON.stringify({ ids: ['x', 'y'], copies: XY_ROUNDS }),
			});
			await sendOperation(A, {
				operation: 'upsert',
				database: 'data',
				table: TABLE,
				records: [{ id: 'marker', name: 'marker' }],
			});
			equal(await deleteEntryCount(A, 'x'), XY_ROUNDS + 1, 'premise: A holds the planted run');

			ctx.B = (await startHarper({ harper: ctx.B }, nodeConfig(ctx.B.hostname))).harper;
			const { B } = ctx;
			await waitForCondition(eventuallyHasRecord(B, 'marker'), {
				timeoutMs: 90000,
				description: 'the write after the runs reaches B',
			});
			for (const id of ['x', 'y', 'z']) {
				equal(await hasRecord(B, id), false, `${id} is deleted on B`);
				equal(await deleteEntryCount(B, id), 1, `B logs one delete for ${id}`);
			}
		});
	}
);
