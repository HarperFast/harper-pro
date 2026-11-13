/**
 * Nodes joining a region grid (harper-pro#1343) by base copy. Lanes are ranked by name, so each joiner is given a name
 * that sorts second in its region: it takes that lane, the two nodes after it move one lane up, and the last one lands
 * in a column the other regions have no node in, which they fold onto their first node. Every moved node then
 * subscribes directly to origins it had taken through a region-mate, and stops subscribing to others.
 *
 * A join into a quiet cluster must cost one base copy into the joiner and the copy each peer that subscribes to the
 * joiner takes from it, and nothing more: a link that becomes direct resumes from the position of the supplier it
 * replaces, and no node downstream of a copy is forced into one.
 *
 * A join under writes must lose nothing. It can cost more copies: the joiner's region-mates copy from it, a write that
 * reaches one of them in that copy has no log entry there, and a follower that has not received the write yet is then
 * sent a copy instead of a replay (the copy-bound gate). The second test reports how many.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, readLogSince } from './clusterShared.mjs';
import {
	REGIONS,
	startNode,
	connectTo,
	waitForLinks,
	waitForCopiesSettled,
	TABLE,
	insert,
	waitForPhase,
	waitForSuppliers,
	markAll,
	regionLayout,
} from './regionTopologyShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

// a link that becomes direct for an origin that has written nothing starts from the floor the replaced supplier
// certified for it; the default interval is 30 s
const FLOOR_INTERVAL_MS = 1000;
const OPTIONS = {
	replicationLogLevel: 'info',
	env: { HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: String(FLOOR_INTERVAL_MS) },
};
const FORCED_COPY = /Peer (\S+) requested replication of database data\b[^\n]*forcing a bounded base-copy resync/g;
const REQUESTED_COPY = /Requesting full copy of database data from (\S+)/g;

const WRITE_INTERVAL_MS = 200;

/**
 * Each writer inserts a row of `phase` every WRITE_INTERVAL_MS until stopped. `stop` resolves how many each wrote, or
 * rejects with the first write that failed.
 */
function startRowWriters(writers, phase) {
	let stopped = false;
	let failure;
	const loops = writers.map(async (writer) => {
		let written = 0;
		try {
			for (; !stopped; written++) {
				await sendOperation(writer, {
					operation: 'insert',
					database: 'data',
					table: TABLE,
					records: [
						{
							id: `${phase}-${writer.hostname}-${written}`,
							phase: `${phase}-${writer.hostname}`,
							origin: writer.hostname,
						},
					],
				});
				await delay(WRITE_INTERVAL_MS);
			}
		} catch (error) {
			// caught here, not at stop: the join can still be running when a write fails
			failure ??= error;
			stopped = true;
		}
		return written;
	});
	return {
		async stop() {
			stopped = true;
			const written = await Promise.all(loops);
			if (failure) throw failure;
			return written;
		},
	};
}

suite('Nodes joining a region grid', { timeout: 1_800_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	let quietJoiner;
	let busyJoiner;
	let layouts;

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'region-join-'));
		const hostnames = [];
		for (let i = 0; i < 11; i++) hostnames.push(await getNextAvailableLoopbackAddress());
		hostnames.sort();
		// second in east, and second in west once east has four
		quietJoiner = hostnames[1];
		busyJoiner = hostnames[5];
		const initial = hostnames.filter((name) => name !== quietJoiner && name !== busyJoiner);
		const regionOf = new Map(initial.map((name, index) => [name, REGIONS[Math.floor(index / 3)]]));
		const withQuiet = new Map([...regionOf, [quietJoiner, REGIONS[0]]]);
		layouts = {
			regionOf,
			initial: regionLayout(initial, nodes, regionOf),
			afterQuiet: regionLayout([...withQuiet.keys()], nodes, withQuiet),
			afterBusy: regionLayout(hostnames, nodes, new Map([...withQuiet, [busyJoiner, REGIONS[1]]])),
		};
		const started = await Promise.allSettled(
			initial.map((name) => startNode(ctx.name, name, regionOf.get(name), workDir, OPTIONS))
		);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		contexts.sort((a, b) => (a.harper.hostname < b.harper.hostname ? -1 : 1));
		await connectTo(nodes()[0], nodes());
		await waitForLinks(nodes(), layouts.initial.expectedLinks, 'grid links before the joins');
		await waitForCopiesSettled(nodes(), 'formation copies');
		await waitForSuppliers(nodes(), layouts.initial.steadySuppliers(), 'settled suppliers before the joins');
	});

	after(async () => {
		await stopAndTeardownNodes(nodes());
		if (workDir) await rm(workDir, { recursive: true, force: true });
	});

	/** Starts `name` in `region` and returns it once the grid has settled on `layout`. */
	async function joinGrid(name, region, layout) {
		const existing = nodes();
		contexts.push(await startNode(ctx.name, name, region, workDir, OPTIONS));
		const joiner = contexts.at(-1).harper;
		await connectTo(existing[0], [joiner]);
		await waitForLinks(nodes(), layout.expectedLinks, `grid links after ${name} joined`);
		await waitForCopiesSettled(nodes(), `copies of ${name} joining`);
		await waitForSuppliers(nodes(), layout.steadySuppliers(), `settled suppliers after ${name} joined`);
		return joiner;
	}

	/** The base copies `existing` nodes forced on, or asked of, a node other than `joiner` since `marks`. */
	async function copiesBeyond(joiner, existing, marks) {
		const copies = [];
		for (const node of existing) {
			const log = await readLogSince(node, marks.get(node.hostname));
			for (const [line, peer] of log.matchAll(FORCED_COPY))
				if (peer !== joiner.hostname) copies.push(`${node.hostname} forced a base copy: ${line}`);
			for (const [line, source] of log.matchAll(REQUESTED_COPY))
				if (URL.parse(source)?.hostname !== joiner.hostname) copies.push(`${node.hostname} asked for one: ${line}`);
		}
		return copies;
	}

	test('a join into a quiet cluster costs no base copy beyond the joiner', async () => {
		const existing = nodes();
		// one writer per column, so every link that becomes direct in the join carries an origin that has written
		const { initial } = layouts;
		const writers = [initial.named('east', 0), initial.named('west', 1), initial.named('eu', 2)];
		for (const writer of writers) await insert(writer, `before-join-${writer.hostname}`, writer.hostname, 20);
		for (const writer of writers) await waitForPhase(existing, `before-join-${writer.hostname}`, 20);
		// no operation reports a certified floor
		await delay(10 * FLOOR_INTERVAL_MS);
		const marks = await markAll(existing);

		const joiner = await joinGrid(quietJoiner, REGIONS[0], layouts.afterQuiet);
		for (const writer of writers) await waitForPhase(nodes(), `before-join-${writer.hostname}`, 20);
		for (const writer of [joiner, ...writers]) {
			await insert(writer, `after-join-${writer.hostname}`, writer.hostname, 20);
			await waitForPhase(nodes(), `after-join-${writer.hostname}`, 20);
		}
		assert.deepEqual(await copiesBeyond(joiner, existing, marks), []);
	});

	test('a join under writes loses nothing as lanes move', async () => {
		const existing = nodes();
		const { afterQuiet } = layouts;
		const writers = [afterQuiet.named('east', 0), afterQuiet.named('west', 1), afterQuiet.named('eu', 2)];
		const marks = await markAll(existing);
		// writing until the suppliers have settled, so writes are in flight when each moved link borrows its start
		const writing = startRowWriters(writers, 'during-join');
		let written;
		let joiner;
		try {
			joiner = await joinGrid(busyJoiner, REGIONS[1], layouts.afterBusy);
		} finally {
			written = await writing.stop();
		}
		for (const [index, writer] of writers.entries())
			await waitForPhase(nodes(), `during-join-${writer.hostname}`, written[index]);
		for (const writer of [joiner, ...writers]) {
			await insert(writer, `after-busy-join-${writer.hostname}`, writer.hostname, 20);
			await waitForPhase(nodes(), `after-busy-join-${writer.hostname}`, 20);
		}
		const copies = await copiesBeyond(joiner, existing, marks);
		if (copies.length) console.log(`a join under writes cost ${copies.length} base copies beyond the joiner`);
	});
});
