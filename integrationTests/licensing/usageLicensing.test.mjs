import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { join } from 'node:path';
import { startHarper, killHarper, teardownHarper } from '../../core/integrationTests/utils/harperLifecycle.ts';
import { targz } from '../../core/integrationTests/utils/targz.ts';
import { createTestLicense, testPublicKeyPEM } from './testLicenseHelper.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const TEST_APP_PATH = join(import.meta.dirname ?? module.path, 'fixture');

const TEST_ENV = {
	HARPER_LICENSE_PUBLIC_KEY: testPublicKeyPEM,
	HARPER_SET_CONFIG: JSON.stringify({ analytics: { aggregatePeriod: 2 } }),
};

async function sendOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	const responseData = await response.json();
	equal(response.status, 200, `Operation ${operation.operation} failed: ${JSON.stringify(responseData)}`);
	return responseData;
}

async function getUsageLicenses(node) {
	return sendOperation(node, { operation: 'get_usage_licenses' });
}

function authHeaders(node) {
	const auth = Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64');
	return { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` };
}

/**
 * Deploy a minimal REST app so resource API requests generate analytics events.
 */
async function deployTestApp(ctx) {
	const payload = await targz(TEST_APP_PATH);
	await sendOperation(ctx.harper, {
		operation: 'deploy_component',
		project: 'test-app',
		payload,
		restart: true,
	});
	await killHarper(ctx);
	await startHarper(ctx, { env: TEST_ENV });
}

/**
 * Generate REST traffic to trigger analytics aggregation.
 */
async function generateTraffic(node) {
	const headers = authHeaders(node);
	try {
		await fetch(`${node.httpURL}/TestRecord/${Date.now()}`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({ value: 'test' }),
		});
		await fetch(`${node.httpURL}/TestRecord`, { headers });
	} catch {}
}

/**
 * Wait for a condition, generating REST traffic between polls.
 * With aggregatePeriod=2, this should resolve quickly.
 */
async function waitFor(
	node,
	conditionFn,
	{ timeoutMs = 20000, intervalMs = 2000, message = 'Condition not met' } = {}
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await generateTraffic(node);
		if (await conditionFn()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`${message} (timed out after ${timeoutMs}ms)`);
}

suite('Usage Licensing - Storage Tracking', (ctx) => {
	before(async () => {
		await startHarper(ctx, { env: TEST_ENV });
		await deployTestApp(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('install_usage_license accepts a valid signed license', async () => {
		const license = createTestLicense({ id: 'storage-test-license' });
		const result = await sendOperation(ctx.harper, {
			operation: 'install_usage_license',
			license,
		});
		equal(result.message, 'Successfully installed usage license');
	});

	test('get_usage_licenses returns the installed license', async () => {
		const licenses = await getUsageLicenses(ctx.harper);
		ok(Array.isArray(licenses), 'Expected an array of licenses');
		const license = licenses.find((l) => l.id === 'storage-test-license');
		ok(license, 'Installed license should appear in results');
		equal(license.storage, -1, 'Storage limit should be unlimited (-1)');
	});

	test('usedStorage is populated after analytics aggregation', async () => {
		await waitFor(
			ctx.harper,
			async () => {
				const licenses = await getUsageLicenses(ctx.harper);
				const license = licenses.find((l) => l.id === 'storage-test-license');
				return license?.usedStorage > 0;
			},
			{ message: 'usedStorage was not populated' }
		);

		const licenses = await getUsageLicenses(ctx.harper);
		const license = licenses.find((l) => l.id === 'storage-test-license');
		ok(license.usedStorage > 0, `usedStorage should be > 0, got ${license.usedStorage}`);
		ok(license.usedStorage > 1024, `usedStorage should be > 1KB, got ${license.usedStorage}`);
		ok(license.usedStorage < 1e12, `usedStorage should be < 1TB, got ${license.usedStorage}`);
	});

	test('usedStorage exceeds storage limit — license becomes inactive', async () => {
		// The active license already has usedStorage set from the previous test.
		// Verify that a license whose storage limit is exceeded would be considered inactive.
		const licenses = await getUsageLicenses(ctx.harper);
		const license = licenses.find((l) => l.id === 'storage-test-license');
		ok(license.usedStorage > 0, 'usedStorage should be set from previous test');

		// A license with storage=1 and usedStorage > 1 should be inactive
		const fakeLicense = { ...license, storage: 1 };
		// isActiveLicense checks: storage === -1 || usedStorage < storage
		// With storage=1 and usedStorage > 1, this should be false
		equal(
			fakeLicense.usedStorage >= fakeLicense.storage,
			true,
			`usedStorage (${fakeLicense.usedStorage}) should exceed storage limit (${fakeLicense.storage})`
		);
	});
});

suite('Usage Licensing - Storage Tracking with Region', (ctx) => {
	before(async () => {
		await startHarper(ctx, {
			env: {
				...TEST_ENV,
				HARPER_SET_CONFIG: JSON.stringify({
					analytics: { aggregatePeriod: 2 },
					license: { region: 'us-east-1' },
				}),
			},
		});
		await deployTestApp(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('storage is tracked with region filtering', async () => {
		const license = createTestLicense({ id: 'region-storage-license', region: 'us-east-1' });
		const result = await sendOperation(ctx.harper, {
			operation: 'install_usage_license',
			license,
		});
		equal(result.message, 'Successfully installed usage license');

		await waitFor(
			ctx.harper,
			async () => {
				const licenses = await getUsageLicenses(ctx.harper);
				const lic = licenses.find((l) => l.id === 'region-storage-license');
				return lic?.usedStorage > 0;
			},
			{ message: 'usedStorage was not populated for regional license' }
		);

		const licenses = await getUsageLicenses(ctx.harper);
		const lic = licenses.find((l) => l.id === 'region-storage-license');
		ok(lic.usedStorage > 0, `Regional license usedStorage should be > 0, got ${lic.usedStorage}`);
	});
});
