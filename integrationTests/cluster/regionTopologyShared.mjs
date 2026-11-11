/**
 * Cluster setup and probes shared by the region topology suites (harper-pro#1343): 3 regions × 3 nodes, regions set
 * by `replication.region`. Addresses are sorted and grouped in threes, so a node's lane is its position in its
 * region, and each lane is a column across the three regions.
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

/**
 * Waits until no node has sent a `data` base copy for `quietMs`. Links report connected while the full copy each new
 * link takes is still applying, and a copy vetoed by another copy into its source is retried a few seconds later.
 */
export async function waitForCopiesSettled(nodes, description, quietMs = 5000) {
	let copying = [];
	let quietSince;
	await waitForCondition(
		async (signal) => {
			copying = [];
			for (const node of nodes) {
				const status = await sendOperation(node, { operation: 'cluster_status' }, { signal });
				for (const connection of status.connections) {
					for (const socket of connection.database_sockets) {
						if (socket.database === 'data' && socket.sendingMessage === 'Copying') {
							copying.push(`${node.hostname} to ${connection.name}`);
						}
					}
				}
			}
			if (copying.length) quietSince = undefined;
			else quietSince ??= Date.now();
			return Date.now() - quietSince >= quietMs;
		},
		{ timeoutMs: 180_000, pollMs: 500, description: () => `${description}; copying: ${copying.join(', ')}` }
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
	let short = {};
	await waitForCondition(
		async (signal) => {
			short = {};
			for (const node of nodes) {
				// a node that is restarting refuses the connection for a moment
				const ids = await phaseIds(node, phase, signal).catch(() => new Set());
				if (ids.size < count) short[node.hostname] = ids.size;
			}
			return Object.keys(short).length === 0;
		},
		{
			timeoutMs: 120_000,
			description: () => `every node holds the ${count} ${phase} records; held: ${JSON.stringify(short)}`,
		}
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
 * What the grid should derive for `hostnames`, which `regionOf` (a Map) places in regions; without it, nine sorted
 * hostnames are grouped in threes. A node's lane is its rank by name in its region, and a region with no node in a
 * lane has its member `lane mod size` carry it. `nodes` returns the live node handles, which a restart replaces.
 */
export function regionLayout(hostnames, nodes, regionOf) {
	const sorted = [...hostnames].sort();
	const region = regionOf ?? new Map(sorted.map((name, index) => [name, REGIONS[Math.floor(index / 3)]]));
	const inRegion = (regionName) => sorted.filter((name) => region.get(name) === regionName);
	const lane = new Map(sorted.map((name) => [name, inRegion(region.get(name)).indexOf(name)]));
	const byName = (name) => nodes().find((node) => node.hostname === name);
	const carrier = (regionName, origin) => {
		const members = inRegion(regionName);
		return members[lane.get(origin)] ?? members[lane.get(origin) % members.length];
	};
	const receivesDirect = (name, origin) =>
		region.get(name) === region.get(origin) || carrier(region.get(name), origin) === name;
	return {
		region,
		lane,
		byName,
		carrier,
		receivesDirect,
		// east: [lane 0, lane 1, lane 2], and so on
		named: (regionName, index) => byName(inRegion(regionName)[index]),
		/** The peers a node subscribes to itself: its region, and the origins whose column it carries. */
		expectedLinks: (node) =>
			new Set(
				nodes()
					.filter((peer) => peer !== node && region.has(peer.hostname) && receivesDirect(node.hostname, peer.hostname))
					.map((peer) => peer.hostname)
			),
		/**
		 * Settled suppliers with `down` stopped: a node takes a remote origin it does not receive itself from its
		 * region's carrier of that column. With the carrier down, the region's lowest-named live node takes the origin
		 * by a direct link (its supplier is then the origin itself) and the others take it from that node.
		 */
		steadySuppliers:
			(down = new Set()) =>
			(node) => {
				const mates = inRegion(region.get(node.hostname));
				const want = new Map();
				for (const origin of sorted) {
					if (down.has(origin) || receivesDirect(node.hostname, origin)) continue;
					const carries = carrier(region.get(node.hostname), origin);
					if (!down.has(carries)) want.set(origin, [carries]);
					else {
						const standIn = mates.find((name) => name !== carries && !down.has(name));
						want.set(origin, [standIn === node.hostname ? origin : standIn]);
					}
				}
				return want;
			},
	};
}
