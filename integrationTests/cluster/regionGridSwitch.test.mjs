/**
 * Region grid supplier switches under load (harper-pro#1343), on the 3 regions × 3 nodes of
 * `regionTopologyShared.mjs`. A carrier is the node of a region that receives a column's origins from the other
 * regions and relays them to its region-mates.
 *
 * - One node of each region, the carrier of a column whose two remote nodes write, is killed (SIGKILL) and restarted
 *   in turn while two nodes of every region write without pause. While each is down every live node must catch up with
 *   every writer, so its region's lowest-named node has taken the column by direct links. At the end every node holds
 *   exactly the rows written, and each writer's counter, raised by one `add` per row, equals its row count: a frame
 *   applied twice would show there.
 * - A follower's link to its carrier is slowed until its cursors for the remote origin it takes through that carrier
 *   are older than the 60 s per-origin overlap, while frames keep arriving. The carrier and the node that will stand
 *   in for it then purge their transaction logs to a bound past those cursors and the carrier is killed, dropping the
 *   held frames. The stand-in must force a base copy (the purge-recovery path) rather than replay from history it no
 *   longer accounts for, and the follower must end with every row.
 * - A carrier whose own catch-up base copy is still open must relay nothing to a follower it admits meanwhile
 *   (harper-pro#1299). An origin's carrier in another region and a follower of that carrier are stopped while the
 *   origin writes; the origin's log is purged, so the restarted carrier catches up by a base copy, whose settle the
 *   test holds while the origin keeps writing. The follower, able to reach only that carrier, is restarted into the
 *   open pass, and must end with every row the copy applied as well as the later ones.
 * - The same carrier killed after its pass applied rows and logged its tail, then restarted cut off from its source:
 *   the follower admitted before a new pass settles must still end with every row, since the reservation the killed
 *   pass left holds relaying back until a later pass from that source settles.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	sendOperation,
	waitForCondition,
	stopAndTeardownNodes,
	logMark,
	readLogSince,
	hdbLogPath,
} from './clusterShared.mjs';
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
	waitForCopiesSettled,
	waitForLinks,
	waitForPhase,
	waitForSuppliers,
	regionLayout,
} from './regionTopologyShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const OPTIONS = { replicationLogLevel: 'info' };
const WRITE_INTERVAL_MS = 200;
// [region, lane] of each node killed in turn; the other two nodes of every region write, so each killed node's column
// has a writer in both other regions
const KILL_ORDER = [
	['east', 2],
	['west', 0],
	['eu', 1],
	['east', 2],
];
const WRITER_LANES = { east: [0, 1], west: [1, 2], eu: [0, 2] };
// The follower's link to its carrier is slowed a little more each second (latency RAMP × elapsed), so frames keep
// arriving and the link stays live, yet after LAG_MS the follower holds the carrier's frames from (1 - 1 / (1 + RAMP)) ×
// LAG_MS ago: 90 s, more than the 60 s per-origin overlap plus the margin below the purge bound. A flat delay over
// 60 s would leave the link silent long enough for the follower to mark it down and switch before the purge.
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
	const marks = new Map(await Promise.all(nodes.map(async (node) => [node.hostname, await logMark(node)])));
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
		marks,
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

/** Forced `data` copies any node logged since the writes began, before and after the one restart a node may have had. */
async function forcedCopiesDuring(nodes, writes) {
	const forced = [];
	for (const node of nodes) {
		const mark = writes.marks.get(node.hostname);
		const path = await hdbLogPath(node);
		let text = (await readFile(mark.path, 'utf8')).slice(mark.length);
		if (path !== mark.path) text += await readFile(path, 'utf8');
		forced.push(...[...text.matchAll(FORCED_COPY)].map(([line]) => `${node.hostname}: ${line}`));
	}
	return forced;
}

/**
 * After `writes` stopped: every node holds exactly the acknowledged rows, and each counter equals its writer's rows.
 * A counter can trail its rows while a base copy still applies (rows sort before counters), so short counts are waited
 * out; a count above the writes never comes back down. A copy forced while the writes ran can count an increment
 * twice (harper#4174), so a high count fails only when no node logged one.
 */
async function assertExactlyWritten(nodes, writes) {
	await waitForRows(nodes, writes, writes.acked, `every node holds every ${writes.phase} row`);
	const total = [...writes.acked.values()].reduce((sum, count) => sum + count, 0);
	for (const node of nodes) {
		const ids = await phaseIds(node, writes.phase);
		assert.equal(ids.size, total, `${node.hostname} holds ${ids.size} ${writes.phase} rows, ${total} were written`);
	}
	const forced = await forcedCopiesDuring(nodes, writes);
	let short = [];
	let high = [];
	await waitForCondition(
		async (signal) => {
			short = [];
			high = [];
			for (const node of nodes) {
				const counters = await sendOperation(
					node,
					{
						operation: 'search_by_id',
						database: 'data',
						table: TABLE,
						ids: [...writes.acked.keys()].map((writer) => counterId(writes.phase, writer)),
						get_attributes: ['id', 'origin', 'count'],
					},
					{ signal }
				);
				for (const { origin, count } of counters) {
					const made = writes.acked.get(origin);
					const line = `${node.hostname} counts ${count} adds from ${origin}, which made ${made}`;
					assert.ok(!(count > made) || forced.length, line);
					if (count > made) high.push(line);
					else if (count !== made) short.push(line);
				}
			}
			return short.length === 0;
		},
		{ timeoutMs: 60_000, pollMs: 1000, description: () => `every counter equals its writes; ${short.join('; ')}` }
	);
	if (high.length)
		console.log(
			`counted above the writes after copies forced during them (harper#4174): ${high.join('; ')}\n${forced.join('\n')}`
		);
}

suite('Region grid switches under load', { timeout: 2_700_000 }, (ctx) => {
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
	 * West's carrier of an east node's column, and a follower of it that can reach only it, are stopped while that east
	 * node writes `phase`; its log is then purged past the carrier's cursor. The carrier, which can then reach only that
	 * origin, catches up by a base copy from it: no other peer's log can hand it those rows first.
	 */
	async function stopRelayAndFollowerAcrossPurge(phase) {
		const origin = layout.named('east', 2);
		const relay = layout.named('west', 2);
		const follower = layout.named('west', 0);
		await waitForSuppliers(nodes(), layout.steadySuppliers(), 'settled suppliers');
		// a route that never carried the origin starts it at the merged start on a switch (harper-pro#1300)
		await insert(origin, `${phase}-seed`, origin.hostname, 1);
		await waitForPhase(nodes(), `${phase}-seed`, 1);
		await cutOffAllBut(follower, relay);
		await waitForSuppliers(
			nodes(),
			(node) => new Map(node === follower ? [[origin.hostname, [relay.hostname]]] : []),
			`${follower.hostname} takes ${origin.hostname} from ${relay.hostname}`
		);
		await killNode(relay);
		await killNode(follower);
		// west's remaining node takes both columns by direct links before the purge, so only the stopped pair needs a copy
		const down = new Set([relay.hostname, follower.hostname]);
		await waitForSuppliers(
			nodes().filter((node) => !down.has(node.hostname)),
			layout.steadySuppliers(down),
			`suppliers without ${relay.hostname} and ${follower.hostname}`
		);
		await insert(origin, phase, origin.hostname, COPIED_ROWS);
		// a copy starts at the source's last transaction and applies that one with a log entry: keep `phase` below it
		await insert(origin, `${phase}-after`, origin.hostname, 1);
		await waitForPhase([layout.named('east', 1)], `${phase}-after`, 1);
		await delay(1000);
		await sendOperation(origin, {
			operation: 'delete_transaction_logs_before',
			database: 'data',
			timestamp: Date.now(),
		});
		await cutOffAllBut(relay, origin);
		return { relay: contextOf(relay), follower: contextOf(follower), origin };
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
		// an increment written while a base copy applies can be counted twice (harper#4174), which these tests do not cover
		await waitForCopiesSettled(nodes(), 'formation copies');
	});

	after(async () => {
		await stopAndTeardownNodes(nodes());
		if (workDir) await rm(workDir, { recursive: true, force: true });
	});

	test("a follower admitted during a carrier's own base copy ends with every row the copy applied", async () => {
		const { relay, follower, origin } = await stopRelayAndFollowerAcrossPurge('open-copied');
		const hold = await holdDirectory('settle-hold');
		const leafMark = await logMark(origin);
		await restart(relay, {
			HARPER_TEST_HOLD_COPY_SETTLE_DIR: hold,
			HARPER_TEST_HOLD_COPY_SETTLE_DB: 'data',
			HARPER_TEST_HOLD_COPY_SETTLE_PEER: origin.hostname,
		});
		await waitForHold(hold, `${relay.harper.hostname} holding the settle of its base copy from ${origin.hostname}`);
		const forcedOnRelay = [...(await readLogSince(origin, leafMark)).matchAll(FORCED_COPY)];
		assert.ok(
			forcedOnRelay.some(([, peer]) => peer === relay.harper.hostname),
			`${origin.hostname} forced no base copy for ${relay.harper.hostname}`
		);
		// logged by the carrier as its log tail while the pass stays open
		const tail = startRowWriter(origin, 'open-tail');
		let tailRows;
		let tailStopped = false;
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
			tailRows = await tail.stop();
			tailStopped = true;
			await waitForPhase([follower.harper], 'open-copied', COPIED_ROWS);
			await waitForPhase([follower.harper], 'open-tail', tailRows);
		} finally {
			if (!tailStopped) tailRows = await tail.stop();
			await reconnectAll(relay, follower);
		}
		await waitForPhase(nodes(), 'open-copied', COPIED_ROWS);
		await waitForPhase(nodes(), 'open-tail', tailRows);
	});

	test('a follower admitted after its carrier restarts mid-copy, before a new copy settles, ends with every row', async () => {
		const { relay, follower, origin } = await stopRelayAndFollowerAcrossPurge('restart-copied');
		const hold = await holdDirectory('restart-settle-hold');
		await restart(relay, {
			HARPER_TEST_HOLD_COPY_SETTLE_DIR: hold,
			HARPER_TEST_HOLD_COPY_SETTLE_DB: 'data',
			HARPER_TEST_HOLD_COPY_SETTLE_PEER: origin.hostname,
		});
		await waitForHold(hold, `${relay.harper.hostname} holding the settle of its base copy from ${origin.hostname}`);
		// logged by the carrier as its copy's tail, above rows the copy applied without log entries
		const tail = startRowWriter(origin, 'restart-tail');
		let tailRows;
		let tailStopped = false;
		try {
			await delay(5000);
			await killNode(relay.harper);
			// cut off from its source, so no new copy starts before the follower is admitted
			await writeFile(
				partitionFile(workDir, relay.harper.hostname),
				JSON.stringify(
					nodes()
						.map(({ hostname }) => hostname)
						.filter((name) => name !== relay.harper.hostname)
				)
			);
			await restart(relay);
			await restart(follower);
			await waitForLink(follower.harper, relay.harper);
			await delay(8000);
			const relayMark = await logMark(relay.harper);
			await cutOffAllBut(relay.harper, origin);
			await waitForCondition(
				async () =>
					[...(await readLogSince(relay.harper, relayMark)).matchAll(FORCED_COPY)].some(
						([, peer]) => peer === follower.harper.hostname
					),
				{
					timeoutMs: 180_000,
					description: `${relay.harper.hostname} forcing a base copy for ${follower.harper.hostname} once a new copy settled`,
				}
			);
			tailRows = await tail.stop();
			tailStopped = true;
			await waitForPhase([follower.harper], 'restart-copied', COPIED_ROWS);
			await waitForPhase([follower.harper], 'restart-tail', tailRows);
			// the follower reaches no other peer, so these rows came through the restarted carrier
			const later = await insert(origin, 'restart-later', origin.hostname, 20);
			await waitForPhase([follower.harper], 'restart-later', later.length);
		} finally {
			if (!tailStopped) tailRows = await tail.stop();
			await reconnectAll(relay, follower);
		}
		await waitForPhase(nodes(), 'restart-copied', COPIED_ROWS);
		await waitForPhase(nodes(), 'restart-tail', tailRows);
		await waitForPhase(nodes(), 'restart-later', 20);
	});

	test('repeated kills of a carrier under writes from every region lose and duplicate nothing', async () => {
		const writers = Object.entries(WRITER_LANES).flatMap(([name, lanes]) =>
			lanes.map((lane) => layout.named(name, lane))
		);
		await waitForCopiesSettled(nodes(), 'base copies the earlier tests forced');
		const writes = await startWriters(nodes(), writers, 'churn');
		try {
			for (const [regionName, lane] of KILL_ORDER) {
				await waitForSuppliers(
					nodes(),
					layout.steadySuppliers(),
					`settled suppliers before killing ${regionName} ${lane}`
				);
				const context = contextOf(layout.named(regionName, lane));
				const carrier = context.harper;
				await killNode(carrier);
				// rows written after the kill reach the rest of the region only through the node that takes the column
				await delay(5000);
				await waitForRows(
					nodes().filter((node) => node !== carrier),
					writes,
					new Map(writes.acked),
					`every live node caught up while ${regionName}'s carrier ${carrier.hostname} is down`
				);
				await restart(context);
				await waitForRows(nodes(), writes, new Map(writes.acked), `${carrier.hostname} caught up after its restart`);
			}
		} finally {
			await writes.stop();
		}
		await assertExactlyWritten(nodes(), writes);
	});

	test('a follower behind purged history moves to the stand-in through a base copy and loses nothing', async () => {
		const carrier = layout.named('east', 2);
		const standIn = layout.named('east', 0);
		const follower = layout.named('east', 1);
		const writer = layout.named('west', 2);
		const context = contextOf(carrier);
		await waitForSuppliers(nodes(), layout.steadySuppliers(), 'settled suppliers');
		// the stand-in's own rows keep the follower's position on its link to the stand-in current
		const writes = await startWriters(nodes(), [writer, standIn], 'held');
		const slowedAt = Date.now();
		const slow = setInterval(
			() =>
				writeFile(
					latencyFile(workDir, follower.hostname),
					JSON.stringify({ [carrier.hostname]: (Date.now() - slowedAt) * RAMP })
				).catch(() => {}),
			1000
		);
		let killed = false;
		try {
			await delay(LAG_MS);
			const mark = await logMark(standIn);
			const bound = Date.now() - PURGE_MARGIN_MS;
			for (const relay of [carrier, standIn]) {
				await sendOperation(relay, {
					operation: 'delete_transaction_logs_before',
					database: 'data',
					timestamp: bound,
				});
			}
			await killNode(carrier);
			killed = true;
			await delay(5000);
			await waitForRows(
				nodes().filter((node) => node !== carrier),
				writes,
				new Map(writes.acked),
				`every live node holds the held rows after ${follower.hostname} moved to ${standIn.hostname}`
			).catch(async (error) => {
				const status = await sendOperation(follower, { operation: 'cluster_status' }).catch((cause) => cause.message);
				error.message += `; ${follower.hostname} cluster_status: ${JSON.stringify(status)}`;
				throw error;
			});
			const forced = [...(await readLogSince(standIn, mark)).matchAll(FORCED_COPY)];
			assert.ok(
				forced.some(([, peer]) => peer === follower.hostname),
				`${standIn.hostname} forced no base copy for ${follower.hostname}: ${JSON.stringify(forced.map(([line]) => line))}`
			);
		} finally {
			clearInterval(slow);
			await writeFile(latencyFile(workDir, follower.hostname), '{}');
			await writes.stop();
			if (killed) await restart(context);
		}
		await assertExactlyWritten(nodes(), writes);
	});
});
