import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The packages core's own startupDependencies test defers, plus the full lodash build.
const DEFERRED_PACKAGES = [
	'lmdb',
	'pkijs',
	'asn1js',
	'easy-ocsp',
	'node-forge',
	'systeminformation',
	'moment',
	'lodash (full build)',
];

describe('startup dependencies', function () {
	this.timeout(120000);

	let storagePath;
	before(() => {
		storagePath = mkdtempSync(join(tmpdir(), 'startup-dependencies-'));
	});
	after(() => {
		if (storagePath) rmSync(storagePath, { recursive: true, force: true });
	});

	it('loading the built-in components does not load packages that are loaded on first use', () => {
		const result = spawnSync(
			process.execPath,
			[...process.execArgv, fileURLToPath(new URL('./fixtures/startupDependencies.cjs', import.meta.url))],
			{
				encoding: 'utf8',
				timeout: 110000,
				// its own storage root, since the suite's databases hold RocksDB locks; and RocksDB, since the
				// storage opened at load would otherwise load lmdb under HARPER_STORAGE_ENGINE=lmdb
				env: { ...process.env, STORAGE_PATH: storagePath, HARPER_STORAGE_ENGINE: 'rocksdb' },
			}
		);
		assert.equal(result.status, 0, result.stderr);
		const loaded = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('[')));
		assert.deepEqual(
			DEFERRED_PACKAGES.filter((name) => loaded.includes(name)),
			[]
		);
	});
});
