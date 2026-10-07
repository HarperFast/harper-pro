// Core names the product from the nearest package.json above its packageUtils.js; a shipped
// manifest on that path (e.g. dist/core/package.json) would silently rebrand Harper Pro as "Harper".
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('Harper Pro product name', () => {
	it('is the PRODUCT_NAME of the compiled core', () => {
		const { PRODUCT_NAME } = createRequire(import.meta.url)(join(REPO_ROOT, 'dist/core/utility/packageUtils.js'));
		assert.equal(PRODUCT_NAME, 'Harper Pro');
	});

	it('names the product in the CLI output', function () {
		this.timeout(30_000);
		const home = mkdtempSync(join(tmpdir(), 'harper-pro-help-'));
		try {
			const output = execFileSync(process.execPath, [join(REPO_ROOT, 'dist/bin/harper.js'), 'help'], {
				encoding: 'utf8',
				env: { ...process.env, HOME: home },
				timeout: 25_000,
			});
			assert.match(output, /harper will simply run Harper Pro \(in the foreground\)/);
		} finally {
			rmSync(home, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	it('is not shadowed by a package.json the published core resolves first', function () {
		this.timeout(60_000);
		const [{ files }] = JSON.parse(
			execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
				cwd: REPO_ROOT,
				encoding: 'utf8',
				timeout: 55_000,
			})
		);
		const lookupPath = [
			'dist/core/utility/package.json',
			'dist/core/package.json',
			'dist/package.json',
			'core/utility/package.json',
			'core/package.json',
		];
		assert.deepEqual(
			files.map(({ path }) => path).filter((path) => lookupPath.includes(path)),
			[]
		);
	});
});
