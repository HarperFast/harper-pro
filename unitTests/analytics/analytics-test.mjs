import { assert } from 'chai';
import axios from 'axios';
import { setupTestApp } from '../setupTestApp.mjs';
import { captureProfile, userCodeFolders } from '#src/analytics/profile';
import analytics from '#src/core/resources/analytics/write';
import { spawn } from 'node:child_process';

describe('Analytics profiling user code', () => {
	before(async () => {
		await setupTestApp();
		analytics.setAnalyticsEnabled(true);
		analytics.analyticsDelay = 50; // let's make this fast
		userCodeFolders.push(new URL('../testApp/', import.meta.url).toString());
	});

	it('can sample user code and record it', async () => {
		await captureProfile(10000); // restart the profile
		const start = Date.now();
		let response = await axios.post('http://localhost:9926/SimpleCache/3', {
			doExpensiveComputation: true,
		});
		assert.equal(response.status, 204);
		await captureProfile();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const analyticsResults = await databases.system.hdb_raw_analytics.search({
			conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
		});
		let userUsageRecorded, harperUsageRecorded;
		for await (let { metrics } of analyticsResults) {
			userUsageRecorded ??= metrics.find(({ metric, path }) => metric === 'cpu-usage' && path === 'user');
			harperUsageRecorded ??= metrics.find(({ metric, path }) => metric === 'cpu-usage' && path === 'harper');
		}
		assert(userUsageRecorded, 'user cpu-usage was recorded in analytics');
		assert(harperUsageRecorded, 'harper cpu-usage was recorded in analytics');
	});

	it('can track child process CPU time', async () => {
		await captureProfile(10000); // restart the profile
		const start = Date.now();

		// Spawn child processes that consume CPU time
		const children = [];
		for (let i = 0; i < 3; i++) {
			const child = spawn('node', ['-e', 'const start = Date.now(); while (Date.now() - start < 200) {}']);
			children.push(child);
		}

		// Wait for children to complete
		await Promise.all(children.map((child) => new Promise((resolve) => child.on('exit', resolve))));
		// Capture profile after children have done work
		await captureProfile();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const analyticsResults = await databases.system.hdb_raw_analytics.search({
			conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
		});
		let childProcessTime = 0;
		for await (let { metrics } of analyticsResults) {
			for (let { metric, method, mean } of metrics) {
				if (metric === 'cpu-usage' && method === 'child-processes') {
					childProcessTime += mean;
				}
			}
		}

		assert(childProcessTime > 0, 'child process CPU time should be greater than 0');
	});

	after(() => {
		analytics.setAnalyticsEnabled(false);
	});
});
