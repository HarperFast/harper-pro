/**
 * QA-710 (source: gh:1935) — replicated redeploy of a static-file component on a
 * 2-node cluster: first deploy establishes control.html + existing.html, then a
 * redeploy adds new.html and changes existing.html. Field report: new pages 404 on
 * the cluster until a full cluster restart.
 *
 * Discriminating question: does the ORIGIN node (which received the deploy_component
 * call directly) also 404, or only the REPLICA (which got the component via
 * replication)? If both 404 the same way, this is the single-node re-`add` class from
 * #1934 and replication is incidental. If only the replica 404s, it's a
 * replication-of-component-payload problem.
 *
 * control.html is byte-identical across both fixture versions and is used as the
 * oracle: if it doesn't serve 200 with its known body at snapshot time, the node
 * itself (or the component) isn't ready and the round is retried — so a 404 on
 * existing.html/new.html captured alongside a 200 control.html is a real finding,
 * not a "not ready yet" false positive.
 *
 * PROMOTED FROM P-489 (qa-explorer promote-candidates): the original exploratory
 * version *observed and logged* the post-redeploy page status but declined to assert
 * it, on the theory that the point was to discover the behavior rather than pin it.
 * That leaves the spec unable to catch a regression of gh#1935: a reintroduced bug
 * would just change the log output, not the exit code. This revision asserts the
 * CORRECT invariant instead — after a `restart:false` replicated redeploy, every
 * node (origin AND replica) must serve the new page and the changed page at 200
 * with their new bodies, without a restart. It also arms the 404 oracle explicitly
 * (a known-absent path must 404 on every node) so a silent no-op deploy — which
 * would otherwise leave every real page 404ing and could be mistaken for "the
 * checker works" — cannot pass by accident.
 *
 * Coverage anchor: F(redeploy/lifecycle) × D(replication topology) × J(static route
 * surface) — the previously-uncovered corner where a component's payload replicates
 * but its HTTP routes may not rebind. requires-isolation: deploys components and
 * restarts a node, so it cannot share an instance with other cluster scenarios.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const NODE_COUNT = 2;
const PROJECT = 'qa710static';
const FIXTURE_V1 = join(import.meta.dirname, 'fixture-static-redeploy');
const FIXTURE_V2 = join(import.meta.dirname, 'fixture-static-redeploy-v2');

suite('replicated redeploy of a static-file component (gh#1935 regression anchor)', { timeout: 300000 }, (ctx) => {
	before(
		async () => {
			// Indexed assignment (not push) so ctx.nodes[0]/[1] keep their origin/replica
			// identity regardless of which startHarper call resolves first, while still
			// recording whichever nodes did start (for teardown) if the other one fails.
			ctx.nodes = [];
			await Promise.all(
				Array(NODE_COUNT)
					.fill(null)
					.map(async (_, i) => {
						const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
						await startHarper(nodeCtx, nodeStartOptions(nodeCtx.harper));
						ctx.nodes[i] = nodeCtx.harper;
					})
			);

			const tokenResponse = await sendOperation(ctx.nodes[0], {
				operation: 'create_authentication_tokens',
				authorization: ctx.nodes[0].admin,
			});
			await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: 'Bearer ' + tokenResponse.operation_token,
			});

			let retries = 0;
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const statuses = await Promise.all(ctx.nodes.map((n) => sendOperation(n, { operation: 'cluster_status' })));
				const fullyConnected = statuses.every(
					(s) =>
						s.connections.length === NODE_COUNT - 1 &&
						s.connections.every((c) => c.database_sockets.every((sock) => sock.connected))
				);
				if (fullyConnected) break;
				if (retries++ > 25) throw new Error('Cluster did not fully connect: ' + JSON.stringify(statuses));
				await delay(500 * retries);
			}
			// Let the reverse-direction (origin -> replica) connection's cert trust settle before
			// deploy_component tries to replicate/restart over it (see deployTrackingReplication.test.mjs).
			// Empirically flaky below ~3s in this harness (intermittent "self-signed certificate" on the
			// restart-propagation leg) — unrelated to the static-files behavior under test.
			await delay(3000);
		},
		// The connect-retry loop above backs off up to 500ms * (1+...+26) ≈ 175s before giving up,
		// so this ceiling has to clear that budget (plus startup/request overhead) — otherwise a
		// cluster that's still legitimately converging gets killed by this timeout instead of by
		// the loop's own, more informative "did not fully connect" error.
		{ timeout: 220_000 }
	);

	after(
		async () => {
			if (!ctx.nodes) return;
			await Promise.all(ctx.nodes.filter(Boolean).map((node) => teardownHarper({ harper: node })));
		},
		{ timeout: 60_000 }
	);

	test(
		'initial deploy: control + existing pages serve on both nodes',
		// Sequential pollHealth over both nodes below can back off up to ~120s each
		// (retries * intervalMs) before giving up, so this ceiling has to clear ~240s
		// of that plus the snapshotPages budget, or a legitimately-slow-but-healthy
		// node gets killed by this timeout instead of pollHealth's own error.
		{ timeout: 320_000 },
		async () => {
			// First-time load of a brand-new component needs restart:true (matches customer's
			// initial site deploy) — restart:false on a never-before-loaded component writes the
			// files but doesn't mount its HTTP handlers into the running server (see
			// core/integrationTests/deploy/redeploy-restart-flag.test.ts, issue135-replicated-*).
			// The REDEPLOY under test in the next case is the one that uses restart:false.
			const payload = await targz(FIXTURE_V1);
			const res = await sendOperation(ctx.nodes[0], {
				operation: 'deploy_component',
				project: PROJECT,
				payload,
				replicated: true,
				restart: true,
			});
			assert.ok(
				res.message?.startsWith(`Successfully deployed: ${PROJECT}`),
				`unexpected deploy message: ${JSON.stringify(res)}`
			);

			await delay(5000);
			for (const node of ctx.nodes) await pollHealth(node);

			for (const node of ctx.nodes) {
				const snap = await snapshotPages(node, ['existing.html']);
				assert.equal(
					snap.control.status,
					200,
					`${node.hostname} control.html should be 200: ${JSON.stringify(snap.control)}`
				);
				assert.ok(snap.control.body.includes('CONTROL-V1'));
				assert.equal(
					snap['existing.html'].status,
					200,
					`${node.hostname} existing.html should be 200 after initial deploy: ${JSON.stringify(snap['existing.html'])}`
				);
				assert.ok(
					snap['existing.html'].body.includes('EXISTING-V1'),
					`${node.hostname} existing.html body: ${snap['existing.html'].body}`
				);

				// ARMING: prove the 200/404 checker can actually see a difference on THIS node,
				// at THIS moment, before we trust any later 200 as meaningful. `new.html` does not
				// exist yet (it's only added by the V2 fixture in the redeploy test below), so it
				// must 404 here. If this ever comes back 200, the oracle is broken (e.g. a stale
				// static map serving directory listings or a catch-all) and the redeploy test's
				// 200 assertions would be worthless.
				const absent = await getPage(node, '/new.html');
				assert.equal(
					absent.status,
					404,
					`${node.hostname} new.html should 404 before it exists (oracle arming check): ${JSON.stringify(absent)}`
				);
			}
		}
	);

	test(
		'redeploy: new page + changed page register on ORIGIN and REPLICA without a restart',
		// pollUntilExpected runs 3x per node (control/existing/new) sequentially across both
		// nodes, each backing off up to its own 15s budget — worst case ~90s — plus the
		// per-worker concurrentBurst pass after it, so this ceiling has to clear both budgets
		// rather than race them.
		{ timeout: 150_000 },
		async () => {
			const payload = await targz(FIXTURE_V2);
			const res = await sendOperation(ctx.nodes[0], {
				operation: 'deploy_component',
				project: PROJECT,
				payload,
				replicated: true,
				restart: false,
			});
			assert.equal(res.message, `Successfully deployed: ${PROJECT}`, JSON.stringify(res));

			// deploy_component reporting success is not route-registration: give each node a
			// bounded, fair window (15s, polled every 500ms — well past the ~3s settle time
			// observed in exploration) to actually mount the new routes before treating a
			// leftover 404 as a real, assertable finding rather than a startup race.
			ctx.snapshots = {};
			for (const [i, node] of ctx.nodes.entries()) {
				const label = i === 0 ? 'origin' : 'replica';
				const control = await pollUntilExpected(node, 'control.html', 'CONTROL-V1');
				const existing = await pollUntilExpected(node, 'existing.html', 'EXISTING-V2-CHANGED');
				const newPage = await pollUntilExpected(node, 'new.html', 'NEW-PAGE-V2');
				const snap = { control, 'existing.html': existing, 'new.html': newPage };
				ctx.snapshots[label] = snap;
				console.log(
					`[QA-710] ${label} (${node.hostname}) post-redeploy, no restart: ` +
						`control=${control.status} existing.html=${existing.status}(${JSON.stringify(existing.body)}) ` +
						`new.html=${newPage.status}(${JSON.stringify(newPage.body)})`
				);

				// Readiness oracle — must be 200, or nothing else here means anything.
				assert.equal(
					control.status,
					200,
					`${label} control.html should still be 200 (readiness oracle): ${JSON.stringify(control)}`
				);
				assert.ok(control.body.includes('CONTROL-V1'), `${label} control.html body: ${control.body}`);

				// CORRECT invariant under test (gh#1935): every node — origin AND replica —
				// must serve the CHANGED page and the NEW page at 200 with their new bodies,
				// without a restart. A 404 or stale body here, on either node, is the defect
				// reported in gh#1935 and must fail the test, not just be logged.
				assert.equal(
					existing.status,
					200,
					`${label} (${node.hostname}) existing.html should be 200 after redeploy (no restart) — gh#1935 regression if 404: ${JSON.stringify(existing)}`
				);
				assert.ok(
					existing.body.includes('EXISTING-V2-CHANGED'),
					`${label} existing.html should reflect the CHANGED body after redeploy: ${existing.body}`
				);
				assert.equal(
					newPage.status,
					200,
					`${label} (${node.hostname}) new.html should be 200 after redeploy (no restart) — gh#1935 regression if 404: ${JSON.stringify(newPage)}`
				);
				assert.ok(
					newPage.body.includes('NEW-PAGE-V2'),
					`${label} new.html should reflect the NEW body after redeploy: ${newPage.body}`
				);
			}

			// Per-worker resolution: burst concurrent requests at each node. With the default
			// threads.count (CPU-count workers), a burst fans out across HTTP workers — if only
			// some workers had picked up the redeployed static map (per-worker staleness, as
			// opposed to a uniform per-node result), this would show up as a mixed-status burst.
			for (const [i, node] of ctx.nodes.entries()) {
				const label = i === 0 ? 'origin' : 'replica';
				for (const [path, expectedBody] of [
					['existing.html', 'EXISTING-V2-CHANGED'],
					['new.html', 'NEW-PAGE-V2'],
				]) {
					const burst = await concurrentBurst(node, path);
					const bad = burst.filter((r) => r.status !== 200 || !r.body.includes(expectedBody));
					assert.equal(
						bad.length,
						0,
						`${label} (${node.hostname}) ${path}: ${bad.length}/${burst.length} concurrent requests did not see the redeployed ` +
							`page uniformly (per-worker staleness) — sample: ${JSON.stringify(bad[0])}`
					);
				}
			}
		}
	);

	test(
		'restart:true on the replica only fixes that node; origin unaffected',
		// delay(5000) + a single pollHealth call (up to ~120s) + two snapshotPages calls
		// (up to ~20s each) — this ceiling has to clear that combined budget.
		{ timeout: 200_000 },
		async () => {
			console.log('[QA-710] pre-restart snapshots:', JSON.stringify(ctx.snapshots));
			if (!ctx.snapshots?.origin) return; // test 2 didn't set snapshots — its own failure already surfaces the issue
			const before = ctx.snapshots;

			// Restart node 1 (replica) only. `restart` drops the HTTP connection, so the request
			// itself may reject/timeout — that's expected, not a failure.
			await sendOperation(ctx.nodes[1], { operation: 'restart' }).catch(() => {});
			await delay(5000);
			await pollHealth(ctx.nodes[1]);

			const replicaAfter = await snapshotPages(ctx.nodes[1], ['existing.html', 'new.html']);
			const originAfter = await snapshotPages(ctx.nodes[0], ['existing.html', 'new.html']);

			console.log(
				`[QA-710] replica (${ctx.nodes[1].hostname}) post-restart: ` +
					`existing.html=${replicaAfter['existing.html'].status}(${JSON.stringify(replicaAfter['existing.html'].body)}) ` +
					`new.html=${replicaAfter['new.html'].status}(${JSON.stringify(replicaAfter['new.html'].body)})`
			);
			console.log(
				`[QA-710] origin (${ctx.nodes[0].hostname}) unchanged (no restart): ` +
					`existing.html=${originAfter['existing.html'].status}(${JSON.stringify(originAfter['existing.html'].body)}) ` +
					`new.html=${originAfter['new.html'].status}(${JSON.stringify(originAfter['new.html'].body)})`
			);

			assert.equal(replicaAfter.control.status, 200, 'replica control.html should be 200 post-restart');
			assert.equal(originAfter.control.status, 200, 'origin control.html should still be 200');

			// Title claims restart:true "fixes" the replica — that only holds if the replica's
			// redeployed pages are actually up after the restart, not merely fetched and logged.
			assert.equal(
				replicaAfter['existing.html'].status,
				200,
				`replica existing.html should still be 200 after restart: ${JSON.stringify(replicaAfter['existing.html'])}`
			);
			assert.ok(
				replicaAfter['existing.html'].body.includes('EXISTING-V2-CHANGED'),
				`replica existing.html body should still be the changed page after restart: ${replicaAfter['existing.html'].body}`
			);
			assert.equal(
				replicaAfter['new.html'].status,
				200,
				`replica new.html should still be 200 after restart: ${JSON.stringify(replicaAfter['new.html'])}`
			);
			assert.ok(
				replicaAfter['new.html'].body.includes('NEW-PAGE-V2'),
				`replica new.html body should still be the new page after restart: ${replicaAfter['new.html'].body}`
			);

			// Restarting the replica should not regress the origin.
			assert.equal(
				originAfter['existing.html'].status,
				before.origin['existing.html'].status,
				'origin existing.html status should be unchanged by restarting the OTHER node'
			);
			assert.equal(
				originAfter['new.html'].status,
				before.origin['new.html'].status,
				'origin new.html status should be unchanged by restarting the OTHER node'
			);
		}
	);
});

// Reused on restart too — a restart without options.config wipes replication.databases (see
// integrationTests/cluster/replicationTopology.test.mjs comment on nodeStartOptions).
function nodeStartOptions(node) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true },
			replication: { securePort: node.hostname + ':9933', databases: ['data'] },
		},
	};
}

async function getPage(node, path) {
	try {
		const res = await fetch(`${node.httpURL}${path}`, { signal: AbortSignal.timeout(10_000) });
		const body = await res.text();
		return { status: res.status, body };
	} catch (err) {
		return { status: 0, body: `<fetch error: ${err.message}>` };
	}
}

/**
 * Poll control.html (byte-identical in both fixture versions) until it serves 200
 * with the expected body — that's our "node + component are actually ready" oracle.
 * Once it does, take a single, non-retried snapshot of the other pages in the same
 * instant: a 404 there is a genuine finding, not a readiness race.
 */
async function snapshotPages(node, paths, { timeoutMs = 20_000, pollMs = 500 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let control;
	while (Date.now() < deadline) {
		control = await getPage(node, '/control.html');
		if (control.status === 200 && control.body.includes('CONTROL-V1')) break;
		await delay(pollMs);
	}
	const snapshot = { control };
	for (const p of paths) {
		snapshot[p] = await getPage(node, `/${p}`);
	}
	return snapshot;
}

/**
 * Poll a single path until it serves 200 with `expectedBody`, or the deadline
 * passes — returns the last observed response either way. Used to give
 * route-registration a bounded, fair window after a redeploy before treating
 * a 404 as a permanent (assertable) finding rather than a startup race.
 */
async function pollUntilExpected(node, path, expectedBody, { timeoutMs = 15_000, pollMs = 500 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	do {
		last = await getPage(node, `/${path}`);
		if (last.status === 200 && last.body.includes(expectedBody)) return last;
		await delay(pollMs);
	} while (Date.now() < deadline);
	return last;
}

/**
 * Fire `n` concurrent requests at a path on one node. With `threads.count: null`
 * (the default, CPU-count worker threads), concurrent requests fan out across
 * HTTP workers — if only some workers picked up the redeployed static map, this
 * surfaces as a mix of statuses/bodies across the burst rather than a single
 * uniform result. Used to distinguish per-worker staleness from per-node.
 */
async function concurrentBurst(node, path, n = 12) {
	return Promise.all(Array.from({ length: n }, () => getPage(node, `/${path}`)));
}

async function pollHealth(node, { retries = 60, intervalMs = 2000 } = {}) {
	let last;
	for (let i = 0; i < retries; i++) {
		try {
			const r = await fetch(`${node.operationsAPIURL}/health`, { signal: AbortSignal.timeout(10_000) });
			if (r.ok) return;
			last = new Error(`status ${r.status}`);
		} catch (err) {
			last = err;
		}
		await delay(intervalMs);
	}
	throw new Error(`Node ${node.hostname} never became healthy: ${last?.message}`);
}
