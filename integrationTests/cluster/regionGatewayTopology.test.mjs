/**
 * Region-aware replication topology (harper-pro#1291) on 3 regions × 3 nodes, regions set by `replication.region`.
 *
 * Addresses are sorted and grouped in threes, so each region's two lowest names are its automatic gateways and the
 * third is a leaf. Links are expected only within a region and between gateways; each origin with no direct link is
 * taken from one supplier and excluded on every other link. Frames are counted from the senders'
 * `sending replication update` trace lines (replication logging at trace), which name the record and the receiver,
 * so a duplicate the receiver would discard on apply still counts.
 *
 * `regionNetworkInjector.mjs` (a threads preload) cuts chosen cross-region links while LAN links stay up, standing in
 * for a gateway that loses its WAN.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	sendOperation,
	waitForCondition,
	restartNode,
	stopNodeProcess,
	stopAndTeardownNodes,
	logMark,
	readLogSince,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const FIXTURE = join(import.meta.dirname, 'fixture-region-topology');
const INJECTOR = join(import.meta.dirname, 'regionNetworkInjector.mjs');
const REGIONS = ['east', 'west', 'eu'];
const TABLE = 'RegionRecord';
const SEND_LINE = /sending replication update (\S+) to: (\S+)/g;

function nodeOptions(hostname, region, workDir) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, console: true, stdStreams: false, level: 'warn' },
			replication: {
				securePort: hostname + ':9933',
				...(region && { region }),
				logging: { level: 'trace' },
			},
			threads: { count: 1, preload: [INJECTOR] },
		},
		env: {
			HARPER_NO_FLUSH_ON_EXIT: true,
			HARPER_TEST_PARTITION_FILE: join(workDir, `partition-${hostname}`),
		},
	};
}

async function startNode(suiteName, hostname, region, workDir) {
	const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
	await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
	const ctx = { name: suiteName, harper: { hostname, dataRootDir } };
	await startHarper(ctx, nodeOptions(hostname, region, workDir));
	return ctx;
}

async function connectTo(seed, nodes) {
	const { operation_token } = await sendOperation(seed, {
		operation: 'create_authentication_tokens',
		authorization: seed.admin,
	});
	for (const node of nodes) {
		if (node === seed) continue;
		await sendOperation(node, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: seed.hostname,
			authorization: 'Bearer ' + operation_token,
		});
	}
}

/** Peers this node holds a connected `data` subscription to. */
async function dataLinks(node, signal) {
	const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
	return new Set(
		status.connections
			.filter((connection) =>
				connection.database_sockets.some(
					(socket) => socket.database === 'data' && socket.connected && socket.subscribed !== false
				)
			)
			.map((connection) => connection.name)
	);
}

function sameSet(actual, expected) {
	return actual.size === expected.size && [...expected].every((name) => actual.has(name));
}

async function waitForLinks(nodes, expectedFor, description) {
	let last;
	await waitForCondition(
		async (signal) => {
			last = new Map();
			for (const node of nodes) last.set(node.hostname, await dataLinks(node, signal).catch(() => new Set()));
			return nodes.every((node) => sameSet(last.get(node.hostname), expectedFor(node)));
		},
		{
			timeoutMs: 180_000,
			description: () =>
				`${description}; links: ${JSON.stringify([...(last ?? [])].map(([name, links]) => [name, [...links]]))}`,
		}
	);
}

function insert(node, phase, origin, count) {
	const records = Array.from({ length: count }, (_, index) => ({ id: `${phase}-${index}`, phase, origin }));
	return sendOperation(node, { operation: 'insert', database: 'data', table: TABLE, records }).then(() =>
		records.map((record) => record.id)
	);
}

async function waitForPhase(nodes, phase, count) {
	await waitForCondition(
		async (signal) => {
			for (const node of nodes) {
				// a node that is restarting refuses the connection for a moment
				const found = await sendOperation(
					node,
					{
						operation: 'search_by_value',
						database: 'data',
						table: TABLE,
						search_attribute: 'phase',
						search_value: phase,
						get_attributes: ['id'],
					},
					{ signal }
				).catch(() => []);
				if (found.length < count) return false;
			}
			return true;
		},
		{ timeoutMs: 120_000, description: `every node holds the ${count} ${phase} records` }
	);
}

/** Per record id, how many frames each receiver was sent, summed over every sender's log since its mark. */
async function sendsSince(nodes, marks, ids) {
	const wanted = new Set(ids);
	const sends = new Map(ids.map((id) => [id, []]));
	for (const node of nodes) {
		const log = await readLogSince(node, marks.get(node.hostname));
		for (const [, id, receiver] of log.matchAll(SEND_LINE)) {
			if (wanted.has(id)) sends.get(id).push({ sender: node.hostname, receiver });
		}
	}
	return sends;
}

/** Waits until every node's region topology supplier for each origin `expected(node)` names is one it allows. */
async function waitForSuppliers(nodes, expected, description) {
	let last;
	await waitForCondition(
		async (signal) => {
			last = {};
			for (const node of nodes) {
				const want = expected(node);
				const status = await sendOperation(node, { operation: 'cluster_status' }, { signal }).catch(() => undefined);
				const suppliers = status?.region_topology?.suppliers?.data ?? {};
				last[node.hostname] = suppliers;
				for (const [origin, allowed] of want) if (!allowed.includes(suppliers[origin])) return false;
			}
			return true;
		},
		{ timeoutMs: 120_000, description: () => `${description}; suppliers: ${JSON.stringify(last)}` }
	);
}

async function markAll(nodes) {
	const marks = new Map();
	for (const node of nodes) marks.set(node.hostname, await logMark(node));
	return marks;
}

suite('Region gateway topology', { timeout: 1_500_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	const region = new Map();
	let gateways;
	const byName = (name) => nodes().find((node) => node.hostname === name);
	const isGatewayName = (name) => gateways.has(name);
	const expectedLinks = (node) =>
		new Set(
			nodes()
				.filter(
					(peer) =>
						peer !== node &&
						(region.get(peer.hostname) === region.get(node.hostname) ||
							(isGatewayName(peer.hostname) && isGatewayName(node.hostname)))
				)
				.map((peer) => peer.hostname)
		);
	// east: [primary, standby, leaf], and so on
	const named = (regionName, index) =>
		byName(
			[...region]
				.filter(([, r]) => r === regionName)
				.map(([name]) => name)
				.sort()[index]
		);

	/**
	 * Settled suppliers with `down` stopped: a leaf, and a gateway that is not its region's first live one, take every
	 * remote origin they do not link to from that first live gateway; that gateway takes a remote leaf from any live
	 * gateway of the leaf's region.
	 */
	const steadySuppliers =
		(down = new Set()) =>
		(node) => {
			const own = region.get(node.hostname);
			const gatewaysOf = (regionName) =>
				[...gateways].filter((name) => region.get(name) === regionName && !down.has(name)).sort();
			const firstGateway = gatewaysOf(own)[0];
			const want = new Map();
			for (const origin of nodes()) {
				const originRegion = region.get(origin.hostname);
				if (!originRegion || originRegion === own || down.has(origin.hostname)) continue;
				const originIsLeaf = !isGatewayName(origin.hostname);
				if (!isGatewayName(node.hostname)) want.set(origin.hostname, [firstGateway]);
				else if (originIsLeaf)
					want.set(origin.hostname, node.hostname === firstGateway ? gatewaysOf(originRegion) : [firstGateway]);
			}
			return want;
		};

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'region-topology-'));
		const hostnames = [];
		for (let i = 0; i < 9; i++) hostnames.push(await getNextAvailableLoopbackAddress());
		hostnames.sort();
		hostnames.forEach((name, index) => region.set(name, REGIONS[Math.floor(index / 3)]));
		gateways = new Set(hostnames.filter((_, index) => index % 3 !== 2));
		for (const name of hostnames) await writeFile(join(workDir, `partition-${name}`), '[]');
		const started = await Promise.allSettled(
			hostnames.map((name) => startNode(ctx.name, name, region.get(name), workDir))
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
		await waitForLinks(nodes(), expectedLinks, 'region links');
	});

	test('each write reaches every node once; a leaf write crosses regions R−1 times', async () => {
		const leaf = named('east', 2);
		const gateway = named('west', 0);
		await waitForSuppliers(nodes(), steadySuppliers(), 'settled suppliers');
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
			const wan = frames.filter(({ sender, receiver }) => region.get(sender) !== region.get(receiver)).length;
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
			assert.equal(region.get(name), 'east', `${leaf.hostname} linked across regions to ${name}`);
		// settled on the standby, a new remote write reaches the leaf once, from it
		await waitForSuppliers(live, steadySuppliers(new Set([primary.hostname])), 'suppliers without the primary');
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
		await startHarper(context, nodeOptions(context.harper.hostname, 'east', workDir));
		const primary = context.harper;
		const mark = await logMark(primary);
		await waitForPhase(nodes(), 'while-down', 20);
		await waitForLinks(nodes(), expectedLinks, 'region links after the gateway restart');
		assert.ok(
			!(await readLogSince(primary, mark)).includes('Requesting full copy'),
			'the gateway requested a base copy'
		);
		const leaf = named('east', 2);
		await waitForSuppliers(nodes(), steadySuppliers(), 'suppliers with the primary back');
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
			(node) => region.get(node.hostname) !== 'east' && isGatewayName(node.hostname)
		);
		await writeFile(
			join(workDir, `partition-${primary.hostname}`),
			JSON.stringify(remoteGateways.map((node) => node.hostname))
		);
		for (const node of remoteGateways)
			await writeFile(join(workDir, `partition-${node.hostname}`), JSON.stringify([primary.hostname]));
		try {
			const ids = await insert(remoteLeaf, 'wan-isolated', remoteLeaf.hostname, 20);
			await waitForPhase([leaf, standby, ...remoteGateways], 'wan-isolated', ids.length);
			const leafLinks = await dataLinks(leaf);
			assert.ok(leafLinks.has(primary.hostname), 'the leaf kept its LAN link to the isolated gateway');
		} finally {
			for (const node of [primary, ...remoteGateways])
				await writeFile(join(workDir, `partition-${node.hostname}`), '[]');
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
		await writeFile(join(workDir, `partition-${hostname}`), '[]');
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
