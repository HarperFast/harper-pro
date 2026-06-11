/**
 * Smoke-test runner. Globs smokeTests/components/*.smoke.mjs and runs them serially.
 *
 * Usage:
 *   node smokeTests/run-smoke.mjs
 *   node smokeTests/run-smoke.mjs --component=redirector
 */
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { parseArgs } from 'node:util';
import { COMPONENT_NAMES } from './manifest.mjs';

const { values } = parseArgs({
	options: { component: { type: 'string' } },
	allowPositionals: true,
});

let globPatterns;
const component = values.component;
if (component && component !== 'all') {
	if (!COMPONENT_NAMES.includes(component)) {
		console.error(`Unknown component "${component}". Known: ${COMPONENT_NAMES.join(', ')}, all`);
		process.exit(2);
	}
	globPatterns = [`smokeTests/components/${component}.smoke.mjs`];
} else {
	globPatterns = ['smokeTests/components/*.smoke.mjs'];
}

// concurrency 1: each suite stands up its own cluster; loopback addresses and ports must not contend.
const stream = run({
	concurrency: 1,
	isolation: 'process',
	globPatterns,
});

stream.on('test:fail', () => {
	process.exitCode = 1;
});

stream.on('end', () => {
	process.exit(process.exitCode || 0);
});

stream.compose(spec).pipe(process.stdout);
