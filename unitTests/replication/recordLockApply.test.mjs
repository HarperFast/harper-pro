/**
 * The decisions behind `record_lock_apply_homes` (harper-pro#862), checked without a cluster: which
 * survey results refuse before anything is staged, when a drain result licenses activating without the
 * interval, what the orchestrator sends to which node in each outcome, and that the peer-callable hop
 * accepts only a node principal and re-validates the relayed proposal against its own row.
 */
import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
// The transport is the module that wires (and must load before) recordLockRpc; entering the graph
// anywhere else trips the rpc → replicator → replicationConnection → transport cycle at load.
import '#src/replication/recordLockTransport';
import { server } from '#src/core/server/Server';
import {
	ApplyRefusedError,
	applyHomes,
	executeTransition,
	executeTransitionLocally,
	planActivation,
	planSurvey,
} from '#src/replication/recordLockApply';
import {
	DELEGATION_DRAIN_MS,
	MIN_DRAIN_BACKSTOP_MS,
	digestOf,
	planActivate,
	planStage,
	setHomesDrainReader,
} from '#src/replication/recordLockHomes';

const T = 1_700_000_000_000;
const PROVEN = { complete: true, surrendered: 0, recalled: 0, outstanding: [] };
const UNPROVEN = { complete: false, surrendered: 0, recalled: 0, outstanding: [] };

function state(generation, homes, extra = {}) {
	const canonical = [...new Set(homes)].sort();
	return { generation, homes: canonical, digest: digestOf(generation, canonical), ...extra };
}
function reply(node, fields = {}) {
	return { node, highestActedOn: 0, ...fields };
}
function replies(entries) {
	return new Map(Object.entries(entries));
}

describe('planSurvey: what refuses before anything is staged', () => {
	const homes = ['a', 'b', 'c'];

	it('a fresh cluster proceeds at generation 1 with nothing already staged or active', () => {
		const plan = planSurvey('db', homes, homes, undefined, replies({ a: reply('a'), b: reply('b'), c: reply('c') }));
		assert.strictEqual(plan.action, 'proceed');
		assert.strictEqual(plan.generation, 1);
		assert.strictEqual(plan.digest, digestOf(1, homes));
		assert.deepStrictEqual([...plan.alreadyActive], []);
		assert.deepStrictEqual([...plan.alreadyStaged], []);
	});

	it('an unreachable node is a hard failure, and names every one that did not answer', () => {
		const plan = planSurvey('db', homes, homes, undefined, replies({ a: reply('a'), b: { error: 'ECONNREFUSED' } }));
		assert.strictEqual(plan.action, 'refuse');
		assert.strictEqual(plan.status, 503);
		assert.match(plan.reason, /b \(ECONNREFUSED\)/);
		assert.match(plan.reason, /c \(no answer\)/);
	});

	it('a node that answers under another name is not the node that was asked', () => {
		const plan = planSurvey('db', ['a', 'b'], ['a', 'b'], undefined, replies({ a: reply('a'), b: reply('z') }));
		assert.strictEqual(plan.action, 'refuse');
		assert.strictEqual(plan.status, 409);
		assert.match(plan.reason, /b answered as z/);
	});

	it('a ring member the operator did not list refuses: that node may still be granting', () => {
		const plan = planSurvey(
			'db',
			['a', 'b'],
			['a', 'b'],
			undefined,
			replies({ a: reply('a', { active: state(1, ['a', 'b', 'c']), highestActedOn: 1 }), b: reply('b') })
		);
		assert.strictEqual(plan.action, 'refuse');
		assert.strictEqual(plan.status, 409);
		assert.match(plan.reason, /c \(in a's ring\)/);
		const staged = planSurvey(
			'db',
			['a', 'b'],
			['a', 'b'],
			undefined,
			replies({
				a: reply('a'),
				b: reply('b', { staged: state(2, ['b', 'd'], { quiesce: ['b', 'd'] }), highestActedOn: 2 }),
			})
		);
		assert.strictEqual(staged.action, 'refuse');
		assert.match(staged.reason, /d \(in b's ring\)/);
	});

	it("a staged row's persisted quiesce still names the old ring after staging erased active", () => {
		// Shrink [a,b,c] → [a,b], interrupted after a and b staged: their rows no longer say c was in
		// the ring, but the quiesce they were staged with does, so a retry that forgot c is refused.
		const staged = state(2, ['a', 'b'], { quiesce: ['a', 'b', 'c'] });
		const plan = planSurvey(
			'db',
			['a', 'b'],
			['a', 'b'],
			2,
			replies({ a: reply('a', { staged, highestActedOn: 2 }), b: reply('b', { staged, highestActedOn: 2 }) })
		);
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /c \(in a's ring\)/);
	});

	it('nodes that disagree about the active or the staged generation refuse', () => {
		const active = planSurvey(
			'db',
			homes,
			homes,
			undefined,
			replies({
				a: reply('a', { active: state(1, homes), highestActedOn: 1 }),
				b: reply('b', { active: state(2, homes), highestActedOn: 2 }),
				c: reply('c'),
			})
		);
		assert.strictEqual(active.action, 'refuse');
		assert.match(active.reason, /disagree about the active generation/);
		// Two different sets staged at the same generation (two operators raced): the derived generation
		// resumes 2 for the matching set and the dry run refuses on the other node, naming it; an explicit
		// higher generation supersedes both and proceeds, so the cluster is never wedged.
		const q = ['a', 'b', 'c'];
		const raced = replies({
			a: reply('a', { staged: state(2, homes, { quiesce: q }), highestActedOn: 2 }),
			b: reply('b', { staged: state(2, ['a', 'b'], { quiesce: q }), highestActedOn: 2 }),
			c: reply('c'),
		});
		const resumed = planSurvey('db', homes, homes, undefined, raced);
		assert.strictEqual(resumed.action, 'refuse');
		assert.match(resumed.reason, /^b would refuse to stage: generation 2 is already staged with a different home set/);
		const superseded = planSurvey('db', homes, homes, 3, raced);
		assert.strictEqual(superseded.action, 'proceed');
		assert.strictEqual(superseded.generation, 3);
		assert.deepStrictEqual([...superseded.alreadyStaged], []);
	});

	it('a staged row with no recorded participant set is refused: the ring it stopped serving cannot be checked', () => {
		const plan = planSurvey(
			'db',
			['a', 'b'],
			['a', 'b'],
			undefined,
			replies({ a: reply('a', { staged: state(2, ['a', 'b']), highestActedOn: 2 }), b: reply('b') })
		);
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /^a hold a staged generation with no recorded participant set/);
		assert.match(plan.reason, /re-stage the same generation and homes on them with quiesce/);
	});

	it('the node taking the call is read too: a ring it serves that the list omits refuses, and its unreadable row refuses', () => {
		const fresh = replies({ d: reply('d') });
		const omitted = planSurvey('db', ['d'], ['d'], undefined, fresh, {
			node: 'b',
			reply: reply('b', { active: state(1, ['a', 'b', 'c']), highestActedOn: 1 }),
		});
		assert.strictEqual(omitted.action, 'refuse');
		assert.match(omitted.reason, /a \(in b's ring, the node taking this call\)/);
		const unreadable = planSurvey('db', ['d'], ['d'], undefined, fresh, {
			node: 'b',
			reply: { error: 'store closed' },
		});
		assert.strictEqual(unreadable.action, 'refuse');
		assert.strictEqual(unreadable.status, 503);
		// An initiator with no row of its own, or one whose rings the list covers, does not interfere.
		assert.strictEqual(
			planSurvey('db', ['d'], ['d'], undefined, fresh, { node: 'b', reply: reply('b') }).action,
			'proceed'
		);
	});

	it('runs planStage as a dry run: a generation at or below a floor, or a different set at a staged generation, refuses', () => {
		const below = planSurvey(
			'db',
			homes,
			homes,
			1,
			replies({ a: reply('a', { highestActedOn: 3 }), b: reply('b'), c: reply('c') })
		);
		assert.strictEqual(below.action, 'refuse');
		assert.match(below.reason, /a would refuse to stage: generation 1 is not greater than 3/);
		const different = planSurvey(
			'db',
			homes,
			homes,
			2,
			replies({
				a: reply('a', { staged: state(2, ['a'], { quiesce: ['a'] }), highestActedOn: 2 }),
				b: reply('b'),
				c: reply('c'),
			})
		);
		assert.strictEqual(different.action, 'refuse');
		assert.match(different.reason, /already staged with a different home set/);
	});

	it('derives the generation as one past the highest floor, for a topology change or a stray highestActedOn', () => {
		const change = planSurvey(
			'db',
			['a', 'b'],
			homes,
			undefined,
			replies({
				a: reply('a', { active: state(1, homes), highestActedOn: 1 }),
				b: reply('b', { active: state(1, homes), highestActedOn: 1 }),
				c: reply('c', { active: state(1, homes), highestActedOn: 1 }),
			})
		);
		assert.strictEqual(change.action, 'proceed');
		assert.strictEqual(change.generation, 2);
		assert.deepStrictEqual([...change.alreadyActive], []);
		const stray = planSurvey(
			'db',
			homes,
			homes,
			undefined,
			replies({ a: reply('a', { highestActedOn: 5 }), b: reply('b'), c: reply('c') })
		);
		assert.strictEqual(stray.generation, 6);
	});

	it('resumes an interrupted transition to the same set instead of opening a new generation', () => {
		const allStaged = planSurvey(
			'db',
			homes,
			homes,
			undefined,
			replies({
				a: reply('a', { staged: state(2, homes, { quiesce: homes }), highestActedOn: 2 }),
				b: reply('b', { staged: state(2, homes, { quiesce: homes }), highestActedOn: 2 }),
				c: reply('c', { staged: state(2, homes, { quiesce: homes }), highestActedOn: 2 }),
			})
		);
		assert.strictEqual(allStaged.action, 'proceed');
		assert.strictEqual(allStaged.generation, 2);
		assert.deepStrictEqual([...allStaged.alreadyStaged].sort(), homes);
		// Interrupted between two activations: the activated node skips the stage, the rest noop it.
		const partial = planSurvey(
			'db',
			homes,
			homes,
			undefined,
			replies({
				a: reply('a', { active: state(2, homes, { quiesce: homes }), highestActedOn: 2 }),
				b: reply('b', { staged: state(2, homes, { quiesce: homes }), highestActedOn: 2 }),
				c: reply('c', { staged: state(2, homes, { quiesce: homes }), highestActedOn: 2 }),
			})
		);
		assert.strictEqual(partial.action, 'proceed');
		assert.strictEqual(partial.generation, 2);
		assert.deepStrictEqual([...partial.alreadyActive], ['a']);
		assert.deepStrictEqual([...partial.alreadyStaged], ['b', 'c']);
		// A node still ACTIVE at the old generation alongside those was never staged (staging retracts
		// active), so it may still be granting under g — the disagreement rule refuses it.
		const unstaged = planSurvey(
			'db',
			homes,
			homes,
			undefined,
			replies({
				a: reply('a', { active: state(2, homes), highestActedOn: 2 }),
				b: reply('b', { staged: state(2, homes, { quiesce: homes }), highestActedOn: 2 }),
				c: reply('c', { active: state(1, homes), highestActedOn: 1 }),
			})
		);
		assert.strictEqual(unstaged.action, 'refuse');
		// A different set at the top generation is a new transition, not a resume.
		const other = planSurvey(
			'db',
			['a', 'b'],
			homes,
			undefined,
			replies({
				a: reply('a', { staged: state(2, homes, { quiesce: homes }), highestActedOn: 2 }),
				b: reply('b', { staged: state(2, homes, { quiesce: homes }), highestActedOn: 2 }),
				c: reply('c', { staged: state(2, homes, { quiesce: homes }), highestActedOn: 2 }),
			})
		);
		assert.strictEqual(other.generation, 3);
	});
});

describe('planActivation: only a proof on every freshly staged node skips the interval', () => {
	const nodes = (entries) =>
		Object.fromEntries(Object.entries(entries).map(([node, fields]) => [node, { role: 'home', ...fields }]));

	it('activates immediately when every node proved quiescence, ignoring nodes already active', () => {
		const plan = planActivation(
			nodes({
				a: { stage: { action: 'staged', proven: true } },
				b: { stage: { action: 'already-active' } },
				c: { stage: { action: 'noop', proven: true } },
			}),
			false
		);
		assert.deepStrictEqual(plan, { activate: true, attested: [] });
	});

	it('withholds activation for one unproven node and reports the interval as a relative wait', () => {
		const plan = planActivation(
			nodes({
				a: { stage: { action: 'staged', proven: true } },
				b: { stage: { action: 'staged', proven: false } },
			}),
			false
		);
		assert.strictEqual(plan.activate, false);
		assert.match(plan.reason, /^b could not prove quiescence/);
		assert.strictEqual(
			plan.retryAfterMs,
			DELEGATION_DRAIN_MS,
			'measured by the operator from the response, never from a node clock'
		);
	});

	it("the operator's attestation covers only nodes that were already staged when this call surveyed them", () => {
		const covered = planActivation(
			nodes({
				a: { stage: { action: 'staged', proven: true } },
				b: { stage: { action: 'noop', proven: false } },
			}),
			true
		);
		assert.deepStrictEqual(covered, { activate: true, attested: ['b'] });
		// A node this call staged has had no interval at all: the attestation cannot cover it.
		const fresh = planActivation(
			nodes({
				a: { stage: { action: 'noop', proven: false } },
				b: { stage: { action: 'staged', proven: false } },
			}),
			true
		);
		assert.strictEqual(fresh.activate, false);
		assert.match(fresh.reason, /^b were staged by this call/);
		assert.strictEqual(fresh.retryAfterMs, DELEGATION_DRAIN_MS);
	});
});

/**
 * Peers as the orchestrator sees them: each holds a row driven by the same pure planners the real
 * per-node operations use, answers with an injectable drain result, and can be made to fail a hop.
 */
function fakeCluster(rowsByNode, { quiesced = {}, fail = {}, hang = [], self } = {}) {
	const rows = new Map(Object.entries(rowsByNode));
	const calls = [];
	return {
		rows,
		calls,
		peers: {
			self: () => self,
			async send(node, operation) {
				calls.push(`${operation.action}:${node}`);
				const failure = fail[`${operation.action}:${node}`];
				if (failure) throw new Error(failure);
				if (hang.includes(`${operation.action}:${node}`)) return new Promise(() => {});
				const row = rows.get(node);
				if (operation.action === 'survey') {
					if (!rows.has(node) && node !== self) throw new Error('no route to ' + node);
					return { node, active: row?.active, staged: row?.staged, highestActedOn: row?.highestActedOn ?? 0 };
				}
				const { generation, homes, quiesce, digest } = operation;
				if (operation.action === 'stage') {
					const plan = planStage(row, operation.database, generation, homes, digest, T, quiesce);
					if (plan.action === 'reject') throw new Error(plan.reason);
					if (plan.action === 'write') rows.set(node, plan.row);
					return { staged: rows.get(node).staged, quiesced: quiesced[node] ?? PROVEN };
				}
				const plan = planActivate(row, operation.database, generation, digest, T, 0);
				if (plan.action === 'reject') throw new Error(plan.reason);
				if (plan.action === 'write') rows.set(node, plan.row);
				return { active: rows.get(node).active };
			},
		},
	};
}

function activeCluster(homes) {
	const rows = {};
	for (const node of homes) {
		const staged = planStage(undefined, 'db', 1, homes, digestOf(1, homes), T, homes).row;
		rows[node] = planActivate(staged, 'db', 1, digestOf(1, homes), T, 0).row;
	}
	return rows;
}

async function refused(promise) {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof ApplyRefusedError, `expected an ApplyRefusedError, got ${error?.stack ?? error}`);
		return error;
	}
	assert.fail('expected the call to be refused');
}

describe('applyHomes over fake peers', function () {
	// Every activation after a fresh stage waits out MIN_DRAIN_BACKSTOP_MS (2s by default).
	this.timeout(30_000);

	it('sends no stage after a refusal, and the refusal carries every node in its body', async () => {
		const cluster = fakeCluster({ a: undefined, b: undefined });
		const error = await refused(applyHomes({ database: 'db', homes: ['a', 'b', 'c'] }, cluster.peers));
		assert.strictEqual(error.statusCode, 503);
		assert.deepStrictEqual(cluster.calls.sort(), ['survey:a', 'survey:b', 'survey:c']);
		assert.strictEqual(error.http_resp_msg.outcome, 'refused');
		assert.match(error.http_resp_msg.error, /c \(no route to c\)/);
		assert.match(error.http_resp_msg.nodes.c.survey.error, /no route to c/);
		assert.strictEqual(error.http_resp_msg.nodes.a.survey.highestActedOn, 0);
		assert.strictEqual(error.http_resp_msg.nodes.a.stage, undefined);
	});

	it('bootstraps generation 1 on a fresh cluster in one call when every node proves', async () => {
		const cluster = fakeCluster({ a: undefined, b: undefined, c: undefined });
		const report = await applyHomes({ database: 'db', homes: ['c', 'a', 'b'] }, cluster.peers);
		assert.strictEqual(report.outcome, 'activated');
		assert.strictEqual(report.generation, 1);
		assert.deepStrictEqual(report.homes, ['a', 'b', 'c']);
		assert.deepStrictEqual(report.quiesce, ['a', 'b', 'c']);
		for (const node of ['a', 'b', 'c']) {
			assert.deepStrictEqual(report.nodes[node].stage, { action: 'staged', quiesced: PROVEN, proven: true });
			assert.deepStrictEqual(report.nodes[node].activate, { action: 'activated' });
			assert.strictEqual(cluster.rows.get(node).active.generation, 1);
			assert.strictEqual(cluster.rows.get(node).staged, undefined);
		}
	});

	it('a topology change stages the departing node, never activates it, and activates the rest at once', async () => {
		const cluster = fakeCluster(activeCluster(['a', 'b', 'c']));
		const report = await applyHomes({ database: 'db', homes: ['a', 'b'], quiesce: ['a', 'b', 'c'] }, cluster.peers);
		assert.strictEqual(report.outcome, 'activated');
		assert.strictEqual(report.generation, 2);
		assert.strictEqual(report.nodes.c.role, 'departing');
		assert.strictEqual(report.nodes.c.stage.action, 'staged');
		assert.deepStrictEqual(report.nodes.c.activate, { action: 'skipped' });
		assert.strictEqual(cluster.rows.get('c').active, undefined, 'a departing node stays staged, unable to lock');
		assert.deepStrictEqual(cluster.rows.get('c').staged.quiesce, ['a', 'b', 'c']);
		assert.deepStrictEqual(cluster.rows.get('a').active.homes, ['a', 'b']);
		assert.ok(!cluster.calls.includes('activate:c'));
	});

	it('withholds activation while a node cannot prove, then the attested re-run completes it', async () => {
		const cluster = fakeCluster({ a: undefined, b: undefined }, { quiesced: { b: UNPROVEN } });
		const first = await applyHomes({ database: 'db', homes: ['a', 'b'] }, cluster.peers);
		assert.strictEqual(first.outcome, 'staged');
		assert.strictEqual(first.generation, 1);
		assert.strictEqual(first.nodes.b.stage.proven, false);
		assert.strictEqual(first.retryAfterMs, DELEGATION_DRAIN_MS);
		assert.ok(!cluster.calls.some((call) => call.startsWith('activate:')), 'nothing activates on an unproven drain');
		assert.strictEqual(cluster.rows.get('a').active, undefined, 'staged retracts active: every node refuses locks');
		assert.deepStrictEqual(cluster.rows.get('a').staged.quiesce, ['a', 'b'], 'the stage persisted the participant set');
		// The attestation is bound to the transition it was reported for.
		await assert.rejects(
			applyHomes({ database: 'db', homes: ['a', 'b'], drained: true }, cluster.peers),
			/pass the generation it reported/
		);
		const second = await applyHomes({ database: 'db', homes: ['a', 'b'], generation: 1, drained: true }, cluster.peers);
		assert.strictEqual(second.outcome, 'activated');
		assert.strictEqual(second.nodes.a.stage.action, 'noop');
		assert.strictEqual(cluster.rows.get('b').active.generation, 1);
	});

	it('an attested call that has to stage a node itself reports staged again instead of activating', async () => {
		// a and b were staged by an earlier call whose stage of c failed. This retry stages c for the
		// first time, and the operator's wait cannot have covered c's old authority.
		const staged = planStage(undefined, 'db', 1, ['a', 'b', 'c'], digestOf(1, ['a', 'b', 'c']), T, ['a', 'b', 'c']).row;
		const cluster = fakeCluster({ a: staged, b: staged, c: undefined }, { quiesced: { c: UNPROVEN } });
		const report = await applyHomes(
			{ database: 'db', homes: ['a', 'b', 'c'], generation: 1, drained: true },
			cluster.peers
		);
		assert.strictEqual(report.outcome, 'staged');
		assert.match(report.reason, /^c were staged by this call/);
		assert.strictEqual(report.nodes.c.stage.action, 'staged');
		assert.ok(!cluster.calls.some((call) => call.startsWith('activate:')));
		const again = await applyHomes(
			{ database: 'db', homes: ['a', 'b', 'c'], generation: 1, drained: true },
			cluster.peers
		);
		assert.strictEqual(again.outcome, 'activated');
	});

	it('a hop that fails mid-stage reports every node, leaves the others staged, and activates nothing', async () => {
		const cluster = fakeCluster(
			{ a: undefined, b: undefined, c: undefined },
			{ fail: { 'stage:b': 'socket hang up' } }
		);
		const error = await refused(applyHomes({ database: 'db', homes: ['a', 'b', 'c'] }, cluster.peers));
		assert.strictEqual(error.statusCode, 503);
		assert.strictEqual(error.http_resp_msg.outcome, 'incomplete');
		assert.deepStrictEqual(error.http_resp_msg.nodes.b.stage, { action: 'failed', error: 'socket hang up' });
		assert.strictEqual(error.http_resp_msg.nodes.a.stage.action, 'staged');
		assert.strictEqual(cluster.rows.get('a').staged.generation, 1);
		assert.ok(!cluster.calls.some((call) => call.startsWith('activate:')));
		// The same call again completes: a and c noop, b stages, all activate.
		const retry = fakeCluster(Object.fromEntries(cluster.rows));
		const report = await applyHomes({ database: 'db', homes: ['a', 'b', 'c'] }, retry.peers);
		assert.strictEqual(report.outcome, 'activated');
		assert.strictEqual(report.nodes.a.stage.action, 'noop');
		assert.strictEqual(report.nodes.b.stage.action, 'staged');
	});

	it('a hop that fails mid-activate is incomplete, and the retry noops what already activated', async () => {
		const cluster = fakeCluster({ a: undefined, b: undefined }, { fail: { 'activate:b': 'socket hang up' } });
		const error = await refused(applyHomes({ database: 'db', homes: ['a', 'b'] }, cluster.peers));
		assert.strictEqual(error.http_resp_msg.outcome, 'incomplete');
		assert.deepStrictEqual(error.http_resp_msg.nodes.a.activate, { action: 'activated' });
		assert.deepStrictEqual(error.http_resp_msg.nodes.b.activate, { action: 'failed', error: 'socket hang up' });
		const retry = fakeCluster(Object.fromEntries(cluster.rows));
		const report = await applyHomes({ database: 'db', homes: ['a', 'b'] }, retry.peers);
		assert.strictEqual(report.outcome, 'activated');
		assert.strictEqual(report.generation, 1);
		assert.deepStrictEqual(report.nodes.a.stage, { action: 'already-active' });
		assert.deepStrictEqual(report.nodes.a.activate, { action: 'noop' });
		assert.strictEqual(report.nodes.b.stage.action, 'noop');
		assert.deepStrictEqual(report.nodes.b.activate, { action: 'activated' });
	});

	it('a hop that never answers is failed at its deadline, and the report says so', async () => {
		const cluster = fakeCluster({ a: undefined, b: undefined }, { hang: ['stage:b'] });
		const timeouts = { hopMs: 200, stageMs: 300 };
		const error = await refused(applyHomes({ database: 'db', homes: ['a', 'b'] }, cluster.peers, timeouts));
		assert.strictEqual(error.http_resp_msg.outcome, 'incomplete');
		assert.match(error.http_resp_msg.nodes.b.stage.error, /b stage did not answer within 300ms/);
		assert.strictEqual(error.http_resp_msg.nodes.a.stage.action, 'staged');
		const survey = fakeCluster({ a: undefined }, { hang: ['survey:a'] });
		const refusal = await refused(applyHomes({ database: 'db', homes: ['a'] }, survey.peers, timeouts));
		assert.strictEqual(refusal.statusCode, 503);
		assert.match(refusal.http_resp_msg.nodes.a.survey.error, /a survey did not answer within 200ms/);
	});

	it("reads the initiating node's own row and reports it, refusing a list that omits a ring it serves", async () => {
		const cluster = fakeCluster({ ...activeCluster(['a', 'b', 'c']), d: undefined }, { self: 'b' });
		const error = await refused(applyHomes({ database: 'db', homes: ['d'] }, cluster.peers));
		assert.strictEqual(error.statusCode, 409);
		assert.match(error.http_resp_msg.error, /a \(in b's ring, the node taking this call\)/);
		assert.strictEqual(error.http_resp_msg.initiator.node, 'b');
		assert.strictEqual(error.http_resp_msg.initiator.survey.active.generation, 1);
		assert.deepStrictEqual(cluster.calls.sort(), ['survey:b', 'survey:d']);
		assert.strictEqual(cluster.rows.get('d'), undefined, 'nothing was staged');
	});

	it('rejects a quiesce that omits a home, and malformed input, before asking anyone', async () => {
		const cluster = fakeCluster({ a: undefined, b: undefined });
		await assert.rejects(
			applyHomes({ database: 'db', homes: ['a', 'b'], quiesce: ['a'] }, cluster.peers),
			/quiesce must include every node in homes; missing b/
		);
		await assert.rejects(applyHomes({ database: 'db', homes: [] }, cluster.peers), /non-empty array/);
		await assert.rejects(
			applyHomes({ database: 'db', homes: ['a'], generation: 0 }, cluster.peers),
			/positive integer/
		);
		assert.deepStrictEqual(cluster.calls, []);
	});
});

describe('record_lock_transition: the peer-callable hop', () => {
	const peer = { name: 'peer-node', url: 'wss://peer-node:9933' };
	const from = { name: 'peer-node' };
	let self;
	before(async () => {
		server.nodes = [...(server.nodes ?? []), peer];
		setHomesDrainReader(async () => PROVEN);
		self = (await executeTransitionLocally({ database: 'hop0', action: 'survey' })).node;
		assert.strictEqual(typeof self, 'string');
	});
	after(() => {
		server.nodes = (server.nodes ?? []).filter((node) => node !== peer);
		setHomesDrainReader(async () => ({ error: 'no record lock drain is wired on this node' }));
	});

	it('rejects a caller that is not a node principal, before reading or writing anything', async () => {
		for (const hdb_user of [undefined, { name: 'super' }, { name: '' }])
			await assert.rejects(
				executeTransition({
					database: 'hop1',
					action: 'stage',
					generation: 1,
					homes: [self],
					quiesce: [self],
					digest: digestOf(1, [self]),
					hdb_user,
				}),
				(error) => error.statusCode === 403 && /cluster nodes only/.test(error.message)
			);
		const survey = await executeTransitionLocally({ database: 'hop1', action: 'survey' });
		assert.strictEqual(survey.staged, undefined, 'the refused stage wrote nothing');
	});

	it('re-validates the relayed proposal: a digest that does not match the generation and set is refused', async () => {
		await assert.rejects(
			executeTransition({
				database: 'hop2',
				action: 'stage',
				generation: 1,
				homes: [self],
				quiesce: [self],
				digest: digestOf(1, ['b']),
				hdb_user: from,
			}),
			(error) => error.statusCode === 409 && /relayed digest does not match/.test(error.message)
		);
		await assert.rejects(
			executeTransition({
				database: 'hop2',
				action: 'stage',
				generation: 0,
				homes: [self],
				quiesce: [self],
				digest: 'x',
				hdb_user: from,
			}),
			/positive integer/
		);
		await assert.rejects(executeTransition({ database: 'hop2', action: 'reboot', hdb_user: from }), /must be one of/);
		const survey = await executeTransitionLocally({ database: 'hop2', action: 'survey' });
		assert.strictEqual(survey.staged, undefined);
	});

	it('refuses to be staged as a node the transition does not name, or activated as one outside the new ring', async () => {
		await assert.rejects(
			executeTransition({
				database: 'hop4',
				action: 'stage',
				generation: 1,
				homes: ['a'],
				quiesce: ['a'],
				digest: digestOf(1, ['a']),
				hdb_user: from,
			}),
			(error) => error.statusCode === 409 && /not named in this transition's quiesce set/.test(error.message)
		);
		// A departing node: staged (named in quiesce, not in homes), then never activated.
		const staged = await executeTransition({
			database: 'hop4',
			action: 'stage',
			generation: 1,
			homes: ['a'],
			quiesce: ['a', self],
			digest: digestOf(1, ['a']),
			hdb_user: from,
		});
		assert.deepStrictEqual(staged.staged.quiesce, ['a', self].sort());
		await assert.rejects(
			executeTransition({
				database: 'hop4',
				action: 'activate',
				generation: 1,
				homes: ['a'],
				digest: digestOf(1, ['a']),
				hdb_user: from,
			}),
			(error) => error.statusCode === 409 && /not a member of generation 1/.test(error.message)
		);
		assert.strictEqual((await executeTransitionLocally({ database: 'hop4', action: 'survey' })).active, undefined);
	});

	it('writes through the per-node planners: stage retracts active and drains, activate needs the matching stage', async function () {
		this.timeout(MIN_DRAIN_BACKSTOP_MS + 5_000);
		const homes = [self, 'a'];
		const canonical = [...homes].sort();
		const staged = await executeTransition({
			database: 'hop3',
			action: 'stage',
			generation: 1,
			homes,
			quiesce: homes,
			digest: digestOf(1, canonical),
			hdb_user: from,
		});
		assert.deepStrictEqual(staged.staged.homes, canonical);
		assert.deepStrictEqual(staged.quiesced, PROVEN);
		const survey = await executeTransitionLocally({ database: 'hop3', action: 'survey' });
		assert.strictEqual(survey.node, self);
		assert.strictEqual(survey.staged.generation, 1);
		assert.strictEqual(survey.active, undefined);
		// Its own row, not the payload, decides: a generation that was never staged here is refused.
		await assert.rejects(
			executeTransition({
				database: 'hop3',
				action: 'activate',
				generation: 2,
				homes,
				digest: digestOf(2, canonical),
				hdb_user: from,
			}),
			/no matching staged generation 2/
		);
		await delay(MIN_DRAIN_BACKSTOP_MS + 50);
		const activated = await executeTransition({
			database: 'hop3',
			action: 'activate',
			generation: 1,
			homes,
			digest: digestOf(1, canonical),
			hdb_user: from,
		});
		assert.strictEqual(activated.active.generation, 1);
		assert.strictEqual(
			(await executeTransitionLocally({ database: 'hop3', action: 'survey' })).active.digest,
			digestOf(1, canonical)
		);
	});
});
