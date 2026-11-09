/**
 * Region topology supplier switches under load (harper-pro#1291), on the 3 regions × 3 nodes of
 * `regionTopologyShared.mjs`.
 *
 * - Each region's preferred gateway is killed (SIGKILL) and restarted in turn while a leaf and the standby gateway of
 *   every region write without pause. While each gateway is down every live node must catch up with every writer, so
 *   its region has moved to the standby. At the end every node holds exactly the rows written, and each writer's
 *   counter, raised by one `add` per row, equals its row count: a frame applied twice would show there.
 * - A leaf's frames from its preferred gateway are held back (a delay on that link only) until its cursors for the
 *   remote origins it takes through that gateway are older than the 60 s per-origin overlap. Both east gateways then
 *   purge their transaction logs to a bound past those cursors and the preferred gateway is killed, dropping the held
 *   frames. The standby must force a base copy (the purge-recovery path) rather than replay from history it no longer
 *   accounts for, and the leaf must end with every row.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition, stopAndTeardownNodes, logMark, readLogSince } from './clusterShared.mjs';
import {
	TABLE,
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
// the leaf's held-back cursors must fall more than the 60 s overlap, plus the margin below the bound, behind
const LAG_MS = 90_000;
const HOLD_MS = 150_000;
const PURGE_MARGIN_MS = 10_000;
const FORCED_COPY = /Peer (\S+) requested replication of database data\b[^\n]*forcing a bounded base-copy resync/g;

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

suite('Region gateway switches under load', { timeout: 1_800_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	let layout;
	const contextOf = (node) => contexts.find((context) => context.harper === node);
	const restart = (context) =>
		startHarper(
			context,
			nodeOptions(context.harper.hostname, layout.region.get(context.harper.hostname), workDir, OPTIONS)
		);

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
		await writeFile(latencyFile(workDir, leaf.hostname), JSON.stringify({ [primary.hostname]: HOLD_MS }));
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
			await writeFile(latencyFile(workDir, leaf.hostname), '{}');
			await writes.stop();
			if (killed) await restart(context);
		}
		await assertExactlyWritten(nodes(), writes);
	});
});
