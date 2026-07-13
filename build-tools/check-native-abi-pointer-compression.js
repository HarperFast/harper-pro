#!/usr/bin/env node
/**
 * Pointer-compression ABI guard for native modules (harper#919).
 *
 * V8 pointer compression changes the V8 C++ ABI (object layouts in the public
 * headers), so any addon that links the raw V8 ABI — rather than Node-API,
 * which is ABI-stable — loads cleanly on a pointer-compression node but
 * segfaults on first use. This scans every .node file that could load on the
 * current runtime and fails if one references V8 C++ symbols without being
 * built for pointer compression.
 *
 * A file is considered safe when:
 *  - it has no undefined V8 C++ symbols (Node-API addons), or
 *  - it lives under build/ (source-built in this image: node-gyp derives its
 *    defines from the running node's process.config, so the ABI matches), or
 *  - its package directory carries a `.pointer-compression-build` marker
 *    (binaries swapped in by the pointer-compression image build).
 *
 * Files that cannot load here (other platform/arch, musl on glibc, mismatched
 * NODE_MODULE_VERSION in the filename) are skipped.
 *
 * Usage: node check-native-abi-pointer-compression.js <dir>
 */
const { execFileSync } = require('node:child_process');
const { readdirSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');

if (process.config.variables.v8_enable_pointer_compression !== 1) {
	console.error('not a pointer-compression node; nothing to check');
	process.exit(0);
}

const root = process.argv[2] || '.';

// The per-file nm failures below are tolerated (non-ELF files), so a missing nm
// binary must fail loudly here — otherwise the scan would silently check nothing.
try {
	execFileSync('nm', ['--version'], { stdio: 'ignore' });
} catch {
	console.error('nm (binutils) is required for the pointer-compression ABI check but was not found');
	process.exit(1);
}
const platform = process.platform; // linux
const arch = process.arch; // x64 | arm64
const abi = process.versions.modules; // e.g. 137
const otherArches = ['x64', 'arm64', 'arm', 'ia32', 'ppc64', 's390x', 'riscv64', 'loong64'].filter((a) => a !== arch);
const otherPlatforms = ['linux', 'darwin', 'win32', 'freebsd'].filter((p) => p !== platform);

function* walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(p);
		else if (entry.name.endsWith('.node')) yield p;
	}
}

function loadableHere(file) {
	// Portable separator between name segments in prebuild file/dir conventions:
	// uws_linux_x64_137.node, prebuilds/linux-x64/..., node.abi137.glibc.node
	const norm = file.replaceAll('\\', '/');
	if (otherPlatforms.some((p) => norm.includes(p))) return false;
	if (otherArches.some((a) => new RegExp(`[-_/.]${a}([-_./]|$)`).test(norm))) return false;
	if (norm.includes('musl')) return false; // glibc images
	const abiMatch = norm.match(/abi(\d+)/) || norm.match(/_(\d{3})\.node$/);
	if (abiMatch && abiMatch[1] !== abi) return false;
	return true;
}

const failures = [];
let checked = 0;
for (const file of walk(root)) {
	if (!loadableHere(file)) continue;
	if (/(^|\/)build\//.test(file.replaceAll('\\', '/'))) continue; // source-built in-image
	if (existsSync(join(dirname(file), '.pointer-compression-build'))) continue;
	// package-root markers (e.g. prebuilds/<platform-arch>/ layout keeps the marker at the package root)
	if (
		existsSync(join(dirname(file), '..', '.pointer-compression-build')) ||
		existsSync(join(dirname(file), '..', '..', '.pointer-compression-build'))
	)
		continue;
	checked++;
	let symbols;
	try {
		symbols = execFileSync('nm', ['-D', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	} catch {
		continue; // not a readable ELF for this platform
	}
	if (/ U _ZN2v8/.test(symbols)) failures.push(file);
}

if (failures.length) {
	console.error('Native modules linking the raw V8 ABI found in a pointer-compression image; these will');
	console.error('segfault at runtime. Rebuild them for pointer compression (and mark the package with');
	console.error('.pointer-compression-build) or remove them:');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
console.log(`pointer-compression ABI check passed (${checked} candidate .node files verified)`);
