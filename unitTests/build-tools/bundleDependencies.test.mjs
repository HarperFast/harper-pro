import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundlePlan } from '../../core/build-tools/bundleDependencies.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lockFile = join(root, 'package-lock.json');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

describe('harper-pro release dependency bundle', function () {
	this.timeout(60_000);
	let lock;
	let manifest;

	beforeEach(() => {
		lock = readJson(lockFile);
		manifest = readJson(join(root, 'package.json'));
	});

	it('keeps the pro-only native roots out of the bundle at their locked versions', () => {
		const plan = bundlePlan(lock);
		for (const name of ['re2', '@datadog/pprof']) {
			assert.ok(manifest.dependencies[name], `${name} is a production dependency`);
			assert.ok(!plan.roots.includes(name));
			assert.strictEqual(plan.external[name], lock.packages[`node_modules/${name}`].version);
			assert.ok(![...plan.packages].some((key) => key.endsWith(`node_modules/${name}`)));
		}
		for (const name of ['@aws-sdk/client-s3', '@aws-sdk/lib-storage', 'inquirer', 'prompt']) {
			assert.ok(plan.roots.includes(name), `${name} is bundled`);
		}
		for (const name of Object.keys(manifest.optionalDependencies)) {
			assert.strictEqual(plan.external[name], lock.packages[`node_modules/${name}`].version);
		}
	});

	it('bundles no package the lock marks as native or platform-specific on any platform', () => {
		const plan = bundlePlan(lock);
		const platformSpecific = Object.entries(lock.packages).filter(
			([key, entry]) => key && (entry.os || entry.cpu || entry.libc || entry.hasInstallScript || entry.engines?.bare)
		);
		assert.ok(
			platformSpecific.some(([key]) => key.includes('win32')),
			'the lock records foreign-platform packages'
		);
		for (const [key] of platformSpecific) assert.ok(!plan.packages.has(key), `${key} is not bundled`);
	});

	it('keeps uWebSockets.js an opt-in peer that the bundle never captures', () => {
		assert.strictEqual(manifest.dependencies['uWebSockets.js'], undefined);
		assert.strictEqual(manifest.optionalDependencies['uWebSockets.js'], undefined);
		assert.strictEqual(manifest.peerDependencies['uWebSockets.js'], '20.68.0');
		assert.strictEqual(manifest.peerDependenciesMeta['uWebSockets.js'].optional, true);
		assert.ok(!bundlePlan(lock).packages.has('node_modules/uWebSockets.js'));
	});

	it('declares no shipped package as a devDependency, so the lock resolves the published declaration', () => {
		for (const declared of [manifest, lock.packages['']]) {
			const shipped = Object.keys({ ...declared.dependencies, ...declared.optionalDependencies });
			assert.deepStrictEqual(
				shipped.filter((name) => declared.devDependencies?.[name] !== undefined),
				[]
			);
		}
	});

	it('fails the plan when a storage engine stops declaring a shared module', () => {
		delete lock.packages['node_modules/@harperfast/rocksdb-js'].dependencies.msgpackr;
		assert.throws(() => bundlePlan(lock), /@harperfast\/rocksdb-js no longer declares msgpackr/);
	});

	describe('checker CLI', () => {
		let directory;
		beforeEach(() => {
			directory = mkdtempSync(join(tmpdir(), 'harper-pro-bundle-'));
		});
		afterEach(() => rmSync(directory, { recursive: true, force: true }));

		for (const flags of [[], ['--preserve-symlinks-main']]) {
			it(`validates when invoked through a linked path ${flags.join(' ')}`, () => {
				const release = join(directory, 'release');
				mkdirSync(release);
				writeFileSync(
					join(release, 'package.json'),
					JSON.stringify({
						name: manifest.name,
						version: lock.packages[''].version,
						dependencies: manifest.dependencies,
					})
				);
				const linked = join(directory, 'linked-tools');
				symlinkSync(join(root, 'core/build-tools'), linked, 'junction');
				assert.throws(
					() =>
						execFileSync(
							process.execPath,
							[...flags, join(linked, 'bundleDependencies.ts'), 'check', release, lockFile],
							{ encoding: 'utf8', stdio: 'pipe' }
						),
					(error) => error.status !== 0 && error.stderr.includes('Release bundleDependencies differ')
				);
			});
		}
	});

	describe('sync-core', () => {
		let directory;
		beforeEach(() => {
			directory = mkdtempSync(join(tmpdir(), 'harper-pro-sync-'));
			mkdirSync(join(directory, 'core'));
		});
		afterEach(() => rmSync(directory, { recursive: true, force: true }));

		it('moves a devDependency spec onto the production entry instead of declaring the package twice', () => {
			writeFileSync(
				join(directory, 'core/package.json'),
				JSON.stringify({
					name: 'harper',
					dependencies: { shared: '1.0.0' },
					devDependencies: { 'lib-storage': '3.2.0', 'test-only': '^1.0.0' },
				})
			);
			writeFileSync(join(directory, 'core/package-lock.json'), '{}\n');
			writeFileSync(
				join(directory, 'package.json'),
				JSON.stringify({
					name: 'pro',
					dependencies: { 'shared': '0.9.0', 'lib-storage': '3.1.0', 'pro-only': '2.0.0' },
				})
			);
			execFileSync('bash', [join(root, 'build-tools/sync-core.sh'), '--skip-install'], {
				cwd: directory,
				env: { ...process.env, NO_USE_GIT: 'true' },
				stdio: 'pipe',
			});
			const synced = readJson(join(directory, 'package.json'));
			assert.deepStrictEqual(synced.dependencies, { 'shared': '1.0.0', 'lib-storage': '3.2.0', 'pro-only': '2.0.0' });
			assert.deepStrictEqual(synced.devDependencies, { 'test-only': '^1.0.0' });
		});
	});
});
