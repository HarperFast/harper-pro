/**
 * A copy hole stands until its node is rebuilt or replaced (harper-pro#1092; `replication/DESIGN.md` item 33, "Row
 * ownership").
 *
 * One sharded database `data`, two shards:
 *
 *   A (shard 0) ── C (shard 1) ── B (shard 1, an injected decode failure drops every `hole-*` record)
 *
 * B's projection from A drops `hole-1`, a record of an ordinary table, so B records a hole: it warns and lists the hole
 * in `cluster_status`. Replacing B the way the warning says (drain, `remove_node`, then `add_node` an empty node D under
 * a new name) leaves no hole: D's own projection carries `hole-1`. A multi-shard database admits no checkpoint across
 * shards yet, so admission after a fill is covered by `unitTests/replication/originFloorSeqRow.test.mjs` instead.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, match } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	sendOperation,
	postOperation,
	stopNodeProcess,
	stopAndTeardownNodes,
	waitForCondition,
} from './clusterShared.mjs';

const TEST_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(TEST_DIR, '..', '..', 'dist', 'bin', 'harper.js');

const TABLE = 'Plain';
const TIMEOUT_MS = 120_000;
const SCHEMA = `type ${TABLE} @table(database: "data") @export {
	id: ID @primaryKey
}
type Rows @table(database: "data") @export @sharded(slots: 2) {
	id: ID @primaryKey
	body: String
}
`;

suite('A copy hole is cleared by replacing its node (harper-pro#1092)', { timeout: 600_000 }, (ctx) => {
	const contexts = {};
	const retired = [];

	async function provision(key, shard, env = {}) {
		const hostname = await getNextAvailableLoopbackAddress();
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'checkpoint-hole-')
		);
		const component = join(dataRootDir, 'components', 'checkpoint-hole');
		await mkdir(component, { recursive: true });
		await writeFile(join(component, 'config.yaml'), "rest: true\ngraphqlSchema:\n  files: 'schema.graphql'\n");
		await writeFile(join(component, 'schema.graphql'), SCHEMA);
		const context = { name: ctx.name, harper: { hostname, dataRootDir } };
		contexts[key] = context;
		await startHarper(context, {
			env,
			config: {
				threads: { count: 1 },
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: false, level: 'warn' },
				replication: { failover: true, securePort: hostname + ':9933', databases: '*', shard, shards: [0, 1] },
				operationsApi: { network: { domainSocket: false } },
			},
		});
		return context.harper;
	}

	async function addNode(node, peer) {
		const { operation_token } = await sendOperation(peer, {
			operation: 'create_authentication_tokens',
			authorization: peer.admin,
		});
		await sendOperation(node, {
			operation: 'add_node',
			hostname: peer.hostname,
			authorization: 'Bearer ' + operation_token,
			rejectUnauthorized: false,
		});
	}

	const status = (node, signal) => sendOperation(node, { operation: 'cluster_status' }, { signal });

	const ready = (nodes) =>
		waitForCondition(
			async (signal) =>
				(await Promise.all(nodes.map((node) => status(node, signal)))).every(
					(response) => response.sharding?.data?.recovery?.phase === 'ready'
				),
			{ timeoutMs: TIMEOUT_MS, description: 'every owner has a complete baseline' }
		);

	async function hasRecord(node, id) {
		const rows = await sendOperation(node, {
			operation: 'search_by_id',
			database: 'data',
			table: TABLE,
			ids: [id],
			get_attributes: ['id'],
		});
		return rows.some((row) => row.id === id);
	}

	before(async () => {
		const A = await provision('A', 0);
		const C = await provision('C', 1);
		await addNode(C, A);
		await ready([A, C]);
		await sendOperation(A, {
			operation: 'upsert',
			database: 'data',
			table: TABLE,
			records: [{ id: 'seed' }, { id: 'hole-1' }],
		});
		await waitForCondition(() => hasRecord(C, 'hole-1'), { timeoutMs: TIMEOUT_MS, description: 'C holds hole-1' });
		// B joins after the records exist, so its projection from A carries them
		const B = await provision('B', 1, { HARPER_TEST_DECODE_FAIL_RECORD_PREFIX: 'hole-' });
		await addNode(B, A);
		await ready([A, B, C]);
	});

	after(async () => {
		await stopAndTeardownNodes([...Object.values(contexts).map((context) => context.harper), ...retired]);
	});

	test('a record a projection dropped stands as a hole, warned and listed in cluster_status', async () => {
		const { harper: A } = contexts.A;
		const { harper: B } = contexts.B;
		const { harper: C } = contexts.C;
		let holes;
		await waitForCondition(
			async (signal) => (holes = (await status(B, signal)).sharding?.data?.checkpointHoles)?.length > 0,
			{ timeoutMs: TIMEOUT_MS, description: 'B lists its hole in cluster_status' }
		);
		ok(
			holes.some((hole) => hole.source === A.hostname && hole.origins.includes(A.hostname)),
			JSON.stringify(holes)
		);
		equal((await status(C)).sharding.data.checkpointHoles, undefined, 'C dropped nothing');
		match(
			await readFile(join(B.logDir ?? join(B.dataRootDir, 'log'), 'hdb.log'), 'utf8'),
			/checkpoint admission is void for .*Rebuilding or replacing this node fills it/
		);
		ok(await hasRecord(B, 'seed'));
		equal(await hasRecord(B, 'hole-1'), false);
	});

	test('replacing the node under a new name leaves no hole', async () => {
		const { harper: A } = contexts.A;
		const { harper: B } = contexts.B;
		const { harper: C } = contexts.C;
		// B wrote nothing of its own, so there is nothing to drain before it leaves
		await stopNodeProcess(B);
		retired.push(B);
		delete contexts.B;
		for (const node of [A, C]) {
			// the removal on A replicates, so C may already have none
			// B is stopped, so the removal is forced rather than waiting for it to drain
			const response = await postOperation(node, { operation: 'remove_node', hostname: B.hostname, force: true });
			if (response.status !== 200) equal(response.body.error, B.hostname + ' does not exist');
		}
		const D = await provision('D', 1);
		await addNode(D, A);
		await ready([A, C, D]);
		ok(await hasRecord(D, 'hole-1'), 'the new node’s projection carried the record');
		equal((await status(D)).sharding.data.checkpointHoles, undefined);
	});
});
