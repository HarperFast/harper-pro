import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const FIXTURE_PATH = join(import.meta.dirname ?? module.path, 'fixture');
const AGGREGATE_PERIOD_SECONDS = 2;
const MAX_WAIT_RETRIES = 10;

suite('Analytics profiling user code', { timeout: 60000 }, (ctx) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				analytics: {
					aggregatePeriod: AGGREGATE_PERIOD_SECONDS,
				},
				logging: {
					colors: false,
					stdStreams: false,
					console: true,
				},
			},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function queryAnalytics(start) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'search_by_conditions',
				database: 'system',
				table: 'hdb_raw_analytics',
				conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
				get_attributes: ['id', 'metrics'],
			}),
		});
		if (!response.ok) return [];
		const data = await response.json();
		return Array.isArray(data) ? data : [];
	}

	async function triggerCpuWork(body) {
		// Resources from a fixture component may be mounted at /CpuWork or /fixture/CpuWork
		// depending on the Harper version; try both.
		for (const path of ['/CpuWork', '/fixture/CpuWork']) {
			const response = await fetch(`${ctx.harper.httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (response.status < 400) return response;
		}
		throw new Error('CpuWork endpoint not reachable at /CpuWork or /fixture/CpuWork');
	}

	test('can sample user code and record it', async () => {
		const start = Date.now();
		await triggerCpuWork({ doExpensiveComputation: true });

		let userUsageRecorded = false;
		let harperUsageRecorded = false;
		for (let i = 0; i < MAX_WAIT_RETRIES; i++) {
			await delay(1000);
			const records = await queryAnalytics(start);
			for (const { metrics = [] } of records) {
				for (const { metric, path } of metrics) {
					if (metric === 'cpu-usage' && path === 'user') userUsageRecorded = true;
					if (metric === 'cpu-usage' && path === 'harper') harperUsageRecorded = true;
				}
			}
			if (userUsageRecorded && harperUsageRecorded) break;
		}

		ok(userUsageRecorded, 'user cpu-usage was recorded in analytics');
		ok(harperUsageRecorded, 'harper cpu-usage was recorded in analytics');
	});

	test('can track child process CPU time', async () => {
		const start = Date.now();
		await triggerCpuWork({ spawnChildren: true });

		let childProcessTime = 0;
		for (let i = 0; i < MAX_WAIT_RETRIES; i++) {
			await delay(1000);
			const records = await queryAnalytics(start);
			childProcessTime = 0;
			for (const { metrics = [] } of records) {
				for (const { metric, method, mean } of metrics) {
					if (metric === 'cpu-usage' && method === 'child-processes') {
						childProcessTime += mean;
					}
				}
			}
			if (childProcessTime > 0) break;
		}

		ok(childProcessTime > 0, 'child process CPU time should be greater than 0');
	});
});
