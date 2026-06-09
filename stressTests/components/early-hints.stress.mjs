/**
 * early-hints stress. Builds + deploys, seeds the smoke records, runs 50/100/300/500/900 rps x 60s.
 */
import { suite, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCluster, teardownCluster } from '../../smokeTests/lib/cluster.mjs';
import { prepareComponent, deployComponent } from '../../smokeTests/lib/deploy.mjs';
import { nodeFetch, waitForHttp } from '../../smokeTests/lib/http.mjs';
import { assertK6, hasK6 } from '../../smokeTests/lib/k6.mjs';
import { nodeConnEnv } from '../../smokeTests/lib/canary.mjs';
import { componentDir, COMPONENTS } from '../../smokeTests/manifest.mjs';

const NAME = 'early-hints';
const SCRIPT = join(import.meta.dirname, '..', 'k6', `${NAME}.stress.js`);

suite(`stress: ${NAME}`, { timeout: 1_800_000 }, () => {
	let nodes = [];
	let seedData = [];

	before(async () => {
		const dir = componentDir(NAME);
		prepareComponent(dir, { build: true, buildArtifact: 'dist/resources/index.js' });
		seedData = JSON.parse(readFileSync(join(dir, 'data', 'seedData.json'), 'utf8'));
		nodes = await startCluster(2);
		await deployComponent(nodes, dir, COMPONENTS[NAME].project);
		await waitForHttp(nodes, '/hints');
	});

	after(async () => {
		await teardownCluster(nodes);
	});

	test('seed site-images', { timeout: 60_000 }, async () => {
		// early-hints self-seeds on deploy, so 409 is acceptable.
		for (const record of seedData) {
			const res = await nodeFetch(nodes[0], 'POST', '/site-images/', { body: record, retry: true });
			assert.ok(
				(res.status >= 200 && res.status < 300) || res.status === 409,
				`POST /site-images returned ${res.status}`
			);
		}
	});

	test('k6 hints stress (50/100/300/500/900 rps x 60s)', { skip: hasK6() ? false : 'k6 not on PATH' }, () => {
		assertK6(SCRIPT, { ...nodeConnEnv(nodes[0]), URLS: seedData.map((r) => r.pageUrl).join(',') });
	});
});
