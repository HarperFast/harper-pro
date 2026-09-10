/**
 * The replication send path reads this to decide whether it is mid-clone, and from which host
 * (harper-pro#737), so what these pin is that the answer comes off disk on every call — an env-var read
 * would stay latched in a worker thread after the main thread cleared it — and that a marker which
 * cannot name its source authorizes nothing.
 */

import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneAttemptSource, cloneAttemptPath, CLONE_ATTEMPT_FILE } from '#src/cloneNode/cloneAttempt';

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
		expect(cloneAttemptSource(rootPath)).to.equal(undefined);
	});

	it('reports the host being cloned from while the marker is on disk', () => {
		writeMarker(JSON.stringify({ attemptId: 'abc', leaderHost: 'leader.example' }));
		expect(cloneAttemptSource(rootPath)).to.equal('leader.example');
	});

	it('stops reporting a source the moment the marker is removed', () => {
		writeMarker(JSON.stringify({ attemptId: 'abc', leaderHost: 'leader.example' }));
		rmSync(cloneAttemptPath(rootPath));
		expect(cloneAttemptSource(rootPath)).to.equal(undefined);
	});

	it('has no source for a marker that does not name one', () => {
		writeMarker(JSON.stringify({ attemptId: 'abc' }));
		expect(cloneAttemptSource(rootPath)).to.equal(undefined);
	});

	it('has no source for an unreadable marker', () => {
		writeMarker('{ not json');
		expect(cloneAttemptSource(rootPath)).to.equal(undefined);
	});

	it('has no source when no root path is configured', () => {
		expect(cloneAttemptSource(undefined)).to.equal(undefined);
	});

	it('has no source outside a clone run, however stale the marker on disk', () => {
		// A `harper run` restart never enters the clone path, so a marker left by a killed clone must not
		// authorize withholding for the life of the install.
		writeMarker(JSON.stringify({ attemptId: 'abc', leaderHost: 'leader.example' }));
		delete process.env.HARPER_CLONE_ATTEMPT;
		expect(cloneAttemptSource(rootPath)).to.equal(undefined);
	});

	it('places the marker in the root path', () => {
		expect(cloneAttemptPath(rootPath)).to.equal(join(rootPath, CLONE_ATTEMPT_FILE));
	});
});
