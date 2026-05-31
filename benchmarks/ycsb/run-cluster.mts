/**
 * YCSB-style CRUD load test against a 3-node Harper (Pro) cluster.
 *
 * Starts N connected nodes (default 3, threads.count=4 each), each with the
 * shared `usertable` app pre-installed, connects them into a cluster, then drives
 * the YCSB load + run phases round-robin across all nodes over REST (data
 * propagates via cluster replication). Reuses the workload generator, REST
 * transport, and harness from core (benchmarks/ycsb/) so the workloads and result
 * shape match the single-node run.
 *
 * Build the Pro distribution first (or point HARPER_INTEGRATION_TEST_INSTALL_SCRIPT
 * at a built dist/bin/harper.js), then:
 *   node benchmarks/ycsb/run-cluster.mts --scale=standard
 *   node benchmarks/ycsb/run-cluster.mts --scale=quick --nodes=3
 *
 * Default workloads are the lag-safe set C,B,A,F,E. Under round-robin reads with
 * asynchronous replication, workload D (read-latest-after-insert) is dominated by
 * replication lag — pass --workloads=D explicitly to observe it, expecting reads
 * of not-yet-replicated keys to surface as errors.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { parseOptions, runBenchmark, writeResults, printReport } from '../../core/benchmarks/ycsb/harness.mts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ?? join(REPO_ROOT, 'dist', 'bin', 'harper.js');
const APP_DIR = join(REPO_ROOT, 'core', 'benchmarks', 'ycsb', 'app');
const REPLICATION_PORT = 9933;

interface Node {
	httpURL: string;
	operationsAPIURL: string;
	hostname: string;
	admin: { username: string; password: string };
	process: { kill: (signal?: string) => void };
}

async function sendOperation(node: Node, operation: Record<string, unknown>): Promise<any> {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	// Read text then parse, so a non-JSON error body (gateway error, plain text) surfaces the
	// real status instead of masking it with a JSON SyntaxError.
	const text = await response.text();
	let data: any;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}
	if (response.status !== 200) {
		const detail = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data);
		throw new Error(`operation ${operation.operation} -> ${response.status}: ${detail}`);
	}
	return data;
}

async function waitForRoute(url: string, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
			await res.body?.cancel(); // always drain, even on 5xx, so the socket is freed
			if (res.status < 500) return;
		} catch {
			// not accepting connections yet (or this probe timed out)
		}
		await delay(250);
	}
	throw new Error(`timed out waiting for ${url}`);
}

// Pushes each started node into `nodes` as it comes up. Uses allSettled (not Promise.all) so
// every startup has fully settled before we return/throw — otherwise a sibling's rejection would
// let other in-flight startups complete and push *after* the caller's teardown ran, orphaning them.
async function startNodes(
	nodes: Node[],
	count: number,
	threads: number,
	engine: string,
	startupTimeoutMs: number
): Promise<void> {
	const outcomes = await Promise.allSettled(
		Array.from({ length: count }, async (_, i) => {
			const hostname = await getNextAvailableLoopbackAddress();
			// Pre-install the app on each node (each gets the usertable schema locally), so no
			// deploy_component + restart is needed — that restart raced the load and dropped writes.
			// Cluster replication then propagates the data, matching the replicationLoad pattern.
			const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-ycsb-cluster-'));
			await cp(APP_DIR, join(dataRootDir, 'components', 'ycsb-app'), { recursive: true });
			const ctx: any = { name: `ycsb-cluster-${i}`, harper: { hostname, dataRootDir } };
			await startHarper(ctx, {
				harperBinPath: HARPER_BIN,
				startupTimeoutMs,
				env: { HARPER_STORAGE_ENGINE: engine },
				config: {
					threads: { count: threads },
					analytics: { aggregatePeriod: -1 },
					logging: { level: 'warn' },
					replication: { securePort: `${hostname}:${REPLICATION_PORT}` },
				},
			});
			nodes.push(ctx.harper as Node);
			console.log(`  node ${i} up at ${ctx.harper.httpURL} (pid ${ctx.harper.process.pid})`);
		})
	);
	const failures = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
	if (failures.length > 0) {
		throw new AggregateError(
			failures.map((f) => f.reason),
			`${failures.length} of ${count} nodes failed to start`
		);
	}
}

async function connectCluster(nodes: Node[]): Promise<void> {
	const token = (
		await sendOperation(nodes[0], { operation: 'create_authentication_tokens', authorization: nodes[0].admin })
	).operation_token;
	for (let j = 1; j < nodes.length; j++) {
		await sendOperation(nodes[j], {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: nodes[0].hostname,
			authorization: `Bearer ${token}`,
		});
	}
	for (let retries = 0; ; retries++) {
		const statuses = await Promise.all(nodes.map((node) => sendOperation(node, { operation: 'cluster_status' })));
		const connected = statuses.every(
			(s) =>
				s.connections.length === nodes.length - 1 &&
				s.connections.every((c: any) => c.database_sockets.every((sock: any) => sock.connected))
		);
		if (connected) break;
		if (retries > 15) throw new Error('timed out waiting for cluster to connect');
		await delay(200 * (retries + 1));
	}
}

function withClusterDefaults(argv: string[]): string[] {
	const args = [...argv];
	if (!args.some((a) => a.startsWith('--workloads'))) args.push('--workloads=C,B,A,F,E');
	if (!args.some((a) => a.startsWith('--settle-ms'))) args.push('--settle-ms=10000');
	return args;
}

async function main(): Promise<void> {
	const options = parseOptions(withClusterDefaults(process.argv.slice(2)));
	const nodeCount = options.nodeCount;

	console.log(`Starting ${nodeCount}-node cluster (threads.count=${options.threads}, engine=${options.engine})...`);
	const nodes: Node[] = [];
	try {
		await startNodes(nodes, nodeCount, options.threads, options.engine, options.startupTimeoutMs);
		await Promise.all(nodes.map((node) => waitForRoute(`${node.httpURL}/usertable/`, 60_000)));
		console.log('Connecting cluster...');
		await connectCluster(nodes);

		const baseUrls = nodes.map((n) => n.httpURL);
		console.log(`Driving load round-robin across ${baseUrls.length} nodes.`);
		const results = await runBenchmark(baseUrls, options, { topology: 'round-robin', nodeCount });
		const file = await writeResults(results, options.out, 'cluster');
		printReport(results);
		console.log(`\nResults written to ${file}`);
	} finally {
		await Promise.all(nodes.map((node) => teardownHarper({ harper: node } as any)));
		console.log('Cluster stopped.');
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
