/**
 * A base copy never presents an INVALIDATED residency stub as a complete record (HarperFast/harper#2257).
 *
 * B writes a record homed on B, so A holds only an index-only stub of it. When B is rebuilt from nothing,
 * A's base copy must not hand B that stub relabelled as a complete `put`: on the unfixed sender the rebuilt
 * B ends up holding `{ home: B }` as the whole record.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import {
	killHarper,
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
} from '@harperfast/integration-testing';
import { sendOperation, stopNodeProcess, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = resolve(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const FIXTURE = resolve(import.meta.dirname ?? module.path, 'fixture-residency-stub');
const TABLE = 'Homed';
const CONVERGE_TIMEOUT_MS = 90000;

const nodeConfig = (hostname) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true },
		replication: { port: hostname + ':9933', securePort: null, databases: ['data'] },
	},
	env: { HARPER_NO_FLUSH_ON_EXIT: true },
});

const addLeader = (node, leader) =>
	sendOperation(node, {
		operation: 'add_node',
		hostname: leader.hostname,
		rejectUnauthorized: false,
		authorization: leader.admin,
		isLeader: true,
	});

async function probe(node, id, signal) {
	const response = await fetch(`${node.httpURL}/HomedProbe/${id}`, { headers: { Accept: 'application/json' }, signal });
	if (!response.ok) throw new Error(`HomedProbe/${id} on ${node.hostname} returned ${response.status}`);
	return response.json();
}

function waitForProbe(node, id, predicate, what) {
	let last;
	return waitForCondition(
		async (signal) => {
			try {
				last = await probe(node, id, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				last = { unreachable: error.message };
				return false;
			}
			return predicate(last) ? last : false;
		},
		{ timeoutMs: CONVERGE_TIMEOUT_MS, description: () => `${what}; last saw ${JSON.stringify(last)}` }
	);
}

async function startNode(ctx, role, hostname, dataRootDir) {
	await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true });
	const nodeCtx = { name: ctx.name, harper: { hostname, dataRootDir } };
	await startHarper(nodeCtx, nodeConfig(hostname));
	ctx[role] = nodeCtx.harper;
	ctx.dataRootDirs[role] = dataRootDir;
	return nodeCtx.harper;
}

suite('A base copy never promotes an INVALIDATED residency stub (harper#2257)', { timeout: 480000 }, (ctx) => {
	before(async () => {
		ctx.dataRootDirs = {};
		const [hostA, hostB] = await Promise.all([getNextAvailableLoopbackAddress(), getNextAvailableLoopbackAddress()]);
		const [dirA, dirB] = await Promise.all([
			mkdtemp(join(tmpdir(), 'harper-integration-test-')),
			mkdtemp(join(tmpdir(), 'harper-integration-test-')),
		]);
		await Promise.all([startNode(ctx, 'A', hostA, dirA), startNode(ctx, 'B', hostB, dirB)]);
		await addLeader(ctx.B, ctx.A);
	});

	after(async () => {
		const errors = [];
		for (const role of ['A', 'B']) {
			const node = ctx[role];
			if (!node) continue;
			try {
				await stopNodeProcess(node);
			} catch (error) {
				errors.push(new Error(`Failed to stop ${role}`, { cause: error }));
			}
			try {
				await teardownHarper({ harper: node });
			} catch (error) {
				errors.push(new Error(`Failed to tear down ${role}`, { cause: error }));
			}
		}
		if (errors.length) throw new AggregateError(errors, 'Failed to tear down residency-stub-guard nodes');
	});

	test('a resident rebuilt from nothing does not receive a peer’s stub as a complete record', async () => {
		const { A, B } = ctx;
		await sendOperation(B, {
			operation: 'upsert',
			database: 'data',
			table: TABLE,
			records: [
				{ id: 'moved', home: B.hostname, name: 'kept', size: 7 },
				{ id: 'zz-control', name: 'control' },
			],
		});
		await waitForProbe(A, 'moved', (state) => state.present && state.invalidated, 'A holds the non-resident stub');
		await waitForProbe(A, 'zz-control', (state) => state.present && !state.invalidated, 'A holds the control record');

		await killHarper({ harper: ctx.B }, { graceMs: 0 });
		await teardownHarper({ harper: ctx.B }).catch(() => {});
		await rm(ctx.dataRootDirs.B, { recursive: true, force: true });
		const rebuilt = await startNode(
			ctx,
			'B',
			ctx.B.hostname,
			await mkdtemp(join(tmpdir(), 'harper-integration-test-'))
		);
		await addLeader(rebuilt, A);
		await waitForProbe(
			rebuilt,
			'zz-control',
			(state) => state.present && !state.invalidated,
			'the base copy reaches the rebuilt B'
		);

		// The copy walks the table in key order and 'zz-control' sorts after 'moved', so the stub's fate is already decided.
		const onB = await probe(rebuilt, 'moved');
		ok(
			!(onB.present && !onB.invalidated),
			`the base copy must not hand the rebuilt resident A's stub as a complete record, saw ${JSON.stringify(onB)}`
		);
	});
});
