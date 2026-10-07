'use strict';

// Runs in a fresh process so nothing another test loaded is already in the require cache.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const harperBin = readFileSync(join(__dirname, '..', '..', 'bin', 'harper.js'), 'utf8');
const builtIns = harperBin.match(/HARPER_BUILTIN_COMPONENTS\s*=[\s\S]*?'([\w.@/=,-]+)';/)[1].split(',');
for (const entry of builtIns) {
	const distPath = entry.split('=')[1].match(/^@\/dist\/(.+)\.js$/);
	if (!distPath) throw new Error(`Unexpected built-in component identifier: ${entry}`);
	require(`#src/${distPath[1]}`);
}
const packages = new Set();
for (const path of Object.keys(require.cache)) {
	const match = path.match(/.*[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/](.*)$/);
	if (match) packages.add(match[2] === 'lodash.js' ? 'lodash (full build)' : match[1].replace('\\', '/'));
}
process.stdout.write(JSON.stringify([...packages]), () => process.exit(0));
