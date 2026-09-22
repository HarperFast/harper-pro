'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Minimal environment setup required before Harper modules are loaded.
// Harper's auth and database modules initialize storage at import time,
// so these env vars must be set before the ESM test files are evaluated.
const testDir = path.join(os.tmpdir(), `harper-unit-tests-${process.pid}`);
// A run killed before its afterAll hook leaves this root behind, and PIDs are reused, so a run
// that inherited one would open a dead run's databases.
fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

process.env.STORAGE_PATH = testDir;
process.env._DISABLE_NATS = 'true';
process.env.LOGGING_STDSTREAMS = 'false';

function removeTestDir() {
	try {
		fs.rmSync(testDir, { recursive: true, force: true });
	} catch (error) {
		// Never throw from an 'exit' listener: it replaces the run's real result with an opaque
		// non-zero exit. The next run clears this root before it creates one.
		fs.writeSync(2, `could not remove the unit-test root ${testDir}: ${error.message}\n`);
	}
}

module.exports.mochaHooks = {
	// Registered here rather than at preload time: 'exit' listeners fire in registration order, and
	// the listener that flushes and closes every open database (RocksTransactionLogStore's
	// shutdown()) is registered when the data layer loads, which is after this preload and before
	// this hook. Removing the root any earlier deletes the database files out from under that flush.
	afterAll() {
		process.on('exit', removeTestDir);
	},
};
