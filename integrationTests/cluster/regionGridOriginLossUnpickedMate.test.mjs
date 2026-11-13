/**
 * The limit of the region grid's origin fallback (harper-pro#1343) that levelling is deferred for (harper-pro#1300),
 * on the 3 regions × 3 nodes of `regionTopologyShared.mjs`.
 *
 * When a node of another region loses its link to an origin, it takes the origin's log from one of the origin's
 * region-mates, the first in an order every node shares (`originFallbackMates`). Writes the origin made last that
 * reached only a region-mate the fallback does not pick stay on that region-mate after the origin is lost for good:
 * region-mates exclude an origin they each receive directly on their links to each other, so the picked one never
 * receives them either. This test pins that behavior. Levelling the origin's last writes within its region flips its
 * last assertion.
 *
 * The origin's messages are delayed on the picked region-mate and on the other regions' receivers, so its last
 * writes reach only the other region-mate; killing the origin drops the delayed messages with the socket.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { stopAndTeardownNodes, readLogSince, waitForCondition } from './clusterShared.mjs';
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
const escape = (hostname) => hostname.replaceAll('.', '\\.');

suite('An origin lost for good whose last writes reached only an unpicked region-mate', { timeout: 900_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	let layout;

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'region-origin-loss-unpicked-'));
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

	test('the last writes stay on that region-mate until levelling (harper-pro#1300)', async () => {
		const origin = layout.named('east', 2);
		// the ring after east's third node wraps to east's first node before its second
		const picked = layout.named('east', 0);
		const holder = layout.named('east', 1);
		const receivers = [layout.named('west', 2), layout.named('eu', 2)];
		const remote = nodes().filter((node) => layout.region.get(node.hostname) !== 'east');
		const lacking = [picked, ...remote];
		await insert(origin, 'before-loss', origin.hostname, 5);
		await waitForPhase(nodes(), 'before-loss', 5);
		// no operation reports a certified floor
		await delay(10 * FLOOR_INTERVAL_MS);

		for (const node of [picked, ...receivers])
			await writeFile(latencyFile(workDir, node.hostname), JSON.stringify({ [origin.hostname]: HELD_MS }));
		// the injector re-reads its file every 200 ms
		await delay(1000);
		const marks = await markAll(receivers);
		await insert(origin, 'last-writes', origin.hostname, 20);
		await waitForPhase([holder], 'last-writes', 20);
		for (const node of lacking)
			assert.equal((await phaseIds(node, 'last-writes')).size, 0, `${node.hostname} already holds the last writes`);
		await killNode(origin);
		for (const node of [picked, ...receivers]) await writeFile(latencyFile(workDir, node.hostname), '{}');

		const took = new RegExp(`takes ${escape(origin.hostname)} from ${escape(picked.hostname)} while its link`);
		await waitForCondition(
			async () => {
				for (const receiver of receivers)
					if (!took.test(await readLogSince(receiver, marks.get(receiver.hostname)))) return false;
				return true;
			},
			{ timeoutMs: 60_000, description: `every receiver taking ${origin.hostname} from ${picked.hostname}` }
		);
		// the holder's own writes cross every region, so the links that would carry the last writes are up
		await insert(holder, 'after-loss', holder.hostname, 10);
		await waitForPhase(lacking, 'after-loss', 10);
		// the fallback link has replayed the picked region-mate's log of the origin by now
		await delay(10_000);
		// a refused fallback moves to the next region-mate, which here is the holder
		const rotated = new RegExp(`takes ${escape(origin.hostname)} from ${escape(holder.hostname)} while its link`);
		for (const receiver of receivers)
			assert.doesNotMatch(
				await readLogSince(receiver, marks.get(receiver.hostname)),
				rotated,
				`${receiver.hostname} moved its fallback to the holder`
			);
		assert.equal((await phaseIds(holder, 'last-writes')).size, 20);
		for (const node of lacking)
			assert.equal(
				(await phaseIds(node, 'last-writes')).size,
				0,
				`${node.hostname} received the last writes: levelling (harper-pro#1300) landed, so this test should now require them everywhere`
			);
	});
});
