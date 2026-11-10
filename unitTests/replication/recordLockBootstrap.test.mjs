/** The automatic first home-map generation (harper-pro#853), checked without a cluster. */
import assert from 'node:assert';
import { createRequire } from 'node:module';
// The transport is the module that wires (and must load before) recordLockRpc; entering the graph
// anywhere else trips the rpc → replicator → replicationConnection → transport cycle at load.
import {
	WITHHELD_DIGEST_PREFIX,
	createRecordLockTransport,
	currentHomesDigest,
	forgetRecordLockHomesCache,
	recordPeerHomesDigest,
	recordPeerHomesAgreement,
	recordPeerLockCapability,
	refreshRecordLockHomesCache,
	setRecordLockHomesRowReader,
} from '#src/replication/recordLockTransport';
import {
	BOOTSTRAP_FOLLOW_MS,
	bootstrapRefusedMessage,
	classifyHomesRow,
	createBootstrapTrigger,
	planBootstrap,
	runBootstrap,
} from '#src/replication/recordLockBootstrap';
import { resolveRecordLockSetting } from '#src/replication/recordLockConfig';
import { withTransitionQueue } from '#src/replication/recordLockApply';
import {
	MIN_DRAIN_BACKSTOP_MS,
	digestOf,
	homesMembership,
	planActivate,
	planStage,
	setHomesMembershipReaders,
} from '#src/replication/recordLockHomes';
import { getReplicationSharedStatus } from '#src/replication/knownNodes';
import { table } from '#src/core/resources/databases';

const { setupTestDBPath } = createRequire(import.meta.url)('../testUtils.js');

const T = 1_700_000_000_000;
const canonical = (homes) => [...new Set(homes)].sort();
function staged1(homes) {
	const set = canonical(homes);
	return planStage(undefined, 'db', 1, set, digestOf(1, set), T, set).row;
}
function active1(homes) {
	const set = canonical(homes);
	return planActivate(staged1(set), 'db', 1, digestOf(1, set), T, 0).row;
}
function answer(node, { view = ['a', 'b', 'c'], mode = 'auto', row } = {}) {
	return {
		node,
		active: row?.active,
		staged: row?.staged,
		highestActedOn: row?.highestActedOn ?? 0,
		supportsFenced: true,
		fenced: row?.fenced,
		view: canonical(view),
		recordLocks: mode,
	};
}
const replies = (entries) => new Map(Object.entries(entries));

describe('resolveRecordLockSetting: what each replication.recordLocks value means', () => {
	function resolve(value, engine = 'rocksdb') {
		const logged = [];
		const log = {
			info: (message) => logged.push(['info', message]),
			warn: (message) => logged.push(['warn', message]),
			error: (message) => logged.push(['error', message]),
		};
		const setting = resolveRecordLockSetting(
			() => {
				if (value instanceof Error) throw value;
				return value;
			},
			engine,
			log
		);
		return { ...setting, logged };
	}

	it('unset or null on RocksDB is on, with the first home map automatic', () => {
		assert.deepStrictEqual(resolve(undefined), { mode: 'auto', logged: [] });
		assert.deepStrictEqual(resolve(null), { mode: 'auto', logged: [] });
	});

	it('unset on LMDB stays off for the engine and says so once, as a notice rather than an error', () => {
		const setting = resolve(undefined, 'lmdb');
		assert.strictEqual(setting.mode, 'off');
		assert.strictEqual(setting.offBecause, 'engine');
		assert.deepStrictEqual(
			setting.logged.map(([level]) => level),
			['info']
		);
		assert.match(setting.logged[0][1], /RocksDB/);
	});

	it('true keeps the operator-managed meaning, and stays off on LMDB with an error', () => {
		assert.deepStrictEqual(resolve(true), { mode: 'operator', logged: [] });
		const lmdb = resolve(true, 'lmdb');
		assert.strictEqual(lmdb.mode, 'off');
		assert.strictEqual(lmdb.offBecause, 'engine');
		assert.strictEqual(lmdb.logged[0][0], 'error');
	});

	it('false is the opt-out, silently', () => {
		assert.deepStrictEqual(resolve(false), { mode: 'off', offBecause: 'config', logged: [] });
	});

	it('a value that is not a boolean is off, with a warning, whichever way it was meant', () => {
		for (const value of ['true', 'false', 1, 0, {}]) {
			const setting = resolve(value);
			assert.strictEqual(setting.mode, 'off', JSON.stringify(value));
			assert.strictEqual(setting.logged[0]?.[0], 'warn', JSON.stringify(value));
		}
	});

	it('a configuration that cannot be read is off, not the default', () => {
		assert.deepStrictEqual(resolve(new Error('no boot properties')), {
			mode: 'off',
			offBecause: 'config',
			logged: [],
		});
	});
});

describe('classifyHomesRow', () => {
	it('separates no history, a lone first generation, and anything else', () => {
		assert.strictEqual(classifyHomesRow(undefined), 'empty');
		assert.strictEqual(classifyHomesRow({ highestActedOn: 0, fenced: [] }), 'empty');
		assert.strictEqual(classifyHomesRow(staged1(['a', 'b'])), 'first-staged');
		assert.strictEqual(classifyHomesRow(active1(['a', 'b'])), 'first-active');
		const second = planStage(active1(['a', 'b']), 'db', 2, ['a', 'b'], digestOf(2, ['a', 'b']), T, ['a', 'b']).row;
		assert.strictEqual(classifyHomesRow(second), 'other');
		assert.strictEqual(classifyHomesRow({ highestActedOn: 2, fenced: [] }), 'other', 'a retracted later generation');
		assert.strictEqual(
			classifyHomesRow({ highestActedOn: 0, fenced: [{ node: 'x', operator: 'op', at: T }] }),
			'other',
			'an operator fence'
		);
	});
});

describe('planBootstrap: when generation 1 may be written without an operator', () => {
	const abc = ['a', 'b', 'c'];

	it('a fresh mesh that agrees on its replicating set proceeds over every participant', () => {
		const plan = planBootstrap('a', abc, replies({ a: answer('a'), b: answer('b'), c: answer('c') }));
		assert.deepStrictEqual(plan, {
			action: 'proceed',
			kind: 'fresh',
			homes: abc,
			digest: digestOf(1, abc),
			stage: abc,
			awaitBackstop: true,
		});
	});

	it('a node that is off is left out of the ring, not a refusal', () => {
		const plan = planBootstrap('a', abc, replies({ a: answer('a'), b: answer('b'), c: answer('c', { mode: 'off' }) }));
		assert.strictEqual(plan.action, 'proceed');
		assert.deepStrictEqual(plan.homes, ['a', 'b']);
	});

	it('refuses a node that is the only participant', () => {
		const plan = planBootstrap(
			'a',
			['a', 'b'],
			replies({ a: answer('a', { view: ['a', 'b'] }), b: answer('b', { view: ['a', 'b'], mode: 'off' }) })
		);
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /no other node/);
	});

	it('refuses when an off node relays to nodes this one does not know: both sides would pass alone', () => {
		const view = ['a', 'b', 'o'];
		const plan = planBootstrap(
			'a',
			view,
			replies({
				a: answer('a', { view }),
				b: answer('b', { view }),
				o: answer('o', { view: ['a', 'b', 'c', 'd', 'o'], mode: 'off' }),
			})
		);
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /o replicates with c, d/);
	});

	it('refuses while a participant does not yet see the same replicating set', () => {
		const plan = planBootstrap(
			'a',
			abc,
			replies({ a: answer('a'), b: answer('b', { view: ['a', 'b'] }), c: answer('c') })
		);
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /^b do not yet replicate with every node a does/);
		assert.strictEqual(plan.settled, false, 'a mesh still forming may agree on its next survey');
	});

	it('refuses when any participant is operator-managed', () => {
		const plan = planBootstrap(
			'a',
			abc,
			replies({ a: answer('a'), b: answer('b', { mode: 'operator' }), c: answer('c') })
		);
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /b set replication.recordLocks: true/);
	});

	it('refuses a peer that cannot say its mode or set (an older build), a misnamed one, or an unreachable one', () => {
		const { view: _view, recordLocks: _mode, ...legacy } = answer('b');
		for (const [b, pattern] of [
			[legacy, /b \(did not report its record lock mode/],
			[{ ...answer('b'), node: 'x' }, /b \(answered as x\)/],
			[{ error: 'ECONNREFUSED' }, /b \(ECONNREFUSED\)/],
			[{ ...answer('b'), view: ['a', ''] }, /b \(did not report a valid replicating set\)/],
		]) {
			const plan = planBootstrap('a', abc, replies({ a: answer('a'), b, c: answer('c') }));
			assert.strictEqual(plan.action, 'refuse');
			assert.match(plan.reason, pattern);
		}
	});

	it('refuses a peer row whose digest is not the one its own generation and homes give', () => {
		const row = staged1(abc);
		const forged = { ...row, staged: { ...row.staged, homes: ['a', 'b'] } };
		const plan = planBootstrap('a', abc, replies({ a: answer('a'), b: answer('b', { row: forged }), c: answer('c') }));
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /malformed home map/);
	});

	it('refuses on any history beyond a lone first generation, anywhere surveyed, including an off node', () => {
		const second = planStage(active1(abc), 'db', 2, abc, digestOf(2, abc), T, abc).row;
		for (const [node, fields] of [
			['b', { row: second }],
			['c', { row: { highestActedOn: 0, fenced: [{ node: 'x', operator: 'op', at: T }] } }],
			['c', { mode: 'off', row: { highestActedOn: 3, fenced: [] } }],
		]) {
			const plan = planBootstrap(
				'a',
				abc,
				replies({ a: answer('a'), b: answer('b'), c: answer('c'), [node]: answer(node, fields) })
			);
			assert.strictEqual(plan.action, 'refuse', node);
			assert.match(plan.reason, /history beyond an automatic first generation/);
		}
	});

	it('resumes the one durable first generation: staged everywhere', () => {
		const row = staged1(abc);
		const plan = planBootstrap(
			'a',
			abc,
			replies({ a: answer('a', { row }), b: answer('b', { row }), c: answer('c', { row }) })
		);
		assert.strictEqual(plan.action, 'proceed');
		assert.strictEqual(plan.kind, 'resume');
		assert.deepStrictEqual(plan.stage, abc);
		assert.strictEqual(plan.awaitBackstop, true, 'an earlier stage may be under the backstop');
	});

	it('resumes a partial activation from a node that is already active, staging only the rest', () => {
		const plan = planBootstrap(
			'a',
			abc,
			replies({
				a: answer('a', { row: active1(abc) }),
				b: answer('b', { row: active1(abc) }),
				c: answer('c', { row: staged1(abc) }),
			})
		);
		assert.strictEqual(plan.kind, 'resume');
		assert.deepStrictEqual(plan.stage, ['c']);
		assert.strictEqual(plan.awaitBackstop, true);
		const done = planBootstrap(
			'a',
			abc,
			replies({
				a: answer('a', { row: active1(abc) }),
				b: answer('b', { row: active1(abc) }),
				c: answer('c', { row: active1(abc) }),
			})
		);
		assert.deepStrictEqual(done.stage, []);
		assert.strictEqual(done.awaitBackstop, false);
	});

	it('resumes the durable set when membership grew before activation, rather than wedging', () => {
		const row = staged1(abc);
		const abcd = [...abc, 'd'];
		const plan = planBootstrap(
			'a',
			abcd,
			replies({
				a: answer('a', { row, view: abcd }),
				b: answer('b', { row, view: abcd }),
				c: answer('c', { row, view: abcd }),
				d: answer('d', { view: abcd }),
			})
		);
		assert.strictEqual(plan.kind, 'resume');
		assert.deepStrictEqual(plan.homes, abc, 'the joiner is not added: the set is never re-derived');
	});

	it('a member whose stage failed is staged by the resume; an unreachable outsider does not block it', () => {
		const row = staged1(abc);
		const plan = planBootstrap(
			'a',
			[...abc, 'd'],
			replies({ a: answer('a', { row }), b: answer('b', { row }), c: answer('c'), d: { error: 'down' } })
		);
		assert.strictEqual(plan.kind, 'resume');
		assert.deepStrictEqual(plan.stage, abc);
	});

	it('a resume refuses too when a surveyed node replicates with someone this node does not know', () => {
		const row = staged1(abc);
		const plan = planBootstrap(
			'a',
			abc,
			replies({
				a: answer('a', { row }),
				b: answer('b', { row, view: ['a', 'b', 'c', 'x'] }),
				c: answer('c', { row }),
			})
		);
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /b replicates with x/);
	});

	it('a joiner never resumes a set it is not in', () => {
		const row = active1(abc);
		const abcd = [...abc, 'd'];
		const plan = planBootstrap(
			'd',
			abcd,
			replies({
				a: answer('a', { row, view: abcd }),
				b: answer('b', { row, view: abcd }),
				c: answer('c', { row, view: abcd }),
				d: answer('d', { view: abcd }),
			})
		);
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /does not include d; an operator adds it with record_lock_apply_homes/);
		assert.strictEqual(plan.settled, true, 'a joiner stays refused until an operator acts');
	});

	it('refuses two different first generations, and a member that left automatic mode', () => {
		const abcd = [...abc, 'd'];
		const two = planBootstrap(
			'a',
			abcd,
			replies({
				a: answer('a', { row: staged1(['a', 'b']), view: abcd }),
				b: answer('b', { row: staged1(['a', 'b']), view: abcd }),
				c: answer('c', { row: staged1(['c', 'd']), view: abcd }),
				d: answer('d', { row: staged1(['c', 'd']), view: abcd }),
			})
		);
		assert.strictEqual(two.action, 'refuse');
		assert.match(two.reason, /different first generations/);
		const row = staged1(abc);
		const left = planBootstrap(
			'a',
			abc,
			replies({ a: answer('a', { row }), b: answer('b', { row, mode: 'operator' }), c: answer('c', { row }) })
		);
		assert.strictEqual(left.action, 'refuse');
		assert.match(left.reason, /b no longer take part/);
	});
});

/** Nodes as the orchestrator sees them, each a row driven by the real per-node planners. */
function fakeMesh(nodes, { views = {}, modes = {}, rows: initial = {}, fail = {}, throwSync = [] } = {}) {
	const rows = new Map(Object.entries(initial));
	const calls = [];
	return {
		rows,
		calls,
		peers: (self) => ({
			self: () => self,
			send(node, operation) {
				if (throwSync.includes(`${operation.action}:${node}`)) throw new Error('synchronous failure');
				return (async () => {
					calls.push(`${operation.action}:${node}`);
					const failure = fail[`${operation.action}:${node}`];
					if (failure) throw new Error(failure);
					if (!nodes.includes(node)) throw new Error(`no route to ${node}`);
					const row = rows.get(node);
					if (operation.action === 'survey')
						return answer(node, { row, view: views[node] ?? nodes, mode: modes[node] ?? 'auto' });
					const { generation, homes, quiesce, digest } = operation;
					if (operation.action === 'stage') {
						const plan = planStage(row, operation.database, generation, homes, digest, T, quiesce);
						if (plan.action === 'reject') throw new Error(plan.reason);
						if (plan.action === 'write') rows.set(node, plan.row);
						return { staged: rows.get(node).staged, quiesced: { complete: true, outstanding: [] } };
					}
					if (!homes.includes(node)) throw new Error(`${node} is not a member`);
					const plan = planActivate(row, operation.database, generation, digest, T, 0);
					if (plan.action === 'reject') throw new Error(plan.reason);
					if (plan.action === 'write') rows.set(node, plan.row);
					return { active: rows.get(node).active };
				})();
			},
		}),
	};
}

describe('runBootstrap: survey, stage and activate over the transition hops', () => {
	const abc = ['a', 'b', 'c'];
	let previousReaders;
	let peersOf = {};
	before(() => {
		previousReaders = homesMembership();
		setHomesMembershipReaders({
			thisNodeName: () => 'a',
			replicatingPeers: (database) => peersOf[database] ?? [],
		});
	});
	after(() => {
		if (previousReaders) setHomesMembershipReaders(previousReaders);
	});
	const slept = [];
	const sleep = async (ms) => {
		slept.push(ms);
	};
	const fastTimeouts = { hopMs: 200, stageMs: 200, attemptMs: 2_000 };

	it('establishes generation 1 on every node of a fresh mesh, waiting the backstop between stage and activate', async () => {
		peersOf.fresh = ['b', 'c'];
		const mesh = fakeMesh(abc);
		const outcome = await runBootstrap('fresh', { peers: mesh.peers('a'), sleep, timeouts: fastTimeouts });
		assert.deepStrictEqual(outcome, { outcome: 'activated', homes: abc, changed: true });
		for (const node of abc) assert.strictEqual(mesh.rows.get(node).active.digest, digestOf(1, abc), node);
		assert.deepStrictEqual(slept, [MIN_DRAIN_BACKSTOP_MS]);
	});

	it('a refused survey writes nothing', async () => {
		peersOf.refused = ['b', 'c'];
		const mesh = fakeMesh(abc, { views: { b: ['a', 'b'] } });
		const outcome = await runBootstrap('refused', { peers: mesh.peers('a'), sleep, timeouts: fastTimeouts });
		assert.strictEqual(outcome.outcome, 'refused');
		assert.ok(
			mesh.calls.every((call) => call.startsWith('survey:')),
			mesh.calls.join()
		);
	});

	it('a node with no peers is refused without a hop', async () => {
		peersOf.alone = [];
		const mesh = fakeMesh(['a']);
		const outcome = await runBootstrap('alone', { peers: mesh.peers('a'), sleep, timeouts: fastTimeouts });
		assert.strictEqual(outcome.outcome, 'refused');
		assert.deepStrictEqual(mesh.calls, []);
	});

	it('a failed stage activates nothing, and the next attempt from any member completes it', async () => {
		peersOf.stagefail = ['b', 'c'];
		const mesh = fakeMesh(abc, { fail: { 'stage:c': 'socket closed' } });
		const first = await runBootstrap('stagefail', { peers: mesh.peers('a'), sleep, timeouts: fastTimeouts });
		assert.deepStrictEqual(first, { outcome: 'failed', reason: 'c stage: socket closed', planned: true });
		assert.ok(!mesh.calls.some((call) => call.startsWith('activate:')));
		assert.strictEqual(classifyHomesRow(mesh.rows.get('a')), 'first-staged');
		const retry = fakeMesh(abc, { rows: Object.fromEntries(mesh.rows) });
		const second = await runBootstrap('stagefail', {
			peers: retry.peers('b'),
			sleep,
			timeouts: fastTimeouts,
			ownSet: abc,
		});
		assert.strictEqual(second.outcome, 'activated');
		for (const node of abc) assert.strictEqual(classifyHomesRow(retry.rows.get(node)), 'first-active', node);
	});

	it('a partial activation completes from a node that is already active', async () => {
		peersOf.partial = ['b', 'c'];
		const mesh = fakeMesh(abc, { fail: { 'activate:c': 'timeout' } });
		const first = await runBootstrap('partial', { peers: mesh.peers('a'), sleep, timeouts: fastTimeouts });
		assert.strictEqual(first.outcome, 'failed');
		assert.strictEqual(classifyHomesRow(mesh.rows.get('a')), 'first-active');
		assert.strictEqual(classifyHomesRow(mesh.rows.get('c')), 'first-staged');
		const retry = fakeMesh(abc, { rows: Object.fromEntries(mesh.rows) });
		const second = await runBootstrap('partial', {
			peers: retry.peers('a'),
			sleep,
			timeouts: fastTimeouts,
			ownSet: abc,
		});
		assert.strictEqual(second.outcome, 'activated');
		assert.strictEqual(classifyHomesRow(retry.rows.get('c')), 'first-active');
		assert.ok(!retry.calls.includes('stage:a'), 'an active member is not staged again');
	});

	it('a superseded attempt stops before writing, and a synchronous hop failure is a failed hop', async () => {
		peersOf.cancel = ['b', 'c'];
		const mesh = fakeMesh(abc);
		const cancelled = await runBootstrap('cancel', {
			peers: mesh.peers('a'),
			sleep,
			timeouts: fastTimeouts,
			current: () => mesh.calls.length < abc.length,
		});
		assert.deepStrictEqual(cancelled, { outcome: 'cancelled' });
		assert.ok(!mesh.calls.some((call) => !call.startsWith('survey:')));
		peersOf.sync = ['b', 'c'];
		const sync = await runBootstrap('sync', {
			peers: fakeMesh(abc, { throwSync: ['survey:b'] }).peers('a'),
			sleep,
			timeouts: fastTimeouts,
		});
		assert.strictEqual(sync.outcome, 'refused');
		assert.match(sync.reason, /b \(synchronous failure\)/);
	});

	it('a release during the stage fan-out sends no further hop, and an expired attempt activates nothing', async () => {
		peersOf.midstage = ['b', 'c'];
		let superseded = false;
		const mesh = fakeMesh(abc);
		const peers = mesh.peers('a');
		const send = peers.send;
		peers.send = (node, operation, ms) => {
			if (operation.action === 'stage') superseded = true;
			return send(node, operation, ms);
		};
		const cancelled = await runBootstrap('midstage', {
			peers,
			sleep,
			timeouts: { ...fastTimeouts },
			current: () => !superseded,
		});
		assert.deepStrictEqual(cancelled, { outcome: 'cancelled' });
		assert.strictEqual(mesh.calls.filter((call) => call.startsWith('stage:')).length, 1, mesh.calls.join());
		peersOf.expired = ['b', 'c'];
		let clock = 0;
		const late = fakeMesh(abc);
		const expired = await runBootstrap('expired', {
			peers: late.peers('a'),
			timeouts: { hopMs: 200, stageMs: 200, attemptMs: 1_000 },
			now: () => clock,
			sleep: async () => {
				clock += 5_000;
			},
		});
		assert.deepStrictEqual(expired, { outcome: 'failed', reason: 'the attempt ran out of time', planned: true });
		assert.ok(!late.calls.some((call) => call.startsWith('activate:')));
	});

	it('an attempt that cannot join the queue before its deadline gives up rather than waiting', async () => {
		peersOf.held = ['b', 'c'];
		let release;
		const holder = withTransitionQueue('held', () => new Promise((resolve) => (release = resolve)));
		const started = Date.now();
		const outcome = await runBootstrap('held', {
			peers: fakeMesh(abc).peers('a'),
			sleep,
			timeouts: { hopMs: 200, stageMs: 200, attemptMs: 50 },
		});
		assert.deepStrictEqual(outcome, {
			outcome: 'failed',
			reason: 'another home-map transition held the queue',
			planned: false,
		});
		assert.ok(Date.now() - started < 2_000);
		release();
		await holder;
	});

	it('a resume where every member is already active reports nothing changed', async () => {
		peersOf.allactive = ['b', 'c'];
		const rows = { a: active1(abc), b: active1(abc), c: active1(abc) };
		const outcome = await runBootstrap('allactive', {
			peers: fakeMesh(abc, { rows }).peers('a'),
			sleep,
			timeouts: fastTimeouts,
			ownSet: abc,
		});
		assert.deepStrictEqual(outcome, { outcome: 'activated', homes: abc, changed: false });
	});

	it('a joiner refuses and writes nothing to the existing members', async () => {
		peersOf.joiner = ['b', 'c', 'd'];
		const abcd = [...abc, 'd'];
		const rows = { a: active1(abc), b: active1(abc), c: active1(abc) };
		const mesh = fakeMesh(abcd, { rows });
		const outcome = await runBootstrap('joiner', { peers: mesh.peers('d'), sleep, timeouts: fastTimeouts });
		assert.strictEqual(outcome.outcome, 'refused');
		assert.ok(mesh.calls.every((call) => call.startsWith('survey:')));
		assert.strictEqual(mesh.rows.get('d'), undefined);
	});
});

describe('createBootstrapTrigger: what homeMap() starts and answers meanwhile', () => {
	function harness(options = {}) {
		const { automatic = true } = options;
		let candidates = options.candidates ?? ['a', 'b'];
		const row = 'row' in options ? options.row : { rowClass: 'empty' };
		let now = 0;
		const timers = [];
		const runs = [];
		const logged = [];
		const rows = { db: row };
		const trigger = createBootstrapTrigger({
			automatic,
			rowState: (database) => rows[database],
			candidates: () => candidates,
			run(database, options) {
				let settle;
				const promise = new Promise((resolve, reject) => (settle = { resolve, reject }));
				runs.push({ database, options, ...settle });
				return promise;
			},
			now: () => now,
			random: () => 0,
			setTimer(callback) {
				const timer = { callback, cleared: false };
				timers.push(timer);
				return timer;
			},
			clearTimer(timer) {
				timer.cleared = true;
			},
			log: { info: (message) => logged.push(message), warn: (message) => logged.push(message) },
		});
		const fire = () => {
			for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
		};
		const tick = () => new Promise((resolve) => setImmediate(resolve));
		return {
			trigger,
			runs,
			rows,
			logged,
			fire,
			tick,
			advance: (ms) => (now += ms),
			setCandidates: (next) => (candidates = next),
		};
	}
	const isRefusal = (error) => error.statusCode === 503 && error.message === bootstrapRefusedMessage('db');

	it('the first call rides through: no throw, one attempt after the jitter', async () => {
		const h = harness();
		h.trigger.missing('db');
		h.trigger.missing('db');
		assert.strictEqual(h.runs.length, 0, 'the attempt waits out the jitter');
		h.fire();
		assert.strictEqual(h.runs.length, 1);
		assert.strictEqual(h.trigger.status('db').state, 'running');
		h.runs[0].resolve({ outcome: 'activated', homes: ['a', 'b'], changed: true });
		await h.tick();
		assert.strictEqual(h.trigger.status('db').state, 'activated');
		assert.deepStrictEqual(h.logged, ['Record lock home map for db: established generation 1 on a, b']);
	});

	it('after a refusal, callers get a 503 until a retry passes the survey', async () => {
		const h = harness();
		h.trigger.missing('db');
		h.fire();
		h.runs[0].resolve({ outcome: 'refused', reason: 'the map does not include a', settled: true });
		await h.tick();
		assert.throws(() => h.trigger.missing('db'), isRefusal);
		assert.deepStrictEqual(h.trigger.status('db'), {
			state: 'refused',
			reason: 'the map does not include a',
			retryInMs: 1_000,
		});
		h.advance(1_000);
		assert.throws(() => h.trigger.missing('db'), isRefusal, 'the retry starts, and the refusal stands meanwhile');
		h.fire();
		assert.strictEqual(h.runs.length, 2);
		assert.throws(() => h.trigger.missing('db'), isRefusal);
		h.runs[1].options.onPlanned();
		h.trigger.missing('db');
		h.runs[1].resolve({ outcome: 'activated', homes: ['a', 'b'], changed: true });
		await h.tick();
		assert.strictEqual(h.logged.filter((line) => /does not include a/.test(line)).length, 1);
	});

	it('backs off exponentially, and a failure after the survey admitted the attempt does not refuse callers', async () => {
		const h = harness();
		h.trigger.missing('db');
		h.fire();
		h.runs[0].resolve({ outcome: 'refused', reason: 'x', settled: true });
		await h.tick();
		h.advance(1_000);
		assert.throws(() => h.trigger.missing('db'));
		h.fire();
		h.runs[1].resolve({ outcome: 'refused', reason: 'x', settled: true });
		await h.tick();
		assert.strictEqual(h.trigger.status('db').retryInMs, 2_000);
		h.advance(2_000);
		assert.throws(() => h.trigger.missing('db'));
		h.fire();
		h.runs[2].options.onPlanned();
		h.runs[2].resolve({ outcome: 'failed', reason: 'c stage: timeout', planned: true });
		await h.tick();
		h.trigger.missing('db');
		assert.strictEqual(h.trigger.status('db').state, 'waiting');
	});

	it('a refusal that can clear by itself (a cluster still converging) rides the wait instead of a 503', async () => {
		const h = harness();
		h.trigger.missing('db');
		h.fire();
		h.runs[0].resolve({ outcome: 'refused', reason: 'b does not yet replicate with every node', settled: false });
		await h.tick();
		h.trigger.missing('db');
		assert.deepStrictEqual(h.trigger.status('db'), {
			state: 'waiting',
			reason: 'b does not yet replicate with every node',
			retryInMs: 1_000,
		});
	});

	it('a node with no peers is refused at once, without an attempt, until a peer is added', () => {
		const h = harness({ candidates: ['a'] });
		assert.throws(() => h.trigger.missing('db'), isRefusal);
		assert.strictEqual(h.runs.length, 0);
		assert.match(h.trigger.status('db').reason, /no other node/);
		h.advance(1_000);
		assert.throws(() => h.trigger.missing('db'), isRefusal, 'still alone: re-checked, not backed off');
		assert.strictEqual(h.trigger.status('db').retryInMs, 1_000);
		h.setCandidates(['a', 'b']);
		h.advance(1_000);
		h.trigger.missing('db');
		h.fire();
		assert.strictEqual(h.runs.length, 1, 'the refusal cleared as soon as a peer was there');
	});

	it('a pristine refusal is not reported once another node activated this one', async () => {
		const h = harness();
		h.trigger.missing('db');
		h.fire();
		h.runs[0].resolve({ outcome: 'refused', reason: 'not agreed yet', settled: false });
		await h.tick();
		assert.strictEqual(h.trigger.status('db').state, 'waiting');
		h.rows.db = { rowClass: 'first-active', firstSet: ['a', 'b'] };
		assert.strictEqual(h.trigger.status('db').state, 'activated');
	});

	it('a follower activated by another node can still resume until the whole ring has agreed once', () => {
		const h = harness();
		h.trigger.missing('db');
		h.rows.db = { rowClass: 'first-active', firstSet: ['a', 'b'] };
		h.fire();
		assert.strictEqual(h.runs.length, 0);
		assert.strictEqual(h.trigger.status('db').state, 'activated');
		h.trigger.missing('db');
		h.fire();
		assert.strictEqual(h.runs.length, 1, 'a member may still be staged: resume');
		h.trigger.release('db');
		h.trigger.available('db');
		h.trigger.missing('db');
		h.fire();
		assert.strictEqual(h.runs.length, 1, 'once a map was answered, a withheld one starts nothing');
	});

	it('reports nothing once an operator generation replaced the first, and a lone-participant refusal re-checks on a short window', async () => {
		const h = harness({ row: { rowClass: 'empty' } });
		h.trigger.missing('db');
		h.fire();
		h.runs[0].resolve({
			outcome: 'refused',
			reason: 'no other node replicating this database takes part in cluster record locks',
			settled: true,
		});
		await h.tick();
		assert.strictEqual(h.trigger.status('db').retryInMs, 5_000);
		h.rows.db = { rowClass: 'other' };
		assert.strictEqual(h.trigger.status('db'), undefined);
	});

	it('a node already active at generation 1 resumes in the background and never throws', async () => {
		const h = harness({ row: { rowClass: 'first-active', firstSet: ['a', 'b'] } });
		h.trigger.missing('db');
		h.fire();
		assert.deepStrictEqual(h.runs[0].options.ownSet, ['a', 'b']);
		h.runs[0].resolve({ outcome: 'refused', reason: 'b is unreachable', settled: true });
		await h.tick();
		h.trigger.missing('db');
		assert.strictEqual(h.trigger.status('db').retryInMs, 1_000);
	});

	it('once this thread completed the first generation, a withheld map starts no further attempt', async () => {
		const h = harness({ row: { rowClass: 'first-active', firstSet: ['a', 'b'] } });
		h.trigger.missing('db');
		h.fire();
		h.runs[0].resolve({ outcome: 'activated', homes: ['a', 'b'], changed: false });
		await h.tick();
		assert.deepStrictEqual(h.logged, [], 'nothing changed, so nothing is logged');
		h.advance(60_000);
		h.trigger.missing('db');
		h.fire();
		assert.strictEqual(h.runs.length, 1);
		assert.strictEqual(h.trigger.status('db').state, 'activated');
	});

	it('a node already staged when its first lock arrives follows once, then resumes', () => {
		const h = harness({ row: { rowClass: 'first-staged', firstSet: ['a', 'b'] } });
		h.trigger.missing('db');
		h.fire();
		assert.strictEqual(h.runs.length, 0);
		assert.strictEqual(h.trigger.status('db').retryInMs, BOOTSTRAP_FOLLOW_MS);
		h.advance(BOOTSTRAP_FOLLOW_MS);
		h.trigger.missing('db');
		h.fire();
		assert.strictEqual(h.runs.length, 1);
	});

	it('a logger that throws while settling is contained', async () => {
		let thrown = 0;
		const trigger = createBootstrapTrigger({
			automatic: true,
			rowState: () => ({ rowClass: 'empty' }),
			candidates: () => ['a', 'b'],
			run: async () => ({ outcome: 'refused', reason: 'x', settled: true }),
			now: () => 0,
			random: () => 0,
			setTimer: (callback) => (callback(), undefined),
			clearTimer() {},
			log: {
				warn() {
					thrown++;
					throw new Error('log sink down');
				},
			},
		});
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			trigger.missing('db');
			await new Promise((resolve) => setTimeout(resolve, 10));
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
		assert.strictEqual(thrown, 1);
		assert.deepStrictEqual(unhandled, []);
		assert.strictEqual(trigger.status('db').reason, 'x');
	});

	it('does nothing when not automatic, after a failed read, or on operator history', () => {
		for (const options of [{ automatic: false }, { row: undefined }, { row: { rowClass: 'other' } }]) {
			const h = harness(options);
			h.trigger.missing('db');
			h.fire();
			assert.strictEqual(h.runs.length, 0, JSON.stringify(options));
			assert.strictEqual(h.trigger.status('db'), undefined);
		}
	});

	it('follows another node that staged this one during the jitter instead of racing it', () => {
		const h = harness();
		h.trigger.missing('db');
		h.rows.db = { rowClass: 'first-staged', firstSet: ['a', 'b'] };
		h.fire();
		assert.strictEqual(h.runs.length, 0);
		assert.strictEqual(h.trigger.status('db').retryInMs, BOOTSTRAP_FOLLOW_MS);
	});

	it('a released database cancels the timer and ignores a late outcome; a throwing run is contained', async () => {
		const h = harness();
		h.trigger.missing('db');
		h.trigger.release('db');
		h.fire();
		assert.strictEqual(h.runs.length, 0);
		h.trigger.missing('db');
		h.fire();
		h.trigger.release('db');
		h.runs[0].resolve({ outcome: 'refused', reason: 'late' });
		await h.tick();
		assert.strictEqual(h.trigger.status('db'), undefined);
		const thrower = createBootstrapTrigger({
			automatic: true,
			rowState: () => ({ rowClass: 'empty' }),
			candidates: () => ['a', 'b'],
			run() {
				throw new Error('boom');
			},
			now: () => 0,
			random: () => 0,
			setTimer: (callback) => (callback(), undefined),
			clearTimer() {},
			log: {},
		});
		thrower.missing('db');
		await h.tick();
		assert.strictEqual(thrower.status('db').reason, 'boom');
	});
});

function fakeAuditStore() {
	const buffers = new Map();
	return {
		getUserSharedBuffer(key, initial) {
			const id = JSON.stringify(key);
			let buffer = buffers.get(id);
			if (!buffer) buffers.set(id, (buffer = initial));
			return buffer;
		},
	};
}

describe('the transport: which homeMap() call may start the first generation', () => {
	function transportFor({ active, agreeing = ['b'], foreign = false } = {}) {
		const auditStore = fakeAuditStore();
		for (const peer of agreeing) {
			const status = getReplicationSharedStatus(auditStore, 'data', peer);
			recordPeerLockCapability(status, true);
			recordPeerHomesAgreement(status, true);
		}
		const flag = new Float64Array(
			auditStore.getUserSharedBuffer(['recordLockForeignRing', 'data'], new ArrayBuffer(8))
		);
		if (foreign) flag[0] = 1;
		const missing = [];
		const transport = createRecordLockTransport(
			'data',
			{
				thisNodeName: () => 'a',
				auditStore: () => auditStore,
				ownsDatabase: () => true,
				homeIncarnation: () => 3,
				send: async () => ({}),
				isFirstIncarnation: () => false,
				monotonicNow: () => 0,
				homeMapMissing: (database) => missing.push(database),
				foreignRing: (store, database) =>
					new Float64Array(store.getUserSharedBuffer(['recordLockForeignRing', database], new ArrayBuffer(8))),
			},
			() => active
		);
		return { transport, missing };
	}
	const ab = { generation: 1, homes: ['a', 'b'], digest: digestOf(1, ['a', 'b']) };

	it('only homeMap() reports a missing map; peekHomeMap never does', () => {
		const { transport, missing } = transportFor();
		assert.strictEqual(transport.peekHomeMap(), undefined);
		assert.deepStrictEqual(missing, []);
		assert.strictEqual(transport.homeMap('data'), undefined);
		assert.deepStrictEqual(missing, ['data']);
	});

	it('a refusal thrown by the trigger is the lock 503', () => {
		const transport = createRecordLockTransport(
			'data',
			{
				thisNodeName: () => 'a',
				auditStore: () => undefined,
				ownsDatabase: () => true,
				homeIncarnation: () => 3,
				send: async () => ({}),
				isFirstIncarnation: () => false,
				monotonicNow: () => 0,
				homeMapMissing: () => {
					throw Object.assign(new Error('refused'), { statusCode: 503 });
				},
			},
			() => undefined
		);
		assert.throws(
			() => transport.homeMap('data'),
			(error) => error.statusCode === 503
		);
		assert.strictEqual(transport.peekHomeMap(), undefined);
	});

	it('a generation-1 ring that met another map is withheld and not resumed; a later generation ignores the flag', () => {
		const withheld = transportFor({ active: ab, foreign: true });
		assert.strictEqual(withheld.transport.homeMap('data'), undefined);
		assert.deepStrictEqual(withheld.missing, [], 'an operator reconciles two maps; no attempt can');
		const second = { generation: 2, homes: ['a', 'b'], digest: digestOf(2, ['a', 'b']) };
		const later = transportFor({ active: second, foreign: true });
		assert.deepStrictEqual(later.transport.homeMap('data')?.homes, ['a', 'b']);
		assert.deepStrictEqual(transportFor({ active: ab }).transport.homeMap('data')?.homes, ['a', 'b']);
	});
});

describe('a generation-1 ring meeting another map', () => {
	let previousReader;
	before(() => {
		// The reconcile reads the shared flag through a real table's audit store.
		setupTestDBPath();
		table({ table: 'ForeignRingA', database: 'foreignringa', attributes: [{ name: 'id', isPrimaryKey: true }] });
		table({ table: 'ForeignRingB', database: 'foreignringb', attributes: [{ name: 'id', isPrimaryKey: true }] });
		table({ table: 'ForeignRingC', database: 'foreignringc', attributes: [{ name: 'id', isPrimaryKey: true }] });
		table({ table: 'ForeignRingD', database: 'foreignringd', attributes: [{ name: 'id', isPrimaryKey: true }] });
		previousReader = setRecordLockHomesRowReader(async (database) =>
			database === 'foreignringc'
				? { active: { generation: 2, homes: ['a', 'b'], digest: digestOf(2, ['a', 'b']) } }
				: { active: { generation: 1, homes: ['a', 'b'], digest: digestOf(1, ['a', 'b']) } }
		);
	});
	after(() => {
		if (previousReader) setRecordLockHomesRowReader(previousReader);
		for (const database of ['foreignringa', 'foreignringb', 'foreignringc', 'foreignringd'])
			forgetRecordLockHomesCache(database);
	});
	const ours = digestOf(1, ['a', 'b']);

	it('a peer outside the ring announcing a different map withholds it and announces the marker', async () => {
		await refreshRecordLockHomesCache('foreignringa');
		recordPeerHomesDigest('foreignringa', 'b', ours);
		assert.strictEqual(currentHomesDigest('foreignringa'), ours, 'a member agreeing changes nothing');
		recordPeerHomesDigest('foreignringa', 'c', digestOf(1, ['c', 'd']));
		assert.strictEqual(currentHomesDigest('foreignringa'), WITHHELD_DIGEST_PREFIX + ours);
	});

	it('a member announcing the marker passes it on', async () => {
		await refreshRecordLockHomesCache('foreignringb');
		recordPeerHomesDigest('foreignringb', 'b', WITHHELD_DIGEST_PREFIX + ours);
		assert.strictEqual(currentHomesDigest('foreignringb'), WITHHELD_DIGEST_PREFIX + ours);
	});

	it('a different map announced before the first read of the row is caught once the row is read', async () => {
		recordPeerHomesDigest('foreignringd', 'c', digestOf(1, ['c', 'd']));
		assert.strictEqual(currentHomesDigest('foreignringd'), undefined);
		await refreshRecordLockHomesCache('foreignringd');
		assert.strictEqual(currentHomesDigest('foreignringd'), WITHHELD_DIGEST_PREFIX + ours);
	});

	it('is off at a later generation, where departed and fenced nodes hold stale maps', async () => {
		await refreshRecordLockHomesCache('foreignringc');
		recordPeerHomesDigest('foreignringc', 'c', digestOf(1, ['a', 'b', 'c']));
		assert.strictEqual(currentHomesDigest('foreignringc'), digestOf(2, ['a', 'b']));
	});
});
