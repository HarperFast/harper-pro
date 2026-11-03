/**
 * When a copy sets the ever-recloned flag (harper-pro#1236), over real tables and the real home-map
 * row written through the operator's own operations.
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { table } from '#src/core/resources/databases';
import * as env from '#src/core/utility/environment/environmentManager';
import { CONFIG_PARAMS } from '#src/core/utility/hdbTerms';
import { cloneAttemptPath } from '#src/cloneNode/cloneAttempt';
import { currentRow, fenceExternal, stageGeneration } from '#src/replication/recordLockHomes';
import { everRecloned, markReclonedIfLockHistory } from '#src/replication/recordLockPoison';

const operator = { hdb_user: { username: 'op' } };

async function databaseWithOwnWrites(database) {
	const Rows = table({ database, table: 'Rows', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
	// cloneNode loads an application's data files before its copy starts
	await Rows.put({ id: 'seed', n: 1 });
	return Rows;
}

function stage(database) {
	return stageGeneration({ database, generation: 1, homes: ['a'], quiesce: ['a'], ...operator });
}

describe('the ever-recloned flag marks only a copy over earlier record-lock state (harper-pro#1236)', () => {
	let rootPath;
	let priorRootPath;
	let priorAttempt;

	function inAttempt(attemptId) {
		process.env.HARPER_CLONE_ATTEMPT = attemptId;
		writeFileSync(cloneAttemptPath(rootPath), JSON.stringify({ attemptId, leaderHost: 'leader.example' }));
	}
	function attemptRetired() {
		rmSync(cloneAttemptPath(rootPath), { force: true });
	}

	beforeEach(() => {
		rootPath = mkdtempSync(join(tmpdir(), 'harper-reclone-'));
		priorRootPath = env.get(CONFIG_PARAMS.ROOTPATH);
		env.setProperty(CONFIG_PARAMS.ROOTPATH, rootPath);
		priorAttempt = process.env.HARPER_CLONE_ATTEMPT;
		delete process.env.HARPER_CLONE_ATTEMPT;
	});
	afterEach(() => {
		env.setProperty(CONFIG_PARAMS.ROOTPATH, priorRootPath);
		rmSync(rootPath, { recursive: true, force: true });
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
		inAttempt('attempt-a');
		await stage('recloneMidClone');
		assert.strictEqual((await currentRow('recloneMidClone')).cloneAttempt, 'attempt-a');
		assert.strictEqual(await markReclonedIfLockHistory('recloneMidClone', 'attempt-a'), false);
		assert.strictEqual(everRecloned('recloneMidClone'), false);
	});

	it('flags a copy in a later attempt over a row an earlier attempt created', async () => {
		await databaseWithOwnWrites('recloneLaterAttempt');
		inAttempt('attempt-a');
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

	it('does not tag a row created after the attempt retired, though the variable lingers in this worker', async () => {
		await databaseWithOwnWrites('recloneAfterRetire');
		inAttempt('attempt-a');
		attemptRetired();
		await stage('recloneAfterRetire');
		assert.strictEqual((await currentRow('recloneAfterRetire')).cloneAttempt, undefined);
	});

	it('flags a sharding recovery, which passes no attempt, over any row, even one the live attempt created', async () => {
		await databaseWithOwnWrites('recloneSharding');
		inAttempt('attempt-a');
		await stage('recloneSharding');
		assert.strictEqual(await markReclonedIfLockHistory('recloneSharding', undefined), true);
		assert.strictEqual(everRecloned('recloneSharding'), true);
	});

	it('keeps answering true for a flag already set, so every copy repeats the durability barrier', async () => {
		await databaseWithOwnWrites('recloneAlreadyFlagged');
		await stage('recloneAlreadyFlagged');
		assert.strictEqual(await markReclonedIfLockHistory('recloneAlreadyFlagged', undefined), true);
		assert.strictEqual(await markReclonedIfLockHistory('recloneAlreadyFlagged', 'attempt-a'), true);
		assert.strictEqual(everRecloned('recloneAlreadyFlagged'), true);
	});

	it('records the creation attempt once: later writes, including ones that build a fresh row, neither move nor backfill it', async () => {
		inAttempt('attempt-a');
		await stage('recloneKeptAttempt');
		inAttempt('attempt-b');
		await fenceExternal({ database: 'recloneKeptAttempt', node: 'c', ...operator });
		await stage('recloneKeptAttempt');
		assert.strictEqual((await currentRow('recloneKeptAttempt')).cloneAttempt, 'attempt-a');

		delete process.env.HARPER_CLONE_ATTEMPT;
		await stage('recloneNoAttempt');
		inAttempt('attempt-b');
		await fenceExternal({ database: 'recloneNoAttempt', node: 'c', ...operator });
		await stage('recloneNoAttempt');
		const row = await currentRow('recloneNoAttempt');
		assert.strictEqual(row.cloneAttempt, undefined);
		assert.strictEqual(row.fenced.length, 1, 'the fence wrote');
	});
});
