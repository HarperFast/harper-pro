/**
 * Region-aware replication topology (harper-pro#1291) on 3 regions × 3 nodes; the layout is in
 * `regionTopologyShared.mjs`.
 *
 * Links are expected only within a region and between gateways; each origin with no direct link is taken from one
 * supplier and excluded on every other link. Frames are counted from the senders' `sending replication update` trace
 * lines (replication logging at trace), which name the record and the receiver, so a duplicate the receiver would
 * discard on apply still counts. Cutting a gateway's cross-region links while its LAN links stay up stands in for a
 * gateway that loses its WAN.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { restartNode, stopNodeProcess, stopAndTeardownNodes, logMark, readLogSince } from './clusterShared.mjs';
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

suite('Region gateway topology', { timeout: 1_500_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	let layout;
	const region = (name) => layout.region.get(name);
	const named = (regionName, index) => layout.named(regionName, index);

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'region-topology-'));
		const hostnames = [];
		for (let i = 0; i < 9; i++) hostnames.push(await getNextAvailableLoopbackAddress());
		hostnames.sort();
		layout = regionLayout(hostnames, nodes);
		const started = await Promise.allSettled(
			hostnames.map((name) => startNode(ctx.name, name, layout.region.get(name), workDir))
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

	test('links follow regions: every node within its region, gateways across regions', async () => {
		await waitForLinks(nodes(), layout.expectedLinks, 'region links');
	});

	test('each write reaches every node once; a leaf write crosses regions R−1 times', async () => {
		const leaf = named('east', 2);
		const gateway = named('west', 0);
		await waitForSuppliers(nodes(), layout.steadySuppliers(), 'settled suppliers');
		const marks = await markAll(nodes());
		const leafIds = await insert(leaf, 'steady-leaf', leaf.hostname, 10);
		const gatewayIds = await insert(gateway, 'steady-gateway', gateway.hostname, 10);
		await waitForPhase(nodes(), 'steady-leaf', 10);
		await waitForPhase(nodes(), 'steady-gateway', 10);
		const sends = await sendsSince(nodes(), marks, [...leafIds, ...gatewayIds]);
		for (const [id, frames] of sends) {
			const origin = id.startsWith('steady-leaf') ? leaf.hostname : gateway.hostname;
			const received = new Map();
			for (const { receiver } of frames) received.set(receiver, (received.get(receiver) ?? 0) + 1);
			for (const node of nodes()) {
				if (node.hostname === origin) continue;
				assert.equal(
					received.get(node.hostname),
					1,
					`${node.hostname} was sent ${id} ${received.get(node.hostname) ?? 0} times`
				);
			}
			const wan = frames.filter(({ sender, receiver }) => region(sender) !== region(receiver)).length;
			// a leaf's write enters each other region once; a gateway's goes straight to every remote gateway
			assert.equal(
				wan,
				origin === leaf.hostname ? REGIONS.length - 1 : 2 * (REGIONS.length - 1),
				`${id} crossed regions ${wan} times`
			);
		}
	});

	test('when a region loses its preferred gateway its nodes move to the second one, losing nothing', async () => {
		const primary = named('east', 0);
		const standby = named('east', 1);
		const leaf = named('east', 2);
		const remoteLeaf = named('west', 2);
		await insert(remoteLeaf, 'before-kill', remoteLeaf.hostname, 20);
		await stopNodeProcess(primary);
		await insert(remoteLeaf, 'after-kill', remoteLeaf.hostname, 20);
		await insert(leaf, 'after-kill-east', leaf.hostname, 20);
		const live = nodes().filter((node) => node !== primary);
		await waitForPhase(live, 'before-kill', 20);
		await waitForPhase(live, 'after-kill', 20);
		await waitForPhase(live, 'after-kill-east', 20);
		const leafLinks = await dataLinks(leaf);
		for (const name of leafLinks)
			assert.equal(region(name), 'east', `${leaf.hostname} linked across regions to ${name}`);
		// settled on the standby, a new remote write reaches the leaf once, from it
		await waitForSuppliers(live, layout.steadySuppliers(new Set([primary.hostname])), 'suppliers without the primary');
		const marks = await markAll(live);
		const ids = await insert(remoteLeaf, 'settled-standby', remoteLeaf.hostname, 10);
		await waitForPhase(live, 'settled-standby', 10);
		const sends = await sendsSince(live, marks, ids);
		for (const [id, frames] of sends) {
			const toLeaf = frames.filter(({ receiver }) => receiver === leaf.hostname);
			assert.deepEqual(
				toLeaf.map(({ sender }) => sender),
				[standby.hostname],
				`${id} reached ${leaf.hostname} from ${toLeaf.map(({ sender }) => sender)}`
			);
		}
	});

	test('a restarted gateway resumes each origin without a base copy and takes its region back', async () => {
		const index = contexts.findIndex((context) => context.harper === named('east', 0));
		const context = contexts[index];
		const remoteLeaf = named('west', 2);
		await insert(remoteLeaf, 'while-down', remoteLeaf.hostname, 20);
		// before the start, so a copy requested while it starts is in what the assertion reads
		const mark = await logMark(context.harper);
		await startHarper(context, nodeOptions(context.harper.hostname, 'east', workDir));
		const primary = context.harper;
		await waitForPhase(nodes(), 'while-down', 20);
		await waitForLinks(nodes(), layout.expectedLinks, 'region links after the gateway restart');
		assert.ok(
			!(await readLogSince(primary, mark)).includes('Requesting full copy'),
			'the gateway requested a base copy'
		);
		const leaf = named('east', 2);
		await waitForSuppliers(nodes(), layout.steadySuppliers(), 'suppliers with the primary back');
		const marks = await markAll(nodes());
		const ids = await insert(remoteLeaf, 'primary-back', remoteLeaf.hostname, 10);
		await waitForPhase(nodes(), 'primary-back', 10);
		for (const [id, frames] of await sendsSince(nodes(), marks, ids)) {
			const toLeaf = frames.filter(({ receiver }) => receiver === leaf.hostname).map(({ sender }) => sender);
			assert.deepEqual(toLeaf, [primary.hostname], `${id} reached ${leaf.hostname} from ${toLeaf}`);
		}
	});

	test('a preferred gateway that loses its WAN but not its LAN hands its region to the second gateway', async () => {
		const primary = named('east', 0);
		const standby = named('east', 1);
		const leaf = named('east', 2);
		const remoteLeaf = named('west', 2);
		const remoteGateways = nodes().filter(
			(node) => region(node.hostname) !== 'east' && layout.isGatewayName(node.hostname)
		);
		await writeFile(
			partitionFile(workDir, primary.hostname),
			JSON.stringify(remoteGateways.map((node) => node.hostname))
		);
		for (const node of remoteGateways)
			await writeFile(partitionFile(workDir, node.hostname), JSON.stringify([primary.hostname]));
		try {
			const ids = await insert(remoteLeaf, 'wan-isolated', remoteLeaf.hostname, 20);
			await waitForPhase([leaf, standby, ...remoteGateways], 'wan-isolated', ids.length);
			const leafLinks = await dataLinks(leaf);
			assert.ok(leafLinks.has(primary.hostname), 'the leaf kept its LAN link to the isolated gateway');
		} finally {
			for (const node of [primary, ...remoteGateways]) await writeFile(partitionFile(workDir, node.hostname), '[]');
		}
		await waitForPhase(nodes(), 'wan-isolated', 20);
	});

	test('a restarted leaf resumes each origin without a base copy', async () => {
		const leaf = named('eu', 2);
		const writer = named('west', 2);
		const mark = await logMark(leaf);
		const restart = restartNode(leaf);
		await insert(writer, 'leaf-restart', writer.hostname, 20);
		await restart;
		await waitForPhase(nodes(), 'leaf-restart', 20);
		assert.ok(!(await readLogSince(leaf, mark)).includes('Requesting full copy'), 'the leaf requested a base copy');
	});

	test('a confirmation count above the peers that subscribe to the writer is refused before commit', async () => {
		const leaf = named('east', 2);
		const put = (id, confirm) =>
			fetch(`${leaf.httpURL}/${TABLE}/${id}`, {
				method: 'PUT',
				signal: AbortSignal.timeout(60_000),
				headers: {
					'Content-Type': 'application/json',
					'Authorization': 'Basic ' + Buffer.from(`${leaf.admin.username}:${leaf.admin.password}`).toString('base64'),
					'X-Replicate-To': `*;confirm=${confirm}`,
				},
				body: JSON.stringify({ id, phase: 'confirm', origin: leaf.hostname }),
			});
		const refused = await put('confirm-3', 3);
		assert.ok(refused.status >= 400 && refused.status < 500, `confirm=3 at a leaf returned ${refused.status}`);
		const accepted = await put('confirm-2', 2);
		assert.ok(accepted.status >= 200 && accepted.status < 300, `confirm=2 at a leaf returned ${accepted.status}`);
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
		const ids = await insert(named('east', 2), 'full-mesh', 'east-leaf', 5);
		await waitForPhase(nodes(), 'full-mesh', ids.length);
	});
});
