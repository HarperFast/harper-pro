/**
 * Region topology supplier switches under load (harper-pro#1291), on the 3 regions × 3 nodes of
 * `regionTopologyShared.mjs`.
 *
 * - Each region's preferred gateway is killed (SIGKILL) and restarted in turn while a leaf and the standby gateway of
 *   every region write without pause. While each gateway is down every live node must catch up with every writer, so
 *   its region has moved to the standby. At the end every node holds exactly the rows written, and each writer's
 *   counter, raised by one `add` per row, equals its row count: a frame applied twice would show there.
 * - A leaf's link to its preferred gateway is slowed until its cursors for the remote origins it takes through that
 *   gateway are older than the 60 s per-origin overlap, while frames keep arriving. Both east gateways then
 *   purge their transaction logs to a bound past those cursors and the preferred gateway is killed, dropping the held
 *   frames. The standby must force a base copy (the purge-recovery path) rather than replay from history it no longer
 *   accounts for, and the leaf must end with every row.
 * - A gateway whose own catch-up base copy is still open must relay nothing to a follower it admits meanwhile
 *   (harper-pro#1299). East's preferred gateway and the west gateway that takes east's leaf through it are stopped
 *   while the leaf writes; the leaf's log is purged, so the restarted gateway catches up by a base copy, whose settle
 *   the test holds while the leaf keeps writing. The west gateway, able to reach only that gateway, is restarted into
 *   the open pass, and must end with every row the copy applied as well as the later ones.
 * - The same gateway killed while its pass is held at COPY_START, then restarted, settles a new pass and relays again:
 *   the lease lives in process memory, and an interrupted pass leaves nothing that withholds relaying.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition, stopAndTeardownNodes, logMark, readLogSince } from './clusterShared.mjs';
import {
	TABLE,
	insert,
	dataLinks,
	partitionFile,
	latencyFile,
	nodeOptions,
	startNode,
	connectTo,
	killNode,
	phaseIds,
	waitForLinks,
	waitForPhase,
	waitForSuppliers,
	regionLayout,
} from './regionTopologyShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const OPTIONS = { replicationLogLevel: 'info' };
const WRITE_INTERVAL_MS = 200;
const KILL_ORDER = ['east', 'west', 'eu', 'east'];
// The leaf's link to its gateway is slowed a little more each second (latency RAMP × elapsed), so frames keep
// arriving and the link stays live, yet after LAG_MS the leaf holds the gateway's frames from (1 - 1 / (1 + RAMP)) ×
// LAG_MS ago: 90 s, more than the 60 s per-origin overlap plus the margin below the purge bound. A flat delay over
// 60 s would leave the link silent long enough for the leaf to mark it down and switch before the purge.
const RAMP = 3;
const LAG_MS = 120_000;
const PURGE_MARGIN_MS = 10_000;
const FORCED_COPY = /Peer (\S+) requested replication of database data\b[^\n]*forcing a bounded base-copy resync/g;
const COPIED_ROWS = 40;

const rowId = (phase, writer, seq) => `${phase}-${writer}-${seq}`;
const counterId = (phase, writer) => `${phase}-counter-${writer}`;

/**
 * Each writer inserts one row and adds 1 to its own counter every WRITE_INTERVAL_MS. `acked` counts the pairs the
 * writer acknowledged; any failed write fails the test.
 */
async function startWriters(nodes, writers, phase) {
	await sendOperation(writers[0], {
		operation: 'insert',
		database: 'data',
		table: TABLE,
		records: writers.map((node) => ({
			id: counterId(phase, node.hostname),
			phase: `${phase}-counter`,
			origin: node.hostname,
			count: 0,
		})),
	});
	await waitForPhase(nodes, `${phase}-counter`, writers.length);
	const acked = new Map(writers.map((node) => [node.hostname, 0]));
	let stopped = false;
	let failure;
	const loops = writers.map(async (node) => {
		for (let seq = 0; !stopped; seq++) {
			await sendOperation(node, {
				operation: 'insert',
				database: 'data',
				table: TABLE,
				records: [{ id: rowId(phase, node.hostname, seq), phase, origin: node.hostname }],
			});
			await sendOperation(node, {
				operation: 'update',
				database: 'data',
				table: TABLE,
				records: [{ id: counterId(phase, node.hostname), count: { __op__: 'add', value: 1 } }],
			});
			acked.set(node.hostname, seq + 1);
			await delay(WRITE_INTERVAL_MS);
		}
	});
	const settled = Promise.all(loops.map((loop) => loop.catch((error) => (failure ??= error))));
	return {
		phase,
		acked,
		check() {
			if (failure) throw failure;
		},
		async stop() {
			stopped = true;
			await settled;
			if (failure) throw failure;
		},
	};
}

/** Waits until every node holds every row `writes` acknowledged up to `due` (writer → count). */
async function waitForRows(nodes, writes, due, description) {
	const missing = {};
	await waitForCondition(
		async (signal) => {
			writes.check();
			for (const node of nodes) {
				let ids;
				try {
					ids = await phaseIds(node, writes.phase, signal);
				} catch (error) {
					// a node that is restarting refuses the connection for a moment
					missing[node.hostname] = `query failed: ${error.message}`;
					continue;
				}
				const byWriter = {};
				for (const [writer, acked] of due) {
					let count = 0;
					for (let seq = 0; seq < acked; seq++) if (!ids.has(rowId(writes.phase, writer, seq))) count++;
					if (count) byWriter[writer] = `${count} of ${acked}`;
				}
				if (Object.keys(byWriter).length) missing[node.hostname] = byWriter;
				else delete missing[node.hostname];
			}
			return Object.keys(missing).length === 0;
		},
		{ timeoutMs: 180_000, pollMs: 1000, description: () => `${description}; missing rows: ${JSON.stringify(missing)}` }
	);
}

/** One row every WRITE_INTERVAL_MS from `node` until stopped; `acked` counts the rows it acknowledged. */
function startRowWriter(node, phase) {
	let stopped = false;
	let acked = 0;
	let failure;
	const loop = (async () => {
		for (let seq = 0; !stopped; seq++) {
			await sendOperation(node, {
				operation: 'insert',
				database: 'data',
				table: TABLE,
				records: [{ id: `${phase}-${seq}`, phase, origin: node.hostname }],
			});
			acked = seq + 1;
			await delay(WRITE_INTERVAL_MS);
		}
	})().catch((error) => (failure = error));
	return {
		async stop() {
			stopped = true;
			await loop;
			if (failure) throw failure;
			return acked;
		},
	};
}

/** After `writes` stopped: every node holds exactly the acknowledged rows, and each counter equals its writer's rows. */
async function assertExactlyWritten(nodes, writes) {
	await waitForRows(nodes, writes, writes.acked, `every node holds every ${writes.phase} row`);
	const total = [...writes.acked.values()].reduce((sum, count) => sum + count, 0);
	for (const node of nodes) {
		const ids = await phaseIds(node, writes.phase);
		assert.equal(ids.size, total, `${node.hostname} holds ${ids.size} ${writes.phase} rows, ${total} were written`);
		const counters = await sendOperation(node, {
			operation: 'search_by_id',
			database: 'data',
			table: TABLE,
			ids: [...writes.acked.keys()].map((writer) => counterId(writes.phase, writer)),
			get_attributes: ['id', 'origin', 'count'],
		});
		for (const { origin, count } of counters) {
			assert.equal(
				count,
				writes.acked.get(origin),
				`${node.hostname} counts ${count} adds from ${origin}, which made ${writes.acked.get(origin)}`
			);
		}
	}
}

suite('Region gateway switches under load', { timeout: 2_700_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	let layout;
	const contextOf = (node) => contexts.find((context) => context.harper === node);
	const restart = (context, env) =>
		startHarper(
			context,
			nodeOptions(context.harper.hostname, layout.region.get(context.harper.hostname), workDir, { ...OPTIONS, env })
		);
	/** `node` receives replication data from `reachable` alone. */
	const cutOffAllBut = (node, reachable) =>
		writeFile(
			partitionFile(workDir, node.hostname),
			JSON.stringify(
				nodes()
					.map(({ hostname }) => hostname)
					.filter((name) => name !== node.hostname && name !== reachable.hostname)
			)
		);
	/**
	 * East's preferred gateway and west's, which can reach only it, are stopped while east's leaf writes `phase`; the
	 * leaf's log is then purged past the gateway's cursor. The gateway, which can then reach only the leaf, catches up by
	 * a base copy from it: no other peer's log can hand it those rows first.
	 */
	async function stopRelayAndFollowerAcrossPurge(phase) {
		const relay = layout.named('east', 0);
		const follower = layout.named('west', 0);
		const leaf = layout.named('east', 2);
		await waitForSuppliers(nodes(), layout.steadySuppliers(), 'settled suppliers');
		await cutOffAllBut(follower, relay);
		await waitForSuppliers(
			nodes(),
			(node) => new Map(node === follower ? [[leaf.hostname, [relay.hostname]]] : []),
			`${follower.hostname} takes ${leaf.hostname} from ${relay.hostname}`
		);
		await killNode(relay);
		await killNode(follower);
		await insert(leaf, phase, leaf.hostname, COPIED_ROWS);
		// a copy starts at the source's last transaction and applies that one with a log entry: keep `phase` below it
		await insert(leaf, `${phase}-after`, leaf.hostname, 1);
		await waitForPhase([layout.named('east', 1)], `${phase}-after`, 1);
		await delay(1000);
		await sendOperation(leaf, { operation: 'delete_transaction_logs_before', database: 'data', timestamp: Date.now() });
		await cutOffAllBut(relay, leaf);
		return { relay: contextOf(relay), follower: contextOf(follower), leaf };
	}
	const reconnectAll = (...contexts) =>
		Promise.all(contexts.map(({ harper }) => writeFile(partitionFile(workDir, harper.hostname), '[]')));
	async function holdDirectory(name) {
		const directory = join(workDir, name);
		await mkdir(directory, { recursive: true });
		return directory;
	}
	const waitForHold = (directory, description) =>
		waitForCondition(() => existsSync(join(directory, 'held')), { timeoutMs: 120_000, description });
	const waitForLink = (node, peer) =>
		waitForCondition(async (signal) => (await dataLinks(node, signal)).has(peer.hostname), {
			timeoutMs: 120_000,
			description: `${node.hostname} connected to ${peer.hostname}`,
		});

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'region-switch-'));
		const hostnames = [];
		for (let i = 0; i < 9; i++) hostnames.push(await getNextAvailableLoopbackAddress());
		hostnames.sort();
		layout = regionLayout(hostnames, nodes);
		const started = await Promise.allSettled(
			hostnames.map((name) => startNode(ctx.name, name, layout.region.get(name), workDir, OPTIONS))
		);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		contexts.sort((a, b) => (a.harper.hostname < b.harper.hostname ? -1 : 1));
		await connectTo(nodes()[0], nodes());
		await waitForLinks(nodes(), layout.expectedLinks, 'region links');
	});

	after(async () => {
		await stopAndTeardownNodes(nodes());
		if (workDir) await rm(workDir, { recursive: true, force: true });
	});

	test('repeated kills of a preferred gateway under writes from every region lose and duplicate nothing', async () => {
		const writers = ['east', 'west', 'eu'].flatMap((name) => [layout.named(name, 1), layout.named(name, 2)]);
		const writes = await startWriters(nodes(), writers, 'churn');
		try {
			for (const regionName of KILL_ORDER) {
				await waitForSuppliers(
					nodes(),
					layout.steadySuppliers(),
					`settled suppliers before killing ${regionName}'s gateway`
				);
				const context = contextOf(layout.named(regionName, 0));
				const gateway = context.harper;
				await killNode(gateway);
				// rows written after the kill reach the region's leaf only through the standby
				await delay(5000);
				await waitForRows(
					nodes().filter((node) => node !== gateway),
					writes,
					new Map(writes.acked),
					`every live node caught up while ${regionName}'s preferred gateway ${gateway.hostname} is down`
				);
				await restart(context);
				await waitForRows(nodes(), writes, new Map(writes.acked), `${gateway.hostname} caught up after its restart`);
			}
		} finally {
			await writes.stop();
		}
		await assertExactlyWritten(nodes(), writes);
	});

	test('a leaf behind purged history moves to the standby through a base copy and loses nothing', async () => {
		const primary = layout.named('east', 0);
		const standby = layout.named('east', 1);
		const leaf = layout.named('east', 2);
		const writer = layout.named('west', 2);
		const context = contextOf(primary);
		await waitForSuppliers(nodes(), layout.steadySuppliers(), 'settled suppliers');
		// the standby's own rows keep the leaf's position on its link to the standby current
		const writes = await startWriters(nodes(), [writer, standby], 'held');
		const slowedAt = Date.now();
		const slow = setInterval(
			() =>
				writeFile(
					latencyFile(workDir, leaf.hostname),
					JSON.stringify({ [primary.hostname]: (Date.now() - slowedAt) * RAMP })
				).catch(() => {}),
			1000
		);
		let killed = false;
		try {
			await delay(LAG_MS);
			const mark = await logMark(standby);
			const bound = Date.now() - PURGE_MARGIN_MS;
			for (const gateway of [primary, standby]) {
				await sendOperation(gateway, {
					operation: 'delete_transaction_logs_before',
					database: 'data',
					timestamp: bound,
				});
			}
			await killNode(primary);
			killed = true;
			await delay(5000);
			await waitForRows(
				nodes().filter((node) => node !== primary),
				writes,
				new Map(writes.acked),
				`every live node holds the held rows after ${leaf.hostname} moved to ${standby.hostname}`
			).catch(async (error) => {
				const status = await sendOperation(leaf, { operation: 'cluster_status' }).catch((cause) => cause.message);
				error.message += `; ${leaf.hostname} cluster_status: ${JSON.stringify(status)}`;
				throw error;
			});
			const forced = [...(await readLogSince(standby, mark)).matchAll(FORCED_COPY)];
			assert.ok(
				forced.some(([, peer]) => peer === leaf.hostname),
				`${standby.hostname} forced no base copy for ${leaf.hostname}: ${JSON.stringify(forced.map(([line]) => line))}`
			);
		} finally {
			clearInterval(slow);
			await writeFile(latencyFile(workDir, leaf.hostname), '{}');
			await writes.stop();
			if (killed) await restart(context);
		}
		await assertExactlyWritten(nodes(), writes);
	});

	test("a follower admitted during a gateway's own base copy ends with every row the copy applied", async () => {
		const { relay, follower, leaf } = await stopRelayAndFollowerAcrossPurge('open-copied');
		const hold = await holdDirectory('settle-hold');
		const leafMark = await logMark(leaf);
		await restart(relay, {
			HARPER_TEST_HOLD_COPY_SETTLE_DIR: hold,
			HARPER_TEST_HOLD_COPY_SETTLE_DB: 'data',
			HARPER_TEST_HOLD_COPY_SETTLE_PEER: leaf.hostname,
		});
		await waitForHold(hold, `${relay.harper.hostname} holding the settle of its base copy from ${leaf.hostname}`);
		const forcedOnRelay = [...(await readLogSince(leaf, leafMark)).matchAll(FORCED_COPY)];
		assert.ok(
			forcedOnRelay.some(([, peer]) => peer === relay.harper.hostname),
			`${leaf.hostname} forced no base copy for ${relay.harper.hostname}`
		);
		// logged by the gateway as its log tail while the pass stays open
		const tail = startRowWriter(leaf, 'open-tail');
		let tailRows;
		try {
			await restart(follower);
			await waitForLink(follower.harper, relay.harper);
			await delay(8000);
			const relayMark = await logMark(relay.harper);
			await writeFile(join(hold, 'release'), '');
			await waitForCondition(
				async () =>
					[...(await readLogSince(relay.harper, relayMark)).matchAll(FORCED_COPY)].some(
						([, peer]) => peer === follower.harper.hostname
					),
				{
					timeoutMs: 120_000,
					description: `${relay.harper.hostname} forcing a base copy for ${follower.harper.hostname} once its own settled`,
				}
			);
		} finally {
			tailRows = await tail.stop();
			await reconnectAll(relay, follower);
		}
		await waitForPhase(nodes(), 'open-copied', COPIED_ROWS);
		await waitForPhase(nodes(), 'open-tail', tailRows);
	});

	test('a gateway killed during its base copy settles a new one after its restart and relays again', async () => {
		const { relay, follower, leaf } = await stopRelayAndFollowerAcrossPurge('restart-copied');
		const hold = await holdDirectory('start-hold');
		await restart(relay, {
			HARPER_TEST_HOLD_COPY_START_DIR: hold,
			HARPER_TEST_HOLD_COPY_START_DB: 'data',
			HARPER_TEST_HOLD_COPY_START_PEER: leaf.hostname,
		});
		await waitForHold(hold, `${relay.harper.hostname} holding COPY_START from ${leaf.hostname}`);
		try {
			await restart(follower);
			await waitForLink(follower.harper, relay.harper);
			await killNode(relay.harper);
			await restart(relay);
			const later = await insert(leaf, 'restart-later', leaf.hostname, 20);
			// the follower reaches no other peer, so these rows came through the restarted gateway
			await waitForPhase([follower.harper], 'restart-later', later.length);
		} finally {
			await reconnectAll(relay, follower);
		}
		await waitForPhase(nodes(), 'restart-copied', COPIED_ROWS);
		await waitForPhase(nodes(), 'restart-later', 20);
	});
});
