'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// Minimal environment setup required before Harper modules are loaded.
// Harper's auth and database modules initialize storage at import time,
// so these env vars must be set before the ESM test files are evaluated.
const testDir = path.join(os.tmpdir(), `harper-unit-tests-${process.pid}`);
fs.mkdirSync(testDir, { recursive: true });

process.env.STORAGE_PATH = testDir;
process.env._DISABLE_NATS = 'true';
process.env.LOGGING_STDSTREAMS = 'false';

process.on('exit', () => fs.rmSync(testDir, { recursive: true, force: true }));
