/**
 * risk-query stress. Seeds 1000 records, runs 50/100/300/500/900 rps x 60s plateau.
 */
import { suite, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startCluster, teardownCluster } from '../../smokeTests/lib/cluster.mjs';
import { prepareComponent, deployComponent } from '../../smokeTests/lib/deploy.mjs';
import { nodeFetch, waitForHttp } from '../../smokeTests/lib/http.mjs';
import { assertK6, hasK6 } from '../../smokeTests/lib/k6.mjs';
import { nodeConnEnv } from '../../smokeTests/lib/canary.mjs';
import { componentDir, COMPONENTS } from '../../smokeTests/manifest.mjs';

const NAME = 'risk-query';
const RECORD_COUNT = 1000;
const SCRIPT = join(import.meta.dirname, '..', 'k6', `${NAME}.stress.js`);

suite(`stress: ${NAME}`, { timeout: 1_800_000 }, () => {
	let nodes = [];

	before(async () => {
		const dir = componentDir(NAME);
		prepareComponent(dir);
		nodes = await startCluster(2);
		await deployComponent(nodes, dir, COMPONENTS[NAME].project);
		await waitForHttp(nodes, '/risq/0');
	});

	after(async () => {
		await teardownCluster(nodes);
	});

	test(`seed ${RECORD_COUNT} records`, { timeout: 600_000 }, async () => {
		for (let i = 0; i < RECORD_COUNT; i++) {
			const res = await nodeFetch(nodes[0], 'PUT', `/risq/${i}`, {
				body: { di: `device-${i}`, d: i % 2 === 0 ? 'allow' : 'deny', r: i % 101 },
				retry: true,
			});
			assert.ok(res.status === 204 || res.status === 200, `PUT /risq/${i} returned ${res.status}`);
		}
	});

	test('k6 read stress (50/100/300/500/900 rps x 60s)', { skip: hasK6() ? false : 'k6 not on PATH' }, () => {
		assertK6(SCRIPT, { ...nodeConnEnv(nodes[0]), RECORD_COUNT });
	});
});
