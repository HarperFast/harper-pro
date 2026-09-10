/**
 * Regression guard for the secretCustody bug (#560): `bin/harper.js` registers a set of
 * built-in components via HARPER_BUILTIN_COMPONENTS, but componentLoader.ts only loads a root
 * component whose config key is truthy (`if (!config[componentName]) continue;`). A built-in
 * with no matching key in static/defaultConfig.yaml silently never runs its startOnMainThread --
 * no error, no log line, nothing. This asserts every built-in named in bin/harper.js has a
 * truthy key in the default config template, so the same class of bug can't recur unnoticed for
 * a future built-in.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function getBuiltinComponentNames() {
	const source = readFileSync(join(REPO_ROOT, 'bin', 'harper.js'), 'utf8');
	// Matches the single-quoted `name=packageIdentifier,name=packageIdentifier,...` literal
	// assigned to HARPER_BUILTIN_COMPONENTS -- deliberately not executing the file, which has
	// process-level side effects (cloneNode / harper() startup) unsafe to trigger in a unit test.
	const match = source.match(/HARPER_BUILTIN_COMPONENTS\s*=[\s\S]*?'([\w.@/=,-]+)';/);
	assert.ok(match, 'Could not find the HARPER_BUILTIN_COMPONENTS string literal in bin/harper.js');
	return match[1].split(',').map((entry) => entry.split('=')[0]);
}

describe('built-in components have a default config key', () => {
	it('every HARPER_BUILTIN_COMPONENTS name has a truthy key in static/defaultConfig.yaml', () => {
		const builtinNames = getBuiltinComponentNames();
		assert.ok(builtinNames.length > 0, 'Expected at least one built-in component name');

		const defaultConfig = yaml.parse(readFileSync(join(REPO_ROOT, 'static', 'defaultConfig.yaml'), 'utf8'));

		for (const name of builtinNames) {
			assert.ok(
				defaultConfig[name],
				`Built-in component '${name}' (registered in bin/harper.js) has no truthy key in ` +
					`static/defaultConfig.yaml -- componentLoader.ts's \`if (!config[componentName]) continue;\` ` +
					`will silently skip loading it and its startOnMainThread will never run.`
			);
		}
	});
});
