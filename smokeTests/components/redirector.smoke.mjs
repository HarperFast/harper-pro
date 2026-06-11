/**
 * redirector smoke canary. Load fixture rules, replicate, k6 /checkredirect at 20 rps for 15s.
 */
import { suite, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startCluster, teardownCluster } from '../lib/cluster.mjs';
import { prepareComponent, deployComponent } from '../lib/deploy.mjs';
import { nodeFetch, waitForHttp } from '../lib/http.mjs';
import { assertK6, hasK6 } from '../lib/k6.mjs';
import { nodeConnEnv, k6Script, fixture } from '../lib/canary.mjs';
import { componentDir, COMPONENTS } from '../manifest.mjs';

const NAME = 'redirector';
const PATHS = readFileSync(fixture('redirector', 'urls.txt'), 'utf8').split(/\r?\n/).filter(Boolean);

suite(`smoke: ${NAME}`, { timeout: 600_000 }, () => {
	let nodes = [];

	before(async () => {
		const dir = componentDir(NAME);
		prepareComponent(dir);
		nodes = await startCluster(2);
		await deployComponent(nodes, dir, COMPONENTS[NAME].project);
		await waitForHttp(nodes, '/checkredirect?v=0&path=/__smoke_probe__');
	});

	after(async () => {
		await teardownCluster(nodes);
	});

	test('load redirect rules and confirm replication', { timeout: 180_000 }, async () => {
		const csv = readFileSync(fixture('redirector', 'redirects.csv'), 'utf8');
		const res = await nodeFetch(nodes[0], 'POST', '/redirect', {
			body: csv,
			contentType: 'text/csv',
			retry: true,
		});
		assert.ok(res.status >= 200 && res.status < 300, `POST /redirect returned ${res.status}`);

		let replicated = false;
		for (let attempt = 0; attempt < 20 && !replicated; attempt++) {
			const r = await nodeFetch(nodes[1], 'GET', `/checkredirect?v=0&path=${encodeURIComponent(PATHS[0])}`);
			if (r.status === 200) {
				const body = await r.json();
				if (body && body.redirectURL) replicated = true;
			}
			if (!replicated) await delay(500);
		}
		assert.ok(replicated, 'redirect rule did not replicate to node 1');
	});

	test('k6 checkredirect canary', { skip: hasK6() ? false : 'k6 not on PATH' }, () => {
		assertK6(k6Script(NAME), {
			...nodeConnEnv(nodes[0]),
			PATHS: PATHS.join(','),
			RATE: 20,
			DURATION: '15s',
			DUR_P95: 1000,
		});
	});
});
