/**
 * Stress-test runner. Globs stressTests/components/*.stress.mjs and runs them serially.
 * Heavy: ~6 min per k6 component, up to 10 min for acl-connect. Use test:smoke for nightly.
 *
 * Usage:
 *   node stressTests/run-stress.mjs
 *   node stressTests/run-stress.mjs --component=redirector
 */
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { parseArgs } from 'node:util';
import { COMPONENT_NAMES } from '../smokeTests/manifest.mjs';

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
	globPatterns = [`stressTests/components/${component}.stress.mjs`];
} else {
	globPatterns = ['stressTests/components/*.stress.mjs'];
}

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
