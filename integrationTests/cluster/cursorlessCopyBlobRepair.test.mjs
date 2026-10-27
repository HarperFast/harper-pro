/**
 * In-place blob repair on a cursorless copy re-delivery.
 *
 * A first base copy closed mid-blob before it banks any copy cursor leaves the record's row committed
 * and its blob file stamped PENDING (the close path aborts the in-flight receive). The reconnect has
 * no cursor, so it is another full copy, which re-sends the record at the same version from the same
 * node. Core's copy-apply skips that same-version write, so only the receiver's in-place repair can
 * stream the re-sent bytes into the stub; before this fix it ran only on a cursor resume or a
 * same-socket copy restart, and the blob stayed PENDING forever.
 *
 * Setup: A seeds file-backed blob records, then B joins (add_node → cursorless base copy A→B). B's
 * injector holds record 0's first blob save open, so the copy cannot bank a cursor (nothing below
 * record 0 is durable). The test then restarts A, which closes the link with that receive in flight.
 *
 * Oracles: every reconnect requested a full copy and none resumed from a cursor (the precondition),
 * the stub was repaired in place, and every record on B serves its exact bytes.
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
	startHarper,
	teardownHarper,
	setupHarperWithFixture,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import {
	sendOperation,
	fetchWithRetry,
	readLog,
	replicationPoolOffEnv,
	restartNode,
	stopNodeProcess,
	waitForCondition,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const BLOB_RECORDS = 10; // /LargeLocation/{n} on A — each a deterministic ~50 KB file-backed blob
const BLOB_BYTES = 50 * 1024;
const HELD_SAVE = '0:1';

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

async function damagedPayloadIds(node) {
	const damaged = [];
	for (let id = 0; id < BLOB_RECORDS; id++) {
		try {
			const response = await fetchWithRetry(node.httpURL + '/LargeLocationImage/' + id, { retries: 3 });
			if (!response.ok) {
				damaged.push(`${id}:status=${response.status}`);
				continue;
			}
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.length !== BLOB_BYTES || createHash('sha1').update(bytes).digest('hex') !== expectedPayloadHash(id)) {
				damaged.push(`${id}:bytes=${bytes.length}`);
			}
		} catch (error) {
			damaged.push(`${id}:error=${error?.message ?? error}`);
		}
	}
	return damaged;
}

const sharedConfig = (host) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, console: true, level: 'warn' },
	replication: { securePort: host + ':9933' },
});

suite('Cursorless copy re-delivery repairs a blob aborted mid-receive', { timeout: 600000 }, (ctx) => {
	before(async () => {
		const nodeA = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		const nodeB = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
		await startHarper(nodeA, { config: sharedConfig(nodeA.harper.hostname) });
		await setupHarperWithFixture(nodeB, join(import.meta.dirname, 'fixture-blob-fail-slow-injector'), {
			config: sharedConfig(nodeB.harper.hostname),
			// Pool off on B: its receiving sockets must be on the HTTP workers, where the injector is loaded.
			env: { ...replicationPoolOffEnv(), HARPER_TEST_BLOB_HOLD_SAVES: HELD_SAVE },
		});
		ctx.nodes = [nodeA.harper, nodeB.harper];

		const payload = await targz(join(import.meta.dirname, 'fixture-large-blob-deterministic'));
		await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project: 'large-blob-deterministic',
			payload,
			restart: false,
		});
		await restartNode(ctx.nodes[0]);
		// Seeded in commit order, one GET per id, so the copy's post-walk log tail re-delivers nothing
		// (see copyGapCursorBanking.test.mjs).
		const [A] = ctx.nodes;
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
			(await readLog(ctx.nodes[1])).includes('[blob-fail-slow-injector] installed'),
			'fault injector did not load on B — the test would not exercise the failure path'
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
		const armResponse = await fetchWithRetry(B.httpURL + '/ArmBlobFaultInjector');
		ok(armResponse.ok, `fault injector did not arm: HTTP ${armResponse.status}`);
		await sendOperation(B, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: A.hostname,
			authorization: 'Bearer ' + tokenResp.operation_token,
		});

		// The first copy walks every row while record 0's blob receive stays in flight.
		let bCount = 0;
		await waitForCondition(
			async (signal) => {
				bCount =
					(
						await sendOperation(B, { operation: 'describe_table', table: 'LargeLocation' }, { signal }).catch(
							() => ({})
						)
					).record_count ?? 0;
				return bCount >= BLOB_RECORDS && (await readLog(B)).includes(`holding save ${HELD_SAVE}`);
			},
			{ timeoutMs: 120000, description: () => `B's first copy to deliver every row (${bCount}) with the held save` }
		);
		const firstCopyLog = await readLog(B);
		ok(
			!/Resuming interrupted copy of database data /.test(firstCopyLog),
			'B resumed from a copy cursor before the close — the first copy was not cursorless'
		);

		await restartNode(A);

		let damaged = [];
		let bLog = '';
		const deadline = Date.now() + 180000;
		while (Date.now() < deadline) {
			bLog = await readLog(B);
			if ((damaged = await damagedPayloadIds(B)).length === 0) break;
			await delay(2000);
		}
		const fullCopyRequests = (bLog.match(/Requesting full copy of database data /g) ?? []).length;
		const cursorResumes = (bLog.match(/Resuming interrupted copy of database data /g) ?? []).length;
		const inPlaceRepairs = (bLog.match(/Repaired blob file in place/g) ?? []).length;
		console.log(
			`cursorless repair test: fullCopyRequests=${fullCopyRequests} cursorResumes=${cursorResumes} ` +
				`inPlaceRepairs=${inPlaceRepairs} damaged=[${damaged}]`
		);

		ok(fullCopyRequests >= 2, `the reconnect did not request a second full copy (${fullCopyRequests} requests)`);
		ok(cursorResumes === 0, `a reconnect resumed from a copy cursor (${cursorResumes}) — the copy was not cursorless`);
		ok(damaged.length === 0, `records whose blob never healed after the cursorless re-copy: [${damaged}]`);
		ok(inPlaceRepairs >= 1, 'the healed blob was not repaired in place');
	});
});
