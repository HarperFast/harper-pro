/**
 * Record-based residency transition handoff (HarperFast/harper#2257).
 *
 * A patch that moves a `Homed` record from A to B leaves A with an INVALIDATED index-only stub. B must
 * end up with the COMPLETE record — including the fields the patch did not touch — even when B is down
 * at the time of the write, and A must keep the complete transition image until B has durably stored
 * that version or a newer one. A later B-side patch and a transition back to A must never promote a
 * stub or an obsolete image into a complete row, and a base copy to a resident (B rebuilt from nothing)
 * must deliver the image, never the stub.
 *
 * Needs the companion core change (HarperFast/harper#2257): on a core that does not retain transition
 * images every test here skips with that reason, so the guard half (`residencyStubGuard.test.mjs`) is
 * what runs against today's core.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
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

async function readRecord(node, id, signal) {
	const response = await fetch(`${node.httpURL}/${TABLE}/${id}`, { headers: { Accept: 'application/json' }, signal });
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`${TABLE}/${id} on ${node.hostname} returned ${response.status}`);
	return response.json();
}

async function patchRecord(node, id, patch) {
	const response = await fetch(`${node.httpURL}/${TABLE}/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(patch),
	});
	ok(response.ok, `PATCH ${TABLE}/${id} on ${node.hostname} returned ${response.status}`);
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

const isComplete = (expected) => (state) =>
	state.present && !state.invalidated && expected.every(([key, value]) => state.value?.[key] === value);

const isStub = (state) => state.present && state.invalidated;

async function startNode(ctx, role, hostname, dataRootDir) {
	await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true });
	const nodeCtx = { name: ctx.name, harper: { hostname, dataRootDir } };
	await startHarper(nodeCtx, nodeConfig(hostname));
	ctx[role] = nodeCtx.harper;
	ctx.dataRootDirs[role] = dataRootDir;
	return nodeCtx.harper;
}

suite('Record-based residency transitions hand off the complete record (harper#2257)', { timeout: 600000 }, (ctx) => {
	before(async () => {
		ctx.dataRootDirs = {};
		const [hostA, hostB] = await Promise.all([getNextAvailableLoopbackAddress(), getNextAvailableLoopbackAddress()]);
		const [dirA, dirB] = await Promise.all([
			mkdtemp(join(tmpdir(), 'harper-integration-test-')),
			mkdtemp(join(tmpdir(), 'harper-integration-test-')),
		]);
		await Promise.all([startNode(ctx, 'A', hostA, dirA), startNode(ctx, 'B', hostB, dirB)]);
		await addLeader(ctx.B, ctx.A);
		const support = await probe(ctx.A, 'core-support-probe');
		ctx.skipReason = support.pendingSupported
			? undefined
			: 'core does not retain residency transition images: needs the companion HarperFast/harper#2257 core change';
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
		if (errors.length) throw new AggregateError(errors, 'Failed to tear down residency-handoff nodes');
	});

	test('a transition patch written while the new resident is down is delivered complete on reconnect and released only after it lands', async (t) => {
		if (ctx.skipReason) return t.skip(ctx.skipReason);
		const { A } = ctx;
		const id = 'moved-while-down';
		await sendOperation(A, {
			operation: 'upsert',
			database: 'data',
			table: TABLE,
			records: [{ id, home: A.hostname, name: 'kept', size: 7 }],
		});
		await waitForProbe(ctx.B, id, isStub, 'B holds the non-resident stub for the seed');

		await killHarper({ harper: ctx.B }, { graceMs: 0 });
		await patchRecord(A, id, { home: ctx.B.hostname, note: 'moved' });

		const onA = await probe(A, id);
		ok(onA.invalidated, `A must hold an INVALIDATED stub after the transition, saw ${JSON.stringify(onA)}`);
		equal(onA.value?.name, undefined, 'the stub carries no unindexed fields');
		ok(onA.pendingSupported, 'core exposes the pending transition images');
		equal(
			onA.pending.length,
			1,
			`A must retain one pending transition image while B is down, saw ${JSON.stringify(onA)}`
		);
		const transitionVersion = onA.version;

		const restarted = await startNode(ctx, 'B', ctx.B.hostname, ctx.dataRootDirs.B);
		const onB = await waitForProbe(
			restarted,
			id,
			isComplete([
				['name', 'kept'],
				['size', 7],
				['note', 'moved'],
				['home', restarted.hostname],
			]),
			'B receives the complete record including the fields the patch did not touch'
		);
		ok(
			onB.version >= transitionVersion,
			`B must store the transition version or newer (${onB.version} < ${transitionVersion})`
		);

		await waitForProbe(A, id, (state) => state.pending.length === 0, 'A releases the transition image once B has it');
		const stillOnA = await probe(A, id);
		ok(stillOnA.invalidated, 'releasing the image leaves the stub in place');
		deepEqual(await readRecord(A, id), { id, home: restarted.hostname, name: 'kept', size: 7, note: 'moved' });
	});

	test('a later patch on the new resident and a transition back never promote a stub or an obsolete image', async (t) => {
		if (ctx.skipReason) return t.skip(ctx.skipReason);
		const { A, B } = ctx;
		const id = 'moved-while-down';
		await patchRecord(B, id, { note: 'edited on B' });
		await waitForProbe(A, id, (state) => isStub(state) && state.pending.length === 0, 'A keeps its stub current');
		deepEqual(await readRecord(A, id), { id, home: B.hostname, name: 'kept', size: 7, note: 'edited on B' });

		await patchRecord(B, id, { home: A.hostname });
		await waitForProbe(
			A,
			id,
			isComplete([
				['name', 'kept'],
				['size', 7],
				['note', 'edited on B'],
				['home', A.hostname],
			]),
			'A becomes the complete resident again'
		);
		await waitForProbe(
			B,
			id,
			(state) => isStub(state) && state.pending.length === 0,
			'B releases its image once A has it'
		);
		deepEqual(await readRecord(B, id), { id, home: A.hostname, name: 'kept', size: 7, note: 'edited on B' });
	});

	test('a resident rebuilt from nothing receives the retained image from the base copy, never the stub', async (t) => {
		if (ctx.skipReason) return t.skip(ctx.skipReason);
		const { A } = ctx;
		const id = 'moved-then-rebuilt';
		await sendOperation(A, {
			operation: 'upsert',
			database: 'data',
			table: TABLE,
			records: [{ id, home: A.hostname, name: 'copied', size: 11 }],
		});
		await waitForProbe(ctx.B, id, isStub, 'B holds the non-resident stub for the second seed');

		await killHarper({ harper: ctx.B }, { graceMs: 0 });
		await patchRecord(A, id, { home: ctx.B.hostname });
		const onA = await probe(A, id);
		ok(
			onA.invalidated && onA.pending.length === 1,
			`A retains the image for the rebuilt resident, saw ${JSON.stringify(onA)}`
		);

		await teardownHarper({ harper: ctx.B }).catch(() => {});
		await rm(ctx.dataRootDirs.B, { recursive: true, force: true });
		// startNode reassigns ctx.B to the rebuilt node below; the suite's after() hook tears that
		// node down through teardownHarper, which removes ctx.harper.dataRootDir itself
		const freshDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
		const rebuilt = await startNode(ctx, 'B', ctx.B.hostname, freshDir);
		await addLeader(rebuilt, A);

		await waitForProbe(
			rebuilt,
			id,
			isComplete([
				['name', 'copied'],
				['size', 11],
				['home', rebuilt.hostname],
			]),
			'the base copy delivers the complete image to the rebuilt resident'
		);
		await waitForProbe(A, id, (state) => state.pending.length === 0, 'A releases the image after the base copy lands');

		// The first record's only complete copy lived on the B we just erased; A's stub must not be copied
		// back as a complete row.
		const lost = await probe(rebuilt, 'moved-while-down');
		ok(!(lost.present && !lost.invalidated), `the base copy must not promote A's stub, saw ${JSON.stringify(lost)}`);
	});
});
