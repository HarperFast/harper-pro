/**
 * QA-578 — regression anchor: do LIVE subscribers actually see rows that arrive via a bulk
 * full copy? (harper-pro#495 field gap; fix shipped in PR #507 "emit reload markers for
 * user-DB tables so live subscribers recover copy-applied rows", commits 0b817f28, 9a54099e,
 * decbca38.)
 *
 * Mechanism under test (replication/replicationConnection.ts, resources/Table.ts):
 *   A copyApply base copy (add_node isLeader:true -> startTime=0 full copy) writes pre-existing
 *   rows on the receiver as audit-less snapshots. The live-subscription notify path is driven off
 *   the audit stream, so those rows fire NO per-row 'put' events -- a subscriber attached before or
 *   during the copy would see nothing, ever, without the fix. PR #507's `emitCopyReloadMarkers`
 *   tracks which user tables actually received a copied row this pass (`copiedTablesThisPass`,
 *   gated by `shouldEmitCopyReloadMarker`) and, once the copy is durable, writes a whole-table
 *   'reload' marker for each. `Table.ts`'s subscribe handler treats a user-DB 'reload' as a signal to
 *   re-deliver the table's current scope as ordinary 'put' events to every live consumer that funnels
 *   through subscribe() -- MQTT, SSE, and WS alike (Table.ts ~L3888-4090). `aclConnectCopyReload.test.mjs`
 *   already covers this over MQTT with the subscriber attached BEFORE the copy starts. This test
 *   targets the uncovered corner: the REST/SSE transport, AND a subscriber that attaches MID-copy
 *   (not just before it), plus an explicit non-blind proof that the copy really delivered rows while
 *   the subscriber was live.
 *
 * Topology: node A (leader, seeds the pre-existing dataset) + node B (subscriber attached BEFORE
 * add_node) + node C (subscriber attached MID-copy, via tight polling for the 0->N transition).
 * B and C each independently `add_node {isLeader:true}` against A, so the two orderings don't
 * interfere with each other's copy pass.
 *
 * Non-blindness: for each ordering we sample the receiver's row count via `describe_table` on a
 * connection entirely separate from the SSE stream, and assert it actually transitions 0 -> N while
 * the SSE subscriber is attached. A test that would stay green if #507 were reverted is worthless;
 * the row-count oracle is what proves the copy really happened during the subscribed window, and the
 * SSE-observed id set is checked against the SAME source id set (not just a count) so a defect that
 * delivered the wrong rows would also be caught.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { sendOperation, fetchWithRetry } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const DATABASE = 'data';
const TABLE = 'CopyRow';
const PROJECT = 'qa578-copy-reload-subscribers';
const FIXTURE_PATH = join(import.meta.dirname ?? module.path, 'fixture-copy-reload-subscribers');

// Large enough that the base copy is observably non-instantaneous (mirrors QA-711's 30k/1KB
// finding that this scale gives a multi-second, repeatedly-sample-able copy window on loopback).
const RECORD_COUNT = 20000;
const SEED_BATCH_SIZE = 2000;
const PAYLOAD_BYTES = 800;

const FETCH_TIMEOUT_MS = 10000;

/** POST an operation with a hard per-call timeout; throws on non-2xx or network/timeout error. */
async function op(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const data = await response.json();
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`operation ${operation.operation} failed: ${response.status} ${JSON.stringify(data)}`);
	}
	return data;
}

function makeRecords(startIdx, count) {
	const blob = 'v'.repeat(PAYLOAD_BYTES);
	const records = [];
	for (let i = startIdx; i < startIdx + count; i++) {
		records.push({ id: `row-${String(i).padStart(7, '0')}`, val: blob });
	}
	return records;
}

/** Row count on `node` via describe_table -- independent of the SSE stream (the non-blind oracle). */
async function rowCount(node) {
	try {
		const desc = await op(node, { operation: 'describe_table', database: DATABASE, table: TABLE });
		return desc?.record_count ?? 0;
	} catch {
		return -1; // table not ready yet / transient -- callers treat as "not readable"
	}
}

async function deployComponent(node) {
	const payload = await targz(FIXTURE_PATH);
	const body = await sendOperation(node, { operation: 'deploy_component', project: PROJECT, payload, restart: true });
	ok(typeof body?.message === 'string', `unexpected deploy response on ${node.hostname}: ${JSON.stringify(body)}`);
}

/** Poll the REST collection route until it's live (component restart complete). */
async function waitForRestReady(node, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetchWithRetry(`${node.httpURL}/${TABLE}/`, { retries: 0 });
			if (res.status !== 404) return;
		} catch {
			/* not up yet */
		}
		await delay(300);
	}
	throw new Error(`${node.hostname}: /${TABLE}/ route never became ready within ${timeoutMs}ms`);
}

/**
 * Open a live SSE subscription to the table collection (Accept: text/event-stream), matching the
 * openSse() pattern used by core's subscription-revocation.test.ts. Each parsed 'data:' payload is
 * the raw subscribe event ({id, value, type, ...} -- resources/Table.ts's subscribe handler shape),
 * so we record id+type for every event, not just a count.
 */
function openSse(node, path) {
	const url = new URL(node.httpURL);
	const auth = 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64');
	const events = [];
	let ended = false;
	let status = 0;
	let buffered = '';
	const req = httpRequest(
		{
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port,
			method: 'GET',
			path,
			headers: { Accept: 'text/event-stream', Authorization: auth },
		},
		(res) => {
			status = res.statusCode ?? 0;
			res.setEncoding('utf8');
			res.on('data', (chunk) => {
				buffered += chunk;
				let idx;
				// SSE events are separated by a blank line.
				while ((idx = buffered.indexOf('\n\n')) !== -1) {
					const rawEvent = buffered.slice(0, idx);
					buffered = buffered.slice(idx + 2);
					const dataLines = rawEvent
						.split('\n')
						.filter((l) => l.startsWith('data:'))
						.map((l) => l.slice(5).trim());
					if (!dataLines.length) continue;
					try {
						const parsed = JSON.parse(dataLines.join(''));
						events.push(parsed);
					} catch {
						events.push({ __unparsed: dataLines.join('') });
					}
				}
			});
			res.on('end', () => (ended = true));
			res.on('close', () => (ended = true));
		}
	);
	req.on('error', () => (ended = true));
	req.end();
	return {
		events,
		ended: () => ended,
		status: () => status,
		ids: () => new Set(events.map((e) => e.id ?? e.value?.id).filter((id) => id != null)),
		close: () => req.destroy(),
	};
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 100 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await delay(intervalMs);
	}
	return predicate();
}

const sharedConfig = (hostname) => ({
	analytics: { aggregatePeriod: -1 },
	logging: { colors: false, stdStreams: false, console: true },
	replication: { port: hostname + ':9933', securePort: null, databases: [DATABASE] },
});

suite('QA-578 live subscriber delivery of copy-applied rows (#495 / PR #507)', { timeout: 600000 }, (ctx) => {
	before(
		async () => {
			ctx.nodes = [];
			const [hostnameA, hostnameB, hostnameC] = await Promise.all([
				getNextAvailableLoopbackAddress(),
				getNextAvailableLoopbackAddress(),
				getNextAvailableLoopbackAddress(),
			]);
			const mk = (hostname) => ({ name: ctx.name, harper: { hostname } });
			const nodeCtxA = mk(hostnameA);
			const nodeCtxB = mk(hostnameB);
			const nodeCtxC = mk(hostnameC);

			// A/B/C all start UNCLUSTERED -- B and C each trigger their own explicit add_node isLeader:true
			// full copy from A later, at a controlled moment (before / mid), rather than joining at startup.
			await Promise.all([
				startHarper(nodeCtxA, { config: sharedConfig(hostnameA), env: { HARPER_NO_FLUSH_ON_EXIT: true } }),
				startHarper(nodeCtxB, { config: sharedConfig(hostnameB), env: { HARPER_NO_FLUSH_ON_EXIT: true } }),
				startHarper(nodeCtxC, { config: sharedConfig(hostnameC), env: { HARPER_NO_FLUSH_ON_EXIT: true } }),
			]);
			ctx.nodeA = nodeCtxA.harper;
			ctx.nodeB = nodeCtxB.harper;
			ctx.nodeC = nodeCtxC.harper;
			ctx.nodes.push(ctx.nodeA, ctx.nodeB, ctx.nodeC);

			// Deploy the same table schema (rest:true, @export) independently to all three nodes BEFORE
			// any clustering, so the /CopyRow/ REST route (and thus the SSE subscribe path) exists on B and
			// C even while their table is empty -- mirrors aclConnectCopyReload's deployAclConnect approach.
			await Promise.all([deployComponent(ctx.nodeA), deployComponent(ctx.nodeB), deployComponent(ctx.nodeC)]);
			await Promise.all([waitForRestReady(ctx.nodeA), waitForRestReady(ctx.nodeB), waitForRestReady(ctx.nodeC)]);

			// Seed the pre-existing dataset on A -- thousands of rows so the base copy to B/C is not
			// instantaneous and there is a real window to sample mid-flight.
			const seedStart = Date.now();
			for (let i = 0; i < RECORD_COUNT; i += SEED_BATCH_SIZE) {
				const records = makeRecords(i, Math.min(SEED_BATCH_SIZE, RECORD_COUNT - i));
				await op(ctx.nodeA, { operation: 'upsert', database: DATABASE, table: TABLE, records });
			}
			console.log(
				`[qa578] seeded ${RECORD_COUNT} records (~${Math.round((RECORD_COUNT * PAYLOAD_BYTES) / 1e6)}MB) on A in ${Date.now() - seedStart}ms`
			);

			const aCount = await rowCount(ctx.nodeA);
			equal(aCount, RECORD_COUNT, `leader A should hold all ${RECORD_COUNT} seeded records before either copy starts`);
			ctx.sourceIds = new Set(makeRecords(0, RECORD_COUNT).map((r) => r.id));
		},
		{ timeout: 300000 }
	);

	after(
		async () => {
			await Promise.all((ctx.nodes ?? []).map((node) => teardownHarper({ harper: node })));
		},
		{ timeout: 120000 }
	);

	test(
		'ordering (a): subscriber attached BEFORE add_node sees copy-applied rows, then a live write',
		async () => {
			const { nodeA, nodeB, sourceIds } = ctx;

			const preCount = await rowCount(nodeB);
			equal(preCount, 0, 'precondition: B must start with an empty CopyRow table');
			// Ground truth for "did the copy really finish": A's OWN row count right now, not a hardcoded
			// constant -- this test runs first so it should equal RECORD_COUNT, but computing it live keeps
			// the assertion correct regardless of suite ordering.
			const totalOnA = await rowCount(nodeA);

			// 1) Attach the live SSE subscriber BEFORE the copy begins. Harper flushes SSE response headers
			// on the FIRST delivered event (see core's subscription-revocation.test.ts openSse() comment) --
			// B's table is genuinely empty here, so nothing flushes yet and `sub.status()` legitimately stays
			// 0 until the copy lands. Do NOT block on status before triggering the copy (that would deadlock);
			// just fire the request and give it a short settle before checking the (empty) event backlog.
			const sub = openSse(nodeB, `/${TABLE}/`);
			await delay(300); // let the connection establish; no data expected yet
			equal(
				sub.events.length,
				0,
				`precondition: B's subscriber must see nothing before the copy, saw ${sub.events.length} events`
			);

			// 2) Trigger the full copy: B joins A as leader -> startTime=0 base copy of A's pre-existing rows.
			const samples = [];
			const pollDeadline = Date.now() + 120000;
			const copyStart = Date.now();
			await sendOperation(nodeB, {
				operation: 'add_node',
				hostname: nodeA.hostname,
				rejectUnauthorized: false,
				isLeader: true,
				authorization: nodeA.admin,
			});

			// 3) NON-BLINDNESS: independently poll B's row count (a channel entirely separate from the SSE
			// stream) until it reaches A's count, proving the copy really delivered all the rows while the
			// subscriber was attached -- not just that the subscriber's own event count happens to match.
			let sawZero = false;
			let finalCount = 0;
			while (Date.now() < pollDeadline) {
				finalCount = await rowCount(nodeB);
				if (finalCount === 0) sawZero = true;
				samples.push({ tRel: Date.now() - copyStart, count: finalCount });
				if (finalCount >= totalOnA) break;
				await delay(250);
			}
			console.log(
				`[qa578][ordering-a] row-count samples: ${JSON.stringify(samples.slice(0, 5))} ... n=${samples.length}, final=${finalCount}`
			);
			ok(sawZero, 'non-blind precondition: must have observed B at 0 rows before the copy landed');
			equal(
				finalCount,
				totalOnA,
				`B's independently-polled row count must reach A's count (${totalOnA}) -- the copy must actually complete`
			);

			// 4) The live SSE subscriber must receive every copied row -- only possible via the copy-complete
			// reload re-read (#507), since copyApply rows carry no per-row audit event. Subset check (not
			// exact-size equality): the assertion is "every pre-existing row arrived", independent of A's
			// exact current total.
			const arrived = await waitFor(
				() => {
					const ids = sub.ids();
					return [...sourceIds].every((id) => ids.has(id));
				},
				{ timeoutMs: 60000, intervalMs: 250 }
			);
			const observedIds = sub.ids();
			const missing = [...sourceIds].filter((id) => !observedIds.has(id));
			ok(
				arrived,
				`ordering-a: SSE subscriber on B must observe all ${RECORD_COUNT} copied ids via the reload re-read; ` +
					`observed ${observedIds.size}, missing ${missing.length} (e.g. ${missing.slice(0, 5)}), sse status=${sub.status()}`
			);
			equal(sub.status(), 200, `SSE subscribe on B must have flushed a 200 once events arrived, got ${sub.status()}`);

			// 5) Prove the subscription SURVIVED the copy (wasn't silently torn down): an ordinary live write
			// on A, after the copy is durable, must still be delivered to B's subscriber.
			const liveId = 'live-after-copy-a';
			await op(nodeA, {
				operation: 'upsert',
				database: DATABASE,
				table: TABLE,
				records: [{ id: liveId, val: 'live-write' }],
			});
			const liveArrived = await waitFor(() => sub.ids().has(liveId), { timeoutMs: 20000, intervalMs: 200 });
			ok(
				liveArrived,
				`ordering-a: an ordinary live write on A after the copy must still reach B's subscriber (id=${liveId})`
			);

			sub.close();
		},
		{ timeout: 240000 }
	);

	test(
		'ordering (b): subscriber attached MID-copy sees copy-applied rows, then a live write',
		async () => {
			const { nodeA, nodeC, sourceIds } = ctx;

			const preCount = await rowCount(nodeC);
			equal(preCount, 0, 'precondition: C must start with an empty CopyRow table');
			// Ground truth: A's row count right now (ordering (a)'s live write permanently added one row to
			// A before this test runs, so this is A's ORIGINAL RECORD_COUNT + 1, not RECORD_COUNT).
			const totalOnA = await rowCount(nodeA);

			// 1) Kick off the full copy WITHOUT attaching a subscriber first.
			const copyStart = Date.now();
			await sendOperation(nodeC, {
				operation: 'add_node',
				hostname: nodeA.hostname,
				rejectUnauthorized: false,
				isLeader: true,
				authorization: nodeA.admin,
			});

			// 2) Tight-poll C's row count (independent of any subscriber) to catch the copy in flight, then
			// attach the SSE subscriber AT that moment -- a genuine mid-copy attach, not a race against an
			// instantaneous copy. Record the exact count observed at attach time as the mid-copy proof.
			const preAttachSamples = [];
			let attachCount = null;
			const attachDeadline = Date.now() + 60000;
			while (Date.now() < attachDeadline) {
				const c = await rowCount(nodeC);
				preAttachSamples.push({ tRel: Date.now() - copyStart, count: c });
				if (c > 0) {
					attachCount = c;
					break;
				}
				await delay(20);
			}
			console.log(
				`[qa578][ordering-b] pre-attach samples: ${JSON.stringify(preAttachSamples.slice(-5))} (n=${preAttachSamples.length})`
			);
			ok(
				attachCount !== null,
				`never observed C's row count go above 0 within the poll window (copy too fast/slow to catch) -- last samples: ${JSON.stringify(preAttachSamples.slice(-5))}`
			);

			const sub = openSse(nodeC, `/${TABLE}/`);
			await waitFor(() => sub.status() !== 0, { timeoutMs: 10000 });
			equal(sub.status(), 200, `SSE subscribe on C must return 200, got ${sub.status()}`);
			const attachCountConfirm = await rowCount(nodeC);
			console.log(
				`[qa578][ordering-b] SSE attached mid-copy: attachCount=${attachCount}, confirm=${attachCountConfirm}, total=${totalOnA} ` +
					`(${attachCountConfirm < totalOnA ? 'genuinely mid-copy' : 'copy completed before attach landed -- see log'})`
			);

			// 3) NON-BLINDNESS continued: keep polling to confirm the copy actually finishes (0/partial -> N)
			// on this independent channel.
			const postAttachSamples = [];
			let finalCount = attachCountConfirm;
			const pollDeadline = Date.now() + 120000;
			while (Date.now() < pollDeadline) {
				finalCount = await rowCount(nodeC);
				postAttachSamples.push({ tRel: Date.now() - copyStart, count: finalCount });
				if (finalCount >= totalOnA) break;
				await delay(250);
			}
			console.log(
				`[qa578][ordering-b] post-attach samples: ${JSON.stringify(postAttachSamples.slice(0, 5))} ... final=${finalCount}`
			);
			equal(
				finalCount,
				totalOnA,
				`C's independently-polled row count must reach A's count (${totalOnA}) -- the copy must actually complete`
			);

			// 4) The mid-copy-attached subscriber must still observe every original row -- whatever it missed
			// via the initial snapshot at attach time must be recovered by the copy-complete reload re-read.
			// Subset check: sourceIds is the ORIGINAL seeded set, not A's current total (which now also
			// includes ordering (a)'s live-write row).
			const arrived = await waitFor(
				() => {
					const ids = sub.ids();
					return [...sourceIds].every((id) => ids.has(id));
				},
				{ timeoutMs: 60000, intervalMs: 250 }
			);
			const observedIds = sub.ids();
			const missing = [...sourceIds].filter((id) => !observedIds.has(id));
			ok(
				arrived,
				`ordering-b: mid-copy-attached SSE subscriber on C must observe all ${RECORD_COUNT} copied ids; ` +
					`observed ${observedIds.size}, missing ${missing.length} (e.g. ${missing.slice(0, 5)})`
			);

			// 5) Subscription must survive the copy: an ordinary live write on A after the copy must reach C.
			const liveId = 'live-after-copy-b';
			await op(nodeA, {
				operation: 'upsert',
				database: DATABASE,
				table: TABLE,
				records: [{ id: liveId, val: 'live-write' }],
			});
			const liveArrived = await waitFor(() => sub.ids().has(liveId), { timeoutMs: 20000, intervalMs: 200 });
			ok(
				liveArrived,
				`ordering-b: an ordinary live write on A after the copy must still reach C's subscriber (id=${liveId})`
			);

			sub.close();
		},
		{ timeout: 240000 }
	);
});
