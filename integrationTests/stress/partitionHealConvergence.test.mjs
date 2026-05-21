/**
 * Partition + heal convergence (split-brain) test.
 *
 * ⚠️  CURRENTLY BLOCKED — requires a Harper-side change. See "Blocker" below.
 *     Test is gated on HARPER_STRESS_ALLOW_INSECURE_REPLICATION=1 in addition
 *     to HARPER_RUN_STRESS_TESTS=1 so it doesn't fail by default.
 *
 * Background: distributed systems claim to converge after a partition heals.
 * Harper's replication should: each side accepts writes while disconnected,
 * and once the connection is restored, both sides exchange catchup so all
 * peers end up with the same content per key (under whatever conflict
 * resolution Harper uses — at the moment, HLC last-write-wins).
 *
 * We can't drop loopback traffic with iptables (no NET_ADMIN, and the
 * loopback path skips netfilter anyway), so we interpose a controllable
 * TCP proxy between the two Harper nodes. The proxy forwards normally, but
 * the test flips it to "blocked" mode to simulate a partition. Existing
 * sockets are torn down; new ones are rejected. On `unblock()`, traffic
 * resumes.
 *
 * Blocker: Harper's replication WS client validates the server certificate's
 * SAN/altnames against the connect target hostname. Self-signed replication
 * certs only list the node's own IP (e.g. 127.0.0.1, ::1), so when peer B
 * dials A via the proxy at 127.0.0.3, the TLS handshake fails with
 *   "Hostname/IP does not match certificate's altnames"
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` does not bypass this; the WS client
 * appears to validate independently. Options to unblock, in rough order
 * of preference:
 *   (a) a `replication.rejectUnauthorized: false` /
 *       `replication.checkServerIdentity` config flag in Harper (clean fix).
 *   (b) bind the proxy to the SAME IP as A but a different PORT (e.g.
 *       127.0.0.1:9934, forwarding to 127.0.0.1:9933). The TLS SAN check
 *       only validates the host, not the port, so 127.0.0.1 matches A's
 *       cert. Requires `add_node` to accept a non-default port — confirm
 *       the operations API supports `hostname: '127.0.0.1:9934'` or a
 *       separate `port` arg.
 *   (c) mint replication certs with a configurable SAN list covering proxy
 *       hostnames.
 * Additional caveat surfaced by review: even after the TLS path opens, this
 * file assumes a single bidirectional WS initiated by B carries both
 * directions of replication. If Harper actually opens an independent A→B
 * connection (gossip / mutual dial), blocking just the B→A proxy won't
 * partition the cluster. Verify the topology before trusting a "passing"
 * result, and add a second proxy / route A's outbound through the proxy if
 * needed.
 *
 * Mechanism:
 *  - 2 nodes A and B. B's `add_node` points at a proxy address that forwards
 *    to A's real replication port. Since replication is a single bidirectional
 *    WS initiated by B, blocking that one proxy interrupts traffic in both
 *    directions — we don't need a second proxy.
 *  - Initial sync ensures both nodes see the deployed schema and connect.
 *  - Phase 1 (pre-partition): drive light churn on both A and B against
 *    overlapping keys 0..KEYSPACE/2 so we have a known baseline of replicated
 *    rows.
 *  - Phase 2 (partition): proxy.block() on both. Each side writes to keys in
 *    a side-specific range so post-heal we know which write came from where
 *    (id encodes the originating side). Run for HARPER_STRESS_PARTITION_SECS.
 *  - Phase 3 (heal): proxy.unblock() on both. Drive a brief tail of churn so
 *    new traffic crosses the heal. Stop. Wait for convergence.
 *
 * Assertions:
 *  1. After heal, A.record_count === B.record_count (strict equality — for
 *     keys, not for blob contents). Catches split-brain where one side
 *     can't observe the other's writes.
 *  2. Sampled keys: pull N specific record ids from each side, compare. They
 *     should match. Catches LWW divergence (different versions resolve to
 *     different "winners" on the two sides).
 *  3. Zero uncaughtException on either side during partition or heal.
 *  4. Catch-up "Replayed" message NOT expected (no crashes); but any
 *     `[error] [replication]` lines from the heal window are surfaced for
 *     review, not failed on (some reconnect noise is expected).
 *
 * Run:
 *   HARPER_RUN_STRESS_TESTS=1 \
 *     npm run test:integration -- integrationTests/stress/partitionHealConvergence.test.mjs
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import {
	stressEnabled,
	sendOperation,
	fetchWithRetry,
	concurrent,
	readLog,
	waitForAllConnected,
} from './stressShared.mjs';
import { ReplicationProxy } from './replicationProxy.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

if (!stressEnabled() || process.env.HARPER_STRESS_ALLOW_INSECURE_REPLICATION !== '1') {
	suite('Partition + heal convergence (skipped)', () => {
		test(
			'skipped — blocked on Harper replication TLS hostname validation. ' +
				'See file header for details. Re-enable by setting both ' +
				'HARPER_RUN_STRESS_TESTS=1 and HARPER_STRESS_ALLOW_INSECURE_REPLICATION=1 ' +
				'after Harper adds a replication TLS-skip config option.',
			{ skip: true },
			() => {}
		);
	});
} else {
	const THREADS_PER_NODE = 2;
	const KEYSPACE = Number(process.env.HARPER_STRESS_PARTITION_KEYS ?? 100);
	const PARTITION_SECS = Number(process.env.HARPER_STRESS_PARTITION_SECS ?? 60);
	const PRE_SECS = Number(process.env.HARPER_STRESS_PARTITION_PRE_SECS ?? 30);
	const HEAL_TAIL_SECS = Number(process.env.HARPER_STRESS_PARTITION_HEAL_TAIL_SECS ?? 30);
	const CONVERGE_BUDGET_SECS = Number(process.env.HARPER_STRESS_PARTITION_CONVERGE_BUDGET_SECS ?? 180);
	const SUITE_TIMEOUT_MS = (PRE_SECS + PARTITION_SECS + HEAL_TAIL_SECS + CONVERGE_BUDGET_SECS + 240) * 1000;

	// Side-specific id encodes which side originated the write — partition rows
	// can be recognized later.
	const partitionId = (side, n) => `partition/${side}/${n}`;

	suite('Partition + heal convergence', { timeout: SUITE_TIMEOUT_MS }, (ctx) => {
		before(async () => {
			const aHost = await getNextAvailableLoopbackAddress();
			const bHost = await getNextAvailableLoopbackAddress();
			const proxyForAHost = await getNextAvailableLoopbackAddress();

			ctx.proxy = new ReplicationProxy({
				listenHost: proxyForAHost,
				listenPort: 9933,
				targetHost: aHost,
				targetPort: 9933,
			});
			await ctx.proxy.start();

			const cfg = (host) => ({
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'debug' },
				replication: { securePort: host + ':9933' },
				threads: { count: THREADS_PER_NODE },
			});
			const nodeA = { name: ctx.name, harper: { hostname: aHost } };
			const nodeB = { name: ctx.name, harper: { hostname: bHost } };
			await startHarper(nodeA, {
				config: cfg(aHost),
				env: { HARPER_NO_FLUSH_ON_EXIT: true, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
			});
			await startHarper(nodeB, {
				config: cfg(bHost),
				env: { HARPER_NO_FLUSH_ON_EXIT: true, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
			});
			ctx.nodes = [nodeA.harper, nodeB.harper];

			// Wire B → A through the proxy. Bidirectional WS rides this one socket.
			const tokenA = await sendOperation(ctx.nodes[0], {
				operation: 'create_authentication_tokens',
				authorization: ctx.nodes[0].admin,
			});
			await sendOperation(ctx.nodes[1], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: proxyForAHost,
				authorization: 'Bearer ' + tokenA.operation_token,
			});
			await waitForAllConnected(ctx.nodes[1], { timeoutMs: 60_000 });

			const payload = await targz(join(import.meta.dirname, 'fixture-prerender-workload'));
			await sendOperation(ctx.nodes[0], {
				operation: 'deploy_component',
				project: 'prerender-workload',
				payload,
				replicated: true,
				restart: true,
			});
			await delay(40_000);
			await waitForAllConnected(ctx.nodes[1], { timeoutMs: 90_000 });
		});

		after(async () => {
			if (ctx.nodes) {
				await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n }).catch(() => null)));
			}
			if (ctx.proxy) {
				await ctx.proxy.stop();
			}
		});

		test('split-brain writes converge on identical state after heal', async () => {
			const [A, B] = ctx.nodes;

			// Phase 1: pre-partition baseline — small overlapping churn.
			console.log(`[partition] phase 1 (pre, ${PRE_SECS}s): baseline overlapping churn`);
			let writesA = 0;
			let writesB = 0;
			let phase = 'pre';
			const drive = async (node, side) => {
				let n = side === 'A' ? writesA++ : writesB++;
				let id;
				if (phase === 'pre' || phase === 'heal') {
					id = partitionId('shared', n % Math.max(1, Math.floor(KEYSPACE / 2)));
				} else {
					id = partitionId(side, n % Math.max(1, Math.floor(KEYSPACE / 2)));
				}
				try {
					await fetchWithRetry(node.httpURL + '/Prerender/' + encodeURIComponent(id), { retries: 1 });
				} catch {
					// Partition-induced errors are expected during phase 2
				}
			};
			let stopChurn = false;
			const driverA = concurrent(() => (stopChurn ? null : drive(A, 'A')), 6);
			const driverB = concurrent(() => (stopChurn ? null : drive(B, 'B')), 6);
			const churnLoop = (async () => {
				while (!stopChurn) {
					await Promise.all([driverA.execute(), driverB.execute()]);
					await delay(25);
				}
				await Promise.all([driverA.finish(), driverB.finish()]);
			})();

			await delay(PRE_SECS * 1000);

			// Phase 2: partition.
			phase = 'partition';
			console.log(`[partition] phase 2 (${PARTITION_SECS}s): blocking proxy — split-brain writes`);
			ctx.proxy.block();
			await delay(PARTITION_SECS * 1000);

			// Phase 3: heal.
			phase = 'heal';
			console.log(`[partition] phase 3 (${HEAL_TAIL_SECS}s): unblocking proxy — write tail`);
			ctx.proxy.unblock();
			await delay(HEAL_TAIL_SECS * 1000);

			stopChurn = true;
			await churnLoop;

			console.log(`[partition] churn stopped; total writesA=${writesA} writesB=${writesB}`);

			// Convergence wait — strict equality for record_count after partition.
			const convergeDeadline = Date.now() + CONVERGE_BUDGET_SECS * 1000;
			let counts = { A: -1, B: -1 };
			let convergedAt = null;
			while (Date.now() < convergeDeadline) {
				const [a, b] = await Promise.all([
					sendOperation(A, { operation: 'describe_table', table: 'Prerender' }).catch(() => null),
					sendOperation(B, { operation: 'describe_table', table: 'Prerender' }).catch(() => null),
				]);
				counts = { A: a?.record_count ?? -1, B: b?.record_count ?? -1 };
				if (counts.A > 0 && counts.A === counts.B) {
					convergedAt = Date.now();
					break;
				}
				console.log(`[partition] converge poll: ${JSON.stringify(counts)}`);
				await delay(3000);
			}

			// Per-record sampling — pick a few side-A and side-B partition ids and
			// check that both nodes report the same `random` field (record version
			// proxy). Strict equality required.
			const sampleIds = [];
			for (let i = 0; i < Math.min(5, Math.floor(KEYSPACE / 2)); i++) {
				sampleIds.push(partitionId('A', i));
				sampleIds.push(partitionId('B', i));
				sampleIds.push(partitionId('shared', i));
			}
			const fetchRecord = async (node, id) => {
				try {
					const res = await fetchWithRetry(node.httpURL + '/Prerender/' + encodeURIComponent(id), { retries: 2 });
					if (!res.ok) return null;
					const json = await res.json();
					return json?.random ?? null;
				} catch {
					return null;
				}
			};
			const sampleDiffs = [];
			for (const id of sampleIds) {
				const [vA, vB] = await Promise.all([fetchRecord(A, id), fetchRecord(B, id)]);
				if (vA !== vB) sampleDiffs.push({ id, vA, vB });
			}

			const [logA, logB] = await Promise.all([readLog(A), readLog(B)]);

			// (1) record_count strictly equal post-heal.
			ok(
				convergedAt !== null,
				`A and B did not converge on record_count within ${CONVERGE_BUDGET_SECS}s: ${JSON.stringify(counts)}`
			);
			equal(counts.A, counts.B, `record_count mismatch post-heal: ${JSON.stringify(counts)}`);

			// (2) sampled keys agree.
			ok(
				sampleDiffs.length === 0,
				`${sampleDiffs.length}/${sampleIds.length} sampled keys diverge between A and B: ` +
					JSON.stringify(sampleDiffs.slice(0, 5))
			);

			// (3) no uncaught.
			const uncaughtRe = /\[error\]: uncaughtException/g;
			for (const [name, log] of [
				['A', logA],
				['B', logB],
			]) {
				const u = (log.match(uncaughtRe) ?? []).length;
				ok(u === 0, `${name} logged ${u} uncaughtException across partition/heal`);
			}

			// Surface replication-error counts for review (not fail-on).
			const replErrRe = /\[error\] \[replication\]/g;
			const errA = (logA.match(replErrRe) ?? []).length;
			const errB = (logB.match(replErrRe) ?? []).length;
			console.log(
				`[partition] completed: writesA=${writesA} writesB=${writesB} counts=${JSON.stringify(counts)} ` +
					`replicationErrorLines A=${errA} B=${errB}`
			);
		});
	});
}
