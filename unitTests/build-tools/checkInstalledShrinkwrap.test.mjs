import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = resolve(dirname(fileURLToPath(import.meta.url)), '../../build-tools/check-installed-shrinkwrap.mjs');

const shrinkwrapPackages = {
	'': { name: 'pkg', version: '1.0.0' },
	'node_modules/msgpackr': { version: '2.0.4' },
	'node_modules/@scope/lib': { version: '1.2.3' },
	'node_modules/@scope/lib/node_modules/msgpackr': { version: '1.11.0' },
	'node_modules/fsevents': { version: '2.3.3', optional: true },
	'node_modules/babel-jest': { version: '29.7.0', devOptional: true },
};

describe('check-installed-shrinkwrap', function () {
	let packageDir;

	beforeEach(async function () {
		packageDir = await mkdtemp(join(tmpdir(), 'harper-pro-installed-shrinkwrap-'));
		await writeFile(
			join(packageDir, 'npm-shrinkwrap.json'),
			JSON.stringify({ lockfileVersion: 3, packages: shrinkwrapPackages })
		);
		await install('node_modules/msgpackr', '2.0.4');
		await install('node_modules/@scope/lib', '1.2.3');
		await install('node_modules/@scope/lib/node_modules/msgpackr', '1.11.0');
	});

	afterEach(async function () {
		await rm(packageDir, { recursive: true, force: true });
	});

	async function install(key, version) {
		await mkdir(join(packageDir, key), { recursive: true });
		await writeFile(join(packageDir, key, 'package.json'), JSON.stringify({ version }));
	}

	function check() {
		return spawnSync(process.execPath, [checker, packageDir], { encoding: 'utf8' });
	}

	it('passes when the tree matches, allowing absent optional entries', function () {
		const result = check();
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /3 installed packages match/);
		assert.match(result.stdout, /node_modules\/fsevents, node_modules\/babel-jest/);
	});

	for (const [description, key, version] of [
		['a direct dependency', 'node_modules/msgpackr', '2.1.2'],
		['a scoped dependency', 'node_modules/@scope/lib', '1.3.0'],
		['a nested dependency', 'node_modules/@scope/lib/node_modules/msgpackr', '1.11.5'],
		['a present optional dependency', 'node_modules/fsevents', '2.3.2'],
	]) {
		it(`fails when ${description} drifts`, async function () {
			await install(key, version);
			const result = check();
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, new RegExp(`version: ${key} is ${version.replaceAll('.', '\\.')}`));
		});
	}

	it('fails on a package the shrinkwrap does not list', async function () {
		await install('node_modules/structon', '1.1.1');
		const result = check();
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /extra: node_modules\/structon@1\.1\.1/);
	});

	it('fails on a missing required package', async function () {
		await rm(join(packageDir, 'node_modules/@scope/lib/node_modules'), { recursive: true });
		const result = check();
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /missing: node_modules\/@scope\/lib\/node_modules\/msgpackr@1\.11\.0/);
	});

	it('fails on a symlinked package', async function () {
		await rm(join(packageDir, 'node_modules/msgpackr'), { recursive: true });
		await symlink(
			join(packageDir, 'node_modules/@scope/lib/node_modules/msgpackr'),
			join(packageDir, 'node_modules/msgpackr')
		);
		const result = check();
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /not a package directory: node_modules\/msgpackr/);
	});

	it('fails on a malformed package manifest', async function () {
		await writeFile(join(packageDir, 'node_modules/msgpackr/package.json'), '{"version":');
		assert.notStrictEqual(check().status, 0);
	});

	it('fails on an unsupported shrinkwrap', async function () {
		await writeFile(join(packageDir, 'npm-shrinkwrap.json'), JSON.stringify({ lockfileVersion: 1, dependencies: {} }));
		const result = check();
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /unsupported npm-shrinkwrap\.json/);
	});
});
