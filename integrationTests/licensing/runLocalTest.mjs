#!/usr/bin/env node
/**
 * Starts Harper locally with a test license keypair for manual testing.
 * Run this, then in another terminal install the license and check usedStorage.
 */
import { createTestLicense, testPublicKeyPEM } from './testLicenseHelper.mjs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const license = createTestLicense({ id: 'local-test' });
const harperScript = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const rootPath = '/tmp/harper-local-test';

console.log('Starting Harper with test license keypair...');
console.log(`ROOTPATH: ${rootPath}`);
console.log();
console.log('Install the test license with:');
console.log(
	`  echo '${JSON.stringify({ operation: 'install_usage_license', license })}' | curl -s -X POST http://localhost:9925 -H "Content-Type: application/json" -d @-`
);
console.log();
console.log('Check usage licenses with:');
console.log(
	`  echo '${JSON.stringify({ operation: 'get_usage_licenses' })}' | curl -s -X POST http://localhost:9925 -H "Content-Type: application/json" -d @-`
);
console.log();

const harper = spawn('node', [harperScript, `--ROOTPATH=${rootPath}`, '--DEFAULTS_MODE=dev', '--LOGGING_LEVEL=trace'], {
	env: { ...process.env, HARPER_LICENSE_PUBLIC_KEY: testPublicKeyPEM },
	stdio: 'inherit',
});

harper.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => harper.kill('SIGINT'));
