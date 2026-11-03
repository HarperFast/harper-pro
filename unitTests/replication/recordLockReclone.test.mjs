/**
 * When a copy marks a database ever-recloned (harper-pro#1236): only when this node holds a
 * record-lock home-map row for it that the clone attempt in flight did not create. Real tables and the
 * real home-map row, written through the same operations an operator calls.
 */
import assert from 'node:assert';
import { table } from '#src/core/resources/databases';
import { currentRow, fenceExternal, stageGeneration } from '#src/replication/recordLockHomes';
import { everRecloned, markReclonedIfLockHistory } from '#src/replication/recordLockPoison';

const operator = { hdb_user: { username: 'op' } };

async function databaseWithOwnWrites(database) {
	const Rows = table({ database, table: 'Rows', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
	// An application's data file is loaded before cloneNode's copy starts, so a first join already has
	// writes of its own in the log.
	await Rows.put({ id: 'seed', n: 1 });
	return Rows;
}

function stage(database) {
	return stageGeneration({ database, generation: 1, homes: ['a'], quiesce: ['a'], ...operator });
}

describe('the ever-recloned flag marks only a copy over earlier record-lock state (harper-pro#1236)', () => {
	let priorAttempt;
	beforeEach(() => {
		priorAttempt = process.env.HARPER_CLONE_ATTEMPT;
		delete process.env.HARPER_CLONE_ATTEMPT;
	});
	afterEach(() => {
		if (priorAttempt === undefined) delete process.env.HARPER_CLONE_ATTEMPT;
		else process.env.HARPER_CLONE_ATTEMPT = priorAttempt;
	});

	it('leaves a first join unflagged: no home-map row, though the database holds writes of its own', async () => {
		await databaseWithOwnWrites('recloneFirstJoin');
		assert.strictEqual(await markReclonedIfLockHistory('recloneFirstJoin', 'attempt-a'), false);
		assert.strictEqual(await markReclonedIfLockHistory('recloneFirstJoin', undefined), false);
		assert.strictEqual(everRecloned('recloneFirstJoin'), false);
	});

	it('leaves a row created during the attempt in flight unflagged', async () => {
		await databaseWithOwnWrites('recloneMidClone');
		process.env.HARPER_CLONE_ATTEMPT = 'attempt-a';
		await stage('recloneMidClone');
		assert.strictEqual((await currentRow('recloneMidClone')).cloneAttempt, 'attempt-a');
		assert.strictEqual(await markReclonedIfLockHistory('recloneMidClone', 'attempt-a'), false);
		assert.strictEqual(everRecloned('recloneMidClone'), false);
	});

	it('flags a copy in a later attempt over a row an earlier attempt created', async () => {
		await databaseWithOwnWrites('recloneLaterAttempt');
		process.env.HARPER_CLONE_ATTEMPT = 'attempt-a';
		await stage('recloneLaterAttempt');
		assert.strictEqual(await markReclonedIfLockHistory('recloneLaterAttempt', 'attempt-b'), true);
		assert.strictEqual(everRecloned('recloneLaterAttempt'), true);
	});

	it('flags a clone over a row created outside any clone, as on an install cloned over', async () => {
		await databaseWithOwnWrites('recloneOverInstall');
		await stage('recloneOverInstall');
		assert.strictEqual((await currentRow('recloneOverInstall')).cloneAttempt, undefined);
		assert.strictEqual(await markReclonedIfLockHistory('recloneOverInstall', 'attempt-b'), true);
		assert.strictEqual(everRecloned('recloneOverInstall'), true);
	});

	it('flags the sharding trigger, which has no attempt, over any row', async () => {
		await databaseWithOwnWrites('recloneSharding');
		process.env.HARPER_CLONE_ATTEMPT = 'attempt-a';
		await stage('recloneSharding');
		assert.strictEqual(await markReclonedIfLockHistory('recloneSharding', undefined), true);
		assert.strictEqual(everRecloned('recloneSharding'), true);
	});

	it('keeps an existing flag and writes nothing new', async () => {
		await databaseWithOwnWrites('recloneAlreadyFlagged');
		await stage('recloneAlreadyFlagged');
		assert.strictEqual(await markReclonedIfLockHistory('recloneAlreadyFlagged', undefined), true);
		assert.strictEqual(await markReclonedIfLockHistory('recloneAlreadyFlagged', undefined), false);
		assert.strictEqual(everRecloned('recloneAlreadyFlagged'), true);
	});

	it('records the creation attempt once: later writes, including ones that build a fresh row, neither move nor backfill it', async () => {
		process.env.HARPER_CLONE_ATTEMPT = 'attempt-a';
		await stage('recloneKeptAttempt');
		process.env.HARPER_CLONE_ATTEMPT = 'attempt-b';
		await fenceExternal({ database: 'recloneKeptAttempt', node: 'c', ...operator });
		await stage('recloneKeptAttempt');
		assert.strictEqual((await currentRow('recloneKeptAttempt')).cloneAttempt, 'attempt-a');

		delete process.env.HARPER_CLONE_ATTEMPT;
		await stage('recloneNoAttempt');
		process.env.HARPER_CLONE_ATTEMPT = 'attempt-b';
		await fenceExternal({ database: 'recloneNoAttempt', node: 'c', ...operator });
		await stage('recloneNoAttempt');
		const row = await currentRow('recloneNoAttempt');
		assert.strictEqual(row.cloneAttempt, undefined);
		assert.strictEqual(row.fenced.length, 1, 'the fence wrote');
	});
});
