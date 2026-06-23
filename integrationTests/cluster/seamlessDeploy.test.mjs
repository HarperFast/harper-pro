/**
 * Seamless deploy_component reload for a ROUTE-LESS replication peer (harper-pro#460).
 *
 * VERIFICATION ARTIFACT — not (yet) a committed PR test. It depends on the test-only
 * decode-fail injection hook in replication/knownNodes.ts (HARPER_TEST_HDBNODES_DECODE_FAIL).
 * Keep uncommitted; it is a candidate to commit to harper-pro after the hook gets reviewer
 * sign-off.
 *
 * Field shape (JJill): followers run `replication: { databases: '*', enableRootCAs: true }`
 * with NO routes. Peers are discovered ONLY via hdb_nodes mesh propagation, so the
 * hdb_nodes subscription scan is the sole outbound-subscription path. A #352/#1163 decode
 * miss on a route-less peer therefore orphans that peer's outbound replication entirely —
 * there is no routes loop / reconcileWorkers route-driven re-subscribe to mask it.
 *
 * Why this topology and not a 2-node add_node setup: `add_node` writes a route, and the
 * routes loop + reconcileWorkers re-subscribe independently of the hdb_nodes scan, masking
 * the bug. A faithful repro needs a route-less peer: 3 nodes where A and C BOTH add_node a
 * hub B, so A and C discover each other purely via mesh propagation (no route between them).
 *
 * What this test proves: with harper-pro#460, a deploy_component reload of a route-less
 * follower keeps replicating from its mesh-discovered peer C even when C's hdb_nodes row
 * fails to decode at the post-reload subscription scan — the scan reconstructs a
 * {name, replicates:true} descriptor and re-subscribes, so the post-deploy write from C
 * still reaches A (assertion (b)).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * IMPORTANT FINDING — this test does NOT isolate harper#1464, contrary to the original plan.
 *
 * The plan was: inject a decode miss for C at A's scan, and assert the #460 reconstruct warn
 * is ABSENT after the deploy WITH #1464 (which makes startOnMainThread run once per
 * component) and PRESENT without it. Running it both ways disproved that premise:
 *
 *   - With #1464 AND without #1464, the reconstruct warn appears identically after the deploy,
 *     emitted by the freshly-restarted HTTP WORKER ([http/2]), immediately after its
 *     "Starting replication server" line — i.e. from replicator.start() -> monitorNodeCAs() ->
 *     subscribeToNodeUpdates(..., 'ca-monitor') -> scanNodesForSubscription. That CA-monitor
 *     scan runs on EVERY worker on EVERY `restart: true` reload and is NOT gated by
 *     startOnMainThread, so #1464 (which dedupes only the MAIN-thread startOnMainThread path)
 *     does not suppress it. Byte trace (both runs): boot scans on [http/1]/[main/0] show
 *     "Known nodes at startup []" (C not yet mesh-known, so the scan-only injection does not
 *     fire at boot); the post-deploy [http/2] scan shows
 *     "Known nodes at startup [127.0.0.17,127.0.0.22,127.0.0.23]" then the #460 warn for C.
 *   - #1464 DID do its job on the main thread: WITH #1464 there is no second [main/0] scan
 *     after the deploy; without it the main-thread scan would also re-run. But because #460's
 *     reconstruct-and-resubscribe already runs per-worker via the CA-monitor scan, replication
 *     self-heals across the deploy in BOTH configs — so neither the warn nor the
 *     prompt-replication timing discriminates #1464 here.
 *
 * Net: with #460 in place, #1464 is a main-thread de-duplication / noise-reduction
 * improvement, not a separately observable correctness fix in this route-less-deploy scenario.
 * A test that truly isolates #1464 would have to observe the main-thread scan re-running
 * directly (e.g. count [main/0] subscription scans across a deploy), not the route-less
 * peer's replication outcome. This file is therefore framed as a harper-pro#460
 * seamless-deploy verification; the warn check is kept as a documented diagnostic, not a gate.
 *
 * SECOND FINDING — assertion (b) is FLAKY in this 3-node hub topology and currently does NOT
 * pass reliably. The mesh-discovery test passes (A reports a connected database_socket to C),
 * but actual record replication FROM the route-less / decode-injected peer C is racy: A's
 * reconstructed subscription to C flaps with repeated WS close code 1006 (visible in the
 * captured log as cycling "Failed to connect to wss://127.0.0.17:9933 (code: 1006)" with
 * widening backoff), so the post-deploy write — and sometimes even the pre-deploy baseline
 * write — does not arrive inside the 20s poll. This is a property of the route-less 3-node
 * subscription establishment under the decode injection, NOT of #1464 (it reproduces with and
 * without it). Until that flap is understood, treat (b) as unstable; the value of this file is
 * the topology repro + the CA-monitor finding above, not a green gate. Captured A logs land in
 * ~/dev/tmp/seamlessDeploy-A-*.log (post-deploy snapshot, survives teardown).
 *
 * UPDATE (2026-06-23) — the SECOND FINDING's flap was an ENVIRONMENT artifact, now resolved. On
 * Linux (local dev box AND CI, Node 22/24/26) assertion (b) passes deterministically: the post-deploy
 * write from the route-less / decode-injected peer C reaches A in ~10s, no widening-backoff spiral.
 * The 1006 close code still appears on Linux but only TRANSIENTLY during initial mesh subscription
 * (peer mid-boot, not yet listening) and self-heals in ~0.5–1.5s. The non-recovering spiral that hit
 * even the routed hub was specific to the macOS loopback self-signed *-replication cert re-handshake.
 *
 * THIRD FINDING — the route-less peer's missing `node.ca` is NOT load-bearing here. The outbound peer
 * connection already runs rejectUnauthorized:true (replicationConnection.createWebSocket), and C's CA
 * reaches A through the cluster CA-mesh availableCAs channel (replicator.ts secure-context updaters),
 * independent of the hdb_nodes row the injection strips. enableRootCAs defaults to true, so the suite
 * is now a matrix over enableRootCAs ∈ {true,false}: true = JJill's literal field shape; false turns
 * the bundled-root-CA safety net off, the only mode where a missing `node.ca` could surface. (b) passing
 * under enableRootCAs=false would prove the CA-mesh alone carries C's CA across the decode-strip+deploy.
 * ────────────────────────────────────────────────────────────────────────────────────────
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation, readLog } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

// The substring of the harper-pro#460 reconstruct warn emitted by scanNodesForSubscription
// when a route-visible hdb_nodes row fails to decode. Logged as a diagnostic only — see the
// IMPORTANT FINDING in the header for why it does not gate the test.
const RECONSTRUCT_WARN = 'subscribing to the peer so outbound replication is not lost (see harper-pro#460)';

const PROMPT_REPLICATION_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 250;

function nodeStartOptions(hostname, env, enableRootCAs) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: false, console: true },
			// Route-less follower config matching the JJill field shape: replicate every database,
			// discover peers via the hdb_nodes mesh — no `routes`. `enableRootCAs` is parameterized so the
			// suite runs as a matrix (see defineSeamlessSuite): true = JJill's literal config and the Harper
			// default ("Verify certificates against Node's bundled CA store: true"); false = the strict probe
			// with that bundled-root-CA safety net OFF. false is the ONLY mode where the reconstructed
			// {name,replicates:true} descriptor's missing `node.ca` could matter — with roots off, C's CA must
			// arrive via the cluster CA-mesh availableCAs channel (replicator.ts), not the hdb_nodes row that
			// the decode injection strips. The outbound peer connection already runs rejectUnauthorized:true.
			replication: {
				securePort: hostname + ':9933',
				databases: '*',
				enableRootCAs,
			},
		},
		env: { HARPER_NO_FLUSH_ON_EXIT: true, ...env },
	};
}

async function startNode(ctx, env, enableRootCAs) {
	const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
	await startHarper(nodeCtx, nodeStartOptions(nodeCtx.harper.hostname, env, enableRootCAs));
	return nodeCtx.harper;
}

async function createTestTable(node) {
	await sendOperation(node, {
		operation: 'create_table',
		table: 'test',
		primary_key: 'id',
		attributes: [
			{ name: 'id', type: 'ID' },
			{ name: 'name', type: 'String' },
		],
	});
}

// add_node the hub from `node`, authorizing with the hub-issued operation token.
async function addHub(node, hub, token) {
	await sendOperation(node, {
		operation: 'add_node',
		rejectUnauthorized: false,
		hostname: hub.hostname,
		authorization: 'Bearer ' + token,
	});
}

// True once `node` reports at least one connected database_socket to `peer` (by hostname).
async function databaseSocketConnectedTo(node, peer) {
	const status = await sendOperation(node, { operation: 'cluster_status' });
	return (status.connections ?? []).some(
		(conn) =>
			(conn.url ?? conn.name ?? '').includes(peer.hostname) &&
			conn.database_sockets?.length > 0 &&
			conn.database_sockets.every((socket) => socket.connected === true)
	);
}

// Poll until `id` written on `source` is readable on `receiver`.
async function waitForReplicated(receiver, id, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await sendOperation(receiver, {
			operation: 'search_by_id',
			table: 'test',
			ids: [id],
			get_attributes: ['id', 'name'],
		});
		if (Array.isArray(result) && result.some((r) => r?.id === id)) return true;
		await delay(POLL_INTERVAL_MS);
	}
	return false;
}

// Run the repro as a matrix over enableRootCAs. true = JJill's literal field shape (and the Harper
// default); false = strict probe with the bundled-root-CA safety net OFF — the discriminating case for
// whether the reconstructed descriptor's missing `node.ca` is actually load-bearing. Both variants run
// the injected decode-miss on CI (HARPER_TEST_HDBNODES_DECODE_FAIL is set by the test); SEAMLESS_NO_INJECT=1
// flips both to the control. Each variant uses its own 3 nodes (fresh loopback addresses).
for (const enableRootCAs of [true, false]) defineSeamlessSuite(enableRootCAs);

function defineSeamlessSuite(enableRootCAs) {
	suite(
		`Seamless deploy reload for a route-less replication peer (harper-pro#460, enableRootCAs=${enableRootCAs})`,
		{ timeout: 180000 },
		(ctx) => {
			before(async () => {
				// Start C first so A can be started with C's hostname as the decode-fail target.
				ctx.C = await startNode(ctx, undefined, enableRootCAs);
				// SEAMLESS_NO_INJECT=1 → control run: no decode-miss, A decodes C's real descriptor (with ca/
				// connection info). Used to classify the 1006 reconnect flap: if the control is stable but the
				// injected run flaps, the reconstructed {name,replicates:true} descriptor is the cause.
				ctx.A = await startNode(
					ctx,
					process.env.SEAMLESS_NO_INJECT ? {} : { HARPER_TEST_HDBNODES_DECODE_FAIL: ctx.C.hostname },
					enableRootCAs
				);
				ctx.B = await startNode(ctx, undefined, enableRootCAs); // hub
				ctx.nodes = [ctx.A, ctx.B, ctx.C];
				await Promise.all(ctx.nodes.map((node) => createTestTable(node)));
			});

			after(async () => {
				if (!ctx.nodes) return;
				await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
			});

			test('A and C mesh-discover each other through hub B (route-less A<->C)', async () => {
				// Hub B issues the token; A and C each add_node B. Neither A nor C has a route to the
				// other — A learns C only via hdb_nodes propagation from B, which is exactly the path the
				// injected decode miss orphans.
				const tokenResponse = await sendOperation(ctx.B, {
					operation: 'create_authentication_tokens',
					authorization: ctx.B.admin,
				});
				const token = tokenResponse.operation_token;
				await addHub(ctx.A, ctx.B, token);
				await addHub(ctx.C, ctx.B, token);

				// Wait until A has a connected database_socket to the route-less peer C. This proves the
				// reconstruct path (harper-pro#460) built the outbound subscription despite the boot
				// decode miss — the precondition for the seamless-reload assertions below.
				const deadline = Date.now() + 60000;
				let connected = false;
				while (Date.now() < deadline) {
					if (await databaseSocketConnectedTo(ctx.A, ctx.C)) {
						connected = true;
						break;
					}
					await delay(POLL_INTERVAL_MS);
				}
				ok(connected, 'A should have a connected database_socket to route-less peer C before the deploy');
			});

			test('baseline: a write on C replicates to A', async () => {
				await sendOperation(ctx.C, {
					operation: 'upsert',
					table: 'test',
					records: [{ id: '1', name: 'from-C-pre-deploy' }],
				});
				const replicated = await waitForReplicated(ctx.A, '1', PROMPT_REPLICATION_TIMEOUT_MS);
				ok(replicated, 'baseline write {id:1} on C must replicate to A before the deploy');
			});

			test('a deploy_component reload of A is SEAMLESS for the route-less peer C', async () => {
				const logBeforeDeploy = await readLog(ctx.A);

				const project = 'seamless-probe';
				const payload = await targz(join(import.meta.dirname, 'fixture-seamless-probe'));
				const deployResponse = await sendOperation(ctx.A, {
					operation: 'deploy_component',
					project,
					payload,
					restart: true,
				});
				ok(
					/Successfully deployed: seamless-probe/.test(deployResponse.message ?? ''),
					`deploy should succeed; got ${JSON.stringify(deployResponse)}`
				);

				// Let the HTTP workers cycle (restart:true) and the fresh worker re-run replicator.start().
				await delay(10000);

				// Persist A's full log to a stable location BEFORE teardown wipes the temp log dir, so the
				// scan/warn evidence survives for inspection.
				const logAfterDeploy = await readLog(ctx.A);
				await captureLog(ctx.A, logAfterDeploy);

				// DIAGNOSTIC (not a gate): record where the #460 reconstruct warn fired. As documented in the
				// header, with #460 in place this warn appears after the deploy in BOTH #1464 configs because
				// the per-worker CA-monitor scan in replicator.start() re-runs on every worker restart and is
				// not gated by startOnMainThread. The injection does NOT fire at A's boot scan (C is not
				// mesh-known yet then), so a pre-deploy occurrence would be unexpected — surface it if seen.
				console.log(
					`[seamlessDeploy] #460 reconstruct warn — pre-deploy: ${logBeforeDeploy.includes(RECONSTRUCT_WARN)}, ` +
						`post-deploy: ${logAfterDeploy.includes(RECONSTRUCT_WARN)} (post-deploy true is expected: ` +
						'per-worker CA-monitor scan re-runs the injection; not a #1464 signal — see header)'
				);

				// PRIMARY ASSERTION (harper-pro#460): a write on C reaches A promptly after the deploy — the
				// route-less peer's outbound replication survives the reload because the post-reload scan
				// reconstructs C's descriptor and re-subscribes. (No ~90s reconcileWorkers gap.)
				await sendOperation(ctx.C, {
					operation: 'upsert',
					table: 'test',
					records: [{ id: '2', name: 'from-C-post-deploy' }],
				});
				const replicatedPromptly = await waitForReplicated(ctx.A, '2', PROMPT_REPLICATION_TIMEOUT_MS);
				ok(
					replicatedPromptly,
					`post-deploy write {id:2} on C must reach A within ${PROMPT_REPLICATION_TIMEOUT_MS}ms (seamless, ` +
						'no ~90s reconcile gap). It did not — the route-less peer was orphaned after the deploy.'
				);
			});
		}
	);
}

// Write a copy of A's captured log to ~/dev/tmp/ so the warn evidence survives teardown.
async function captureLog(node, contents) {
	try {
		const { writeFile, mkdir } = await import('node:fs/promises');
		const { homedir } = await import('node:os');
		const dir = join(homedir(), 'dev', 'tmp');
		await mkdir(dir, { recursive: true });
		const out = join(dir, `seamlessDeploy-A-${node.hostname}-${Date.now()}.log`);
		await writeFile(out, contents, 'utf8');
		console.log('[seamlessDeploy] captured A log to', out);
	} catch (err) {
		console.error('[seamlessDeploy] failed to capture A log', err);
	}
}
