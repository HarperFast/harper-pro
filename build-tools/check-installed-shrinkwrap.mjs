#!/usr/bin/env node
// Fail unless the dependency tree installed in a package directory is exactly the one its
// npm-shrinkwrap.json records: the same package paths at the same versions. A lock entry marked
// optional may be absent: npm skips it on an os/cpu/libc mismatch or a failed native build.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageDir = process.argv[2];
if (!packageDir) throw new Error('usage: check-installed-shrinkwrap.mjs <package dir>');

const lock = JSON.parse(readFileSync(join(packageDir, 'npm-shrinkwrap.json'), 'utf8'));
if (!(lock.lockfileVersion >= 2) || !lock.packages?.['']) {
	throw new Error(`unsupported npm-shrinkwrap.json: expected lockfileVersion >= 2 with a "packages" map`);
}

const installed = new Map();
const problems = [];

function collect(nodeModulesKey) {
	let entries;
	try {
		entries = readdirSync(join(packageDir, nodeModulesKey), { withFileTypes: true });
	} catch (error) {
		if (error.code === 'ENOENT') return;
		throw error;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		if (entry.name.startsWith('@') && entry.isDirectory()) {
			for (const scoped of readdirSync(join(packageDir, nodeModulesKey, entry.name))) {
				collectPackage(`${nodeModulesKey}/${entry.name}/${scoped}`);
			}
		} else {
			collectPackage(`${nodeModulesKey}/${entry.name}`);
		}
	}
}

function collectPackage(key) {
	if (!lstatSync(join(packageDir, key)).isDirectory()) {
		problems.push(`not a package directory: ${key}`);
		return;
	}
	const { version } = JSON.parse(readFileSync(join(packageDir, key, 'package.json'), 'utf8'));
	installed.set(key, version);
	collect(`${key}/node_modules`);
}

collect('node_modules');

for (const [key, version] of installed) {
	const expected = lock.packages[key];
	if (!expected) problems.push(`extra: ${key}@${version}`);
	else if (expected.version !== version)
		problems.push(`version: ${key} is ${version}, shrinkwrap has ${expected.version}`);
}
const skippedOptional = [];
for (const [key, expected] of Object.entries(lock.packages)) {
	if (key === '' || installed.has(key)) continue;
	if (expected.optional || expected.devOptional) skippedOptional.push(key);
	else problems.push(`missing: ${key}@${expected.version}`);
}

if (skippedOptional.length > 0) console.log(`Optional, not installed: ${skippedOptional.join(', ')}`);
if (problems.length > 0) {
	console.error(`Installed dependencies differ from npm-shrinkwrap.json in ${packageDir}:`);
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}
console.log(`${installed.size} installed packages match npm-shrinkwrap.json`);
