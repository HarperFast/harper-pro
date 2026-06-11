/**
 * early-hints smoke canary. Build, seed 3 site-images, replicate, k6 /hints at 20 rps for 15s.
 */
import { suite, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startCluster, teardownCluster } from '../lib/cluster.mjs';
import { prepareComponent, deployComponent } from '../lib/deploy.mjs';
import { nodeFetch, waitForHttp } from '../lib/http.mjs';
import { assertK6, hasK6 } from '../lib/k6.mjs';
import { nodeConnEnv, k6Script } from '../lib/canary.mjs';
import { componentDir, COMPONENTS } from '../manifest.mjs';

const NAME = 'early-hints';

suite(`smoke: ${NAME}`, { timeout: 600_000 }, () => {
	let nodes = [];
	let seedData = [];

	before(async () => {
		const dir = componentDir(NAME);
		prepareComponent(dir, { build: true, buildArtifact: 'dist/resources/index.js' });
		seedData = JSON.parse(readFileSync(join(dir, 'data', 'seedData.json'), 'utf8'));
		nodes = await startCluster(2);
		await deployComponent(nodes, dir, COMPONENTS[NAME].project);
		// /hints returns 400 (missing q) once the route is live.
		await waitForHttp(nodes, '/hints');
	});

	after(async () => {
		await teardownCluster(nodes);
	});

	test('seed site-images and confirm replication', { timeout: 180_000 }, async () => {
		// early-hints self-seeds on deploy, so 409 is also acceptable.
		for (const record of seedData) {
			const res = await nodeFetch(nodes[0], 'POST', '/site-images/', { body: record, retry: true });
			assert.ok(
				(res.status >= 200 && res.status < 300) || res.status === 409,
				`POST /site-images returned ${res.status}`
			);
		}

		const probeUrl = seedData[0].pageUrl;
		let replicated = false;
		for (let attempt = 0; attempt < 20 && !replicated; attempt++) {
			const r = await nodeFetch(nodes[1], 'GET', `/hints?q=${encodeURIComponent(probeUrl)}`);
			if (r.status === 200) replicated = true;
			else await delay(500);
		}
		assert.ok(replicated, 'seeded site-image did not replicate to node 1');
	});

	test('k6 hints canary', { skip: hasK6() ? false : 'k6 not on PATH' }, () => {
		assertK6(k6Script(NAME), {
			...nodeConnEnv(nodes[0]),
			URLS: seedData.map((r) => r.pageUrl).join(','),
			RATE: 20,
			DURATION: '15s',
			DUR_P95: 1000,
		});
	});
});
