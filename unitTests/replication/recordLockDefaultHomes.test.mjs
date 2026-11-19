/**
 * The cluster default home map (harper-pro#1452): precedence between a database's own row and the default,
 * the digest scope that keeps the two from agreeing, a database's first own map planned against the default
 * it inherited, the default stage's drain set and its aggregation, and the markers a default activation
 * writes. The `on a real table` cases drive the real `hdb_record_lock_homes` row and remove the default row
 * afterwards, since every later test in this process would otherwise inherit it.
 */
import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
// Loaded first, as the other record-lock suites do: it closes the module cycle the others enter through.
import '#src/replication/recordLockTransport';
import {
	DEFAULT_HOMES_KEY,
	MAX_EXPLICIT_DATABASES,
	MIN_DRAIN_BACKSTOP_MS,
	activateGeneration,
	currentRow,
	digestFor,
	digestOf,
	drainInheriting,
	fenceExternal,
	getRecordLockHomesTable,
	inheritedFrom,
	ownRow,
	planStage,
	rowKeyOf,
	setHomesDrainCandidates,
	setHomesDrainReader,
	stageGeneration,
	validateExplicit,
} from '#src/replication/recordLockHomes';
import { planSurvey } from '#src/replication/recordLockApply';
import {
	cachedActiveGeneration,
	createDisabledRecordLockTransport,
	ensureRecordLockTransport,
	homeMapSourceOf,
	releaseRecordLockTransport,
} from '#src/replication/recordLockTransport';

const defaultRow = (state) => ({ database: DEFAULT_HOMES_KEY, highestActedOn: 3, fenced: [], ...state });
const ring = (generation, homes, key = DEFAULT_HOMES_KEY) => ({
	generation,
	homes,
	digest: digestFor(key, generation, homes),
});

describe('the default home map: keys and digests', () => {
	it('scopes the default digest, so an inheriting database never agrees with an own row of the same ring', () => {
		assert.notStrictEqual(digestFor(DEFAULT_HOMES_KEY, 1, ['a', 'b']), digestOf(1, ['a', 'b']));
		assert.strictEqual(digestFor('data', 1, ['a', 'b']), digestOf(1, ['a', 'b']), 'per-database digests are unchanged');
	});

	it('addresses exactly one row: a database, or the default with default: true', () => {
		assert.strictEqual(rowKeyOf({ database: 'data' }), 'data');
		assert.strictEqual(rowKeyOf({ default: true }), DEFAULT_HOMES_KEY);
		assert.throws(() => rowKeyOf({}), /exactly one/);
		assert.throws(() => rowKeyOf({ database: 'data', default: true }), /exactly one/);
		assert.throws(() => rowKeyOf({ default: false }), /must be true/);
		assert.throws(() => rowKeyOf({ database: DEFAULT_HOMES_KEY }), /reserved/);
	});

	it('bounds and canonicalizes the databases a default activation marks', () => {
		assert.deepStrictEqual(validateExplicit(['b', 'a', 'b']), ['a', 'b']);
		assert.deepStrictEqual(validateExplicit(undefined), []);
		assert.throws(() => validateExplicit([DEFAULT_HOMES_KEY]), /must not name/);
		assert.throws(() => validateExplicit(['']), /non-empty/);
		assert.throws(() => validateExplicit('data'), /array/);
		assert.throws(() => validateExplicit(new Array(MAX_EXPLICIT_DATABASES + 1).fill('x')), /at most/);
	});
});

describe('a first own map, planned against the inherited default', () => {
	const inherited = inheritedFrom('data', defaultRow({ active: ring(3, ['a', 'b']) }));

	it('keeps the default fields and drops its fences', () => {
		assert.strictEqual(inherited.inherited, true);
		assert.strictEqual(inherited.active.generation, 3);
		assert.deepStrictEqual(inherited.fenced, []);
	});

	it('must name a generation above the default it was served under', () => {
		const plan = planStage(inherited, 'data', 3, ['a'], digestOf(3, ['a']), 0, ['a', 'b']);
		assert.strictEqual(plan.action, 'reject');
		assert.match(plan.reason, /not greater than 3/);
	});

	it('must quiesce every node of the default ring it stops inheriting', () => {
		const plan = planStage(inherited, 'data', 4, ['a'], digestOf(4, ['a']), 0, ['a']);
		assert.strictEqual(plan.action, 'reject');
		assert.match(plan.reason, /missing b/);
	});

	it('writes a row of its own, with no inherited marker and none of the default fences', () => {
		const plan = planStage(inherited, 'data', 4, ['a'], digestOf(4, ['a']), 7, ['a', 'b']);
		assert.strictEqual(plan.action, 'write');
		assert.strictEqual(plan.row.inherited, undefined);
		assert.strictEqual(plan.row.active, undefined);
		assert.deepStrictEqual(plan.row.fenced, []);
		assert.deepStrictEqual(plan.row.staged, {
			generation: 4,
			homes: ['a'],
			digest: digestOf(4, ['a']),
			stagedAt: 7,
			quiesce: ['a', 'b'],
		});
		assert.strictEqual(plan.row.highestActedOn, 4);
	});

	it('is refused while the default is staged on this node, whatever it covers', () => {
		const staged = inheritedFrom(
			'data',
			defaultRow({ staged: { ...ring(4, ['a']), quiesce: ['a', 'b'] }, highestActedOn: 4 })
		);
		const plan = planStage(staged, 'data', 9, ['a'], digestOf(9, ['a']), 0, ['a', 'b']);
		assert.strictEqual(plan.action, 'reject');
		assert.match(plan.reason, /default home map is staged at generation 4/);
	});
});

describe('planSurvey over databases that inherit the default', () => {
	const reply = (node, extra = {}) => ({
		node,
		active: ring(3, ['a', 'b', 'c']),
		highestActedOn: 3,
		inherited: true,
		supportsFenced: true,
		...extra,
	});

	it('refuses a list that leaves out a member of the default ring the database inherits', () => {
		const replies = new Map([
			['a', reply('a')],
			['b', reply('b')],
		]);
		const plan = planSurvey('data', ['a', 'b'], ['a', 'b'], undefined, replies);
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /c \(in a's ring\)/);
	});

	it("opens a generation past the default's, never resuming it even for the same homes", () => {
		const replies = new Map(['a', 'b', 'c'].map((node) => [node, reply(node)]));
		const plan = planSurvey('data', ['a', 'b', 'c'], ['a', 'b', 'c'], undefined, replies);
		assert.strictEqual(plan.action, 'proceed');
		assert.strictEqual(plan.generation, 4);
		assert.strictEqual(plan.digest, digestOf(4, ['a', 'b', 'c']));
	});

	it('refuses while a surveyed node has the default staged', () => {
		const staged = {
			node: 'a',
			staged: { ...ring(4, ['a', 'b']), quiesce: ['a', 'b'] },
			highestActedOn: 4,
			inherited: true,
		};
		const replies = new Map([
			['a', staged],
			['b', { ...staged, node: 'b' }],
		]);
		const plan = planSurvey('data', ['a', 'b'], ['a', 'b'], undefined, replies);
		assert.strictEqual(plan.action, 'refuse');
		assert.match(plan.reason, /default home map is staged/);
	});
});

describe('the default stage drains every inheriting database', () => {
	const clean = { complete: true, surrendered: 1, recalled: 1, outstanding: [] };

	it('an empty set is a complete drain, and an unwired candidate list is not', async () => {
		assert.deepStrictEqual(await drainInheriting([], [], async () => clean), {
			complete: true,
			surrendered: 0,
			recalled: 0,
			outstanding: [],
		});
		assert.ok((await drainInheriting(undefined)).error);
	});

	it('proves only if every database proves, and keeps the totals and entries', async () => {
		const results = {
			x: clean,
			y: { complete: true, surrendered: 0, recalled: 0, outstanding: [{ table: 't', key: 1, reason: 'held' }] },
		};
		const aggregate = await drainInheriting(['x', 'y'], [], async (database) => results[database]);
		assert.strictEqual(aggregate.complete, false);
		assert.strictEqual(aggregate.surrendered, 1);
		assert.deepStrictEqual(
			aggregate.outstanding.map((entry) => entry.table),
			['y.t', 'y.*']
		);
	});

	it('a database whose drain threw, or answered nothing usable, is unproven', async () => {
		for (const failing of [
			() => Promise.reject(new Error('owner gone')),
			async () => ({ error: 'no owner' }),
			async () => null,
		]) {
			const aggregate = await drainInheriting(['x', 'y'], [], (database) =>
				database === 'x' ? failing() : Promise.resolve(clean)
			);
			assert.strictEqual(aggregate.complete, false);
			assert.ok(aggregate.outstanding.some((entry) => entry.table === 'x.*' && entry.delegate === undefined));
		}
	});

	it('a recall to a fenced delegate is excused per database, and nothing else is', async () => {
		const fencedRecall = {
			complete: false,
			surrendered: 0,
			recalled: 0,
			outstanding: [{ table: 't', key: 1, delegate: 'gone', reason: 'recall' }],
		};
		const incomplete = { complete: false, surrendered: 0, recalled: 0, outstanding: [] };
		const excused = await drainInheriting(['x'], ['gone'], async () => fencedRecall);
		assert.strictEqual(excused.complete, false);
		assert.deepStrictEqual(
			excused.outstanding.map((entry) => entry.table),
			['x.t']
		);
		const hidden = await drainInheriting(['x', 'y'], ['gone'], async (database) =>
			database === 'x' ? fencedRecall : incomplete
		);
		assert.ok(
			hidden.outstanding.some((entry) => entry.table === 'y.*'),
			'an incomplete drain is not hidden behind another database fenced recall'
		);
	});
});

describe('the default row, on a real table', function () {
	this.timeout(20_000);
	const operator = { hdb_user: { username: 'op' } };
	const drained = [];
	const registered = ['inh-a', 'own-b', 'inh-c', 'inh-d'];

	before(async () => {
		setHomesDrainReader(async (database) => {
			drained.push(database);
			return { complete: true, surrendered: 0, recalled: 0, outstanding: [] };
		});
		setHomesDrainCandidates(async () => ['inh-a', 'own-b']);
		for (const database of registered) ensureRecordLockTransport(database, () => createDisabledRecordLockTransport());
		await stageGeneration({ database: 'own-b', generation: 1, homes: ['n1'], quiesce: ['n1'], ...operator });
		drained.length = 0;
	});

	after(async () => {
		await getRecordLockHomesTable().delete(DEFAULT_HOMES_KEY);
		for (const database of registered) releaseRecordLockTransport(database);
		setHomesDrainReader(async () => ({ error: 'no record lock drain is wired on this node' }));
		setHomesDrainCandidates(async () => undefined);
	});

	it('staging the default drains exactly the candidates with no row of their own, and reports the rest', async () => {
		const result = await stageGeneration({
			default: true,
			generation: 1,
			homes: ['n1', 'n2'],
			quiesce: ['n1', 'n2'],
			explicit: ['elsewhere'],
			...operator,
		});
		assert.deepStrictEqual(drained, ['inh-a']);
		assert.deepStrictEqual(result.quiesced, { complete: true, surrendered: 0, recalled: 0, outstanding: [] });
		assert.ok(result.explicit.includes('own-b'));
		assert.ok(!result.explicit.includes('inh-a'));
		assert.deepStrictEqual(result.staged.explicit, ['elsewhere'], 'the survey union is kept for a later activation');
		const row = await currentRow('inh-a');
		assert.strictEqual(row.inherited, true);
		assert.strictEqual(row.active, undefined);
		assert.strictEqual(row.staged.generation, 1);
		assert.strictEqual(homeMapSourceOf('inh-a'), 'default');
		assert.strictEqual(cachedActiveGeneration('inh-a'), undefined);
	});

	it('refuses a first own map while the default is staged here', async () => {
		await assert.rejects(
			stageGeneration({ database: 'inh-c', generation: 5, homes: ['n1', 'n2'], quiesce: ['n1', 'n2'], ...operator }),
			/default home map is staged/
		);
		assert.strictEqual(await ownRow('inh-c'), undefined);
	});

	it('activating it marks the databases with rows of their own elsewhere, then every database without one inherits', async () => {
		await delay(MIN_DRAIN_BACKSTOP_MS + 100);
		await activateGeneration({ default: true, generation: 1, homes: ['n1', 'n2'], explicit: ['marked'], ...operator });
		for (const database of ['marked', 'elsewhere']) {
			const marker = await ownRow(database);
			assert.strictEqual(marker.highestActedOn, 1, database);
			assert.strictEqual(marker.active, undefined, database);
			assert.strictEqual(marker.staged, undefined, database);
		}
		assert.strictEqual((await ownRow('own-b')).staged.generation, 1, 'an own row is never replaced by a marker');
		const row = await currentRow('inh-a');
		assert.strictEqual(row.inherited, true);
		assert.deepStrictEqual(row.active.homes, ['n1', 'n2']);
		assert.strictEqual(row.active.digest, digestFor(DEFAULT_HOMES_KEY, 1, ['n1', 'n2']));
		assert.strictEqual(cachedActiveGeneration('inh-a'), 1, 'the default fan-out refreshed every registered database');
		assert.strictEqual(homeMapSourceOf('inh-a'), 'default');
		assert.strictEqual(cachedActiveGeneration('own-b'), undefined);
		assert.strictEqual(homeMapSourceOf('own-b'), 'database');
		assert.strictEqual(
			(await currentRow('marked')).inherited,
			undefined,
			'a marker detaches the database from the default'
		);
	});

	it('a first own map must cover the default ring and name a generation above it', async () => {
		await assert.rejects(
			stageGeneration({ database: 'inh-d', generation: 2, homes: ['n1'], quiesce: ['n1'], ...operator }),
			/missing n2/
		);
		await assert.rejects(
			stageGeneration({ database: 'inh-d', generation: 1, homes: ['n1'], quiesce: ['n1', 'n2'], ...operator }),
			/not greater than 1/
		);
		const { staged } = await stageGeneration({
			database: 'inh-d',
			generation: 2,
			homes: ['n1'],
			quiesce: ['n1', 'n2'],
			...operator,
		});
		assert.strictEqual(staged.generation, 2);
		assert.strictEqual((await ownRow('inh-d')).staged.generation, 2);
		assert.strictEqual(homeMapSourceOf('inh-d'), 'database');
	});

	it('records a fence for an inheriting database on the default, never as a first row of its own', async () => {
		await assert.rejects(
			fenceExternal({ database: 'inh-c', node: 'gone', ...operator }),
			/follows the default home map/
		);
		assert.strictEqual(await ownRow('inh-c'), undefined);
		await fenceExternal({ default: true, node: 'gone', ...operator });
		assert.deepStrictEqual(
			(await ownRow(DEFAULT_HOMES_KEY)).fenced.map((entry) => entry.node),
			['gone']
		);
	});
});
