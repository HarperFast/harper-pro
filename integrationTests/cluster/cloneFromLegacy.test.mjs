/**
 * Clone a v5 node from a legacy v4 source via HDB_LEADER_URL.
 *
 * This exercises the cloneNode bootstrap flow against a v4 leader, which is the
 * §3a "recommended" path in the v4 → v5 Fabric Cluster Migration Runbook:
 * cloneNode marks the leader as `isLeader: true`, and that's the only thing
 * that triggers the full-table-copy path at replication/replicationConnection.ts
 * (look for "Replicating all tables to"). Plain `add_node` does *not* set
 * isLeader and so only does audit-log catchup — meaning customers with data
 * older than the v4 audit-log retention silently lose those records on the
 * audit-log-only path.
 *
 * The test is skipped when HARPER_LEGACY_VERSION_PATH is not set. CI sets it
 * (see .github/workflows/integration-tests.yaml).
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { join } from 'node:path';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const RECORDS_PER_TABLE = 50;
const CLONE_AVAILABLE_TIMEOUT_MS = 120000;

async function waitForAvailableStatus(node, timeoutMs = CLONE_AVAILABLE_TIMEOUT_MS, checkInterval = 2000) {
	const timeoutAt = Date.now() + timeoutMs;
	while (Date.now() < timeoutAt) {
		await delay(checkInterval);
		let response;
		try {
			response = await sendOperation(node, { operation: 'get_status', id: 'availability' });
		} catch {}
		if (response?.status === 'Available') return true;
	}
	throw new Error(`Cloned node status did not become Available within ${timeoutMs}ms`);
}

suite('Clone from legacy v4 leader', { timeout: 240000 }, (ctx) => {
	const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;

	before(async () => {
		ctx.nodes = [];
		if (!legacyPath) return;

		// Start a v4 source node. The replication block is the same shape the
		// existing legacy test in replicationTopology.test.mjs uses, which is
		// known to be accepted by v4.
		const legacyHostname = await getNextAvailableLoopbackAddress();
		const legacyCtx = { name: ctx.name, harper: { hostname: legacyHostname } };
		await startHarper(legacyCtx, {
			config: {
				logging: { colors: false, stdStreams: true, console: true },
				replication: {
					securePort: legacyHostname + ':9933',
					databases: ['data'],
				},
			},
			env: {
				TC_AGREEMENT: 'yes',
				REPLICATION_HOSTNAME: legacyHostname,
			},
			harperBinPath: join(legacyPath, 'bin', 'harperdb.js'),
		});
		ctx.nodes.push(legacyCtx.harper);

		// Pre-populate two tables on the v4 source. Multiple tables exercises
		// the per-table loop inside the full-copy path (replicationConnection.ts
		// around line 1466); RECORDS_PER_TABLE rows per table catches the
		// "first record in a batch only" class of bugs.
		for (const table of ['historical_orders', 'historical_users']) {
			await sendOperation(legacyCtx.harper, {
				operation: 'create_table',
				table,
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'data', type: 'String' },
				],
			});
			const records = [];
			for (let i = 0; i < RECORDS_PER_TABLE; i++) {
				records.push({ id: `${table}-${i}`, data: `${table} record ${i}` });
			}
			await sendOperation(legacyCtx.harper, { operation: 'upsert', table, records });
		}
	});

	after(async () => {
		if (!ctx.nodes?.length) return;
		await Promise.all(ctx.nodes.map((node) => teardownHarper({ harper: node })));
	});

	// See issue #236: v5 cloneNode now derives the leader's replication URL from
	// `get_configuration` (so a v4 default `securePort: 9933` resolves to `wss://`,
	// not `ws://`) and pre-creates the leader's user databases/tables locally
	// before set_node so the v5 → v4 outgoing subscription actually starts. Prior
	// to that fix the v5 clone sat at "Available never reached" because
	// `forEachReplicatedDatabase` only iterates over locally-existing databases.
	test('cloneNode against a v4 leader copies every record (full-table-copy path)', async () => {
		if (!legacyPath) return;

		const legacy = ctx.nodes[0];

		// Start a v5 node pointed at the v4 source via HDB_LEADER_URL. This is
		// what the §3a procedure in the runbook does. The cloneNode workflow
		// will register this node with the v4 leader as a follower with
		// isLeader: true, which is what triggers the full-table-copy path on
		// the v4 side (sender walks the table's primary store, emits every
		// record). Credentials are passed via the env vars cloneNode reads.
		const cloneHostname = await getNextAvailableLoopbackAddress();
		const cloneCtx = { name: ctx.name, harper: { hostname: cloneHostname } };
		await startHarper(cloneCtx, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, stdStreams: true, console: true },
				replication: {
					securePort: cloneHostname + ':9933',
					databases: ['data'],
				},
			},
			env: {
				HDB_LEADER_URL: legacy.operationsAPIURL,
				HDB_LEADER_USERNAME: legacy.admin.username,
				HDB_LEADER_PASSWORD: legacy.admin.password,
				ALLOW_SELF_SIGNED: true,
				HARPER_NO_FLUSH_ON_EXIT: true,
			},
		});
		ctx.nodes.push(cloneCtx.harper);

		await waitForAvailableStatus(cloneCtx.harper);

		// Both pre-existing tables must be present with their full record
		// counts on the v5 clone. If the audit-log-only path had been taken,
		// these records (written before the v5 node existed) would not have
		// arrived — that's the regression this test guards against.
		for (const table of ['historical_orders', 'historical_users']) {
			let response;
			let retries = 0;
			do {
				await delay(500);
				try {
					response = await sendOperation(cloneCtx.harper, {
						operation: 'search_by_value',
						search_attribute: 'id',
						search_value: '*',
						table,
						get_attributes: ['id', 'data'],
					});
				} catch {
					response = undefined;
				}
			} while ((response?.length ?? 0) < RECORDS_PER_TABLE && retries++ < 60);
			equal(
				response?.length ?? 0,
				RECORDS_PER_TABLE,
				`Clone node only has ${response?.length ?? 0}/${RECORDS_PER_TABLE} records in table ${table}; full-table-copy from v4 did not deliver everything`
			);
		}

		// Cluster-status check: the v5 clone should now have the v4 source as
		// a peer, connected on the replication socket. Without this we can't
		// be sure ongoing audit-log forwarding will take over from full-copy.
		const status = await sendOperation(cloneCtx.harper, { operation: 'cluster_status' });
		const legacyConn = status.connections.find((c) => c.name === legacy.hostname || c.url?.includes(legacy.hostname));
		ok(legacyConn, 'Clone node should list the v4 source in cluster_status connections');
		ok(
			legacyConn.database_sockets?.some?.((s) => s.connected),
			'Clone node should have at least one connected database socket to the v4 source after clone'
		);
	});

	test('Ongoing writes on v4 after clone continue to replicate', async () => {
		if (!legacyPath) return;

		const legacy = ctx.nodes[0];
		const clone = ctx.nodes[1];
		if (!clone) return;

		// After the clone is complete, audit-log forwarding should pick up new
		// writes on the v4 source and ship them to the v5 clone. This is the
		// path the migration uses for the live delta between bootstrap and
		// cutover.
		await sendOperation(legacy, {
			operation: 'upsert',
			table: 'historical_orders',
			records: [{ id: 'post-clone-1', data: 'written after clone' }],
		});

		let response;
		let retries = 0;
		do {
			await delay(300);
			try {
				response = await sendOperation(clone, {
					operation: 'search_by_id',
					table: 'historical_orders',
					get_attributes: ['id', 'data'],
					ids: ['post-clone-1'],
				});
			} catch {
				response = undefined;
			}
		} while ((response?.length ?? 0) === 0 && retries++ < 30);
		equal(response?.length ?? 0, 1, 'Post-clone v4 write did not reach v5 clone via audit-log forwarding');
		equal(response[0].data, 'written after clone');
	});
});
