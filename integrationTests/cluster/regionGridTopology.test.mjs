/**
 * Region × column replication topology (harper-pro#1343) on 3 regions × 3 nodes; the layout is in
 * `regionTopologyShared.mjs`.
 *
 * A node subscribes only to its region and to its column in the other regions; each origin it does not subscribe to
 * is taken from one supplier in its region and excluded on every other link. Frames are counted from the senders'
 * `sending replication update` trace lines (replication logging at trace), which name the record and the receiver, so
 * a duplicate the receiver would discard on apply still counts.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	restartNode,
	sendOperation,
	stopNodeProcess,
	stopAndTeardownNodes,
	logMark,
	readLogSince,
} from './clusterShared.mjs';
import {
	REGIONS,
	TABLE,
	partitionFile,
	nodeOptions,
	startNode,
	connectTo,
	dataLinks,
	waitForLinks,
	insert,
	waitForPhase,
	sendsSince,
	waitForSuppliers,
	markAll,
	regionLayout,
} from './regionTopologyShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

suite('Region grid topology', { timeout: 1_500_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	let layout;
	const region = (name) => layout.region.get(name);
	const named = (regionName, index) => layout.named(regionName, index);
	const FULL_COPY = /Requesting full copy of database data\b/;
	const FORCED_COPY = /Peer (\S+) requested replication of database data\b[^\n]*forcing a bounded base-copy resync/g;
	// a carrier certifies a floor for each origin it relays at this interval (30 s by default)
	const FLOOR_INTERVAL_MS = 1000;

	/** Counts the frames of `ids` each live node was sent, and by whom, since `marks`. */
	async function framesByReceiver(live, marks, ids) {
		const byId = new Map();
		for (const [id, frames] of await sendsSince(live, marks, ids)) {
			const received = new Map();
			for (const { sender, receiver } of frames) received.set(receiver, [...(received.get(receiver) ?? []), sender]);
			byId.set(id, { frames, received });
		}
		return byId;
	}

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'region-topology-'));
		const hostnames = [];
		for (let i = 0; i < 9; i++) hostnames.push(await getNextAvailableLoopbackAddress());
		hostnames.sort();
		layout = regionLayout(hostnames, nodes);
		const started = await Promise.allSettled(
			hostnames.map((name) =>
				startNode(ctx.name, name, layout.region.get(name), workDir, {
					env: { HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: String(FLOOR_INTERVAL_MS) },
				})
			)
		);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		contexts.sort((a, b) => (a.harper.hostname < b.harper.hostname ? -1 : 1));
		await connectTo(nodes()[0], nodes());
	});

	after(async () => {
		await stopAndTeardownNodes(nodes());
		if (workDir) await rm(workDir, { recursive: true, force: true });
	});

	test('links follow the grid: every node within its region, and its column across regions', async () => {
		await waitForLinks(nodes(), layout.expectedLinks, 'grid links');
		const status = await sendOperation(named('west', 1), { operation: 'cluster_status' });
		assert.equal(status.region_topology.active, true);
		assert.equal(status.region_topology.column, 1);
		assert.deepEqual(
			Object.values(status.region_topology.columns.east).sort(),
			[0, 1, 2],
			JSON.stringify(status.region_topology)
		);
	});

	test('each write reaches every node once, crossing into each other region once and relayed at most once', async () => {
		await waitForSuppliers(nodes(), layout.steadySuppliers(), 'settled suppliers');
		const writers = [named('east', 2), named('west', 0), named('eu', 1)];
		const marks = await markAll(nodes());
		const idsByWriter = new Map();
		for (const writer of writers) {
			idsByWriter.set(writer.hostname, await insert(writer, `steady-${writer.hostname}`, writer.hostname, 10));
		}
		for (const writer of writers) await waitForPhase(nodes(), `steady-${writer.hostname}`, 10);
		for (const [origin, ids] of idsByWriter) {
			for (const [id, { frames, received }] of await framesByReceiver(nodes(), marks, ids)) {
				for (const node of nodes()) {
					if (node.hostname === origin) continue;
					const senders = received.get(node.hostname) ?? [];
					assert.equal(senders.length, 1, `${node.hostname} was sent ${id} ${senders.length} times (${senders})`);
					// from the origin itself, or from a node the origin sent it to
					assert.ok(
						senders[0] === origin || layout.receivesDirect(senders[0], origin),
						`${node.hostname} got ${id} from ${senders[0]}, which does not receive ${origin} itself`
					);
				}
				const wan = frames.filter(({ sender, receiver }) => region(sender) !== region(receiver));
				assert.equal(wan.length, REGIONS.length - 1, `${id} crossed regions ${wan.length} times`);
				for (const { sender } of wan) assert.equal(sender, origin, `${id} crossed regions from ${sender}`);
			}
		}
	});

	test('when a region loses the carrier of a column, its lowest-named node takes the column by direct links', async () => {
		const carrier = named('east', 2);
		const standIn = named('east', 0);
		const follower = named('east', 1);
		const writer = named('west', 2);
		const otherOrigin = named('eu', 2);
		await insert(writer, 'before-kill', writer.hostname, 20);
		await waitForPhase(nodes(), 'before-kill', 20);
		// otherOrigin has written nothing, so east holds no position for it: the stand-in can start its link only from
		// the floor the carrier certified, which no operation reports
		await delay(3 * FLOOR_INTERVAL_MS);
		const marksAtKill = await markAll([standIn, follower, writer, otherOrigin]);
		await stopNodeProcess(carrier);
		await insert(writer, 'after-kill', writer.hostname, 20);
		await insert(follower, 'after-kill-east', follower.hostname, 20);
		const live = nodes().filter((node) => node !== carrier);
		await waitForPhase(live, 'before-kill', 20);
		await waitForPhase(live, 'after-kill', 20);
		await waitForPhase(live, 'after-kill-east', 20);
		await waitForSuppliers(live, layout.steadySuppliers(new Set([carrier.hostname])), 'suppliers without the carrier');
		const standInLinks = await dataLinks(standIn);
		for (const origin of [writer, otherOrigin])
			assert.ok(standInLinks.has(origin.hostname), `${standIn.hostname} holds no direct link to ${origin.hostname}`);
		const followerLinks = await dataLinks(follower);
		for (const origin of [writer, otherOrigin])
			assert.ok(!followerLinks.has(origin.hostname), `${follower.hostname} linked to ${origin.hostname} as well`);
		// the takeover resumes from where the lost carrier's link stood: nobody asks for a base copy or is sent one
		for (const node of [standIn, follower]) {
			const log = await readLogSince(node, marksAtKill.get(node.hostname));
			assert.ok(!FULL_COPY.test(log), `${node.hostname} requested a base copy during the takeover`);
		}
		for (const sender of [writer, otherOrigin, standIn]) {
			const forced = [...(await readLogSince(sender, marksAtKill.get(sender.hostname))).matchAll(FORCED_COPY)]
				.map(([, peer]) => peer)
				.filter((peer) => peer === standIn.hostname || peer === follower.hostname);
			assert.deepEqual(forced, [], `${sender.hostname} forced a base copy during the takeover`);
		}
		// settled on the stand-in, a new remote write enters the region once, through it
		const marks = await markAll(live);
		const ids = await insert(writer, 'settled-stand-in', writer.hostname, 10);
		await waitForPhase(live, 'settled-stand-in', 10);
		for (const [id, { frames, received }] of await framesByReceiver(live, marks, ids)) {
			assert.deepEqual(received.get(standIn.hostname), [writer.hostname], `${id} reached ${standIn.hostname}`);
			assert.deepEqual(received.get(follower.hostname), [standIn.hostname], `${id} reached ${follower.hostname}`);
			const intoEast = frames.filter(
				({ sender, receiver }) => region(sender) !== 'east' && region(receiver) === 'east'
			);
			assert.equal(intoEast.length, 1, `${id} crossed into east ${intoEast.length} times`);
		}
	});

	test('a restarted carrier resumes each origin without a base copy and takes its column back', async () => {
		const index = contexts.findIndex((context) => context.harper === named('east', 2));
		const context = contexts[index];
		const standIn = named('east', 0);
		const follower = named('east', 1);
		const writer = named('west', 2);
		await insert(writer, 'while-down', writer.hostname, 20);
		const mark = await logMark(context.harper);
		const marksAtReturn = await markAll([standIn, follower]);
		await startHarper(context, nodeOptions(context.harper.hostname, 'east', workDir));
		const carrier = context.harper;
		await waitForPhase(nodes(), 'while-down', 20);
		await waitForSuppliers(nodes(), layout.steadySuppliers(), 'suppliers with the carrier back');
		// the stand-in's direct links to the column's origins end with the takeover
		await waitForLinks(nodes(), layout.expectedLinks, 'grid links after the carrier restart');
		assert.ok(!FULL_COPY.test(await readLogSince(carrier, mark)), 'the carrier requested a base copy');
		for (const node of [standIn, follower]) {
			const log = await readLogSince(node, marksAtReturn.get(node.hostname));
			assert.ok(!FULL_COPY.test(log), `${node.hostname} requested a base copy when the carrier returned`);
		}
		const marks = await markAll(nodes());
		const ids = await insert(writer, 'carrier-back', writer.hostname, 10);
		await waitForPhase(nodes(), 'carrier-back', 10);
		for (const [id, { received }] of await framesByReceiver(nodes(), marks, ids)) {
			assert.deepEqual(received.get(carrier.hostname), [writer.hostname], `${id} reached ${carrier.hostname}`);
			for (const node of [standIn, follower])
				assert.deepEqual(received.get(node.hostname), [carrier.hostname], `${id} reached ${node.hostname}`);
		}
	});

	test('a carrier cut off from one origin takes it through its column in a third region', async () => {
		const carrier = named('east', 1);
		const origin = named('west', 1);
		const follower = named('east', 2);
		await writeFile(partitionFile(workDir, carrier.hostname), JSON.stringify([origin.hostname]));
		try {
			const ids = await insert(origin, 'link-cut', origin.hostname, 20);
			await waitForPhase([carrier, follower, named('east', 0)], 'link-cut', ids.length);
		} finally {
			await writeFile(partitionFile(workDir, carrier.hostname), '[]');
		}
		const ids = await insert(origin, 'link-back', origin.hostname, 10);
		await waitForPhase(nodes(), 'link-back', ids.length);
		await waitForLinks(nodes(), layout.expectedLinks, 'grid links after the cut link returned');
	});

	test('a restarted follower resumes each origin without a base copy', async () => {
		const follower = named('eu', 2);
		const writer = named('west', 0);
		const mark = await logMark(follower);
		const restart = restartNode(follower);
		await insert(writer, 'follower-restart', writer.hostname, 20);
		await restart;
		await waitForPhase(nodes(), 'follower-restart', 20);
		assert.ok(!FULL_COPY.test(await readLogSince(follower, mark)), 'the follower requested a base copy');
	});

	test('a confirmation count above the peers that subscribe to the writer is refused before commit', async () => {
		const writer = named('east', 2);
		const put = (id, confirm) =>
			fetch(`${writer.httpURL}/${TABLE}/${id}`, {
				method: 'PUT',
				signal: AbortSignal.timeout(60_000),
				headers: {
					'Content-Type': 'application/json',
					'Authorization':
						'Basic ' + Buffer.from(`${writer.admin.username}:${writer.admin.password}`).toString('base64'),
					'X-Replicate-To': `*;confirm=${confirm}`,
				},
				body: JSON.stringify({ id, phase: 'confirm', origin: writer.hostname }),
			});
		// two region-mates and its column in two other regions subscribe to it
		const refused = await put('confirm-5', 5);
		assert.ok(refused.status >= 400 && refused.status < 500, `confirm=5 returned ${refused.status}`);
		const accepted = await put('confirm-4', 4);
		assert.ok(accepted.status >= 200 && accepted.status < 300, `confirm=4 returned ${accepted.status}`);
	});

	test('an unlabeled member turns the cluster back to a full mesh', async () => {
		const hostname = await getNextAvailableLoopbackAddress();
		contexts.push(await startNode(ctx.name, hostname, undefined, workDir));
		const unlabeled = contexts.at(-1).harper;
		await connectTo(nodes()[0], [unlabeled]);
		await waitForLinks(
			nodes(),
			(node) =>
				new Set(
					nodes()
						.filter((peer) => peer !== node)
						.map((peer) => peer.hostname)
				),
			'full mesh with an unlabeled member'
		);
		const ids = await insert(named('east', 2), 'full-mesh', 'east-2', 5);
		await waitForPhase(nodes(), 'full-mesh', ids.length);
	});
});
