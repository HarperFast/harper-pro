import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scriptPath = join(root, 'scripts/patch-release.js');
const { milestoneTargetsRelease, isPRPresent, backportVerificationApplies, evaluateWorkflowRuns } = createRequire(
	import.meta.url
)(scriptPath);

describe('patch-release milestone backport verification', function () {
	it('rejects obsolete label selection with milestone guidance', function () {
		const r = spawnSync(process.execPath, [scriptPath, '--label', 'patch', '--json'], {
			encoding: 'utf8',
			timeout: 5000,
			env: { ...process.env, PATH: '' },
		});
		assert.equal(r.status, 1);
		const result = JSON.parse(r.stdout.trim().slice('RESULT: '.length));
		assert.match(result.error, /--label.*milestones/);
	});

	describe('milestoneTargetsRelease', function () {
		for (const [milestone, line, expected] of [
			['v5.1', 'v5.1', true],
			['v5.1', 'v5.2', true],
			['v5.2.5', 'v5.2', true],
			['v5.2.0-beta.1', 'v5.3', true],
			['v5.2', 'v5.1', false],
			['v5.1', 'v6.0', false],
			['v4.9', 'v5.1', false],
			['v5.10', 'v5.9', false],
			['Other work', 'v5.1', false],
			[null, 'v5.1', false],
		]) {
			it(`${milestone} targets ${line}: ${expected}`, function () {
				assert.equal(milestoneTargetsRelease(milestone, line), expected);
			});
		}
	});

	describe('backportVerificationApplies', function () {
		it('does not apply when the release branch is the source branch', function () {
			assert.equal(backportVerificationApplies('main', 'main'), false);
		});

		it('applies to a release branch cut from the source branch', function () {
			assert.equal(backportVerificationApplies('v5.3', 'main'), true);
			assert.equal(backportVerificationApplies('rc/5.3.1-core', 'main'), true);
		});
	});

	describe('evaluateWorkflowRuns', function () {
		// Rows shaped like the script's projections of the REST workflow-runs and jobs responses.
		let runId = 0;
		const job = (name, conclusion = 'success', status = 'completed') => ({
			name,
			status,
			conclusion: status === 'completed' ? conclusion : null,
			html_url: `https://github.com/HarperFast/harper/actions/runs/1/job/${name.length}`,
		});
		const run = (run_number, jobs, extra = {}) => ({
			id: ++runId,
			run_number,
			event: 'push',
			status: 'completed',
			conclusion: jobs.every((j) => j.conclusion === 'success' || j.conclusion === 'skipped') ? 'success' : 'failure',
			html_url: `https://github.com/HarperFast/harper/actions/runs/${runId}`,
			jobs,
			...extra,
		});
		const states = (runs) => evaluateWorkflowRuns(runs).blocking.map((b) => [b.job ?? null, b.state]);

		it('is green when every job of the only run passed or was skipped', function () {
			assert.deepEqual(states([run(1, [job('Unit Test (Node.js v22)'), job('Docs', 'skipped')])]), []);
			assert.equal(evaluateWorkflowRuns([run(1, [job('a'), job('b')])]).jobCount, 2);
		});

		it('reports missing when no run exists', function () {
			assert.deepEqual(states([]), [[null, 'missing']]);
		});

		it('ignores pull_request runs, which test the merge ref rather than the commit', function () {
			assert.deepEqual(states([run(1, [job('a')], { event: 'pull_request' })]), [[null, 'missing']]);
		});

		it('blocks on each failed or cancelled job', function () {
			assert.deepEqual(states([run(1, [job('v22', 'failure'), job('v24'), job('v26', 'cancelled')])]), [
				['v22', 'failure'],
				['v26', 'cancelled'],
			]);
		});

		it('blocks while the latest run is still running instead of using an older success', function () {
			assert.deepEqual(
				states([
					run(1, [job('a')]),
					run(2, [job('a', null, 'in_progress')], { status: 'in_progress', conclusion: null }),
				]),
				[[null, 'in_progress']]
			);
		});

		it('lets a later run of the same job supersede a flaky failure', function () {
			assert.deepEqual(states([run(7, [job('v22', 'failure'), job('v24')]), run(8, [job('v22'), job('v24')])]), []);
		});

		it('blocks when the latest run of a job failed after an earlier success', function () {
			assert.deepEqual(states([run(7, [job('v22'), job('v24')]), run(8, [job('v22', 'failure'), job('v24')])]), [
				['v22', 'failure'],
			]);
		});

		it('orders by run_number, not by response order', function () {
			assert.deepEqual(states([run(8, [job('v22')]), run(7, [job('v22', 'failure')])]), []);
		});

		it('does not let a narrower later run mask a job that failed in an earlier full run', function () {
			const full = run(10, [job('Unit Test (Node.js v22)', 'failure'), job('Unit Test (Node.js v24)')]);
			const narrow = run(11, [job('Unit Test (Node.js v24)')], { event: 'workflow_dispatch' });
			assert.deepEqual(states([full, narrow]), [['Unit Test (Node.js v22)', 'failure']]);
		});

		it('blocks on a run that failed without any jobs', function () {
			assert.deepEqual(states([run(1, [job('a')]), run(2, [], { conclusion: 'startup_failure' })]), [
				[null, 'startup_failure'],
			]);
		});

		it('rejects a run without a numeric run_number', function () {
			assert.throws(() => evaluateWorkflowRuns([run('7', [job('a')])]), /Invalid run_number/);
		});
	});

	describe('isPRPresent', function () {
		const sha = 'a'.repeat(40);
		const other = 'b'.repeat(40);
		const pr = { mergeCommit: { oid: sha, patchId: 'patch-a' } };
		const evidence = (extra = {}) => ({
			commitShas: new Set(),
			cherryPickedShas: new Set(),
			patchIds: new Set(),
			...extra,
		});

		it('accepts a reachable merge commit', function () {
			assert.equal(isPRPresent(pr, evidence({ commitShas: new Set([sha]) })), true);
		});

		it('accepts an exact cherry-pick trailer', function () {
			assert.equal(isPRPresent(pr, evidence({ cherryPickedShas: new Set([sha]) })), true);
			assert.equal(isPRPresent(pr, evidence({ cherryPickedShas: new Set([sha.slice(0, 8)]) })), false);
		});

		it('accepts an equivalent stable patch ID', function () {
			assert.equal(isPRPresent(pr, evidence({ patchIds: new Set(['patch-a']) })), true);
		});

		it('requires evidence for every original PR commit', function () {
			const multi = {
				mergeCommit: { oid: 'c'.repeat(40) },
				commits: [{ oid: sha }, { oid: other, patchId: 'patch-b' }],
			};
			assert.equal(isPRPresent(multi, evidence({ cherryPickedShas: new Set([sha]) })), false);
			assert.equal(
				isPRPresent(multi, evidence({ cherryPickedShas: new Set([sha]), patchIds: new Set(['patch-b']) })),
				true
			);
		});

		it('rejects missing, empty and unrelated evidence', function () {
			assert.equal(isPRPresent(pr, evidence()), false);
			assert.equal(isPRPresent({ ...pr, commits: [] }, evidence()), false);
			assert.equal(isPRPresent(pr, evidence({ commitShas: new Set([other]), patchIds: new Set(['patch-b']) })), false);
			assert.equal(isPRPresent({ mergeCommit: { oid: sha } }, evidence({ patchIds: new Set([undefined]) })), false);
		});
	});

	describe('spawned CLI with real git repositories', function () {
		this.timeout(30000);
		let fixture;
		let pro;
		let core;
		let env;
		let prs;
		let runs;
		const remote = (repo) => join(fixture, 'github.com', 'HarperFast', repo === core ? 'harper.git' : 'harper-pro.git');
		const git = (repo, ...args) =>
			execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
		const publish = (repo, ...refspecs) => git(remote(repo), 'fetch', repo, ...refspecs);
		const snapshot = () =>
			[core, pro].map((repo) => ({
				refs: git(repo, 'show-ref', '--heads', '--tags'),
				version: readFileSync(join(repo, 'package.json'), 'utf8'),
			}));
		const runCli = (args = ['--yes', '--json'], input = '') => {
			writeFileSync(join(fixture, 'prs.json'), JSON.stringify(prs));
			writeFileSync(join(fixture, 'runs.json'), JSON.stringify(runs));
			return spawnSync(process.execPath, [join(pro, 'scripts', 'patch-release.js'), '--branch', 'v5.1', ...args], {
				env,
				input,
				encoding: 'utf8',
				timeout: 20000,
			});
		};
		const resultOf = (r) => {
			assert.ifError(r.error);
			const lines = r.stdout.match(/RESULT: [^\n]+/g) ?? [];
			assert.equal(lines.length, 1, r.stdout + r.stderr);
			return JSON.parse(lines[0].slice('RESULT: '.length));
		};
		const addPR = (repo, number = 42, milestone = 'v5.1') => {
			writeFileSync(join(repo, `change-${number}.txt`), `change ${number}\n`);
			git(repo, 'add', '.');
			git(repo, 'commit', '-m', `Source PR ${number}`);
			const sha = git(repo, 'rev-parse', 'HEAD');
			publish(repo, 'main:refs/heads/main', `HEAD:refs/pull/${number}/head`);
			const pr = {
				number,
				title: `Change ${number}`,
				merge_commit_sha: sha,
				merged_at: '2000-01-01T00:00:00Z',
				milestone: { title: milestone },
				base: { ref: 'main' },
			};
			prs[repo === core ? 'core' : 'pro'].push(pr);
			if (repo === core) {
				git(pro, 'add', 'core');
				git(pro, 'commit', '-m', 'Pin fixture core');
				publish(pro, 'main:refs/heads/main');
			}
			return pr;
		};

		beforeEach(function () {
			const parent = join(root, 'node_modules', '.cache', 'dispatch', 'patch-release-tests');
			mkdirSync(parent, { recursive: true });
			fixture = mkdtempSync(join(parent, 'fixture-'));
			pro = join(fixture, 'pro');
			core = join(pro, 'core');
			env = {
				...process.env,
				GIT_CEILING_DIRECTORIES: fixture,
				GIT_CONFIG_COUNT: '5',
				GIT_CONFIG_KEY_0: 'core.hooksPath',
				GIT_CONFIG_VALUE_0: '/dev/null',
				GIT_CONFIG_KEY_1: 'commit.gpgsign',
				GIT_CONFIG_VALUE_1: 'false',
				GIT_CONFIG_KEY_2: 'protocol.file.allow',
				GIT_CONFIG_VALUE_2: 'always',
				GIT_CONFIG_KEY_3: 'push.recurseSubmodules',
				GIT_CONFIG_VALUE_3: 'no',
				GIT_CONFIG_KEY_4: 'tag.gpgSign',
				GIT_CONFIG_VALUE_4: 'false',
				NODE_PATH: join(root, 'node_modules'),
				PATCH_RELEASE_FIXTURE: fixture,
			};
			prs = { core: [], pro: [] };
			runs = {};
			mkdirSync(core, { recursive: true });
			for (const repo of [core, pro]) {
				git(repo, 'init', '-b', 'main');
				assert.equal(git(repo, 'rev-parse', '--show-toplevel'), repo);
				git(repo, 'config', 'user.name', 'Release fixture');
				git(repo, 'config', 'user.email', 'fixture@example.invalid');
				writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'release-fixture', version: '5.1.0' }));
				git(repo, 'add', 'package.json');
				if (repo === pro) {
					writeFileSync(join(pro, '.gitmodules'), `[submodule "core"]\n\tpath = core\n\turl = ${remote(core)}\n`);
					git(pro, 'add', '.gitmodules');
					git(pro, 'update-index', '--add', '--cacheinfo', `160000,${git(core, 'rev-parse', 'HEAD')},core`);
				}
				git(repo, 'commit', '-m', 'Initial release');
				git(repo, 'tag', 'v5.1.0');
				git(repo, 'branch', 'v5.1');
				mkdirSync(remote(repo), { recursive: true });
				git(remote(repo), 'init', '--bare');
				git(repo, 'remote', 'add', 'origin', remote(repo));
				publish(repo, 'main:refs/heads/main', 'v5.1:refs/heads/v5.1', 'refs/tags/v5.1.0:refs/tags/v5.1.0');
			}
			mkdirSync(join(pro, 'scripts'));
			copyFileSync(scriptPath, join(pro, 'scripts', 'patch-release.js'));
			mkdirSync(join(fixture, 'bin'));
			writeFileSync(
				join(fixture, 'bin', 'gh'),
				`#!${process.execPath}\n
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const fixture = process.env.PATCH_RELEASE_FIXTURE;
fs.appendFileSync(path.join(fixture, 'gh-calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === '--version') console.log('gh fixture');
else if (args[0] === 'pr' && args[1] === 'list') console.log('[]');
else if (args[0] === 'api' && args[1].includes('/actions/')) {
    // runs.json: { "<repo>/<workflow file>": [run rows with jobs] | "error" }; absent means one green push run.
    const runs = JSON.parse(fs.readFileSync(path.join(fixture, 'runs.json'), 'utf8'));
    const workflowRuns = args[1].match(new RegExp('^repos/[^/]+/([^/]+)/actions/workflows/([^/]+)/runs[?]head_sha=([0-9a-f]{40})&'));
    const jobs = args[1].match(new RegExp('/actions/runs/([^/]+)/jobs[?]filter=latest&'));
    if (workflowRuns) {
        const key = workflowRuns[1] + '/' + workflowRuns[2];
        const onWorkflowQuery = path.join(fixture, 'on-workflow-query.sh');
        if (fs.existsSync(onWorkflowQuery)) execFileSync('bash', [onWorkflowQuery], { stdio: 'inherit' });
        if (runs[key] === 'error') { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
        const rows = runs[key] ?? [{ id: 'green-' + key.replace('/', '-'), run_number: 1, event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/' + key }];
        for (const { jobs, ...row } of rows) console.log(JSON.stringify(row));
    } else if (jobs) {
        const row = Object.values(runs).flat().find((row) => String(row.id) === jobs[1]);
        for (const job of row?.jobs ?? [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/job' }]) console.log(JSON.stringify(job));
    } else process.exit(1);
} else if (args[0] === 'api' && args.includes('--paginate')) {
    const prs = JSON.parse(fs.readFileSync(path.join(fixture, 'prs.json'), 'utf8'));
    let rows = args[1].includes('/harper-pro/') ? prs.pro : prs.core;
    const commits = args[1].match(new RegExp('/pulls/([0-9]+)/commits'));
    if (commits) {
        const pr = rows.find((pr) => pr.number === Number(commits[1]));
        const repo = path.join(fixture, 'pro', ...(args[1].includes('/harper-pro/') ? [] : ['core']));
        rows = (pr.originalCommits ?? [pr.merge_commit_sha]).map((sha) => ({
            sha,
            parents: execFileSync('git', ['-C', repo, 'rev-list', '--parents', '-n', '1', sha], {encoding:'utf8'})
                .trim().split(' ').slice(1).map((sha) => ({sha})),
        }));
    }
    if (args.includes('--slurp')) console.log(JSON.stringify([rows.slice(0, 1), rows.slice(1)]));
    else if (args.includes('--jq')) {
        for (const row of rows.filter((row) => row.merged_at)) console.log(JSON.stringify({number:row.number,title:row.title,merge_commit_sha:row.merge_commit_sha,milestone:row.milestone?.title,base:row.base.ref}));
    } else process.exit(1);
} else { console.error('Unexpected gh call: ' + args.join(' ')); process.exit(1); }
`,
				{ mode: 0o755 }
			);
			env.PATH = join(fixture, 'bin') + ':' + process.env.PATH;
		});

		afterEach(function () {
			if (fixture) rmSync(fixture, { recursive: true, force: true });
		});

		for (const which of ['core', 'pro']) {
			it(`--yes aborts before publication when a ${which} milestone PR is missing`, function () {
				addPR(which === 'core' ? core : pro);
				const before = snapshot();
				const r = runCli();
				assert.equal(r.status, 1, r.stdout + r.stderr);
				const result = resultOf(r);
				assert.equal(result.ok, false);
				assert.equal(result.pushed, false);
				assert.equal(result.cmTriggered, false);
				assert.equal(result.missingPRs[0].number, 42);
				assert.match(result.missingPRs[0].repo, which === 'core' ? /\/harper$/ : /\/harper-pro$/);
				assert.deepEqual(snapshot(), before);
				assert.equal(git(pro, 'for-each-ref', '--format=%(refname)', 'refs/patch-release'), '');
				assert.equal(git(core, 'for-each-ref', '--format=%(refname)', 'refs/patch-release'), '');
			});
		}

		it('checks all pages and emits RESULT even without --json, including dry-run', function () {
			addPR(pro, 41, 'v6.0');
			addPR(pro, 42, 'v5.0.9');
			const r = runCli(['--yes', '--dry-run']);
			assert.equal(r.status, 1, r.stdout + r.stderr);
			assert.deepEqual(
				resultOf(r).missingPRs.map((pr) => pr.number),
				[42]
			);
		});

		it('prints missing PRs before the interactive confirmation and permits declining', function () {
			addPR(pro);
			const r = runCli(['--json'], 'n\n');
			assert.equal(r.status, 0, r.stdout + r.stderr);
			assert.match(r.stderr, /MISSING:.*#42/);
			assert.match(r.stdout, /Proceed with version bump/);
			assert.equal(resultOf(r).aborted, true);
		});

		for (const mode of ['ancestry', 'trailer', 'patch-id']) {
			it(`recognizes ${mode} evidence in release history before the last tag`, function () {
				const pr = addPR(pro);
				git(pro, 'checkout', 'v5.1');
				if (mode === 'ancestry') git(pro, 'merge', '--ff-only', 'main');
				else git(pro, 'cherry-pick', ...(mode === 'trailer' ? ['-x'] : []), pr.merge_commit_sha);
				if (mode === 'patch-id') git(pro, 'commit', '--amend', '-m', 'Manual equivalent backport');
				git(pro, 'tag', 'v5.1.1');
				publish(pro, 'v5.1:refs/heads/v5.1', 'refs/tags/v5.1.1:refs/tags/v5.1.1');
				git(pro, 'checkout', 'main');
				const r = runCli(['--yes', '--dry-run', '--json']);
				assert.equal(r.status, 0, r.stdout + r.stderr);
				assert.equal(resultOf(r).ok, true);
			});
		}

		it('rejects a PR-number subject reference without commit or patch evidence', function () {
			addPR(pro);
			git(pro, 'checkout', 'v5.1');
			git(pro, 'commit', '--allow-empty', '-m', 'Mention #42 without applying it');
			publish(pro, 'v5.1:refs/heads/v5.1');
			git(pro, 'checkout', 'main');
			const r = runCli();
			assert.equal(r.status, 1, r.stdout + r.stderr);
			assert.equal(resultOf(r).missingPRs[0].number, 42);
		});

		for (const mode of ['squash', 'rebase']) {
			it(`requires all original commits of a ${mode}-merged PR to have landed`, function () {
				git(pro, 'checkout', '-b', 'feature');
				const originals = [];
				for (const name of ['first', 'second']) {
					writeFileSync(join(pro, `${name}.txt`), `${name} change\n`);
					git(pro, 'add', `${name}.txt`);
					git(pro, 'commit', '-m', name);
					originals.push(git(pro, 'rev-parse', 'HEAD'));
				}
				git(pro, 'checkout', 'main');
				if (mode === 'squash') {
					git(pro, 'merge', '--squash', 'feature');
					git(pro, 'commit', '-m', 'Squash PR 42');
				} else git(pro, 'merge', '--ff-only', 'feature');
				prs.pro.push({
					number: 42,
					title: 'Multi-commit PR',
					merge_commit_sha: git(pro, 'rev-parse', 'HEAD'),
					merged_at: '2000-01-01T00:00:00Z',
					milestone: { title: 'v5.1' },
					base: { ref: 'main' },
					originalCommits: mode === 'rebase' ? originals.toReversed() : originals,
				});
				publish(pro, 'main:refs/heads/main', 'feature:refs/pull/42/head');
				const pickOrder = mode === 'rebase' ? originals.toReversed() : originals;
				git(pro, 'checkout', 'v5.1');
				git(pro, 'cherry-pick', pickOrder[0]);
				git(pro, 'commit', '--amend', '-m', 'First backport');
				publish(pro, 'v5.1:refs/heads/v5.1');
				git(pro, 'checkout', 'main');
				const partial = runCli();
				assert.equal(partial.status, 1, partial.stdout + partial.stderr);
				assert.equal(resultOf(partial).missingPRs[0].number, 42);
				git(pro, 'checkout', 'v5.1');
				git(pro, 'cherry-pick', pickOrder[1]);
				git(pro, 'commit', '--amend', '-m', 'Second backport');
				publish(pro, 'v5.1:refs/heads/v5.1');
				git(pro, 'checkout', 'main');
				const complete = runCli(['--yes', '--dry-run', '--json']);
				assert.equal(complete.status, 0, complete.stdout + complete.stderr);
				assert.equal(resultOf(complete).ok, true);
			});
		}

		it('uses the core RC branch version to select milestone targets', function () {
			addPR(core);
			git(core, 'branch', 'rc/5.1-core', 'v5.1');
			publish(core, 'rc/5.1-core:refs/heads/rc/5.1-core');
			const r = runCli(['--yes', '--json', '--core-branch', 'rc/5.1-core']);
			assert.equal(r.status, 1, r.stdout + r.stderr);
			assert.equal(resultOf(r).missingPRs[0].branch, 'rc/5.1-core');
		});

		it('recognizes a squash backport after the PR merged unrelated main changes', function () {
			git(pro, 'checkout', '-b', 'feature');
			const originals = [];
			for (const name of ['first', 'second']) {
				writeFileSync(join(pro, `${name}.txt`), `${name} change\n`);
				git(pro, 'add', `${name}.txt`);
				git(pro, 'commit', '-m', name);
				originals.push(git(pro, 'rev-parse', 'HEAD'));
			}
			git(pro, 'checkout', 'main');
			writeFileSync(join(pro, 'main-only.txt'), 'unrelated main change\n');
			git(pro, 'add', 'main-only.txt');
			git(pro, 'commit', '-m', 'Unrelated main change');
			git(pro, 'checkout', 'feature');
			git(pro, 'merge', '--no-ff', 'main', '-m', 'Merge main into feature');
			originals.push(git(pro, 'rev-parse', 'HEAD'));
			git(pro, 'checkout', 'main');
			git(pro, 'merge', '--squash', 'feature');
			git(pro, 'commit', '-m', 'Squash PR 42');
			const mergeSha = git(pro, 'rev-parse', 'HEAD');
			prs.pro.push({
				number: 42,
				title: 'Updated PR',
				merge_commit_sha: mergeSha,
				merged_at: '2000-01-01T00:00:00Z',
				milestone: { title: 'v5.1' },
				base: { ref: 'main' },
				originalCommits: originals,
			});
			publish(pro, 'main:refs/heads/main', 'feature:refs/pull/42/head');
			git(pro, 'checkout', 'v5.1');
			git(pro, 'cherry-pick', mergeSha);
			git(pro, 'commit', '--amend', '-m', 'Backport the squash');
			publish(pro, 'v5.1:refs/heads/v5.1');
			git(pro, 'checkout', 'main');
			const r = runCli(['--yes', '--dry-run', '--json']);
			assert.equal(r.status, 0, r.stdout + r.stderr);
			assert.equal(resultOf(r).ok, true);
		});

		it('requires merge-only resolution content as well as ordinary commits', function () {
			git(pro, 'checkout', '-b', 'feature');
			const originals = [];
			for (const name of ['first', 'second']) {
				git(pro, 'checkout', '-b', name, 'main');
				writeFileSync(join(pro, `${name}.txt`), `${name} change\n`);
				git(pro, 'add', `${name}.txt`);
				git(pro, 'commit', '-m', name);
				originals.push(git(pro, 'rev-parse', 'HEAD'));
			}
			git(pro, 'checkout', 'feature');
			git(pro, 'merge', '--ff-only', 'first');
			git(pro, 'merge', '--no-ff', '--no-commit', 'second');
			writeFileSync(join(pro, 'resolution.txt'), 'merge-only resolution\n');
			git(pro, 'add', 'resolution.txt');
			git(pro, 'commit', '-m', 'Merge with additional resolution');
			originals.push(git(pro, 'rev-parse', 'HEAD'));
			git(pro, 'checkout', 'main');
			git(pro, 'merge', '--squash', 'feature');
			git(pro, 'commit', '-m', 'Squash PR 42');
			const mergeSha = git(pro, 'rev-parse', 'HEAD');
			prs.pro.push({
				number: 42,
				title: 'PR with merge resolution',
				merge_commit_sha: mergeSha,
				merged_at: '2000-01-01T00:00:00Z',
				milestone: { title: 'v5.1' },
				base: { ref: 'main' },
				originalCommits: originals,
			});
			publish(pro, 'main:refs/heads/main', 'feature:refs/pull/42/head');
			git(pro, 'checkout', 'v5.1');
			git(pro, 'cherry-pick', ...originals.slice(0, 2));
			publish(pro, 'v5.1:refs/heads/v5.1');
			git(pro, 'checkout', 'main');
			const partial = runCli(['--yes', '--dry-run', '--json']);
			assert.equal(partial.status, 1, partial.stdout + partial.stderr);
			assert.equal(resultOf(partial).missingPRs[0].number, 42);
			git(pro, 'checkout', 'v5.1');
			git(pro, 'reset', '--hard', 'v5.1.0');
			git(pro, 'cherry-pick', mergeSha);
			git(pro, 'commit', '--amend', '-m', 'Complete backport');
			publish(pro, '+v5.1:refs/heads/v5.1');
			git(pro, 'checkout', 'main');
			const complete = runCli(['--yes', '--dry-run', '--json']);
			assert.equal(complete.status, 0, complete.stdout + complete.stderr);
			assert.equal(resultOf(complete).ok, true);
		});

		it('fails closed when a PR head cannot be fetched', function () {
			addPR(pro);
			git(remote(pro), 'update-ref', '-d', 'refs/pull/42/head');
			const r = runCli();
			assert.equal(r.status, 1, r.stdout + r.stderr);
			assert.equal(resultOf(r).ok, false);
			assert.match(r.stderr, /refs\/pull\/42\/head/);
		});

		it('collects missing backports from both repositories before aborting', function () {
			addPR(core, 41);
			addPR(pro, 42);
			const before = snapshot();
			const r = runCli();
			assert.equal(r.status, 1, r.stdout + r.stderr);
			assert.deepEqual(
				resultOf(r).missingPRs.map((pr) => pr.number),
				[41, 42]
			);
			assert.deepEqual(snapshot(), before);
		});

		it('fails closed on missing merge metadata instead of dropping a targeted PR', function () {
			addPR(pro).merge_commit_sha = null;
			const r = runCli();
			assert.equal(r.status, 1, r.stdout + r.stderr);
			assert.match(resultOf(r).error, /Invalid merge metadata.*#42/);
		});

		for (const originalCommits of [[], Array(250).fill(null)]) {
			it(`reports missing when GitHub cannot prove a complete original commit list (${originalCommits.length})`, function () {
				const pr = addPR(pro);
				pr.originalCommits = originalCommits.map(() => pr.merge_commit_sha);
				const r = runCli();
				assert.equal(r.status, 1, r.stdout + r.stderr);
				assert.equal(resultOf(r).missingPRs[0].number, 42);
			});
		}

		it('refuses a local release branch ahead of the verified remote', function () {
			git(pro, 'checkout', 'v5.1');
			git(pro, 'commit', '--allow-empty', '-m', 'Unpublished local release');
			git(pro, 'checkout', 'main');
			const before = snapshot();
			const r = runCli();
			assert.equal(r.status, 1, r.stdout + r.stderr);
			assert.equal(resultOf(r).ok, false);
			assert.match(resultOf(r).error, /Local v5\.1 has commits absent from origin\/v5\.1/);
			assert.deepEqual(snapshot(), before);
		});

		describe('release-candidate CI gate', function () {
			const remoteSnapshot = () => [core, pro].map((repo) => git(remote(repo), 'show-ref'));
			const ghCalls = () =>
				readFileSync(join(fixture, 'gh-calls.jsonl'), 'utf8')
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line));
			const failingRun = (key) => [
				{
					id: 9001,
					run_number: 12,
					event: 'push',
					status: 'completed',
					conclusion: 'failure',
					html_url: `https://example.invalid/${key}/runs/9001`,
					jobs: [
						{
							name: 'Unit Test (Node.js v22)',
							status: 'completed',
							conclusion: 'failure',
							html_url: 'https://example.invalid/job/1',
						},
						{
							name: 'Unit Test (Node.js v24)',
							status: 'completed',
							conclusion: 'success',
							html_url: 'https://example.invalid/job/2',
						},
					],
				},
			];
			const allowRelease = () => {
				mkdirSync(join(pro, 'build-tools'));
				writeFileSync(join(pro, 'build-tools', 'sync-core.sh'), '#!/bin/sh\n', { mode: 0o755 });
			};

			for (const [which, repoName, workflow] of [
				['core', 'harper', 'unit-test.yml'],
				['pro', 'harper-pro', 'unit-tests.yaml'],
			]) {
				it(`--yes aborts before tagging when a required ${which} check failed, even without --json`, function () {
					runs[`${repoName}/${workflow}`] = failingRun(`${repoName}/${workflow}`);
					const before = [snapshot(), remoteSnapshot()];
					const r = runCli(['--yes']);
					assert.equal(r.status, 1, r.stdout + r.stderr);
					const result = resultOf(r);
					assert.equal(result.ok, false);
					assert.equal(result.pushed, false);
					assert.equal(result.cmTriggered, false);
					assert.match(result.error, /Release candidate CI is not green/);
					const candidate = git(which === 'core' ? core : pro, 'rev-parse', 'refs/remotes/origin/v5.1');
					assert.deepEqual(
						result.ciFailures.map((f) => [f.repo, f.workflow, f.job, f.state, f.sha]),
						[[`HarperFast/${repoName}`, workflow, 'Unit Test (Node.js v22)', 'failure', candidate]]
					);
					assert.ok(
						ghCalls().some(
							([, endpoint]) =>
								endpoint ===
								`repos/HarperFast/${repoName}/actions/workflows/${workflow}/runs?head_sha=${candidate}&per_page=100`
						)
					);
					assert.match(
						r.stderr,
						new RegExp(`✗ ${workflow.replace('.', '\\.')} / Unit Test \\(Node\\.js v22\\): failure`)
					);
					assert.deepEqual([snapshot(), remoteSnapshot()], before);
				});
			}

			it('--yes --dry-run aborts when CI evidence cannot be read', function () {
				runs['harper-pro/integration-tests.yaml'] = 'error';
				const r = runCli(['--yes', '--dry-run', '--json']);
				assert.equal(r.status, 1, r.stdout + r.stderr);
				const [failure, ...rest] = resultOf(r).ciFailures;
				assert.deepEqual(rest, []);
				assert.equal(failure.workflow, 'integration-tests.yaml');
				assert.equal(failure.state, 'error');
				assert.match(failure.error, /HTTP 404/);
			});

			it('names the dispatch command when a candidate has no run of a required workflow', function () {
				runs['harper/integration-tests.yml'] = [];
				const r = runCli(['--yes', '--dry-run', '--json']);
				assert.equal(r.status, 1, r.stdout + r.stderr);
				assert.deepEqual(
					resultOf(r).ciFailures.map((f) => [f.workflow, f.state]),
					[['integration-tests.yml', 'missing']]
				);
				assert.match(r.stderr, /gh workflow run integration-tests\.yml --repo HarperFast\/harper --ref v5\.1/);
			});

			it('--ci-override proceeds past non-green CI and records the reason', function () {
				runs['harper-pro/unit-tests.yaml'] = failingRun('harper-pro/unit-tests.yaml');
				const r = runCli(['--yes', '--dry-run', '--json', '--ci-override', ' incident 123 hotfix ']);
				assert.equal(r.status, 0, r.stdout + r.stderr);
				const result = resultOf(r);
				assert.equal(result.ok, true);
				assert.deepEqual(result.ciOverride, { reason: 'incident 123 hotfix' });
				assert.deepEqual(
					result.ciFailures.map((f) => [f.workflow, f.job]),
					[['unit-tests.yaml', 'Unit Test (Node.js v22)']]
				);
				assert.match(r.stderr, /CI gate overridden with --ci-override \(1 failing checks above\): incident 123 hotfix/);
			});

			it('--ci-override does not waive a missing backport', function () {
				addPR(pro);
				runs['harper-pro/unit-tests.yaml'] = failingRun('harper-pro/unit-tests.yaml');
				const r = runCli(['--yes', '--json', '--ci-override', 'incident']);
				assert.equal(r.status, 1, r.stdout + r.stderr);
				const result = resultOf(r);
				assert.equal(result.missingPRs[0].number, 42);
				assert.doesNotMatch(result.error, /CI is not green/);
			});

			it('rejects a blank --ci-override reason', function () {
				const r = runCli(['--yes', '--json', '--ci-override', '   ']);
				assert.equal(r.status, 1, r.stdout + r.stderr);
				assert.match(resultOf(r).error, /--ci-override requires a non-blank reason/);
			});

			for (const [label, input] of [
				['declining', 'n\n'],
				['closed stdin at', ''],
			]) {
				it(`interactive mode prints the failing checks and aborts on ${label} the override prompt`, function () {
					runs['harper/unit-test.yml'] = failingRun('harper/unit-test.yml');
					const before = [snapshot(), remoteSnapshot()];
					const r = runCli(['--json'], input);
					assert.equal(r.status, 0, r.stdout + r.stderr);
					assert.match(r.stderr, /✗ unit-test\.yml \/ Unit Test \(Node\.js v22\): failure/);
					assert.match(r.stdout, /Required CI is NOT green .* overriding the CI gate\? \[y\/N\]/);
					assert.equal(resultOf(r).aborted, true);
					assert.deepEqual([snapshot(), remoteSnapshot()], before);
				});
			}

			it('records an interactive override and declines the CM deploy prompt when stdin closes', function () {
				allowRelease();
				runs['harper-pro/integration-tests.yaml'] = failingRun('harper-pro/integration-tests.yaml');
				const r = runCli(['--json'], 'y\n');
				assert.equal(r.status, 0, r.stdout + r.stderr);
				const result = resultOf(r);
				assert.equal(result.pushed, true);
				assert.equal(result.cmTriggered, false);
				assert.deepEqual(result.ciOverride, { reason: 'interactive confirmation' });
				assert.equal(result.ciFailures[0].workflow, 'integration-tests.yaml');
				assert.match(r.stderr, /Skipped\. Manually trigger release-to-environments/);
				assert.equal(
					git(remote(pro), 'rev-parse', 'refs/tags/v5.1.1^{commit}^'),
					git(remote(pro), 'rev-parse', 'v5.1.0^{commit}')
				);
			});

			it('tags the verified candidate even when origin/<branch> moves during the CI check', function () {
				allowRelease();
				const candidate = git(pro, 'rev-parse', 'v5.1');
				git(pro, 'checkout', '-b', 'unverified', 'v5.1');
				git(pro, 'commit', '--allow-empty', '-m', 'Unverified commit');
				const unverified = git(pro, 'rev-parse', 'HEAD');
				git(pro, 'checkout', 'main');
				writeFileSync(
					join(fixture, 'on-workflow-query.sh'),
					`git -C "${pro}" update-ref refs/remotes/origin/v5.1 ${unverified}\n`
				);
				const r = runCli(['--yes', '--json']);
				assert.equal(r.status, 0, r.stdout + r.stderr);
				const result = resultOf(r);
				assert.equal(result.ok, true);
				assert.equal(result.pushed, true);
				assert.deepEqual(result.ciFailures, []);
				assert.equal(result.ciOverride, null);
				assert.deepEqual(result.backportVerification, { core: 'passed', pro: 'passed' });
				const coreCandidate = git(remote(core), 'rev-parse', 'v5.1');
				assert.deepEqual(result.candidates, { core: coreCandidate, pro: candidate, proCoreGitlink: coreCandidate });
				assert.equal(git(remote(pro), 'rev-parse', 'refs/tags/v5.1.1^{commit}^'), candidate);
				assert.equal(git(remote(pro), 'rev-parse', 'v5.1'), git(remote(pro), 'rev-parse', 'refs/tags/v5.1.1^{commit}'));
			});

			it('warns when harper-pro CI ran against a different core than the release builds on', function () {
				git(core, 'checkout', 'v5.1');
				git(core, 'commit', '--allow-empty', '-m', 'Core backport');
				publish(core, 'v5.1:refs/heads/v5.1');
				git(core, 'checkout', 'main');
				const r = runCli(['--yes', '--dry-run', '--json']);
				assert.equal(r.status, 0, r.stdout + r.stderr);
				const { candidates } = resultOf(r);
				assert.notEqual(candidates.proCoreGitlink, candidates.core);
				assert.match(
					r.stderr,
					/harper-pro CI ran against core [0-9a-f]{8}, but this release builds on core [0-9a-f]{8}/
				);
			});
		});

		describe('release cut from the source branch', function () {
			it('reports backport verification as not applicable instead of passed', function () {
				addPR(pro, 42, 'v5.1');
				const r = runCli(['--yes', '--dry-run', '--json', '--branch', 'main']);
				assert.equal(r.status, 0, r.stdout + r.stderr);
				assert.deepEqual(resultOf(r).backportVerification, { core: 'not-applicable', pro: 'not-applicable' });
				assert.match(r.stderr, /Backport verification not applicable: release cut from source branch main/);
				assert.doesNotMatch(r.stdout + r.stderr, /Backport verification passed/);
				const calls = readFileSync(join(fixture, 'gh-calls.jsonl'), 'utf8');
				assert.doesNotMatch(calls, /\/pulls\?/);
			});

			it('decides applicability per repository', function () {
				addPR(core, 41);
				const r = runCli(['--yes', '--dry-run', '--json', '--branch', 'main', '--core-branch', 'v5.1']);
				assert.equal(r.status, 1, r.stdout + r.stderr);
				const result = resultOf(r);
				assert.deepEqual(result.backportVerification, { core: 'missing', pro: 'not-applicable' });
				assert.deepEqual(
					result.missingPRs.map((pr) => pr.number),
					[41]
				);
			});
		});
	});
});
