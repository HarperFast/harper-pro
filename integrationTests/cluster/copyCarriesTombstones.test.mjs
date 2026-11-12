/**
 * harper-pro#1331 and #1307 (hdb_nodes): a node that joins by base copy rejects the older writes its source
 * rejects against a deletion. B's stale writes commit with a witness row, so the witness reaching C proves C
 * processed them in the same frame; A stays down while B delivers, since up it would relay only the witness
 * and move C's cursor for B past the stale writes.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const FIXTURE = join(import.meta.dirname, 'fixture-copy-tombstones');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const TABLE = 'Tombstoned';
const WAIT_MS = 120_000;
// a stop has to flush so a restart finds the writes; the harness default escalates to SIGKILL after 5 s
const SHUTDOWN_GRACE_MS = 30_000;

async function request(node, path, options = {}) {
	const response = await fetch(`${node.httpURL}/${path}`, {
		...options,
		headers: {
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
			'Content-Type': 'application/json',
			...options.headers,
		},
		signal: options.signal ?? AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	assert.ok(response.status < 300, `${path} on ${node.hostname}: ${response.status} ${text}`);
	return text ? JSON.parse(text) : undefined;
}

const storedRow = (node, database, table, id, signal) =>
	request(node, 'StoredRow', { method: 'POST', body: JSON.stringify({ database, table, id }), signal });
const dataRow = (node, id, signal) => storedRow(node, 'data', TABLE, id, signal);
const nodeRow = (node, name, signal) => storedRow(node, 'system', 'hdb_nodes', name, signal);
const redeliver = (node, id, record, behind) =>
	request(node, 'Redeliver', {
		method: 'POST',
		body: JSON.stringify({ database: 'data', table: TABLE, id, record, behind }),
	});
const writeTogether = (node, database, writes) =>
	request(node, 'WriteTogether', { method: 'POST', body: JSON.stringify({ database, writes }) });
const put = (node, id, record) =>
	request(node, `${TABLE}/${id}`, { method: 'PUT', body: JSON.stringify({ id, ...record }) });

function nodeOptions(hostname, env) {
	return {
		config: {
			analytics: { aggregatePeriod: -1 },
			logging: { colors: false, stdStreams: true, console: true, level: 'warn' },
			replication: { securePort: hostname + ':9933' },
		},
		env,
	};
}

function cluster(name) {
	const contexts = [];
	return {
		contexts,
		async startFresh(env) {
			const hostname = await getNextAvailableLoopbackAddress();
			const parentDir = process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir();
			const dataRootDir = await mkdtemp(join(parentDir, 'harper-integration-test-'));
			const context = { name, harper: { hostname, dataRootDir }, env };
			contexts.push(context);
			await cp(FIXTURE, join(dataRootDir, 'components', basename(FIXTURE)), { recursive: true, dereference: true });
			await startHarper(context, nodeOptions(hostname, env));
			return context;
		},
		async stop(context) {
			await killHarper(context, { graceMs: SHUTDOWN_GRACE_MS });
		},
		async start(context) {
			await startHarper(context, nodeOptions(context.harper.hostname, context.env));
		},
		async join(context, leader) {
			await sendOperation(context.harper, {
				operation: 'add_node',
				hostname: leader.harper.hostname,
				rejectUnauthorized: false,
				authorization: leader.harper.admin,
			});
		},
		async waitForMesh(members) {
			let summary;
			await waitForCondition(
				async (signal) => {
					const statuses = await Promise.all(
						members.map((context) => sendOperation(context.harper, { operation: 'cluster_status' }, { signal }))
					);
					summary = statuses.map((status) => status.connections.map(({ name }) => name));
					return statuses.every((status, i) => {
						const peers = members.filter((_, j) => j !== i).map((context) => context.harper.hostname);
						return peers.every((peer) =>
							status.connections.some(
								(connection) =>
									connection.name === peer &&
									['data', 'system'].every((database) =>
										connection.database_sockets?.some((socket) => socket.database === database && socket.connected)
									)
							)
						);
					});
				},
				{ timeoutMs: WAIT_MS, pollMs: 1000, description: () => `a connected mesh; last: ${JSON.stringify(summary)}` }
			);
		},
		teardown() {
			return stopAndTeardownNodes(contexts.map((context) => context.harper));
		},
	};
}

function waitFor(probe, description) {
	return waitForCondition(probe, { timeoutMs: WAIT_MS, pollMs: 500, description });
}

suite('a base copy carries deletions', { timeout: 900_000, skip: isLMDB && 'copy-apply is RocksDB-only' }, (ctx) => {
	const nodes = cluster(ctx.name);
	let A, B, D, C;
	const tombstones = {};

	before(async () => {
		[A, B, D] = await Promise.all([nodes.startFresh(), nodes.startFresh(), nodes.startFresh()]);
		await nodes.join(B, A);
		await nodes.join(D, A);
		await nodes.waitForMesh([A, B, D]);
		await put(A.harper, 'k-put', { name: 'v1' });
		await put(A.harper, 'k-patch', { name: 'v1', count: 1 });
		// gives A a position in B's data log, so A's copy hands C a cursor for it
		await put(B.harper, 'b-seed', { name: 'b' });
		for (const context of [A, B, D])
			for (const id of ['k-put', 'k-patch', 'b-seed'])
				await waitFor(
					async (signal) => (await dataRow(context.harper, id, signal)).present,
					`${id} on ${context.harper.hostname}`
				);
	});

	after(() => nodes.teardown());

	test('B writes to rows A deletes while the two cannot reach each other', async () => {
		await nodes.stop(A);
		await writeTogether(B.harper, 'data', [
			{ table: TABLE, op: 'patch', id: 'k-patch', record: { name: 'stale patch' } },
			{ table: TABLE, op: 'put', id: 'k-put', record: { id: 'k-put', name: 'stale put' } },
			{ table: TABLE, op: 'put', id: 'witness-data', record: { id: 'witness-data', name: 'witness' } },
		]);
		await writeTogether(B.harper, 'system', [
			{ table: 'hdb_nodes', op: 'rewrite', id: D.harper.hostname },
			{ table: 'CopyWitness', op: 'put', id: 'witness-system', record: { id: 'witness-system' } },
		]);
		await Promise.all([nodes.stop(B), nodes.stop(D)]);

		await nodes.start(A);
		await sendOperation(A.harper, { operation: 'delete', database: 'data', table: TABLE, ids: ['k-put', 'k-patch'] });
		await sendOperation(A.harper, { operation: 'remove_node', hostname: D.harper.hostname });
		await put(A.harper, 'sentinel', { name: 'after the deletes' });
		for (const [id, read] of [
			['k-put', dataRow],
			['k-patch', dataRow],
			[D.harper.hostname, nodeRow],
		]) {
			const row = await read(A.harper, id);
			assert.equal(row.present, false, `${id} on A`);
			assert.ok(row.fullWriteHead, `premise: A holds ${id} as a flagged tombstone`);
			tombstones[id] = row.version;
		}
	});

	test('a node that joins by copy stores each deletion as a tombstone at its version and origin', async () => {
		C = await nodes.startFresh();
		await nodes.join(C, A);
		await waitFor(async (signal) => (await dataRow(C.harper, 'sentinel', signal)).present, 'the copy to reach C');
		// only A's system copy brings D's tombstone, and it sorts after B's row, which arrives first
		await waitFor(
			async (signal) => (await nodeRow(C.harper, D.harper.hostname, signal)).stored,
			"D's copied tombstone"
		);
		const expectTombstones = async (when) => {
			for (const [id, read] of [
				['k-put', dataRow],
				['k-patch', dataRow],
				[D.harper.hostname, nodeRow],
			]) {
				const { originId, ...row } = await read(C.harper, id);
				assert.ok(originId, `${id} on C keeps a remote origin`);
				assert.deepEqual(
					row,
					{
						stored: true,
						present: false,
						version: tombstones[id],
						origin: A.harper.hostname,
						fullWriteHead: true,
						history: 0,
					},
					`${id} on C ${when}`
				);
			}
		};
		await expectTombstones('after the copy');
		await nodes.stop(C);
		await nodes.start(C);
		await expectTombstones('after a restart');
	});

	test('older writes delivered after the copy do not recreate the rows or the removed node', async () => {
		await nodes.stop(A);
		await nodes.start(B);
		// B never learned C's row while A was down
		await nodes.join(C, B);
		await waitFor(
			async (signal) => (await dataRow(C.harper, 'witness-data', signal)).present,
			'the data witness, committed with the stale writes, to reach C'
		);
		await waitFor(
			async (signal) => (await storedRow(C.harper, 'system', 'CopyWitness', 'witness-system', signal)).present,
			"the system witness, committed with D's rewritten row, to reach C"
		);
		const resurrected = async (node) => {
			const found = [];
			for (const id of ['k-put', 'k-patch'])
				if ((await dataRow(node.harper, id)).present) found.push(`${id} on ${node.harper.hostname}`);
			if ((await nodeRow(node.harper, D.harper.hostname)).present)
				found.push(`removed node D in ${node.harper.hostname}'s hdb_nodes`);
			return found;
		};
		const onC = await resurrected(C);
		const status = await sendOperation(C.harper, { operation: 'cluster_status' });
		if (status.connections.some(({ name }) => name === D.harper.hostname))
			onC.push("removed node D in C's cluster_status");
		assert.deepEqual(onC, [], 'older writes recreated deleted rows on the copied node');

		await nodes.start(A);
		await nodes.waitForMesh([A, B, C]);
		await waitFor(async (signal) => {
			const rows = await Promise.all([
				dataRow(B.harper, 'k-put', signal),
				dataRow(B.harper, 'k-patch', signal),
				nodeRow(B.harper, D.harper.hostname, signal),
			]);
			return rows.every((row) => !row.present);
		}, 'B to apply the deletes it missed');
		assert.deepEqual([...(await resurrected(A)), ...(await resurrected(C))], []);
	});
});

suite('a delete under a later publish', { timeout: 900_000, skip: isLMDB && 'copy-apply is RocksDB-only' }, (ctx) => {
	const nodes = cluster(ctx.name);
	let A, X, E1, E2;
	const deleted = {};

	before(async () => {
		A = await nodes.startFresh();
		for (const id of ['native', 'covered']) await put(A.harper, id, { name: 'v1' });
		for (const id of ['native', 'covered'])
			await sendOperation(A.harper, { operation: 'delete', database: 'data', table: TABLE, ids: [id] });
		await put(A.harper, 'sentinel', { name: 'seeded' });
		for (const id of ['native', 'covered']) {
			const row = await dataRow(A.harper, id);
			assert.ok(row.fullWriteHead && !row.present, `premise: A holds ${id} as a flagged tombstone`);
			deleted[id] = row.version;
		}
	});

	after(() => nodes.teardown());

	const expectDeleteOn = async (node, id) => {
		await waitFor(async (signal) => (await dataRow(node.harper, id, signal)).stored, `the delete of ${id} on E`);
		const { originId, origin, ...row } = await dataRow(node.harper, id);
		assert.ok(originId, `the delete of ${id} keeps a remote origin on ${node.harper.hostname}`);
		assert.equal(origin, A.harper.hostname, `the delete of ${id} keeps A's origin, not the copy source's`);
		assert.deepEqual(
			row,
			{ stored: true, present: false, version: deleted[id], fullWriteHead: true, history: 0 },
			`${id} on ${node.harper.hostname} holds the delete at its version`
		);
		await redeliver(node.harper, id, { id, name: 'older write' }, 1000);
		assert.equal((await dataRow(node.harper, id)).present, false, `an older write recreated ${id}`);
	};

	test('a node copying from a node that deleted a row and then published to it keeps the delete', async () => {
		await writeTogether(A.harper, 'data', [{ table: TABLE, op: 'publish', id: 'native', record: { message: 'm' } }]);
		const held = await dataRow(A.harper, 'native');
		assert.equal(held.present, false);
		assert.equal(held.fullWriteHead, false, 'premise: the publish cleared the flag');
		assert.equal(held.boundary?.version, deleted.native, 'premise: A keeps its own delete as the boundary');
		E1 = await nodes.startFresh();
		await nodes.join(E1, A);
		await waitFor(async (signal) => (await dataRow(E1.harper, 'sentinel', signal)).present, 'the copy to reach E1');
		await expectDeleteOn(E1, 'native');
	});

	test('a node copying from a node that took the delete by copy and then published to it keeps the delete', async () => {
		X = await nodes.startFresh();
		await nodes.join(X, A);
		await waitFor(async (signal) => (await dataRow(X.harper, 'sentinel', signal)).present, 'the copy to reach X');
		await waitFor(async (signal) => (await dataRow(X.harper, 'covered', signal)).stored, "A's copied tombstone on X");
		// down, so E2 can only learn the delete from X's copy
		await Promise.all([nodes.stop(A), nodes.stop(E1)]);
		await writeTogether(X.harper, 'data', [{ table: TABLE, op: 'publish', id: 'covered', record: { message: 'm' } }]);
		const held = await dataRow(X.harper, 'covered');
		assert.equal(held.present, false);
		assert.equal(held.fullWriteHead, false, 'premise: the publish cleared the flag');
		assert.equal(held.boundary?.version, deleted.covered, 'premise: X holds the delete only as the boundary');
		E2 = await nodes.startFresh();
		await nodes.join(E2, X);
		await waitFor(async (signal) => (await dataRow(E2.harper, 'sentinel', signal)).present, 'the copy to reach E2');
		await expectDeleteOn(E2, 'covered');
	});
});

suite('base-copy deletions at the edges', { timeout: 600_000, skip: isLMDB && 'copy-apply is RocksDB-only' }, (ctx) => {
	const nodes = cluster(ctx.name);
	let A, holdDirectory;

	before(async () => {
		A = await nodes.startFresh();
		for (const id of ['r1', 'r2', 'r-deleted']) await put(A.harper, id, { name: id });
		await sendOperation(A.harper, { operation: 'delete', database: 'data', table: TABLE, ids: ['r-deleted'] });
		await put(A.harper, 'sentinel', { name: 'seeded' });
	});

	after(async () => {
		await nodes.teardown();
		if (holdDirectory) await rm(holdDirectory, { recursive: true, force: true });
	});

	test('a receiver without tombstoneCopy completes the copy as before, storing no tombstone', async () => {
		const older = await nodes.startFresh({ HARPER_TEST_OMIT_REPLICATION_CAPABILITIES: '1' });
		await nodes.join(older, A);
		await waitFor(async (signal) => (await dataRow(older.harper, 'sentinel', signal)).present, 'the copy to finish');
		for (const id of ['r1', 'r2']) assert.equal((await dataRow(older.harper, id)).present, true, id);
		assert.deepEqual(await dataRow(older.harper, 'r-deleted'), { stored: false });
	});

	test('a delete that lands during the copy is kept', async () => {
		holdDirectory = await mkdtemp(join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'hold-'));
		const joiner = await nodes.startFresh({
			HARPER_TEST_HOLD_COPY_START_DB: 'data',
			HARPER_TEST_HOLD_COPY_START_DIR: holdDirectory,
			HARPER_TEST_HOLD_COPY_START_PEER: A.harper.hostname,
		});
		await nodes.join(joiner, A);
		await waitFor(() => existsSync(join(holdDirectory, 'held')), "the joiner's COPY_START to be held");
		await sendOperation(A.harper, { operation: 'delete', database: 'data', table: TABLE, ids: ['r1'] });
		await put(A.harper, 'sentinel-2', { name: 'after the delete' });
		await writeFile(join(holdDirectory, 'release'), '');
		await waitFor(
			async (signal) => (await dataRow(joiner.harper, 'sentinel-2', signal)).present,
			'the copy and replay'
		);
		const r1 = await dataRow(joiner.harper, 'r1');
		assert.equal(r1.present, false, 'the delete made during the copy was lost');
		assert.equal(r1.version, (await dataRow(A.harper, 'r1')).version);
		assert.equal((await dataRow(joiner.harper, 'r2')).present, true);
	});
});
