/**
 * redirector stress. Loads the smoke fixture rules, runs 50/100/300/500/900 rps x 60s plateau.
 */
import { suite, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCluster, teardownCluster } from '../../smokeTests/lib/cluster.mjs';
import { prepareComponent, deployComponent } from '../../smokeTests/lib/deploy.mjs';
import { nodeFetch, waitForHttp } from '../../smokeTests/lib/http.mjs';
import { assertK6, hasK6 } from '../../smokeTests/lib/k6.mjs';
import { nodeConnEnv, fixture } from '../../smokeTests/lib/canary.mjs';
import { componentDir, COMPONENTS } from '../../smokeTests/manifest.mjs';

const NAME = 'redirector';
const PATHS = readFileSync(fixture('redirector', 'urls.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
const SCRIPT = join(import.meta.dirname, '..', 'k6', `${NAME}.stress.js`);

suite(`stress: ${NAME}`, { timeout: 1_800_000 }, () => {
	let nodes = [];

	before(async () => {
		const dir = componentDir(NAME);
		prepareComponent(dir);
		nodes = await startCluster(2);
		await deployComponent(nodes, dir, COMPONENTS[NAME].project);
		await waitForHttp(nodes, '/checkredirect?v=0&path=/__stress_probe__');
	});

	after(async () => {
		await teardownCluster(nodes);
	});

	test('load redirect rules', { timeout: 60_000 }, async () => {
		const csv = readFileSync(fixture('redirector', 'redirects.csv'), 'utf8');
		const res = await nodeFetch(nodes[0], 'POST', '/redirect', {
			body: csv,
			contentType: 'text/csv',
			retry: true,
		});
		assert.ok(res.status >= 200 && res.status < 300, `POST /redirect returned ${res.status}`);
	});

	test('k6 checkredirect stress (50/100/300/500/900 rps x 60s)', { skip: hasK6() ? false : 'k6 not on PATH' }, () => {
		assertK6(SCRIPT, { ...nodeConnEnv(nodes[0]), PATHS: PATHS.join(',') });
	});
});
