import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function runGuard(dir, before, after) {
	const result = spawnSync('bash', [guard, dir, before, after], { env: gitEnv, encoding: 'utf8' });
	return { status: result.status, warning: result.stdout };
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

	it('is silent on an unchanged pointer and on a pointer the tip descends from', () => {
		assert.deepStrictEqual(runGuard(core, shas.main2, shas.main2), { status: 0, warning: '' });
		assert.deepStrictEqual(runGuard(core, shas.main1, shas.main2), { status: 0, warning: '' });
	});

	it("warns, without failing, when the tip lacks the pointer's changes, naming the commits and files it drops", () => {
		const { status, warning } = runGuard(core, shas.companion, shas.main2);
		assert.strictEqual(status, 0);
		assert.match(warning, /may drop changes/);
		assert.match(warning, /companion: merge floors/);
		assert.match(warning, /Table\.txt \| 1 \+/);
		assert.doesNotMatch(warning, /other\.txt/);
	});

	it('is silent on a tip that carries the changes as a squash, and on a merge commit of the companion with main', () => {
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
		assert.deepStrictEqual(runGuard(core, shas.companion, squashed), { status: 0, warning: '' });
		assert.deepStrictEqual(runGuard(core, mergeCommit, squashed), { status: 0, warning: '' });
		assert.notStrictEqual(companionTree, mergedTree);
	});

	it('warns when merging the pointer into the tip conflicts, since preservation cannot be shown', () => {
		writeFileSync(join(core, 'Table.txt'), 'cursors\nsomething else\n');
		git(core, 'add', 'Table.txt');
		const conflicting = git(core, 'commit-tree', git(core, 'write-tree'), '-p', shas.main2, '-m', 'conflicting');
		git(core, 'reset', '-q', '--hard', 'HEAD');
		const { status, warning } = runGuard(core, shas.companion, conflicting);
		assert.strictEqual(status, 0);
		assert.match(warning, /conflicts/);
		assert.match(warning, /Table\.txt/);
	});

	it('warns, without failing, on a companion that merged with later revisions to its own lines', () => {
		// the pointer's exact content is on no tip once the companion revised its own lines before merging
		git(core, 'checkout', '-q', '--detach', shas.companion);
		writeFileSync(join(core, 'Table.txt'), 'cursors\nfloors, revised\n');
		git(core, 'add', 'Table.txt');
		const revised = git(core, 'commit-tree', git(core, 'write-tree'), '-p', shas.base, '-m', 'companion revised');
		git(core, 'reset', '-q', '--hard', shas.main2);
		const squashedRevision = git(
			core,
			'commit-tree',
			git(core, 'merge-tree', '--write-tree', shas.main2, revised).split('\n')[0],
			'-p',
			shas.main2,
			'-m',
			'companion revised (squashed)'
		);
		const { status, warning } = runGuard(core, shas.companion, squashedRevision);
		assert.strictEqual(status, 0);
		assert.match(warning, /companion: merge floors/);
		assert.match(warning, /Table\.txt/);
	});

	it('warns that it cannot decide on an unknown object rather than calling the move safe', () => {
		const { status, warning } = runGuard(core, shas.companion, '0'.repeat(40));
		assert.strictEqual(status, 0);
		assert.match(warning, /could not be determined/);
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
			assert.deepStrictEqual(runGuard(dir, shas.main1, git(dir, 'rev-parse', 'FETCH_HEAD')), {
				status: 0,
				warning: '',
			});
			assert.strictEqual(git(dir, 'rev-parse', '--is-shallow-repository'), 'true');
		});

		it('deepens only to compare a divergent pointer, then warns the same way', () => {
			const dir = shallowClone('companion');
			const { status, warning } = runGuard(dir, shas.companion, git(dir, 'rev-parse', 'FETCH_HEAD'));
			assert.strictEqual(status, 0);
			assert.match(warning, /Table\.txt/);
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

	const warningFile = () => join(tmp, 'core-sync-warning.md');
	const sync = () =>
		spawnSync('bash', [syncCore, '--skip-install'], {
			cwd: pro,
			env: { ...gitEnv, CORE_SYNC_WARNING_FILE: warningFile() },
			encoding: 'utf8',
		});

	it('moves core off the companion to the fetched tip anyway, writing the warning for the PR body', () => {
		const result = sync();
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.strictEqual(git(join(pro, 'core'), 'rev-parse', 'HEAD'), shas.main3);
		const warning = readFileSync(warningFile(), 'utf8');
		assert.match(warning, /may drop changes/);
		assert.match(warning, /Table\.txt/);
		assert.match(result.stderr, /may drop changes/);
		git(pro, 'checkout', '--', 'package.json');
		git(pro, 'submodule', 'update', '-q', 'core');
		rmSync(join(pro, 'package-lock.json'));
	});

	it('moves core to the tip once main carries the companion without a warning, and then copies the manifest', () => {
		git(upstream, 'merge', '-q', '--no-edit', 'companion');
		const tip = git(upstream, 'rev-parse', 'HEAD');
		const result = sync();
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.strictEqual(readFileSync(warningFile(), 'utf8'), '');
		assert.strictEqual(git(join(pro, 'core'), 'rev-parse', 'HEAD'), tip);
		assert.match(git(pro, 'status', '--porcelain'), /package-lock\.json/);
	});

	it('initializes a submodule a plain clone left empty before syncing it', () => {
		const clone = join(tmp, 'pro-clone');
		git(tmp, 'clone', '-q', `file://${pro}`, clone);
		assert.strictEqual(git(clone, 'submodule', 'status').trim()[0], '-', 'core starts uninitialized');
		const result = spawnSync('bash', [syncCore, '--skip-install'], {
			cwd: clone,
			env: { ...gitEnv, CORE_SYNC_WARNING_FILE: join(tmp, 'missing-dir', 'warning.md') },
			encoding: 'utf8',
		});
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stderr, /could not write/, 'an unwritable warning file does not stop the sync');
		assert.strictEqual(git(join(clone, 'core'), 'rev-parse', 'HEAD'), git(upstream, 'rev-parse', 'main'));
		git(clone, 'checkout', '--', 'package.json');
		git(clone, 'submodule', 'deinit', '-f', 'core');
		const afterDeinit = spawnSync('bash', [syncCore, '--skip-install'], { cwd: clone, env: gitEnv, encoding: 'utf8' });
		assert.notStrictEqual(afterDeinit.status, 0, 'a deinitialized core is not re-initialized');
		assert.match(afterDeinit.stderr, /deinitialized/);
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
