/**
 * A first base copy closed mid-blob before it banks a copy cursor leaves the record's row committed
 * on a PENDING blob stub. The reconnect has no cursor, so it is another full copy that re-sends the
 * record at the same version from the same node; core's copy-apply skips that write, so only the
 * receiver's in-place repair can stream the re-sent bytes into the stub, so it must run on a copy
 * with no resume cursor too.
 *
 * A's fixture stalls the send of record 0's blob after its first payload KiB, so B's receive of the
 * lowest walk position stays in flight and nothing can bank. Stopping A closes the link mid-receive.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
	startHarper,
	teardownHarper,
	setupHarperWithFixture,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import {
	sendOperation,
	postOperation,
	readLog,
	replicationPoolOffEnv,
	restartNode,
	stopNodeProcess,
	waitForCondition,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const BLOB_RECORDS = 10;
const BLOB_BYTES = 50 * 1024;
const STALL_FIXTURE = join(import.meta.dirname, 'fixture-blob-stall-source');

// Mirrors fixture-large-blob-deterministic/resources.js.
function expectedPayloadHash(id) {
	const seed = Number(id) | 0;
	const hash = createHash('sha1');
	for (let c = 0; c < 50; c++) {
		const buf = Buffer.allocUnsafe(1024);
		for (let i = 0; i < 1024; i++) buf[i] = (seed * 131 + c * 31 + i) & 0xff;
		hash.update(buf);
	}
	return hash.digest('hex');
}

async function readImage(node, id, signal) {
	const response = await fetch(node.httpURL + '/LargeLocationImage/' + id, { signal });
	return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function damagedPayloadIds(node, signal) {
	const damaged = [];
	for (let id = 0; id < BLOB_RECORDS; id++) {
		const { status, bytes } = await readImage(node, id, signal).catch((error) => {
			if (signal.aborted) throw error;
			return { status: `error ${error.message}`, bytes: Buffer.alloc(0) };
		});
		if (status !== 200) damaged.push(`${id}:status=${status}`);
		else if (bytes.length !== BLOB_BYTES || createHash('sha1').update(bytes).digest('hex') !== expectedPayloadHash(id))
			damaged.push(`${id}:bytes=${bytes.length}`);
	}
	return damaged;
}

const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, console: true, level: 'warn' },
	replication: { securePort: host + ':9933' },
});

suite('Cursorless copy re-delivery repairs a blob aborted mid-receive', { timeout: 600000 }, (ctx) => {
	const armFile = join(tmpdir(), `blob-stall-arm-${process.pid}-${Date.now()}`);
	// Pool off on A: the stalled read must be on the thread that sends the copy, where the fixture is loaded.
	const sourceOptions = (host) => ({
		config: sharedConfig(host),
		env: { ...replicationPoolOffEnv(), HARPER_TEST_BLOB_STALL_ARM_FILE: armFile, HARPER_TEST_BLOB_STALL_RECORD: '0' },
	});

	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		// A deploys the stall fixture rather than starting from it: a node started from a fixture does not
		// listen on its replication port.
		await startHarper(nodeA, sourceOptions(nodeA.harper.hostname));
		await setupHarperWithFixture(nodeB, STALL_FIXTURE, { config: sharedConfig(nodeB.harper.hostname) });
		ctx.nodes = [nodeA.harper, nodeB.harper];

		const [A] = ctx.nodes;
		for (const [project, path] of [
			['large-blob-deterministic', join(import.meta.dirname, 'fixture-large-blob-deterministic')],
			['blob-stall-source', STALL_FIXTURE],
		])
			await sendOperation(A, { operation: 'deploy_component', project, payload: await targz(path), restart: false });
		await restartNode(A);
		// Seeded in commit order, one GET per id, so the copy's post-walk log tail re-delivers nothing
		// (see copyGapCursorBanking.test.mjs).
		const seededCount = async (signal) =>
			(
				await sendOperation(
					A,
					{ operation: 'describe_table', table: 'LargeLocation', exact_count: true },
					{ signal }
				).catch(() => ({}))
			).record_count;
		await waitForCondition(
			async (signal) => {
				if (!Number.isInteger(await seededCount(signal))) return false;
				const response = await fetch(A.httpURL + '/', { signal }).catch(() => null);
				const bodyRead = await response?.arrayBuffer().then(
					() => true,
					() => false
				);
				return bodyRead && response.status < 500;
			},
			{ timeoutMs: 60000, description: "A's operations and HTTP servers after the deploy restart" }
		);
		for (let id = 0; id < BLOB_RECORDS; id++) {
			const response = await fetch(A.httpURL + '/LargeLocation/' + id, { signal: AbortSignal.timeout(30000) });
			await response.arrayBuffer();
			ok(response.ok, `seed GET of LargeLocation/${id} failed: HTTP ${response.status}`);
			await waitForCondition(async (signal) => (await seededCount(signal)) > id, {
				timeoutMs: 30000,
				pollMs: 100,
				description: `the seed of LargeLocation/${id} to commit`,
			});
		}
		ok(
			(await readLog(A)).includes('[blob-stall-source] installed'),
			'stall fixture did not load on A — the test would not exercise the failure path'
		);
	});

	after(async () => {
		if (ctx.nodes) {
			await stopNodeProcess(ctx.nodes[0]).catch(() => null);
			await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
		}
	});

	test('the reconnect full copy heals the PENDING stub in place', async () => {
		const [A, B] = ctx.nodes;
		const tokenResp = await sendOperation(A, { operation: 'create_authentication_tokens', authorization: A.admin });
		writeFileSync(armFile, '');
		let addNode;
		// A's replication listener can come up after its operations API following the deploy restart.
		await waitForCondition(
			async (signal) =>
				(addNode = await postOperation(
					B,
					{
						operation: 'add_node',
						rejectUnauthorized: false,
						hostname: A.hostname,
						authorization: 'Bearer ' + tokenResp.operation_token,
					},
					{ signal }
				)).status === 200,
			{
				timeoutMs: 60000,
				pollMs: 1000,
				description: () => `add_node to succeed (last: ${JSON.stringify(addNode?.body)})`,
			}
		);

		let bCount = 0;
		await waitForCondition(
			async (signal) => {
				bCount =
					(
						await sendOperation(B, { operation: 'describe_table', table: 'LargeLocation' }, { signal }).catch(
							() => ({})
						)
					).record_count ?? 0;
				return bCount >= BLOB_RECORDS && (await readLog(A)).includes('[blob-stall-source] stall engaged for record 0');
			},
			{ timeoutMs: 120000, description: () => `B's first copy to deliver every row (${bCount}) with record 0 stalled` }
		);

		await stopNodeProcess(A);
		let stub;
		await waitForCondition(
			async (signal) => {
				stub = await readImage(B, 0, signal);
				return stub.status === 503 && /pending replication/.test(stub.bytes.toString());
			},
			{
				timeoutMs: 60000,
				description: () => `record 0 on B to read as a PENDING stub (last: ${stub?.status} ${stub?.bytes})`,
			}
		);

		ctx.nodes[0] = (await startHarper({ name: ctx.name, harper: A }, sourceOptions(A.hostname))).harper;
		let damaged = [];
		await waitForCondition(async (signal) => (damaged = await damagedPayloadIds(B, signal)).length === 0, {
			timeoutMs: 180000,
			pollMs: 2000,
			description: () =>
				`every record's blob to read in full on B after the cursorless re-copy (damaged: [${damaged}])`,
		});

		const bLog = await readLog(B);
		const fullCopyRequests = (bLog.match(/Requesting full copy of database data /g) ?? []).length;
		ok(fullCopyRequests >= 2, `the reconnect did not request a second full copy (${fullCopyRequests} requests)`);
		equal(
			(bLog.match(/Resuming interrupted copy of database data /g) ?? []).length,
			0,
			'a reconnect resumed from a copy cursor — the copy was not cursorless'
		);
		ok(bLog.includes('Repaired blob file in place'), 'the stub was not repaired in place');
	});
});
