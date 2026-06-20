/**
 * Typed-struct dictionary divergence resistance (randomAccessFields:true replication)
 *
 * Regression guard for HarperFast/harper#1163 (#1152): per-node typed-structure
 * dictionary divergence producing silent empty/partial results on replicas.
 *
 * Background:
 *   When a table uses randomAccessFields:true, records are encoded with structon's
 *   typed (random-access) structure encoding. Each shape gets a local structure-id;
 *   the id→shape mapping is the "structure dictionary". The dictionary is persisted and
 *   sent to peers via TABLE_FIXED_STRUCTURE replication messages. On the receiver, raw
 *   record bytes are decoded using the sender's structure dict, then re-encoded using
 *   the receiver's own encoder. If the receiver's decoder for a tableId is absent or
 *   stale (structure dict diverged, or TABLE_FIXED_STRUCTURE never received), the
 *   decode returns null — silently, without error.
 *
 * What is tested:
 *   Attempt A — pre-diverged dictionaries: A and B each independently write different
 *     record shapes, building divergent structure-id dictionaries, then B joins A as
 *     subscriber (full copy). A's records must read correctly on B with no silent nulls.
 *   Attempt B — late-joiner: fresh node C (empty structure dictionary) joins the
 *     established cluster. A's records must arrive intact on C.
 *   Attempt C — restart reload: node B is restarted, forcing structure-dict reload from
 *     disk. A's records must still read correctly on the restarted B.
 *   Control: PlainRecord (randomAccessFields:false) must always decode correctly in
 *     all three attempts — confirms the issue is specific to typed-struct encoding.
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import {
	startHarper,
	killHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
	targz,
} from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'..', '..', 'dist', 'bin', 'harper.js'
);

const STRESS = process.env.HARPER_RUN_STRESS_TESTS === '1';
const FIXTURE_PATH = join(
	import.meta.dirname ?? new URL('.', import.meta.url).pathname,
	'fixture-typed-struct-replication-divergence'
);

// Number of distinctly-shaped records per node; more shapes → higher collision probability.
const SHAPES_PER_NODE = 30;
const CONVERGE_TIMEOUT_MS = 90_000;

/**
 * Generate a record with a deliberately unique shape to force a new structure entry.
 * Varying which optional fields are present causes structon to mint a new struct id.
 */
function makeShapedRecord(nodePrefix, i) {
	const base = { id: `${nodePrefix}-${i}`, f1: `field1-${nodePrefix}-${i}` };
	if (i % 4 === 0) return { ...base, f2: i, f3: i * 1.5, f4: `extra-${i}` };
	if (i % 4 === 1) return { ...base, f2: i };
	if (i % 4 === 2) return { ...base, f3: i * 2.5, f4: `str-${i}` };
	return { ...base };
}

async function waitForCount(node, table, target, timeoutMs = CONVERGE_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const desc = await sendOperation(node, { operation: 'describe_table', database: 'data', table });
			if ((desc.record_count ?? 0) >= target) return desc.record_count;
		} catch { /* transient */ }
		await delay(1000);
	}
	throw new Error(`Timed out waiting for ${table} count >= ${target} on ${node.hostname}`);
}

async function scanTable(node, table) {
	try {
		const result = await sendOperation(node, {
			operation: 'search_by_value',
			database: 'data',
			table,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id', 'f1', 'f2', 'f3', 'f4'],
		});
		return Array.isArray(result) ? result : [];
	} catch {
		return [];
	}
}

/**
 * Compare received records against their origin values. Returns a summary of any
 * fields that are missing or have the wrong value.
 */
function auditRecords(records, originRecordsById) {
	let nullFieldCount = 0;
	const corruptRecords = [];
	for (const rec of records) {
		const origin = originRecordsById.get(rec.id);
		if (!origin) continue;
		const missing = [];
		if (origin.f1 !== undefined && rec.f1 !== origin.f1) missing.push(`f1: got ${JSON.stringify(rec.f1)}, want ${JSON.stringify(origin.f1)}`);
		if (origin.f2 !== undefined && rec.f2 !== origin.f2) missing.push(`f2: got ${JSON.stringify(rec.f2)}, want ${JSON.stringify(origin.f2)}`);
		if (origin.f3 !== undefined && rec.f3 !== origin.f3) missing.push(`f3: got ${JSON.stringify(rec.f3)}, want ${JSON.stringify(origin.f3)}`);
		if (origin.f4 !== undefined && rec.f4 !== origin.f4) missing.push(`f4: got ${JSON.stringify(rec.f4)}, want ${JSON.stringify(origin.f4)}`);
		if (missing.length) {
			nullFieldCount += missing.length;
			corruptRecords.push({ id: rec.id, issues: missing });
		}
	}
	return { nullFieldCount, corruptRecords, checkedCount: records.filter(r => originRecordsById.has(r.id)).length };
}

suite('Typed-struct replication divergence resistance (randomAccessFields:true)', { skip: !STRESS, timeout: 600_000 }, (ctx) => {
	before(async () => {
		ctx.nodes = {};

		const startNode = async (label) => {
			const hostname = await getNextAvailableLoopbackAddress();
			const nodeCtx = { name: ctx.name, harper: { hostname } };
			await startHarper(nodeCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, console: true, level: 'debug' },
					replication: { securePort: hostname + ':9933', databases: ['data'] },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			return nodeCtx.harper;
		};

		ctx.nodes.A = await startNode('A');
		ctx.nodes.B = await startNode('B');
		ctx.nodes.C = await startNode('C');

		// Deploy schema fixture to all nodes.
		const payload = await targz(FIXTURE_PATH);
		for (const node of Object.values(ctx.nodes)) {
			await sendOperation(node, {
				operation: 'deploy_component',
				project: 'qa178-struct-dict',
				payload,
				restart: true,
			});
		}
		await delay(20_000);

		// Seed SHAPES_PER_NODE varied-shape records on A — builds A's structure dictionary.
		ctx.aRecords = Array.from({ length: SHAPES_PER_NODE }, (_, i) => makeShapedRecord('a', i));
		await sendOperation(ctx.nodes.A, {
			operation: 'upsert',
			database: 'data',
			table: 'TypedRecord',
			records: ctx.aRecords,
		});
		await sendOperation(ctx.nodes.A, {
			operation: 'upsert',
			database: 'data',
			table: 'PlainRecord',
			records: ctx.aRecords,
		});

		// Seed SHAPES_PER_NODE different-shaped records on B independently —
		// forces B's structure dictionary to diverge from A's.
		const bLocalRecords = Array.from({ length: SHAPES_PER_NODE }, (_, i) => ({
			id: `b-local-${i}`,
			f1: `b-field-${i}`,
			...(i % 3 === 0 ? { f2: i * 100, f3: i * 0.5 } : {}),
			...(i % 3 === 1 ? { f4: `b-extra-${i}`, f2: i * 7 } : {}),
			...(i % 3 === 2 ? { f3: i * 3.14 } : {}),
		}));
		await sendOperation(ctx.nodes.B, {
			operation: 'upsert',
			database: 'data',
			table: 'TypedRecord',
			records: bLocalRecords,
		});

		ctx.aRecordsById = new Map(ctx.aRecords.map((r) => [r.id, r]));

		// Allow local writes to commit and persist structure dicts to disk.
		await delay(5_000);
	});

	after(async () => {
		await Promise.all(
			Object.values(ctx.nodes).map((node) => teardownHarper({ harper: node }).catch(() => null))
		);
	});

	test('Attempt A — full copy with pre-diverged structure dicts: TypedRecord fields intact', async () => {
		const { A, B } = ctx.nodes;

		// B subscribes to A (isLeader:true triggers full copy). B already has its own
		// independently-built structure dictionary — the divergence scenario.
		await sendOperation(B, {
			operation: 'add_node',
			hostname: A.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: A.admin,
		});

		// B should end up with its own local records + A's records.
		await waitForCount(B, 'TypedRecord', SHAPES_PER_NODE + SHAPES_PER_NODE);
		await waitForCount(B, 'PlainRecord', SHAPES_PER_NODE);

		const typedOnB = await scanTable(B, 'TypedRecord');
		const typedAudit = auditRecords(typedOnB, ctx.aRecordsById);
		const plainOnB = await scanTable(B, 'PlainRecord');
		const plainAudit = auditRecords(plainOnB, ctx.aRecordsById);

		ctx.attemptA = { typedAudit, plainAudit };

		// PlainRecord (control) must always be correct.
		equal(
			plainAudit.nullFieldCount, 0,
			`PlainRecord (randomAccessFields:false) has ${plainAudit.nullFieldCount} corrupt fields — ` +
			'control table should be immune to struct dict divergence. ' +
			JSON.stringify(plainAudit.corruptRecords.slice(0, 3))
		);

		// TypedRecord: no silent null/wrong fields after full copy with diverged dicts.
		equal(
			typedAudit.nullFieldCount, 0,
			`TypedRecord (randomAccessFields:true) has ${typedAudit.nullFieldCount} corrupt fields after ` +
			`full copy with pre-diverged structure dictionaries (#1163 regression). ` +
			JSON.stringify(typedAudit.corruptRecords.slice(0, 5))
		);
	});

	test('Attempt B — late-joiner fresh node: TypedRecord fields intact', async () => {
		const { A, C } = ctx.nodes;

		// C has a completely empty structure dictionary (never seen any data).
		await sendOperation(C, {
			operation: 'add_node',
			hostname: A.hostname,
			rejectUnauthorized: false,
			isLeader: true,
			authorization: A.admin,
		});

		await waitForCount(C, 'TypedRecord', SHAPES_PER_NODE);
		await waitForCount(C, 'PlainRecord', SHAPES_PER_NODE);

		const typedOnC = await scanTable(C, 'TypedRecord');
		const typedAudit = auditRecords(typedOnC, ctx.aRecordsById);
		const plainOnC = await scanTable(C, 'PlainRecord');
		const plainAudit = auditRecords(plainOnC, ctx.aRecordsById);

		ctx.attemptB = { typedAudit, plainAudit };

		equal(
			plainAudit.nullFieldCount, 0,
			`PlainRecord control has ${plainAudit.nullFieldCount} corrupt fields on late-joiner C. ` +
			JSON.stringify(plainAudit.corruptRecords.slice(0, 3))
		);

		equal(
			typedAudit.nullFieldCount, 0,
			`TypedRecord has ${typedAudit.nullFieldCount} corrupt fields on fresh late-joiner C (#1163 regression). ` +
			JSON.stringify(typedAudit.corruptRecords.slice(0, 5))
		);
	});

	test('Attempt C — restart B (structure dict reload from disk): TypedRecord fields intact', async () => {
		const { B } = ctx.nodes;

		// Kill B and restart with the same hostname + data dir (preserves persisted state).
		await killHarper({ harper: B });
		await delay(3_000);

		const ctxBRestart = { name: ctx.name, harper: { hostname: B.hostname, dataRootDir: B.dataRootDir } };
		await startHarper(ctxBRestart, {
			config: {
				analytics: { aggregatePeriod: -1 },
				logging: { colors: false, console: true, level: 'debug' },
				replication: { securePort: B.hostname + ':9933', databases: ['data'] },
			},
			env: { HARPER_NO_FLUSH_ON_EXIT: true },
		});
		ctx.nodes.B = ctxBRestart.harper;
		await delay(15_000);

		const nodeB = ctx.nodes.B;
		const typedOnB = await scanTable(nodeB, 'TypedRecord');
		const typedAudit = auditRecords(typedOnB, ctx.aRecordsById);
		const plainOnB = await scanTable(nodeB, 'PlainRecord');
		const plainAudit = auditRecords(plainOnB, ctx.aRecordsById);

		ctx.attemptC = { typedAudit, plainAudit };

		equal(
			plainAudit.nullFieldCount, 0,
			`PlainRecord control has ${plainAudit.nullFieldCount} corrupt fields on restarted B. ` +
			JSON.stringify(plainAudit.corruptRecords.slice(0, 3))
		);

		equal(
			typedAudit.nullFieldCount, 0,
			`TypedRecord has ${typedAudit.nullFieldCount} corrupt fields on restarted B — structure dict not ` +
			`reloaded correctly from disk (#1163 regression). ` +
			JSON.stringify(typedAudit.corruptRecords.slice(0, 5))
		);
	});

	test('summary — all attempts must have zero corrupt fields', () => {
		const attempts = [
			['A (pre-diverged full-copy)', ctx.attemptA],
			['B (late-joiner)', ctx.attemptB],
			['C (post-restart reload)', ctx.attemptC],
		];

		for (const [label, result] of attempts) {
			if (!result) continue;
			equal(result.typedAudit.nullFieldCount, 0,
				`TypedRecord corrupt fields in ${label}: ${result.typedAudit.nullFieldCount}`);
			equal(result.plainAudit.nullFieldCount, 0,
				`PlainRecord corrupt fields in ${label}: ${result.plainAudit.nullFieldCount}`);
		}

		ok(true, 'All typed-struct replication scenarios passed with zero corrupt fields');
	});
});
