// Test harness for the companion-check workflow's embedded github-script.
// Usage: node build-tools/companion-check.test.mjs [path-to-companion-check.yaml]
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const yaml = readFileSync(
	process.argv[2] || new URL('../.github/workflows/companion-check.yaml', import.meta.url),
	'utf8'
);
const scriptLines = [];
let inScript = false;
for (const line of yaml.split('\n')) {
	if (!inScript) {
		if (/^\s*script: \|/.test(line)) inScript = true;
	} else if (line.trim() === '' || line.startsWith('            ')) {
		scriptLines.push(line.slice(12));
	} else break;
}
const script = scriptLines.join('\n');
assert(script.includes('parseDeps'), 'script extraction failed');

const OWN = 'HarperFast/documentation';

// Dep PR database: "owner/repo#n" -> PR data | 'private' | 'flaky500'
const prDb = {
	'HarperFast/harper#2147': { merged: false, state: 'open' },
	'HarperFast/harper#2000': { merged: true, state: 'closed' },
	'HarperFast/harper#1999': { merged: false, state: 'closed' },
	'HarperFast/harper#1500': { merged: true, state: 'closed' },
	'HarperFast/harper-pro#512': 'private',
	'HarperFast/harper#666': 'flaky500',
	'HarperFast/documentation#600': { merged: true, state: 'closed' },
};

// Submodule fixtures. S(c) is a 40-char sha. `onBranches` lists the HarperFast/harper branches that
// contain a commit (compare `behind`); any other commit compares `diverged`.
const S = (c) => c.repeat(40);
const SETTLED_MAIN = S('1');
const SETTLED_V53 = S('2');
const UNSETTLED = S('3');
const COMPARE_500 = S('5');
const COMPARE_ODD = S('6'); // compare answers a status outside the documented four
const onBranches = { [SETTLED_MAIN]: ['main', 'v5.3'], [SETTLED_V53]: ['v5.3'] };
const harperBranches = ['main', 'v5.3'];
const HARPER_SSH = 'git@github.com:HarperFast/harper.git';

// listFiles entries, shaped as captured from the live API. The contents API reports each gitlink
// fixture as a submodule at `url`, and every other path as a file.
const gitlinkUrls = new WeakMap();
const gitlink = (path, sha, { status = 'modified', url = HARPER_SSH, patch = true } = {}) => {
	const added = status === 'added';
	const file = { filename: path, status, sha, additions: 1, deletions: added ? 0 : 1 };
	if (patch)
		file.patch = added
			? `@@ -0,0 +1 @@\n+Subproject commit ${sha}`
			: `@@ -1 +1 @@\n-Subproject commit ${S('0')}\n+Subproject commit ${sha}`;
	gitlinkUrls.set(file, url);
	return file;
};
const removedGitlink = (path) => ({
	filename: path,
	status: 'removed',
	sha: S('0'),
	additions: 0,
	deletions: 1,
	patch: `@@ -1 +0,0 @@\n-Subproject commit ${S('0')}`,
});
const textFile = (path, patch = '@@ -1 +1,2 @@\n x\n+y', counts = { additions: 1, deletions: 0 }) => ({
	filename: path,
	status: 'modified',
	sha: S('d'),
	...counts,
	...(patch === null ? {} : { patch }),
});
// "<pr number>" -> files | 'flaky500'; unknown PRs change one regular file.
const filesDb = {};
// "<path>@<head sha>" whose contents read fails; otherwise derived from the PR's files.
const flakyContents = new Set();
// "<head sha>" -> 'flaky500' | 'truncated'; otherwise the head tree is derived from the PR's files.
const treeDb = {};

function makeEnv(eventName, openPrs, payloadPr) {
	const posted = [];
	const getCalls = [];
	const calls = { listFiles: [], getContent: [], getTree: [], getBranch: [], getRepo: [], compare: [] };
	const flaky = () => Object.assign(new Error('boom'), { status: 500 });
	const notFound = () => Object.assign(new Error('nf'), { status: 404 });
	const github = {
		rest: {
			pulls: {
				listFiles: async ({ owner, repo, pull_number, per_page, page = 1 }) => {
					assert.equal(`${owner}/${repo}`, OWN);
					assert.equal(per_page, 100);
					calls.listFiles.push(pull_number);
					const files = filesDb[pull_number] ?? [textFile('README.md')];
					if (files === 'flaky500') throw flaky();
					return { data: files.slice((page - 1) * per_page, page * per_page) };
				},
				get: async ({ owner, repo, pull_number }) => {
					const key = `${owner}/${repo}#${pull_number}`;
					getCalls.push(key);
					const fresh = openPrs.find((p) => key === `${OWN}#${p.number}`);
					if (fresh) return { data: fresh }; // sweep re-read of our own PR
					const rec = prDb[key];
					if (rec === 'flaky500') throw Object.assign(new Error('boom'), { status: 500 });
					if (!rec || rec === 'private') throw Object.assign(new Error('nf'), { status: 404 });
					return { data: rec };
				},
				list: 'LIST',
			},
			repos: {
				listCommitStatusesForRef: async ({ ref }) => ({
					data:
						ref === 'ddd'
							? [
									{
										context: 'companion-check',
										state: 'failure',
										description: 'HarperFast/harper#1999 closed without merging',
									},
								]
							: ref === 'heal'
								? [{ context: 'companion-check', state: 'pending', description: 'Waiting on HarperFast/harper#2147' }]
								: [],
				}),
				createCommitStatus: async (s) => posted.push(s),
				getContent: async ({ owner, repo, path, ref }) => {
					assert.equal(`${owner}/${repo}`, OWN);
					calls.getContent.push(`${path}@${ref}`);
					if (flakyContents.has(`${path}@${ref}`)) throw flaky();
					const files = filesDb[[...openPrs, payloadPr].find((p) => p?.head.sha === ref)?.number];
					const file = Array.isArray(files) && files.find((f) => f.filename === path);
					if (!file) throw notFound();
					const url = gitlinkUrls.get(file);
					const kind = url ? { type: 'submodule', submodule_git_url: url } : { type: 'file' };
					return { data: { ...kind, sha: file.sha } };
				},
				getBranch: async ({ owner, repo, branch }) => {
					calls.getBranch.push(`${owner}/${repo}:${branch}`);
					if (`${owner}/${repo}` === 'HarperFast/flaky') throw flaky();
					if (`${owner}/${repo}` !== 'HarperFast/harper' || !harperBranches.includes(branch)) throw notFound();
					return { data: { name: branch } };
				},
				get: async ({ owner, repo }) => {
					calls.getRepo.push(`${owner}/${repo}`);
					if (`${owner}/${repo}` !== 'HarperFast/harper') throw notFound();
					return { data: { default_branch: 'main' } };
				},
				compareCommitsWithBasehead: async ({ owner, repo, basehead, per_page }) => {
					assert.equal(`${owner}/${repo}`, 'HarperFast/harper');
					assert.equal(per_page, 1);
					calls.compare.push(basehead);
					const [branch, sha] = basehead.split('...');
					if (sha === COMPARE_500) throw flaky();
					if (sha === COMPARE_ODD) return { data: { status: 'weird' } };
					return { data: { status: onBranches[sha]?.includes(branch) ? 'behind' : 'diverged' } };
				},
			},
			git: {
				getTree: async ({ owner, repo, tree_sha, recursive }) => {
					assert.equal(`${owner}/${repo}`, OWN);
					assert.equal(recursive, 'true');
					calls.getTree.push(tree_sha);
					if (treeDb[tree_sha] === 'flaky500') throw flaky();
					const files = filesDb[[...openPrs, payloadPr].find((p) => p?.head.sha === tree_sha)?.number];
					const tree = (Array.isArray(files) ? files : [])
						.filter((f) => f.status !== 'removed')
						.map((f) => ({ path: f.filename, type: gitlinkUrls.has(f) ? 'commit' : 'blob', sha: f.sha }));
					return { data: { tree, truncated: treeDb[tree_sha] === 'truncated' } };
				},
			},
		},
		paginate: async (fn, args) => {
			if (fn === 'LIST') return openPrs;
			const all = [];
			for (let page = 1; ; page++) {
				const { data } = await fn({ ...args, page });
				all.push(...data);
				if (data.length < args.per_page) return all;
			}
		},
	};
	const core = { info: () => {}, warning: () => {}, setFailed: (m) => (core.failed = m) };
	const context = {
		repo: { owner: 'HarperFast', repo: 'documentation' },
		eventName,
		payload: { pull_request: payloadPr },
		serverUrl: 'https://github.com',
		runId: 1,
	};
	return { github, core, context, posted, getCalls, calls };
}

async function run(env) {
	await new Function('github', 'context', 'core', `return (async()=>{${script}})()`)(env.github, env.context, env.core);
	return Object.fromEntries(env.posted.map((s) => [s.sha, s]));
}

const ownHead = { repo: { full_name: OWN } };
const pr = (number, body, sha, head = {}, base = 'main') => ({
	number,
	body,
	head: { sha, ...ownHead, ...head },
	base: { ref: base },
});

process.env.COMPANION_CHECK_TOKEN = '';
globalThis.fetch = async () => ({ ok: false, status: 403 });

// --- schedule sweep ---
const sweepPrs = [
	pr(623, 'Docs.\n\nDepends-on: HarperFast/harper#2147\n', 'aaa'),
	pr(700, 'plain docs PR, no deps', 'bbb'),
	pr(701, 'Depends-on: https://github.com/HarperFast/harper/pull/2000, documentation#600', 'ccc'),
	pr(702, 'depends-on: HarperFast/harper#1999', 'ddd'),
	pr(703, 'Depends-on: HarperFast/harper-pro#512', 'eee'),
	pr(704, 'Depends-on: harper#1500', 'fff'), // repo#N shorthand
	pr(705, 'Depends-on: the harper PR', 'ggg'), // unparseable -> failure
	pr(706, 'Depends-on: HarperFast/harper#666', 'hhh'), // 500 -> unreadable, no crash
	pr(707, `Depends-on: ${Array.from({ length: 12 }, (_, i) => `HarperFast/harper#${i + 1}`).join(', ')}`, 'iii'),
	pr(708, 'Depends-on: harper#1500, HarperFast/harper#1500', 'jjj'), // dedupe -> 1 dep
	pr(709, 'Depends-on: HarperFast/harper#2147 (the pagination PR)', 'res1'), // residue -> failure
	pr(710, 'Depends-on:', 'res2'), // empty marker -> failure
	pr(711, 'Depends-on: ../../evil/x#1', 'res3'), // traversal segments -> failure
	pr(712, 'no marker, stale pending from removed marker', 'heal'), // heals to success
	pr(713, 'Depends-on: harper#1500', 'memo'), // same dep as 704: memoized
];
const sweep = makeEnv('schedule', sweepPrs);
const bySha = await run(sweep);

assert.equal(bySha.aaa.state, 'pending');
assert.match(bySha.aaa.description, /Waiting on HarperFast\/harper#2147/);
assert.equal(bySha.bbb.state, 'success', 'sweep backfills no-marker PRs');
assert.equal(bySha.ccc.state, 'success');
assert.match(bySha.ccc.description, /harper#2000.*documentation#600/);
assert.equal(bySha.ddd, undefined, 'unchanged status must not repost');
assert.equal(bySha.eee.state, 'failure', 'definitive 404 without secret blocks as not-found');
assert.match(bySha.eee.description, /not found or inaccessible/);
assert.equal(bySha.fff.state, 'success', 'repo#N shorthand resolves in own org');
assert.equal(bySha.ggg.state, 'failure', 'unparseable marker fails closed');
assert.match(bySha.ggg.description, /unparseable/i);
assert.equal(bySha.hhh.state, 'pending', 'HTTP 500 must degrade, not crash');
assert.match(bySha.hhh.description, /^Cannot read HarperFast\/harper#666 \(500\)$/);
assert.equal(bySha.iii.state, 'failure', 'dep cap enforced');
assert.equal(bySha.jjj.state, 'success', 'duplicates deduped');
assert.match(bySha.jjj.description, /^All companion PRs merged \(HarperFast\/harper#1500\)$/);
assert.equal(bySha.res1.state, 'failure', 'non-ref residue on marker line fails closed');
assert.equal(bySha.res2.state, 'failure', 'empty marker fails closed');
assert.equal(bySha.res3.state, 'failure', 'path-traversal segments fail closed');
assert.equal(bySha.heal.state, 'success', 'sweep heals stale pending after marker removal');
assert.equal(bySha.memo.state, 'success');
assert.equal(
	sweep.getCalls.filter((k) => k === 'HarperFast/harper#1500').length,
	1,
	'dep lookups memoized within a run'
);
assert.equal(sweep.core.failed, undefined, 'no PR-level failures expected');
assert.deepEqual(sweep.calls.listFiles, [700, 712], 'only no-marker PRs list files; marker evaluation unchanged');
assert.equal(sweep.calls.getContent.length + sweep.calls.compare.length, 0, 'no gitlink, no submodule lookups');
assert.ok(sweep.posted.every((s) => s.context === 'companion-check' && s.description.length <= 140));
assert.ok(
	sweep.posted.every((s) => s.request?.retries === 0),
	'sweep verdict writes opt out of retries: a retry lands after the freshness check'
);

// --- no marker: submodule pointer moves ---
const pageTwo = Array.from({ length: 150 }, (_, i) => textFile(`src/f${i}.js`));
pageTwo.splice(140, 0, gitlink('core', UNSETTLED));
const renamed = { ...gitlink('modules/core', UNSETTLED, { status: 'renamed' }), previous_filename: 'core' };
gitlinkUrls.set(renamed, HARPER_SSH);
const otherHarper = { url: 'https://github.com/HarperFast/harper' };
Object.assign(filesDb, {
	800: [gitlink('core', UNSETTLED)],
	802: [gitlink('core', SETTLED_MAIN), textFile('package.json')],
	803: [textFile('notes.md', `@@ -0,0 +1 @@\n+Subproject commit ${UNSETTLED}`)],
	804: [removedGitlink('core')],
	805: [gitlink('core', SETTLED_V53)],
	806: [gitlink('core', SETTLED_V53)],
	807: [gitlink('core', COMPARE_500)],
	808: [gitlink('core', SETTLED_MAIN)],
	809: 'flaky500',
	810: [gitlink('vendor/lib', SETTLED_MAIN, { url: 'https://gitlab.com/x/lib.git' })],
	811: [gitlink('core', UNSETTLED)],
	812: [gitlink('core', SETTLED_MAIN)],
	813: [gitlink('vendor/lib', COMPARE_500, otherHarper), gitlink('core', UNSETTLED)],
	814: [gitlink('core', UNSETTLED, { status: 'added' })],
	815: [gitlink('vendor/flaky', SETTLED_MAIN, { url: 'https://github.com/HarperFast/flaky.git' })],
	816: [gitlink('vendor/evil', SETTLED_MAIN, { url: 'https://github.com/../harper.git' })],
	817: [gitlink('core', UNSETTLED), gitlink('vendor/lib', COMPARE_500, otherHarper)],
	818: [gitlink('vendor/look', SETTLED_MAIN, { url: 'https://github.com.evil.com/HarperFast/harper.git' })],
	828: [gitlink('vendor/dot', SETTLED_MAIN, { url: 'git@github.com:HarperFast/.github.git' })],
	819: [gitlink('core', UNSETTLED, { patch: false })],
	820: [
		textFile('empty.txt', null, { additions: 0, deletions: 0 }),
		textFile('logo.png', null, { additions: 0, deletions: 0 }),
	],
	821: pageTwo,
	822: Array.from({ length: 3000 }, (_, i) => textFile(`gen/f${i}.json`)),
	823: [gitlink('core', COMPARE_ODD)],
	824: [renamed],
	825: [gitlink('core', SETTLED_MAIN, { patch: false }), textFile('logo.png', null, { additions: 0, deletions: 0 })],
	826: [gitlink('core', UNSETTLED), textFile('logo.png', null, { additions: 0, deletions: 0 })],
	827: [textFile('logo.png', null, { additions: 0, deletions: 0 })],
});
Object.assign(treeDb, { gl25: 'truncated', gl26: 'flaky500', gl27: 'flaky500' });
flakyContents.add('core@gl8');
const gitlinkPrs = [
	pr(800, 'Bumps core (see harper#3072 in prose only)', 'gl0'),
	pr(802, 'routine core bump', 'gl2'),
	pr(803, 'mentions a gitlink in a doc', 'gl3'),
	pr(804, 'drops the submodule', 'gl4'),
	pr(805, 'release-line bump', 'gl5', {}, 'v5.3'),
	pr(806, 'base with no harper branch of its name', 'gl6', {}, 'release-x'),
	pr(807, 'compare errors', 'gl7'),
	pr(808, 'contents errors', 'gl8'),
	pr(809, 'files listing errors', 'gl9'),
	pr(810, 'non-GitHub submodule', 'gl10'),
	pr(811, 'Depends-on: HarperFast/harper#2147', 'gl11'), // marker present: existing path
	pr(812, 'same settled core as 802', 'gl12'),
	pr(813, 'unreadable then unsettled', 'gl13'),
	pr(814, 'adds a submodule on an unsettled commit', 'gl14'),
	pr(815, 'submodule repo branches unreadable', 'gl15'),
	pr(816, 'traversal in submodule URL', 'gl16'),
	pr(817, 'unsettled then unreadable', 'gl17'),
	pr(818, 'lookalike host in submodule URL', 'gl18'),
	pr(819, 'gitlink whose patch GitHub omitted', 'gl19'),
	pr(820, 'patchless text and binary files', 'gl20'),
	pr(821, 'gitlink on the second page', 'gl21'),
	pr(822, 'at the file-listing ceiling', 'gl22'),
	pr(823, 'unexpected compare status', 'gl23'),
	pr(824, 'moves and repoints the submodule', 'gl24'),
	pr(825, 'patchless gitlink, head tree truncated', 'gl25'),
	pr(826, 'unsettled gitlink, head tree unreadable', 'gl26'),
	pr(827, 'binary file, head tree unreadable', 'gl27'),
	pr(828, 'submodule repo named with a leading dot', 'gl28'),
];
const gl = makeEnv('schedule', gitlinkPrs);
const glBySha = await run(gl);
const unsettledHint = (path, branch = 'main') =>
	`${path} is on HarperFast/harper@3333333, not yet on ${branch}: add "Depends-on: HarperFast/harper#<PR>" naming its PR, or re-point it`;

assert.equal(glBySha.gl0.state, 'failure', 'undeclared move onto an unsettled commit fails');
assert.equal(glBySha.gl0.description, unsettledHint('core'));
assert.equal(glBySha.gl2.state, 'success', 'bump between settled commits stays green');
assert.equal(glBySha.gl2.description, 'No companion dependencies (core on HarperFast/harper main)');
assert.equal(glBySha.gl3.state, 'success', 'a text line that looks like a gitlink is not one');
assert.equal(glBySha.gl3.description, 'No companion dependencies');
assert.equal(glBySha.gl4.state, 'success', 'submodule removal waits on nothing');
assert.equal(glBySha.gl4.description, 'No companion dependencies');
assert.equal(glBySha.gl5.state, 'success', 'release-line base settles on the same-named submodule branch');
assert.equal(glBySha.gl5.description, 'No companion dependencies (core on HarperFast/harper v5.3)');
assert.ok(gl.calls.compare.includes(`v5.3...${SETTLED_V53}`));
assert.equal(glBySha.gl6.state, 'failure', 'base with no same-named submodule branch settles on the default branch');
assert.match(glBySha.gl6.description, /not yet on main/);
assert.ok(gl.calls.getRepo.includes('HarperFast/harper'), 'default branch read after the same-named branch 404s');
assert.equal(glBySha.gl7.state, 'pending', 'unreadable compare fails closed but retryable');
assert.equal(glBySha.gl7.description, 'Cannot check core against HarperFast/harper main (500)');
assert.equal(glBySha.gl8.state, 'pending', 'unreadable contents fails closed but retryable');
assert.equal(glBySha.gl8.description, 'Cannot read submodule core (500)');
assert.equal(glBySha.gl9.state, 'pending');
assert.equal(glBySha.gl9.description, 'Cannot list PR files (500)');
assert.equal(glBySha.gl10.state, 'pending', 'a non-GitHub submodule cannot be checked');
assert.equal(glBySha.gl10.description, 'Cannot resolve the GitHub repo of submodule vendor/lib');
assert.equal(glBySha.gl11.state, 'pending', 'marker present: companion state decides, as before');
assert.match(glBySha.gl11.description, /^Waiting on HarperFast\/harper#2147$/);
assert.ok(!gl.calls.listFiles.includes(811), 'marker present: no files listing');
assert.equal(glBySha.gl12.state, 'success');
assert.equal(
	gl.calls.compare.filter((b) => b === `main...${SETTLED_MAIN}`).length,
	1,
	'compare memoized across PRs in one run'
);
assert.equal(gl.calls.getBranch.filter((b) => b === 'HarperFast/harper:main').length, 1, 'settle branch memoized');
assert.equal(glBySha.gl13.state, 'failure', 'an unsettled pointer outranks an earlier unreadable one');
assert.equal(glBySha.gl13.description, unsettledHint('core'));
assert.equal(glBySha.gl17.state, 'failure', 'an unsettled pointer outranks a later unreadable one');
assert.equal(glBySha.gl14.state, 'failure', 'a newly added submodule is checked like a moved one');
assert.equal(glBySha.gl15.state, 'pending');
assert.equal(glBySha.gl15.description, 'Cannot read HarperFast/flaky branches (500)');
assert.equal(glBySha.gl16.state, 'pending', 'path-traversal submodule URL is never looked up');
assert.equal(glBySha.gl16.description, 'Cannot resolve the GitHub repo of submodule vendor/evil');
assert.equal(glBySha.gl18.description, 'Cannot resolve the GitHub repo of submodule vendor/look');
assert.deepEqual(
	[...new Set(gl.calls.getBranch.map((b) => b.split(':')[0]))].sort(),
	['HarperFast/.github', 'HarperFast/flaky', 'HarperFast/harper'],
	'only well-formed GitHub submodule repos are queried'
);
assert.equal(
	glBySha.gl28.description,
	'Cannot read HarperFast/.github branches (404)',
	'a leading-dot repo name is a real repo'
);
assert.equal(glBySha.gl19.state, 'failure', 'a gitlink with no patch is found through the head tree');
assert.equal(glBySha.gl20.state, 'success', 'patchless regular files are not gitlinks');
assert.ok(gl.calls.getTree.includes('gl20'));
assert.ok(!gl.calls.getContent.some((c) => c.endsWith('@gl20')), 'regular files never reach the contents API');
assert.equal(glBySha.gl25.state, 'pending', 'a truncated head tree certifies nothing');
assert.equal(glBySha.gl25.description, 'Cannot check submodule pointers: PR head tree truncated');
assert.equal(glBySha.gl26.state, 'failure', 'a proven unsettled pointer outranks an unreadable head tree');
assert.equal(glBySha.gl27.state, 'pending');
assert.equal(glBySha.gl27.description, 'Cannot read the PR head tree (500)');
assert.equal(glBySha.gl21.state, 'failure', 'gitlink past the first page is found');
assert.equal(gl.calls.listFiles.filter((n) => n === 821).length, 2);
assert.equal(glBySha.gl22.state, 'pending', 'a listing at the API ceiling may be incomplete');
assert.equal(glBySha.gl22.description, "Cannot check submodule pointers past GitHub's 3000-file PR listing");
assert.equal(glBySha.gl23.state, 'pending', 'an unknown compare status certifies nothing');
assert.equal(glBySha.gl23.description, 'Cannot check core against HarperFast/harper main (compare status weird)');
assert.equal(glBySha.gl24.state, 'failure');
assert.equal(glBySha.gl24.description, unsettledHint('modules/core'));
assert.equal(gl.core.failed, undefined, 'gitlink lookups never throw out of the PR loop');
assert.ok(gl.posted.every((s) => s.description.length <= 140));

// --- no marker, no gitlink: exactly one files listing per PR, nothing else ---
const plain = makeEnv('schedule', [pr(803, 'doc', 'gl3'), pr(804, 'drop', 'gl4'), pr(830, 'code', 'pl0')]);
const plainBySha = await run(plain);
assert.ok(['gl3', 'gl4', 'pl0'].every((sha) => plainBySha[sha].state === 'success'));
assert.deepEqual(plain.calls.listFiles, [803, 804, 830]);
assert.ok(
	Object.entries(plain.calls).every(([name, c]) => name === 'listFiles' || !c.length),
	'no submodule lookups without a kept gitlink'
);

// --- pull_request_target: undeclared unsettled move fails on the event too ---
const glEvt = makeEnv('pull_request_target', [], pr(800, 'Bumps core', 'gl0'));
assert.equal((await run(glEvt)).gl0.state, 'failure');

// --- a failed refresh of a no-marker PR also downgrades to pending ---
const glErr = makeEnv('pull_request_target', [], pr(802, 'routine core bump', 'gl2'));
glErr.github.rest.repos.listCommitStatusesForRef = async () => {
	throw new Error('api down');
};
const glErrBySha = await run(glErr);
assert.equal(glErrBySha.gl2.state, 'pending', 'a stale success must not survive a failed refresh');
assert.match(glErr.core.failed, /1 PR/);

// --- sweep race guard: base retargeted between list and post -> skip ---
const retarget = makeEnv('schedule', [pr(802, 'routine core bump', 'gl2')]);
const retargetGet = retarget.github.rest.pulls.get;
retarget.github.rest.pulls.get = async (args) =>
	args.repo === 'documentation' ? { data: pr(802, 'routine core bump', 'gl2', {}, 'v5.3') } : retargetGet(args);
assert.equal((await run(retarget)).gl2, undefined, 'sweep must not post a verdict for the old base');

// --- pull_request_target: no-marker PR gets success, no sweep re-read ---
const evt = makeEnv('pull_request_target', [], pr(700, 'plain', 'bbb'));
const evtBySha = await run(evt);
assert.equal(evtBySha.bbb.state, 'success');
assert.equal(evtBySha.bbb.description, 'No companion dependencies');
assert.equal(evtBySha.bbb.request?.retries, undefined, 'event writes keep the client retry defaults');

// --- sweep race guard: body changed between list and post -> skip ---
const stale = pr(720, 'Depends-on: HarperFast/harper#2147', 'kkk');
const race = makeEnv('schedule', [stale]);
const origGet = race.github.rest.pulls.get;
race.github.rest.pulls.get = async (args) =>
	args.repo === 'documentation' ? { data: pr(720, 'edited body', 'kkk') } : origGet(args);
const raceBySha = await run(race);
assert.equal(raceBySha.kkk, undefined, 'sweep must not post over a changed PR');

// --- error mid-PR must downgrade a would-be-stale status to pending ---
const errEnv = makeEnv('pull_request_target', [], pr(721, 'Depends-on: HarperFast/harper#2147', 'err1'));
errEnv.github.rest.repos.listCommitStatusesForRef = async () => {
	throw new Error('api down');
};
const errBySha = await run(errEnv);
assert.equal(errBySha.err1.state, 'pending', 'failed refresh posts pending, not silence');
assert.match(errBySha.err1.description, /errored/);
assert.match(errEnv.core.failed, /1 PR/);

// --- sweep: a failed verdict write falls back to a retried pending ---
const writeErr = makeEnv('schedule', [pr(722, 'plain', 'err2')]);
const writes = writeErr.posted;
writeErr.github.rest.repos.createCommitStatus = async (s) => {
	if (s.state !== 'pending') throw Object.assign(new Error('Service Unavailable'), { status: 503 });
	writes.push(s);
};
const writeErrBySha = await run(writeErr);
assert.equal(writeErrBySha.err2.state, 'pending', 'failed sweep write must not leave the old verdict');
assert.equal(writeErrBySha.err2.request?.retries, undefined, 'pending fallback keeps the client retries');
assert.match(writeErr.core.failed, /1 PR/);

// --- secret guards ---
process.env.COMPANION_CHECK_TOKEN = 'tok';
let fetched = [];
globalThis.fetch = async (url) => (fetched.push(url), { ok: false, status: 404 });

// foreign org: secret withheld
const foreign = makeEnv('pull_request_target', [], pr(730, 'Depends-on: HarperFast/../evil#1', 'lll'));
await run(foreign); // traversal caught in parse; now a clean foreign ref:
const foreign2 = makeEnv('pull_request_target', [], {
	number: 731,
	body: 'Depends-on: https://github.com/evilorg/private/pull/1',
	head: { sha: 'mmm', repo: { full_name: OWN } },
});
const foreignBySha = await run(foreign2);
assert.equal(fetched.length, 0, 'secret must not be sent for foreign orgs');
assert.equal(foreignBySha.mmm.state, 'failure');

// fork PR: secret withheld even for same-org refs
fetched = [];
const fork = makeEnv('pull_request_target', [], {
	number: 732,
	body: 'Depends-on: HarperFast/harper-pro#512',
	head: { sha: 'nnn', repo: { full_name: 'outsider/documentation' } },
});
const forkBySha = await run(fork);
assert.equal(fetched.length, 0, 'secret must not be sent for fork PRs');
assert.equal(forkBySha.nnn.state, 'failure', 'blocks without leaking; message explains');

// non-fork same-org: secret used; token-confirmed 404 -> failure
fetched = [];
const typo = makeEnv('pull_request_target', [], pr(733, 'Depends-on: HarperFast/ghost#1', 'ooo'));
const typoBySha = await run(typo);
assert.equal(fetched.length, 1, 'secret used for same-org non-fork refs');
assert.equal(typoBySha.ooo.state, 'failure', 'token-confirmed 404 fails, not pending');
assert.match(typoBySha.ooo.description, /not found/);

// fork PR moving a gitlink: submodule lookups never use the secret
fetched = [];
const forkGitlink = makeEnv('pull_request_target', [], {
	...pr(800, 'Bumps core', 'gl0'),
	head: { sha: 'gl0', repo: { full_name: 'outsider/documentation' } },
});
assert.equal((await run(forkGitlink)).gl0.state, 'failure');
assert.equal(fetched.length, 0, 'secret never sent for submodule lookups');
process.env.COMPANION_CHECK_TOKEN = '';

console.log('PASS: all companion-check scenarios correct');
