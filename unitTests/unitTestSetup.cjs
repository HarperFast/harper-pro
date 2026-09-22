'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Minimal environment setup required before Harper modules are loaded.
// Harper's auth and database modules initialize storage at import time,
// so these env vars must be set before the ESM test files are evaluated.
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-unit-tests-'));

process.env.STORAGE_PATH = testDir;
process.env._DISABLE_NATS = 'true';
process.env.LOGGING_STDSTREAMS = 'false';
// The whole unit-test run is one process, so RocksTransactionLogStore's own `exit` listener
// (registered the first time any test imports it) fires AFTER this one and tries to flush
// every still-known RocksDB log into a directory this listener already removed. Unit tests
// close their own databases explicitly; the exit-time safety flush is for crash/replay
// coverage (see integrationTests), which this suite doesn't exercise.
process.env.HARPER_NO_FLUSH_ON_EXIT = 'true';

function removeTestDir() {
	try {
		fs.rmSync(testDir, { recursive: true, force: true });
	} catch (error) {
		// Nothing below may throw either: an exception out of an 'exit' listener replaces the run's
		// real result with an opaque non-zero exit.
		try {
			fs.writeSync(2, `could not remove the unit-test root ${testDir}: ${error.message}\n`);
		} catch {}
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
