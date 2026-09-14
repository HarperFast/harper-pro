/**
 * The replication send path reads this to decide whether it is mid-clone, and from which host
 * (harper-pro#737), so what these pin is that the answer comes off disk on every call — an env-var read
 * would stay latched in a worker thread after the main thread cleared it — and that a marker which
 * cannot name its source authorizes nothing.
 */

import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CLONE_ATTEMPT_FILE,
	CLONE_COMPLETION_GRACE_MS,
	cloneAttemptPath,
	cloneAttemptSource,
	completeCloneAttempt,
	reusableCloneAttemptId,
} from '#src/cloneNode/cloneAttempt';

describe('clone-attempt marker (#737)', () => {
	let rootPath;
	let priorAttempt;
	const writeMarker = (contents) => writeFileSync(cloneAttemptPath(rootPath), contents);

	beforeEach(() => {
		rootPath = mkdtempSync(join(tmpdir(), 'harper-clone-attempt-'));
		priorAttempt = process.env.HARPER_CLONE_ATTEMPT;
		process.env.HARPER_CLONE_ATTEMPT = 'attempt-under-test';
	});

	afterEach(() => {
		rmSync(rootPath, { recursive: true, force: true });
		if (priorAttempt === undefined) delete process.env.HARPER_CLONE_ATTEMPT;
		else process.env.HARPER_CLONE_ATTEMPT = priorAttempt;
	});

	it('has no source with no marker on disk', () => {
		assert.equal(cloneAttemptSource(rootPath), undefined);
	});

	it('reports the host being cloned from while the marker is on disk', () => {
		writeMarker(JSON.stringify({ attemptId: 'abc', leaderHost: 'leader.example' }));
		assert.equal(cloneAttemptSource(rootPath), 'leader.example');
	});

	it('reports the host during the completed-at grace', () => {
		writeMarker(JSON.stringify({ attemptId: 'abc', leaderHost: 'leader.example', completedAt: Date.now() }));
		assert.equal(cloneAttemptSource(rootPath), 'leader.example');
	});

	it('has no source after the completed-at grace', () => {
		writeMarker(
			JSON.stringify({
				attemptId: 'abc',
				leaderHost: 'leader.example',
				completedAt: Date.now() - CLONE_COMPLETION_GRACE_MS,
			})
		);
		assert.equal(cloneAttemptSource(rootPath), undefined);
	});

	it('has no source for a malformed completion time', () => {
		writeMarker(JSON.stringify({ attemptId: 'abc', leaderHost: 'leader.example', completedAt: 'recently' }));
		assert.equal(cloneAttemptSource(rootPath), undefined);
	});

	it('marks an attempt complete without changing its identity', () => {
		writeMarker(JSON.stringify({ attemptId: 'abc', leaderHost: 'leader.example' }));
		completeCloneAttempt(rootPath, 1234);
		assert.deepEqual(JSON.parse(readFileSync(cloneAttemptPath(rootPath), 'utf8')), {
			attemptId: 'abc',
			leaderHost: 'leader.example',
			completedAt: 1234,
		});
	});

	it('reuses only an unfinished attempt for the same leader', () => {
		assert.equal(reusableCloneAttemptId({ attemptId: 'abc', leaderHost: 'leader.example' }, 'leader.example'), 'abc');
		assert.equal(
			reusableCloneAttemptId(
				{ attemptId: 'abc', leaderHost: 'leader.example', completedAt: Date.now() },
				'leader.example'
			),
			undefined
		);
		assert.equal(
			reusableCloneAttemptId({ attemptId: 'abc', leaderHost: 'other.example' }, 'leader.example'),
			undefined
		);
	});

	it('stops reporting a source the moment the marker is removed', () => {
		writeMarker(JSON.stringify({ attemptId: 'abc', leaderHost: 'leader.example' }));
		rmSync(cloneAttemptPath(rootPath));
		assert.equal(cloneAttemptSource(rootPath), undefined);
	});

	it('has no source for a marker that does not name one', () => {
		writeMarker(JSON.stringify({ attemptId: 'abc' }));
		assert.equal(cloneAttemptSource(rootPath), undefined);
	});

	it('has no source for an unreadable marker', () => {
		writeMarker('{ not json');
		assert.equal(cloneAttemptSource(rootPath), undefined);
	});

	it('has no source when no root path is configured', () => {
		assert.equal(cloneAttemptSource(undefined), undefined);
	});

	it('has no source outside a clone run, however stale the marker on disk', () => {
		// A `harper run` restart never enters the clone path, so a marker left by a killed clone must not
		// authorize withholding for the life of the install.
		writeMarker(JSON.stringify({ attemptId: 'abc', leaderHost: 'leader.example' }));
		delete process.env.HARPER_CLONE_ATTEMPT;
		assert.equal(cloneAttemptSource(rootPath), undefined);
	});

	it('places the marker in the root path', () => {
		assert.equal(cloneAttemptPath(rootPath), join(rootPath, CLONE_ATTEMPT_FILE));
	});
});
