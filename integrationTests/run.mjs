import { run } from 'node:test';
import { availableParallelism } from 'node:os';
import { spec } from 'node:test/reporters';
import { parseArgs } from 'node:util';

/**
 * Custom test runner for Harper Pro integration tests.
 *
 * This exists because Node.js CLI arg parsing doesn't allow passing options like --test-shard
 * after the --test flag. Using the run() API directly gives us full control over configuration.
 */

const { values, positionals } = parseArgs({
	options: {
		concurrency: { type: 'string' },
		isolation: { type: 'string' },
		shard: { type: 'string' },
		only: { type: 'boolean' },
	},
	allowPositionals: true,
});

const CONCURRENCY =
	parseInt(process.env.HARPER_INTEGRATION_TEST_CONCURRENCY || values.concurrency, 10) ||
	Math.max(1, Math.floor(availableParallelism() / 2) + 1);

const ISOLATION = process.env.HARPER_INTEGRATION_TEST_ISOLATION || values.isolation || 'process';

const [SHARD_INDEX, SHARD_TOTAL] = (process.env.HARPER_INTEGRATION_TEST_SHARD || values.shard || '1/1')
	.split('/')
	.map((v) => parseInt(v, 10));

const ONLY = values.only ?? false;

const TEST_FILES = positionals.length > 0 ? positionals : ['integrationTests/**/*.test.mjs'];

run({
	concurrency: ISOLATION === 'none' ? undefined : CONCURRENCY,
	isolation: ISOLATION,
	globPatterns: TEST_FILES,
	only: ONLY,
	shard: {
		index: SHARD_INDEX,
		total: SHARD_TOTAL,
	},
})
	.on('test:fail', () => {
		process.exitCode = 1;
	})
	.compose(spec)
	.pipe(process.stdout);
