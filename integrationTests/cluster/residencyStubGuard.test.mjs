/**
 * A base copy never presents an INVALIDATED residency stub as a complete record (HarperFast/harper#2257).
 *
 * This is the half of the residency handoff that holds on today's core: when A has written a record out of
 * its own residency it keeps an index-only stub, and a resident peer rebuilt from nothing must not receive
 * that stub relabelled as a complete `put`. On the unfixed sender the rebuilt B ends up holding
 * `{ home: B }` as the whole record; here it must hold nothing complete for it. The full handoff (image
 * delivery, receipts, release) is `residencyHandoff.test.mjs` and needs the companion core change.
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

const FIXTURE = resolve(import.meta.dirname ?? module.path, 'fixture-residency-handoff');
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

	test('a resident rebuilt from nothing does not receive the origin’s stub as a complete record', async () => {
		const { A } = ctx;
		await sendOperation(A, {
			operation: 'upsert',
			database: 'data',
			table: TABLE,
			records: [
				{ id: 'moved', home: A.hostname, name: 'kept', size: 7 },
				{ id: 'zz-control', name: 'control' },
			],
		});
		await waitForProbe(ctx.B, 'moved', (state) => state.present && state.invalidated, 'B holds the non-resident stub');
		await waitForProbe(
			ctx.B,
			'zz-control',
			(state) => state.present && !state.invalidated,
			'B holds the control record'
		);

		await killHarper({ harper: ctx.B }, { graceMs: 0 });
		const patched = await fetch(`${A.httpURL}/${TABLE}/moved`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ home: ctx.B.hostname }),
		});
		ok(patched.ok, `PATCH on A returned ${patched.status}`);
		const onA = await probe(A, 'moved');
		ok(
			onA.present && onA.invalidated,
			`A must hold an INVALIDATED stub after writing itself out, saw ${JSON.stringify(onA)}`
		);

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
