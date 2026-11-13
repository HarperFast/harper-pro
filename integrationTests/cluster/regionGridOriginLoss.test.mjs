/**
 * An origin lost for good under the region grid (harper-pro#1343), on the 3 regions × 3 nodes of
 * `regionTopologyShared.mjs`.
 *
 * The node of each other region that receives an origin links to nothing else of the origin's region. Writes the
 * origin made just before it stopped can therefore have reached its region-mates and no other region. The receiving
 * node must then take the origin's log from one of those region-mates, over a link it opens for that origin alone.
 *
 * The origin's last writes are held back from the other regions by delaying its messages on their receivers' links;
 * the origin is then killed, which drops the delayed messages with the socket.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { stopAndTeardownNodes, readLogSince } from './clusterShared.mjs';
import {
	startNode,
	connectTo,
	killNode,
	latencyFile,
	waitForLinks,
	waitForCopiesSettled,
	insert,
	phaseIds,
	waitForPhase,
	waitForSuppliers,
	markAll,
	regionLayout,
} from './regionTopologyShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

// A fallback link starts the origin at the floor the receiver certified for it, or 60 s below the receiver's position
// when that is higher. Without a floor the start of a cluster this young sits below a region-mate's formation copy,
// which a link carrying no base copy is refused at. Every origin certifies one at this interval (30 s by default).
const FLOOR_INTERVAL_MS = 1000;
// the main thread reports the fallback link at info
const OPTIONS = {
	logLevel: 'info',
	replicationLogLevel: 'info',
	env: { HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: String(FLOOR_INTERVAL_MS) },
};
// longer than the test takes to kill the origin; a ping delayed this long does not yet mark the link down
const HELD_MS = 30_000;

suite('An origin lost for good under the region grid', { timeout: 900_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	let layout;

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'region-origin-loss-'));
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
		await waitForLinks(nodes(), layout.expectedLinks, 'grid links');
		await waitForCopiesSettled(nodes(), 'formation copies');
		await waitForSuppliers(nodes(), layout.steadySuppliers(), 'settled suppliers');
	});

	after(async () => {
		await stopAndTeardownNodes(nodes());
		if (workDir) await rm(workDir, { recursive: true, force: true });
	});

	test("writes that reached only the origin's region cross to the other regions after the origin is lost", async () => {
		const origin = layout.named('east', 2);
		const mates = [layout.named('east', 0), layout.named('east', 1)];
		const receivers = [layout.named('west', 2), layout.named('eu', 2)];
		const remote = nodes().filter((node) => layout.region.get(node.hostname) !== 'east');
		// every node holds a position for the origin, so nothing below depends on a first-time copy
		await insert(origin, 'before-loss', origin.hostname, 5);
		await waitForPhase(nodes(), 'before-loss', 5);
		// no operation reports a certified floor
		await delay(10 * FLOOR_INTERVAL_MS);

		for (const receiver of receivers)
			await writeFile(latencyFile(workDir, receiver.hostname), JSON.stringify({ [origin.hostname]: HELD_MS }));
		// the injector re-reads its file every 200 ms
		await delay(1000);
		const marks = await markAll(receivers);
		await insert(origin, 'last-writes', origin.hostname, 20);
		await waitForPhase(mates, 'last-writes', 20);
		for (const node of remote)
			assert.equal((await phaseIds(node, 'last-writes')).size, 0, `${node.hostname} already holds the last writes`);
		await killNode(origin);
		for (const receiver of receivers) await writeFile(latencyFile(workDir, receiver.hostname), '{}');

		await waitForPhase([...mates, ...remote], 'last-writes', 20);
		const mateNames = mates
			.map((mate) => mate.hostname)
			.join('|')
			.replaceAll('.', '\\.');
		const took = new RegExp(`takes ${origin.hostname.replaceAll('.', '\\.')} from (${mateNames}) while its link`);
		for (const receiver of receivers) {
			const log = await readLogSince(receiver, marks.get(receiver.hostname));
			assert.match(log, took, `${receiver.hostname} did not take ${origin.hostname} from one of its region-mates`);
		}
		// the rest of each region still takes the origin from its one receiver, which a later write confirms end to end
		const writer = mates[0];
		await insert(writer, 'after-loss', writer.hostname, 10);
		await waitForPhase([...mates, ...remote], 'after-loss', 10);
	});
});
