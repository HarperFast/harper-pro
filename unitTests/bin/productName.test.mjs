/**
 * Harper Pro's local CLI, installer, and lifecycle messages name the product through core's
 * PRODUCT_NAME, which core's packageUtils reads from the nearest package.json above it. For the
 * compiled core that is Harper Pro's root manifest only while the package ships no other
 * package.json on that path — a dist/core/package.json would silently rebrand them "Harper".
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('Harper Pro product name', () => {
	it('is the PRODUCT_NAME of the compiled core', () => {
		const { PRODUCT_NAME } = createRequire(import.meta.url)(join(REPO_ROOT, 'dist/core/utility/packageUtils.js'));
		assert.equal(PRODUCT_NAME, 'Harper Pro');
	});

	it('is not shadowed by another package.json in the published package', function () {
		this.timeout(60_000);
		const [{ files }] = JSON.parse(
			execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: REPO_ROOT, encoding: 'utf8' })
		);
		const manifests = files.map(({ path }) => path).filter((path) => /(^|\/)package\.json$/.test(path));
		assert.deepEqual(manifests, ['package.json']);
	});
});
