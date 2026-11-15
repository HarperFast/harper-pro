import assert from 'node:assert';
import {
	DEFAULT_DRAIN_TIMEOUT_MS,
	FENCE_OPERATION,
	RECEIPT_OPERATION,
	drainNode,
	drainTimeoutMs,
	getReceivedOriginFloors,
	liftFenceAfterRemoval,
	liftFenceForOwnRecovery,
	receiptShortfall,
	receiptsBindRequired,
	markRemoval,
	removalMarked,
	removeNodeFence,
	unmarkRemoval,
} from '#src/replication/nodeRemoval';
import { materializeOperationResponse } from '#src/replication/materializeOperationResponse';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databases, table } from '#src/core/resources/databases';
import { persistLocalWriteFence, readLocalWriteFence } from '#src/core/resources/auditStore';
import { localWritesFenced, setLocalWriteFence } from '#src/core/resources/originClosedFloor';
import { getThisNodeName } from '#src/core/server/nodeName';
import { getHDBNodeTable } from '#src/replication/knownNodes';
import { CONFIG_PARAMS } from '#src/core/utility/hdbTerms';
import * as env from '#src/core/utility/environment/environmentManager';

const T = 1_790_000_000_000;
const drain = { target: T, generation: 'gen-1', sharded: false, peers: ['p1'] };
const holds = { closedFloor: T + 1, originGeneration: 'gen-1', fullCoverage: true };

describe('receiptShortfall (harper-pro#1348)', () => {
	it('accepts a generation-matched floor at or above the target on a route that carries every table', () => {
		assert.equal(receiptShortfall(holds, drain), undefined);
		assert.equal(receiptShortfall({ ...holds, closedFloor: T }, drain), undefined);
	});

	it('names what a floor that proves nothing lacks', () => {
		const cases = [
			[undefined, /no certified floor/],
			[{ closedFloor: null }, /no certified floor/],
			[{ ...holds, closedFloor: T - 1 }, /below the target/],
			[{ ...holds, floorRevoked: true }, /revoked/],
			[{ ...holds, partialHistory: true }, /partial history/],
			[{ ...holds, hole: true }, /partial history/],
			[{ ...holds, originGeneration: 'gen-0' }, /another generation/],
			[{ ...holds, originGeneration: undefined }, /another generation/],
			[{ ...holds, fullCoverage: false }, /does not carry every table/],
		];
		for (const [answer, reason] of cases) assert.match(receiptShortfall(answer, drain), reason, JSON.stringify(answer));
	});

	it('accepts a route between shards, which never carries every table, for a sharded database', () => {
		assert.equal(receiptShortfall({ ...holds, fullCoverage: false }, { ...drain, sharded: true }), undefined);
	});
});

describe('receiptsBindRequired (harper-pro#1348)', () => {
	it('accepts receipts from every peer still required, under the same shard ownership', () => {
		assert.equal(receiptsBindRequired({ peers: ['p1', 'p2'] }, { peers: ['p1', 'p2'] }), true);
		assert.equal(receiptsBindRequired({ peers: ['p1', 'p2'] }, { peers: ['p2'] }), true);
		const owners = [['p1'], ['p2']];
		assert.equal(
			receiptsBindRequired({ peers: ['p1', 'p2'], shardOwners: owners }, { peers: ['p1', 'p2'], shardOwners: owners }),
			true
		);
	});

	it('refuses when a peer became required after the receipts were collected', () => {
		assert.equal(receiptsBindRequired({ peers: ['p1'] }, { peers: ['p1', 'p3'] }), false);
	});

	it('refuses when shard ownership changed, or the receipts name no peers', () => {
		assert.equal(
			receiptsBindRequired(
				{ peers: ['p1', 'p2'], shardOwners: [['p1'], ['p2']] },
				{ peers: ['p1', 'p2'], shardOwners: [['p2']] }
			),
			false
		);
		assert.equal(receiptsBindRequired({ peers: ['p1', 'p2'] }, { peers: ['p1', 'p2'], shardOwners: [['p1']] }), false);
		assert.equal(receiptsBindRequired({ target: T }, { peers: [] }), false);
		assert.equal(receiptsBindRequired(undefined, { peers: [] }), false);
	});
});

describe('drainTimeoutMs', () => {
	it('defaults, and refuses a value that is not a positive integer of milliseconds', () => {
		assert.equal(drainTimeoutMs(undefined), DEFAULT_DRAIN_TIMEOUT_MS);
		assert.equal(drainTimeoutMs(5000), 5000);
		for (const value of [0, -5, 1.5, '100', Infinity, 1e12])
			assert.throws(() => drainTimeoutMs(value), /timeout must be/);
	});
});

describe('drainNode', () => {
	const fence = (epoch = 'e1', target = T) => ({
		node: 'leaving',
		epoch,
		state: 'fenced',
		databases: { data: { target, generation: 'gen-1', sharded: false, peers: ['p1', 'p2'] } },
	});

	function transport(handlers) {
		const calls = [];
		const send = async (node, operation, options) => {
			calls.push({ node, operation, options });
			return handlers(node, operation);
		};
		send.calls = calls;
		return send;
	}

	it('finalizes once every required peer holds a floor at or above the target', async () => {
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION)
				return operation.finalize ? { ...fence(), state: 'removing' } : fence();
			assert.equal(operation.operation, RECEIPT_OPERATION);
			assert.deepEqual(operation.databases, ['data']);
			return { databases: { data: holds } };
		});
		const result = await drainNode('leaving', { name: 'leaving' }, 5000, send, async (peer) => ({ name: peer }));
		assert.equal(result.state, 'removing');
		const finalize = send.calls.find(({ operation }) => operation.finalize);
		assert.deepEqual(finalize.operation, {
			operation: FENCE_OPERATION,
			node: 'leaving',
			finalize: 'e1',
			databases: ['data'],
			receipts: { data: { target: T, generation: 'gen-1', peers: ['p1', 'p2'] } },
		});
		assert.ok(send.calls.every(({ options }) => options.timeoutMs > 0 && options.timeoutMs <= 30_000));
	});

	it('waits for a peer whose floor is still below the target', async () => {
		let receipts = 0;
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION) return fence();
			receipts++;
			return { databases: { data: node.name === 'p2' && receipts < 4 ? { ...holds, closedFloor: T - 1 } : holds } };
		});
		await drainNode('leaving', { name: 'leaving' }, 10_000, send, async (peer) => ({ name: peer }));
		assert.ok(receipts >= 4);
	});

	it('times out naming each shortfall, without finalizing', async () => {
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION) return fence();
			if (node.name === 'p2') throw new Error('connect ECONNREFUSED');
			return { databases: { data: { ...holds, closedFloor: T - 1 } } };
		});
		await assert.rejects(
			drainNode('leaving', { name: 'leaving' }, 1200, send, async (peer) => ({ name: peer })),
			(error) => {
				assert.equal(error.statusCode, 504);
				assert.match(error.message, /p1 has its floor at .* below the target/);
				assert.match(error.message, /p2 could not be asked for its receipt/);
				assert.match(error.message, /still refuses local writes and stays a member/);
				return true;
			}
		);
		assert.ok(!send.calls.some(({ operation }) => operation.finalize));
	});

	it('keeps trying a node it cannot reach, then times out telling the operator about force', async () => {
		let calls = 0;
		const send = transport(() => {
			throw new Error(
				++calls % 2
					? 'connect ECONNREFUSED'
					: `${FENCE_OPERATION} to wss://10.0.0.9:9933 did not answer within 30ms; its outcome there is unknown`
			);
		});
		await assert.rejects(
			drainNode('leaving', { name: 'leaving' }, 2500, send, async () => ({})),
			(error) => {
				assert.equal(error.statusCode, 504);
				assert.match(error.message, /leaving could not be reached to fence it/);
				assert.match(error.message, /force: true/);
				return true;
			}
		);
		assert.ok(calls >= 2, 'a call that timed out is retried, not read as an unsupported operation');
	});

	it('refuses at once a node that does not know the fence operation, or refuses to fence', async () => {
		const unknown = transport(() => {
			throw new Error(`Operation '${FENCE_OPERATION}' not found`);
		});
		await assert.rejects(
			drainNode('leaving', {}, 60_000, unknown, async () => ({})),
			(error) => {
				assert.equal(error.statusCode, 400);
				assert.match(error.message, /cannot drain its writes before removal/);
				return true;
			}
		);
		assert.equal(unknown.calls.length, 1);
		const refused = transport(() => {
			throw new Error('ClientError: leaving is the only owner of shard 1 of database data');
		});
		await assert.rejects(
			drainNode('leaving', {}, 60_000, refused, async () => ({})),
			/only owner of shard 1/
		);
		assert.equal(refused.calls.length, 1);
	});

	it('waits only for peers that receive the database from the node, and counts those that hold its writes', async () => {
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION)
				return operation.finalize ? { ...fence(), state: 'removing' } : fence();
			return { databases: { data: node.name === 'p2' ? { closedFloor: null, receives: false } : holds } };
		});
		const result = await drainNode('leaving', { name: 'leaving' }, 5000, send, async (peer) => ({ name: peer }));
		assert.deepEqual(result.databases.data.peers, ['p1']);
	});

	it('refuses when no peer the node sends a database to subscribes to it', async () => {
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION) return fence();
			return { databases: { data: { closedFloor: null, receives: false } } };
		});
		await assert.rejects(
			drainNode('leaving', { name: 'leaving' }, 5000, send, async (peer) => ({ name: peer })),
			(error) => {
				assert.equal(error.statusCode, 409);
				assert.match(error.message, /No peer of leaving that must hold its writes to database data/);
				assert.match(error.message, /leaving accepts local writes again/);
				return true;
			}
		);
		assert.ok(!send.calls.some(({ operation }) => operation.finalize));
		assert.ok(
			send.calls.some(({ operation }) => operation.cancel === true),
			'the refused drain lifts its fence'
		);
	});

	it('refuses when every other owner of one shard does not subscribe, even if another shard holds the writes', async () => {
		const sharded = () => ({
			...fence(),
			databases: {
				data: { target: T, generation: 'gen-1', sharded: true, peers: ['p1', 'p2'], shardOwners: [['p1'], ['p2']] },
			},
		});
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION) return operation.cancel ? { cancelled: true } : sharded();
			return { databases: { data: node.name === 'p1' ? { closedFloor: null, receives: false } : holds } };
		});
		await assert.rejects(
			drainNode('leaving', { name: 'leaving' }, 5000, send, async (peer) => ({ name: peer })),
			(error) => error.statusCode === 409 && /must hold its writes to database data/.test(error.message)
		);
		assert.ok(!send.calls.some(({ operation }) => operation.finalize));
	});

	it('never calls a peer with less than a usable budget left, keeping the last complete round', async () => {
		const send = transport(async (node, operation) => {
			if (operation.operation === FENCE_OPERATION) return fence();
			await new Promise((resolve) => setTimeout(resolve, 200));
			return { databases: { data: { ...holds, closedFloor: T - 1 } } };
		});
		await assert.rejects(
			drainNode('leaving', { name: 'leaving' }, 1500, send, async (peer) => ({ name: peer })),
			(error) => {
				assert.equal(error.statusCode, 504);
				assert.match(error.message, /p1 has its floor at .* below the target/);
				assert.match(error.message, /p2 has its floor at .* below the target/);
				return true;
			}
		);
		assert.ok(
			send.calls.every(({ options }) => options.timeoutMs >= 250),
			JSON.stringify(send.calls.map((c) => c.options))
		);
	});

	it('times out on time when looking up a peer stalls', async () => {
		const send = transport(() => fence());
		const started = performance.now();
		// mocha timeouts are off: a regression must fail here, not hang the run
		const hung = new Promise((_, reject) => setTimeout(() => reject(new Error('the drain hung')), 5000).unref());
		await assert.rejects(
			Promise.race([drainNode('leaving', { name: 'leaving' }, 1000, send, () => new Promise(() => {})), hung]),
			(error) => error.statusCode === 504
		);
		assert.ok(performance.now() - started < 3000, `took ${performance.now() - started}ms`);
	});

	it('finalizes without receipts a database the node sends to no peer', async () => {
		const send = transport((node, operation) => {
			const state = operation.finalize ? 'removing' : 'fenced';
			return { ...fence(), state, databases: { data: { target: T, generation: 'gen-1', sharded: false, peers: [] } } };
		});
		const result = await drainNode('leaving', {}, 5000, send, async () => ({}));
		assert.equal(result.state, 'removing');
		assert.ok(!send.calls.some(({ operation }) => operation.operation === RECEIPT_OPERATION));
	});

	it('removes a node with no database but system without a finalize', async () => {
		const send = transport(() => ({ node: 'leaving', epoch: 'e1', state: 'fenced', databases: {} }));
		const result = await drainNode('leaving', {}, 5000, send, async () => ({}));
		assert.equal(result.state, 'removing');
		assert.equal(send.calls.length, 1);
	});

	it('reads the receipts of databases named like the operation envelope keys or Object members', async () => {
		const names = ['__proto__', 'constructor', 'error', 'requestId', 'results'];
		const drains = Object.fromEntries(
			names.map((name) => [name, { target: T, generation: 'gen-1', sharded: false, peers: ['p1'] }])
		);
		// what an operation connection does to an answer: the peer stamps its request id on it, and the caller
		// rejects one that carries `error`
		const overTheWire = async (answer) => {
			const response = await materializeOperationResponse(answer);
			response.requestId = 7;
			if (response.error) throw new Error(response.error);
			return response;
		};
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION)
				return overTheWire({
					node: 'leaving',
					epoch: 'e1',
					state: operation.finalize ? 'removing' : 'fenced',
					databases: drains,
				});
			return overTheWire({ databases: Object.fromEntries(operation.databases.map((name) => [name, holds])) });
		});
		const result = await drainNode('leaving', { name: 'leaving' }, 5000, send, async (peer) => ({ name: peer }));
		assert.equal(result.state, 'removing');
		for (const name of names) assert.deepEqual(result.databases[name].peers, ['p1'], name);
	});

	it('re-fences after a refused finalize, for a database created during the drain', async () => {
		let fences = 0;
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION) {
				if (operation.finalize && fences === 1) throw new Error('ClientError: fence changed');
				if (!operation.finalize) fences++;
				return operation.finalize ? { ...fence(), state: 'removing' } : fence();
			}
			return { databases: { data: holds } };
		});
		const result = await drainNode('leaving', {}, 10_000, send, async (peer) => ({ name: peer }));
		assert.equal(result.state, 'removing');
		assert.equal(fences, 2);
	});
});

describe('a database created while a removal is marked (harper-pro#1348)', () => {
	let rootPath;
	before(() => {
		rootPath = env.get(CONFIG_PARAMS.ROOTPATH);
		env.setProperty(CONFIG_PARAMS.ROOTPATH, mkdtempSync(join(tmpdir(), 'removal-mark-')));
	});
	after(() => {
		unmarkRemoval();
		env.setProperty(CONFIG_PARAMS.ROOTPATH, rootPath);
	});

	const open = (database) =>
		table({ table: 'Created', database, attributes: [{ name: 'id', isPrimaryKey: true }] }).primaryStore.rootStore;

	it('opens fenced while the mark exists, and unfenced once it is cleared', () => {
		markRemoval('epoch-1');
		assert.equal(removalMarked(), true);
		const fenced = open('created_during_removal');
		assert.equal(localWritesFenced(fenced), true);
		setLocalWriteFence(fenced, false);
		unmarkRemoval();
		assert.equal(removalMarked(), false);
		assert.equal(localWritesFenced(open('created_after_removal')), false);
	});
});

describe('lifting a removal fence (harper-pro#1348)', () => {
	const attributes = [{ name: 'id', isPrimaryKey: true }];
	let rootPath;
	before(() => {
		rootPath = env.get(CONFIG_PARAMS.ROOTPATH);
		env.setProperty(CONFIG_PARAMS.ROOTPATH, mkdtempSync(join(tmpdir(), 'removal-lift-')));
	});
	after(() => {
		unmarkRemoval();
		env.setProperty(CONFIG_PARAMS.ROOTPATH, rootPath);
	});

	const open = (database, tableName) => table({ table: tableName, database, attributes });
	const fenceCall = (request) =>
		removeNodeFence({
			operation: FENCE_OPERATION,
			node: getThisNodeName(),
			hdb_user: { name: 'admin', role: { permission: { super_user: true } } },
			...request,
		});

	it('lifts the fence an earlier poll left when a later poll is refused', async () => {
		const fenced = open('fenced_then_refused', 'Fenced');
		const rootStore = fenced.primaryStore.rootStore;
		markRemoval('epoch-1');
		const target = setLocalWriteFence(rootStore, true);
		await persistLocalWriteFence(fenced.auditStore, { epoch: 'epoch-1', target, state: 'fenced' });
		// a database on LMDB has no durable floor, so the poll is refused before it fences anything
		const engine = process.env.HARPER_STORAGE_ENGINE;
		process.env.HARPER_STORAGE_ENGINE = 'lmdb';
		let legacy;
		try {
			legacy = open('refusing_lmdb', 'Legacy').primaryStore.rootStore;
		} finally {
			if (engine === undefined) delete process.env.HARPER_STORAGE_ENGINE;
			else process.env.HARPER_STORAGE_ENGINE = engine;
		}
		await assert.rejects(fenceCall({}), (error) => {
			assert.equal(error.statusCode, 400);
			assert.match(error.message, /no durable origin-closed floor/);
			assert.match(error.message, /accepts local writes again$/);
			return true;
		});
		assert.equal(localWritesFenced(rootStore), false);
		assert.equal(readLocalWriteFence(fenced.auditStore), undefined);
		assert.equal(removalMarked(), false);
		// gone from disk, so no catalog rescan in a later suite finds an LMDB database
		delete databases.refusing_lmdb;
		await legacy.close();
		rmSync(legacy.path, { force: true });
		rmSync(`${legacy.path}-lock`, { force: true });
	});

	it('lifts on cancel a fence on a database this thread has not loaded yet', async () => {
		markRemoval('epoch-2');
		const rootStore = open('opened_elsewhere', 'Elsewhere').primaryStore.rootStore;
		assert.equal(localWritesFenced(rootStore), true);
		// as on a thread that another thread's schema change has not reached
		delete databases.opened_elsewhere;
		assert.deepEqual(await fenceCall({ cancel: true }), { cancelled: true });
		assert.equal(localWritesFenced(rootStore), false);
	});

	it('keeps the mark when deleting it cannot be synced, so a retry still finds a database this thread has not loaded', async function () {
		// a directory without read permission lets the mark be unlinked, then fails the directory sync
		if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip();
		const markDirectory = env.get(CONFIG_PARAMS.ROOTPATH);
		markRemoval('epoch-sync');
		const rootStore = open('sync_fails_elsewhere', 'Elsewhere').primaryStore.rootStore;
		assert.equal(localWritesFenced(rootStore), true);
		delete databases.sync_fails_elsewhere;
		chmodSync(markDirectory, 0o300);
		try {
			await assert.rejects(liftFenceAfterRemoval(true), { code: 'EACCES' });
		} finally {
			chmodSync(markDirectory, 0o700);
		}
		assert.equal(removalMarked(), true);
		assert.equal(localWritesFenced(rootStore), true);
		await liftFenceAfterRemoval(true);
		assert.equal(removalMarked(), false);
		assert.equal(localWritesFenced(rootStore), false);
	});

	it('refuses a cancel without force when a database this thread has not loaded was finalized', async () => {
		markRemoval('epoch-3');
		const finalizedTable = open('finalized_elsewhere', 'Finalized');
		const rootStore = finalizedTable.primaryStore.rootStore;
		const target = setLocalWriteFence(rootStore, true);
		await persistLocalWriteFence(finalizedTable.auditStore, { epoch: 'epoch-3', target, state: 'removing' });
		delete databases.finalized_elsewhere;
		await assert.rejects(fenceCall({ cancel: true }), (error) => {
			assert.equal(error.statusCode, 409);
			assert.match(error.message, /was finalized/);
			return true;
		});
		assert.equal(localWritesFenced(rootStore), true);
		assert.deepEqual(await fenceCall({ cancel: true, force: true }), { cancelled: true });
		assert.equal(localWritesFenced(rootStore), false);
	});
});

describe('a removal fence while own writes are still coming back (harper-pro#1348, #1364)', () => {
	const attributes = [{ name: 'id', isPrimaryKey: true }];
	const peer = 'returning-peer';
	const EPOCH = Symbol.for('ownOriginRecovery');
	const REPORT = Symbol.for('ownOriginRecovered');
	const REFUSAL = /its peers have yet to return its own writes/;
	let rootPath;
	let sequence = 0;
	before(async () => {
		rootPath = env.get(CONFIG_PARAMS.ROOTPATH);
		env.setProperty(CONFIG_PARAMS.ROOTPATH, mkdtempSync(join(tmpdir(), 'removal-recovery-')));
		await getHDBNodeTable().put(peer, { name: peer });
	});
	after(async () => {
		unmarkRemoval();
		env.setProperty(CONFIG_PARAMS.ROOTPATH, rootPath);
		await getHDBNodeTable().delete(peer);
	});

	const fenceCall = (request) =>
		removeNodeFence({
			operation: FENCE_OPERATION,
			node: getThisNodeName(),
			hdb_user: { name: 'admin', role: { permission: { super_user: true } } },
			...request,
		});
	// a database whose recovery epoch still waits for `peer`, fenced as an earlier poll left it
	async function fencedWhileRecovering(state, recovering = true, pageCacheKept) {
		const database = `recovering_${++sequence}`;
		const fenced = table({ table: 'Recovering', database, attributes });
		const before = Date.now();
		if (recovering)
			await fenced.dbisDB.put(EPOCH, {
				after: 1,
				lastKey: 0,
				before,
				requiredPeers: [peer],
				...(pageCacheKept ? { pageCacheKept: true } : {}),
			});
		const rootStore = fenced.primaryStore.rootStore;
		markRemoval(`epoch-${database}`);
		const target = setLocalWriteFence(rootStore, true);
		await persistLocalWriteFence(fenced.auditStore, { epoch: `epoch-${database}`, target, state });
		// the peer's clean report, after which this database no longer holds any fence call back
		const recovered = async () => {
			await fenced.dbisDB.put([REPORT, peer], { epoch: before });
			await new Promise((resolve) => setTimeout(resolve, 100)); // past the cached verdict (UNPROVEN_RECHECK_MS)
		};
		return { fenced, rootStore, recovered };
	}

	it("refuses to fence and lifts an earlier fence while a peer has not returned this node's writes", async () => {
		const { fenced, rootStore, recovered } = await fencedWhileRecovering('fenced');
		await assert.rejects(fenceCall({}), (error) => {
			assert.equal(error.statusCode, 409);
			assert.match(error.message, REFUSAL);
			assert.match(error.message, new RegExp(`${peer} has not returned`));
			assert.match(error.message, /accepts local writes again$/);
			return true;
		});
		assert.equal(localWritesFenced(rootStore), false);
		assert.equal(readLocalWriteFence(fenced.auditStore), undefined);
		assert.equal(removalMarked(), false);
		await recovered();
		await fenceCall({}).catch((error) => assert.doesNotMatch(error.message, REFUSAL));
		assert.deepEqual(await fenceCall({ cancel: true }), { cancelled: true });
	});

	it('does not refuse a removal finalized before the restart, whose receipts were already taken', async () => {
		const { rootStore, recovered } = await fencedWhileRecovering('removing');
		await fenceCall({}).then(
			(result) => assert.equal(result.state, 'removing'),
			(error) => assert.doesNotMatch(error.message, REFUSAL)
		);
		assert.equal(localWritesFenced(rootStore), true);
		assert.deepEqual(await fenceCall({ cancel: true, force: true }), { cancelled: true });
		await recovered();
	});

	it('lifts at startup a fence that would refuse the returned writes, unless the removal was finalized', async () => {
		const pending = await fencedWhileRecovering('fenced');
		await liftFenceForOwnRecovery();
		assert.equal(localWritesFenced(pending.rootStore), false);
		assert.equal(readLocalWriteFence(pending.fenced.auditStore), undefined);
		assert.equal(removalMarked(), false);
		await pending.recovered();

		const finalized = await fencedWhileRecovering('removing');
		await liftFenceForOwnRecovery();
		assert.equal(localWritesFenced(finalized.rootStore), true);
		assert.deepEqual(await fenceCall({ cancel: true, force: true }), { cancelled: true });
		await finalized.recovered();

		const intact = await fencedWhileRecovering('fenced', false);
		await liftFenceForOwnRecovery();
		assert.equal(localWritesFenced(intact.rootStore), true);
		assert.deepEqual(await fenceCall({ cancel: true }), { cancelled: true });
	});

	it('keeps and renews a fence while peers answer an epoch opened with nothing to have lost', async () => {
		// the OS kept running: the epoch exists only because the database had none, and may never finish
		const { rootStore } = await fencedWhileRecovering('fenced', true, true);
		await liftFenceForOwnRecovery();
		assert.equal(localWritesFenced(rootStore), true);
		await fenceCall({}).catch((error) => assert.doesNotMatch(error.message, REFUSAL));
		assert.deepEqual(await fenceCall({ cancel: true }), { cancelled: true });
	});
});

describe('a receipt for a database this node does not have (harper-pro#1348)', () => {
	const peer = 'receipt-peer';
	const self = getThisNodeName();
	let selfRow;
	let configured;
	before(async () => {
		selfRow = getHDBNodeTable().primaryStore.getSync(self);
		configured = env.get(CONFIG_PARAMS.REPLICATION_DATABASES);
		await getHDBNodeTable().put(peer, { name: peer, replicates: true });
		await getHDBNodeTable().put(self, { ...selfRow, name: self, replicates: true });
	});
	after(async () => {
		env.setProperty(CONFIG_PARAMS.REPLICATION_DATABASES, configured);
		await getHDBNodeTable().delete(peer);
		if (selfRow) await getHDBNodeTable().put(self, selfRow);
		else await getHDBNodeTable().delete(self);
	});

	const receipt = async () =>
		(
			await getReceivedOriginFloors({
				origin: peer,
				databases: ['never_created_here'],
				hdb_user: { name: 'admin', role: { permission: { super_user: true } } },
			})
		).databases.never_created_here;

	it('answers receives: false when this node does not replicate it, so a drain does not wait for it', async () => {
		env.setProperty(CONFIG_PARAMS.REPLICATION_DATABASES, ['system']);
		assert.deepEqual(await receipt(), { closedFloor: null, receives: false });
	});

	it('gives no answer when this node replicates it, since it may still arrive', async () => {
		env.setProperty(CONFIG_PARAMS.REPLICATION_DATABASES, '*');
		assert.deepEqual(await receipt(), { closedFloor: null });
	});
});
