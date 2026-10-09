/**
 * `build-tools/core-sync-guard.sh` decides whether re-pointing `core` keeps every change the
 * committed pointer has (build-tools/DESIGN.md). Each case builds a throwaway upstream with a
 * `main` and a companion branch and runs the real script against a clone of it.
 */
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guard = join(root, 'build-tools/core-sync-guard.sh');
const syncCore = join(root, 'build-tools/sync-core.sh');

const gitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
	GIT_ALLOW_PROTOCOL: 'file',
};
const git = (cwd, ...args) =>
	execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, env: gitEnv, stdio: 'pipe' })
		.toString()
		.trim();

function runGuard(dir, before, after, env = {}) {
	const result = spawnSync('bash', [guard, dir, before, after], { env: { ...gitEnv, ...env }, encoding: 'utf8' });
	return { status: result.status, stderr: result.stderr };
}

function makeUpstream(tmp) {
	const upstream = join(tmp, 'upstream');
	git(tmp, 'init', '-q', '-b', 'main', upstream);
	const commit = (file, content, message) => {
		writeFileSync(join(upstream, file), content);
		git(upstream, 'add', file);
		git(upstream, 'commit', '-q', '-m', message);
		return git(upstream, 'rev-parse', 'HEAD');
	};
	const shas = {};
	shas.base = commit('Table.txt', 'cursors\n', 'base');
	shas.main1 = commit('other.txt', 'one\n', 'main1');
	git(upstream, 'checkout', '-q', '-b', 'companion', shas.base);
	shas.companion = commit('Table.txt', 'cursors\nfloors\n', 'companion: merge floors');
	git(upstream, 'checkout', '-q', 'main');
	shas.main2 = commit('other.txt', 'one\ntwo\n', 'main2');
	return { upstream, shas };
}

describe('core-sync-guard.sh', function () {
	this.timeout(60_000);
	let tmp;
	let upstream;
	let shas;
	let core;

	before(() => {
		tmp = mkdtempSync(join(tmpdir(), 'core-sync-guard-'));
		({ upstream, shas } = makeUpstream(tmp));
		core = join(tmp, 'core');
		git(tmp, 'clone', '-q', upstream, core);
		git(core, 'fetch', '-q', 'origin', 'companion');
	});

	after(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	it('passes an unchanged pointer and a pointer the tip descends from', () => {
		assert.strictEqual(runGuard(core, shas.main2, shas.main2).status, 0);
		assert.strictEqual(runGuard(core, shas.main1, shas.main2).status, 0);
	});

	it("refuses a tip that lacks the pointer's changes, naming the files it would drop", () => {
		const { status, stderr } = runGuard(core, shas.companion, shas.main2);
		assert.strictEqual(status, 1);
		assert.match(stderr, /core sync refused/);
		assert.match(stderr, /Table\.txt/);
		assert.doesNotMatch(stderr, /other\.txt/);
	});

	it('passes a tip that carries the changes as a squash, and a merge commit of the companion with main', () => {
		const companionTree = git(core, 'rev-parse', `${shas.companion}^{tree}`);
		const mergedTree = git(core, 'merge-tree', '--write-tree', shas.main2, shas.companion).split('\n')[0];
		const squashed = git(core, 'commit-tree', mergedTree, '-p', shas.main2, '-m', 'companion (squashed)');
		const mergeCommit = git(
			core,
			'commit-tree',
			mergedTree,
			'-p',
			shas.companion,
			'-p',
			shas.main2,
			'-m',
			'merge main'
		);
		assert.strictEqual(runGuard(core, shas.companion, squashed).status, 0);
		assert.strictEqual(runGuard(core, mergeCommit, squashed).status, 0);
		assert.notStrictEqual(companionTree, mergedTree);
	});

	it('refuses when merging the pointer into the tip conflicts, since preservation cannot be shown', () => {
		writeFileSync(join(core, 'Table.txt'), 'cursors\nsomething else\n');
		git(core, 'add', 'Table.txt');
		const conflicting = git(core, 'commit-tree', git(core, 'write-tree'), '-p', shas.main2, '-m', 'conflicting');
		git(core, 'reset', '-q', '--hard', 'HEAD');
		const { status, stderr } = runGuard(core, shas.companion, conflicting);
		assert.strictEqual(status, 1);
		assert.match(stderr, /conflicts/);
		assert.match(stderr, /Table\.txt/);
	});

	it('drops the changes only on CORE_SYNC_DROP_CONTENT=true exactly, saying which pointers it moved between', () => {
		assert.strictEqual(runGuard(core, shas.companion, shas.main2, { CORE_SYNC_DROP_CONTENT: 'false' }).status, 1);
		assert.strictEqual(runGuard(core, shas.companion, shas.main2, { CORE_SYNC_DROP_CONTENT: '1' }).status, 1);
		const { status, stderr } = runGuard(core, shas.companion, shas.main2, { CORE_SYNC_DROP_CONTENT: 'true' });
		assert.strictEqual(status, 0);
		assert.match(stderr, new RegExp(`${shas.companion} -> ${shas.main2}`));
	});

	it("refuses a companion that merged with later revisions, unless told its merged pull request's commit", () => {
		// the companion revised the line it added, then was squash-merged: the pointer's exact content is on
		// no tip, and only the merged pull request proves the pointer was superseded rather than dropped
		git(core, 'checkout', '-q', '--detach', shas.companion);
		writeFileSync(join(core, 'Table.txt'), 'cursors\nfloors, revised\n');
		git(core, 'add', 'Table.txt');
		const revisedTree = git(core, 'write-tree');
		git(core, 'reset', '-q', '--hard', shas.main2);
		const revisedMerge = git(core, 'merge-tree', '--write-tree', shas.main2, shas.companion).split('\n')[0];
		const squashedRevision = git(
			core,
			'commit-tree',
			git(
				core,
				'merge-tree',
				'--write-tree',
				shas.main2,
				git(core, 'commit-tree', revisedTree, '-p', shas.base, '-m', 'c2')
			).split('\n')[0],
			'-p',
			shas.main2,
			'-m',
			'companion revised (squashed)'
		);
		assert.notStrictEqual(squashedRevision, revisedMerge);
		assert.strictEqual(runGuard(core, shas.companion, squashedRevision).status, 1);
		const { status, stderr } = runGuard(core, shas.companion, squashedRevision, {
			CORE_SYNC_SUPERSEDED_BY: squashedRevision,
		});
		assert.strictEqual(status, 0);
		assert.match(stderr, /pull request merged as/);
		assert.strictEqual(
			runGuard(core, shas.companion, shas.main2, { CORE_SYNC_SUPERSEDED_BY: squashedRevision }).status,
			1,
			'the tip must contain the merged pull request'
		);
	});

	it('cannot decide on an unknown object and does not pretend the move is safe', () => {
		const { status, stderr } = runGuard(core, shas.companion, '0'.repeat(40));
		assert.strictEqual(status, 2);
		assert.match(stderr, /cannot compare/);
	});

	it('never moves the clone', () => {
		assert.strictEqual(git(core, 'rev-parse', 'HEAD'), shas.main2);
		assert.strictEqual(git(core, 'status', '--porcelain'), '');
	});

	describe('a shallow checkout, as CI makes', () => {
		const shallowClone = (ref) => {
			const dir = join(tmp, `shallow-${ref}`);
			git(tmp, 'clone', '-q', '--depth', '1', '--branch', ref, `file://${upstream}`, dir);
			assert.strictEqual(git(dir, 'rev-parse', '--is-shallow-repository'), 'true');
			git(dir, 'fetch', '-q', 'origin', 'main');
			return dir;
		};

		it('decides a forward move from the fetched history alone', () => {
			git(upstream, 'branch', '-q', 'behind', shas.main1);
			const dir = shallowClone('behind');
			assert.strictEqual(runGuard(dir, shas.main1, git(dir, 'rev-parse', 'FETCH_HEAD')).status, 0);
			assert.strictEqual(git(dir, 'rev-parse', '--is-shallow-repository'), 'true');
		});

		it('deepens only to compare a divergent pointer, then refuses the same way', () => {
			const dir = shallowClone('companion');
			const { status, stderr } = runGuard(dir, shas.companion, git(dir, 'rev-parse', 'FETCH_HEAD'));
			assert.strictEqual(status, 1);
			assert.match(stderr, /Table\.txt/);
			assert.strictEqual(git(dir, 'rev-parse', '--is-shallow-repository'), 'false');
		});
	});
});

describe('sync-core.sh', function () {
	this.timeout(120_000);
	let tmp;
	let upstream;
	let shas;
	let pro;

	before(() => {
		tmp = mkdtempSync(join(tmpdir(), 'sync-core-'));
		({ upstream, shas } = makeUpstream(tmp));
		writeFileSync(join(upstream, 'package.json'), JSON.stringify({ name: 'core', dependencies: { a: '1.0.0' } }));
		writeFileSync(join(upstream, 'package-lock.json'), '{"name":"core"}\n');
		git(upstream, 'add', '.');
		git(upstream, 'commit', '-q', '-m', 'main3: manifest');
		shas.main3 = git(upstream, 'rev-parse', 'HEAD');
		pro = join(tmp, 'pro');
		git(tmp, 'init', '-q', '-b', 'main', pro);
		writeFileSync(join(pro, 'package.json'), JSON.stringify({ name: 'pro', dependencies: { b: '2.0.0' } }));
		git(pro, 'submodule', 'add', '-q', '-b', 'main', `file://${upstream}`, 'core');
		git(join(pro, 'core'), 'fetch', '-q', 'origin', 'companion');
		git(join(pro, 'core'), 'checkout', '-q', '--detach', shas.companion);
		git(pro, 'add', '.');
		git(pro, 'commit', '-q', '-m', 'pin core at the companion');
	});

	after(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	const sync = () => spawnSync('bash', [syncCore, '--skip-install'], { cwd: pro, env: gitEnv, encoding: 'utf8' });

	it('refuses to move core off the companion before touching anything', () => {
		const result = sync();
		assert.notStrictEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stderr, /core sync refused/);
		assert.strictEqual(git(join(pro, 'core'), 'rev-parse', 'HEAD'), shas.companion);
		assert.strictEqual(git(pro, 'status', '--porcelain'), '');
	});

	it('moves core to the tip once main carries the companion, and then copies the manifest', () => {
		git(upstream, 'merge', '-q', '--no-edit', 'companion');
		const tip = git(upstream, 'rev-parse', 'HEAD');
		const result = sync();
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.strictEqual(git(join(pro, 'core'), 'rev-parse', 'HEAD'), tip);
		assert.match(git(pro, 'status', '--porcelain'), /package-lock\.json/);
	});

	it("tracks the superproject's own branch when submodule.core.branch is `.`", () => {
		git(pro, 'checkout', '-q', '-B', 'release', 'main');
		git(upstream, 'checkout', '-q', '-b', 'release');
		writeFileSync(join(upstream, 'other.txt'), 'release\n');
		git(upstream, 'commit', '-q', '-am', 'release-only');
		const releaseTip = git(upstream, 'rev-parse', 'HEAD');
		git(pro, 'submodule', 'set-branch', '--branch', '.', 'core');
		git(pro, 'commit', '-q', '-am', 'track the same-named branch');
		const result = sync();
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.strictEqual(git(join(pro, 'core'), 'rev-parse', 'HEAD'), releaseTip);
	});
});
