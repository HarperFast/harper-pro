/**
 * Cluster setup and probes shared by the region topology suites (harper-pro#1291): 3 regions × 3 nodes, regions set
 * by `replication.region`. Addresses are sorted and grouped in threes, so each region's two lowest names are its
 * automatic gateways and the third is a leaf.
 *
 * `regionNetworkInjector.mjs` (a threads preload) reads each node's partition and latency files, so a test can cut
 * or slow chosen links while the rest stay up.
 */
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startHarper } from '@harperfast/integration-testing';
import { sendOperation, waitForCondition, logMark, readLogSince, readNodePid } from './clusterShared.mjs';

export const FIXTURE = join(import.meta.dirname, 'fixture-region-topology');
export const INJECTOR = join(import.meta.dirname, 'regionNetworkInjector.mjs');
export const REGIONS = ['east', 'west', 'eu'];
export const TABLE = 'RegionRecord';
const SEND_LINE = /sending replication update (\S+) to: (\S+)/g;

export const partitionFile = (workDir, hostname) => join(workDir, `partition-${hostname}`);
export const latencyFile = (workDir, hostname) => join(workDir, `latency-${hostname}`);

export function nodeOptions(hostname, region, workDir, { logLevel = 'warn', replicationLogLevel = 'trace', env } = {}) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, console: true, stdStreams: false, level: logLevel },
			replication: {
				securePort: hostname + ':9933',
				...(region && { region }),
				logging: { level: replicationLogLevel },
			},
			threads: { count: 1, preload: [INJECTOR] },
		},
		env: {
			HARPER_NO_FLUSH_ON_EXIT: true,
			HARPER_TEST_PARTITION_FILE: partitionFile(workDir, hostname),
			HARPER_TEST_PEER_LATENCY_FILE: latencyFile(workDir, hostname),
			...env,
		},
	};
}

/** `latency` is this node's `{ peer: ms }` starting delays. */
export async function startNode(suiteName, hostname, region, workDir, options, latency = {}) {
	await writeFile(partitionFile(workDir, hostname), '[]');
	await writeFile(latencyFile(workDir, hostname), JSON.stringify(latency));
	const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-integration-test-'));
	await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true });
	const ctx = { name: suiteName, harper: { hostname, dataRootDir } };
	await startHarper(ctx, nodeOptions(hostname, region, workDir, options));
	return ctx;
}

export async function connectTo(seed, nodes) {
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

/** SIGKILL, so the node gets no graceful shutdown; resolves once the process is gone. */
export async function killNode(node) {
	const pid = await readNodePid(node);
	if (pid === undefined) return;
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		return;
	}
	await waitForCondition(
		() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		},
		{ timeoutMs: 15_000, pollMs: 100, description: `${node.hostname} (pid ${pid}) to exit` }
	);
}

/** Peers this node holds a connected `data` subscription to. */
export async function dataLinks(node, signal) {
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

export async function waitForLinks(nodes, expectedFor, description) {
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

export function insert(node, phase, origin, count) {
	const records = Array.from({ length: count }, (_, index) => ({ id: `${phase}-${index}`, phase, origin }));
	return sendOperation(node, { operation: 'insert', database: 'data', table: TABLE, records }).then(() =>
		records.map((record) => record.id)
	);
}

/** Ids of the rows a node holds in `phase`. */
export async function phaseIds(node, phase, signal) {
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
	);
	return new Set(found.map(({ id }) => id));
}

export async function waitForPhase(nodes, phase, count) {
	await waitForCondition(
		async (signal) => {
			for (const node of nodes) {
				// a node that is restarting refuses the connection for a moment
				const ids = await phaseIds(node, phase, signal).catch(() => new Set());
				if (ids.size < count) return false;
			}
			return true;
		},
		{ timeoutMs: 120_000, description: `every node holds the ${count} ${phase} records` }
	);
}

/** Per record id, how many frames each receiver was sent, summed over every sender's log since its mark. */
export async function sendsSince(nodes, marks, ids) {
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
export async function waitForSuppliers(nodes, expected, description) {
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

export async function markAll(nodes) {
	const marks = new Map();
	for (const node of nodes) marks.set(node.hostname, await logMark(node));
	return marks;
}

/**
 * Region and role of each of nine sorted hostnames, and what the topology should derive from them. `nodes` returns
 * the live node handles, which a restart replaces.
 */
export function regionLayout(hostnames, nodes) {
	const region = new Map(hostnames.map((name, index) => [name, REGIONS[Math.floor(index / 3)]]));
	const gateways = new Set(hostnames.filter((_, index) => index % 3 !== 2));
	const isGatewayName = (name) => gateways.has(name);
	const byName = (name) => nodes().find((node) => node.hostname === name);
	return {
		region,
		gateways,
		isGatewayName,
		byName,
		// east: [primary, standby, leaf], and so on
		named: (regionName, index) => byName(hostnames.filter((name) => region.get(name) === regionName)[index]),
		expectedLinks: (node) =>
			new Set(
				nodes()
					.filter(
						(peer) =>
							peer !== node &&
							(region.get(peer.hostname) === region.get(node.hostname) ||
								(isGatewayName(peer.hostname) && isGatewayName(node.hostname)))
					)
					.map((peer) => peer.hostname)
			),
		/**
		 * Settled suppliers with `down` stopped: a leaf, and a gateway that is not its region's first live one, take
		 * every remote origin they do not link to from that first live gateway; that gateway takes a remote leaf from
		 * any live gateway of the leaf's region.
		 */
		steadySuppliers:
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
			},
	};
}
