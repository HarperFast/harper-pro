/**
 * What region topology (harper-pro#1291) saves, on 3 regions × 3 nodes: a measurement, not a gate, and the file name
 * keeps it out of the *.test.* globs.
 *
 *   npm run test:integration -- integrationTests/cluster/regionTopology.bench.mjs
 *
 * The same nine nodes run once as a full mesh (no regions) and once labeled. `regionNetworkInjector.mjs` counts the
 * bytes each node receives from each peer and adds latency: 30 ms between regions, 1 ms within one. For a single
 * writer (a leaf, then a gateway) it reports the cross-region bytes per write and each node's egress, and it times a
 * leaf's write until a leaf in another region can read it. The labeled run is measured once suppliers have settled.
 * Results go to REGION_TOPOLOGY_BENCH_OUT (default under the OS tmpdir) and the test diagnostics.
 */
import { suite, test, after } from 'node:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition, stopAndTeardownNodes } from './clusterShared.mjs';
import { TABLE, startNode, connectTo, waitForLinks, waitForSuppliers, regionLayout } from './regionTopologyShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const WAN_MS = 30;
const LAN_MS = 1;
const RECORDS = 2000;
const BODY = 'x'.repeat(1000);
const LATENCY_SAMPLES = 40;
const OUT = process.env.REGION_TOPOLOGY_BENCH_OUT ?? join(tmpdir(), 'region-topology-bench.json');

async function startCluster(suiteName, hostnames, labeled, workDir) {
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	const layout = regionLayout(hostnames, nodes);
	const { region } = layout;
	const started = await Promise.all(
		hostnames.map((hostname) =>
			startNode(
				suiteName,
				hostname,
				labeled ? region.get(hostname) : undefined,
				workDir,
				{
					replicationLogLevel: 'warn',
					env: { HARPER_TEST_INGRESS_FILE: join(workDir, `ingress-${labeled ? 'labeled' : 'mesh'}-${hostname}`) },
				},
				Object.fromEntries(
					hostnames
						.filter((peer) => peer !== hostname)
						.map((peer) => [peer, region.get(peer) === region.get(hostname) ? LAN_MS : WAN_MS])
				)
			)
		)
	);
	contexts.push(...started);
	await connectTo(nodes()[0], nodes());
	const fullMesh = (node) =>
		new Set(
			nodes()
				.filter((peer) => peer !== node)
				.map((peer) => peer.hostname)
		);
	await waitForLinks(nodes(), labeled ? layout.expectedLinks : fullMesh, labeled ? 'region links' : 'full-mesh links');
	// measured once each remote origin has its one supplier, not while suppliers are still settling
	if (labeled) await waitForSuppliers(nodes(), layout.steadySuppliers(), 'settled suppliers');
	return { nodes: nodes(), region };
}

/** Bytes each node has received from each peer, summed over its threads' counter files. */
async function ingress(workDir, labeled, nodes) {
	const files = await readdir(workDir);
	const totals = new Map();
	for (const node of nodes) {
		const counts = {};
		const prefix = `ingress-${labeled ? 'labeled' : 'mesh'}-${node.hostname}.`;
		for (const file of files.filter((name) => name.startsWith(prefix))) {
			for (const [host, { bytes }] of Object.entries(JSON.parse(await readFile(join(workDir, file), 'utf8'))))
				counts[host] = (counts[host] ?? 0) + bytes;
		}
		totals.set(node.hostname, counts);
	}
	return totals;
}

async function countPhase(node, phase) {
	const found = await sendOperation(node, {
		operation: 'search_by_value',
		database: 'data',
		table: TABLE,
		search_attribute: 'phase',
		search_value: phase,
		get_attributes: ['id'],
	});
	return found.length;
}

async function measureWriter(workDir, labeled, cluster, writer, phase) {
	const { nodes, region } = cluster;
	// settle the counters, then measure only this writer's records
	await delay(2000);
	const before = await ingress(workDir, labeled, nodes);
	for (let offset = 0; offset < RECORDS; offset += 200) {
		const records = Array.from({ length: 200 }, (_, index) => ({
			id: `${phase}-${offset + index}`,
			phase,
			origin: BODY,
		}));
		await sendOperation(writer, { operation: 'insert', database: 'data', table: TABLE, records });
	}
	await waitForCondition(
		async () => {
			for (const node of nodes) if ((await countPhase(node, phase)) < RECORDS) return false;
			return true;
		},
		{ timeoutMs: 300_000, description: `${phase} everywhere` }
	);
	await delay(1000);
	const afterCounts = await ingress(workDir, labeled, nodes);
	let crossRegion = 0;
	const egress = Object.fromEntries(nodes.map((node) => [node.hostname, 0]));
	for (const node of nodes) {
		const was = before.get(node.hostname);
		for (const [sender, bytes] of Object.entries(afterCounts.get(node.hostname))) {
			const delta = bytes - (was[sender] ?? 0);
			egress[sender] = (egress[sender] ?? 0) + delta;
			if (region.get(sender) !== region.get(node.hostname)) crossRegion += delta;
		}
	}
	return {
		crossRegionBytesPerWrite: Math.round(crossRegion / RECORDS),
		writerEgressBytesPerWrite: Math.round(egress[writer.hostname] / RECORDS),
		maxEgressBytesPerWrite: Math.round(Math.max(...Object.values(egress)) / RECORDS),
		egressBytesPerWrite: Object.fromEntries(
			Object.entries(egress).map(([name, bytes]) => [name, Math.round(bytes / RECORDS)])
		),
	};
}

async function measureLatency(writer, reader, phase) {
	const samples = [];
	for (let i = 0; i < LATENCY_SAMPLES; i++) {
		const id = `${phase}-${i}`;
		const start = performance.now();
		await sendOperation(writer, {
			operation: 'insert',
			database: 'data',
			table: TABLE,
			records: [{ id, phase, origin: 'latency' }],
		});
		for (;;) {
			const [found] = await sendOperation(reader, {
				operation: 'search_by_id',
				database: 'data',
				table: TABLE,
				ids: [id],
				get_attributes: ['id'],
			});
			if (found) break;
			await delay(2);
		}
		samples.push(performance.now() - start);
	}
	samples.sort((a, b) => a - b);
	return {
		p50: Math.round(samples[Math.floor(samples.length / 2)]),
		p90: Math.round(samples[Math.floor(samples.length * 0.9)]),
	};
}

suite('Region topology cost', { timeout: 3_600_000 }, (ctx) => {
	const results = {};
	let workDir;
	let current;
	after(async () => {
		if (current) await stopAndTeardownNodes(current.nodes);
		if (workDir) await rm(workDir, { recursive: true, force: true });
	});

	for (const labeled of [false, true]) {
		test(labeled ? 'region topology' : 'full mesh', async (t) => {
			workDir ??= await mkdtemp(join(tmpdir(), 'region-topology-bench-'));
			const hostnames = [];
			for (let i = 0; i < 9; i++) hostnames.push(await getNextAvailableLoopbackAddress());
			hostnames.sort();
			current = await startCluster(ctx.name, hostnames, labeled, workDir);
			const [, , eastLeaf, westGateway, , westLeaf] = current.nodes;
			const scenario = {
				leafWriter: await measureWriter(workDir, labeled, current, eastLeaf, `${labeled}-leaf`),
				gatewayWriter: await measureWriter(workDir, labeled, current, westGateway, `${labeled}-gateway`),
				remoteLeafVisibleMs: await measureLatency(eastLeaf, westLeaf, `${labeled}-latency`),
			};
			results[labeled ? 'regionTopology' : 'fullMesh'] = scenario;
			t.diagnostic(JSON.stringify(scenario));
			await stopAndTeardownNodes(current.nodes);
			current = undefined;
			await writeFile(OUT, JSON.stringify({ wanMs: WAN_MS, lanMs: LAN_MS, records: RECORDS, ...results }, null, 2));
		});
	}
});
