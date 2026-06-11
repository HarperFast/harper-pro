/**
 * risk-query smoke canary. Seed 100, replicate, k6 read at 10 rps for 15s.
 */
import { suite, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startCluster, teardownCluster } from '../lib/cluster.mjs';
import { prepareComponent, deployComponent } from '../lib/deploy.mjs';
import { nodeFetch, waitForHttp } from '../lib/http.mjs';
import { assertK6, hasK6 } from '../lib/k6.mjs';
import { nodeConnEnv, k6Script } from '../lib/canary.mjs';
import { componentDir, COMPONENTS } from '../manifest.mjs';

const NAME = 'risk-query';
const RECORD_COUNT = 100;

suite(`smoke: ${NAME}`, { timeout: 600_000 }, () => {
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

	test('seed 100 records and confirm replication', { timeout: 180_000 }, async () => {
		for (let i = 0; i < RECORD_COUNT; i++) {
			const res = await nodeFetch(nodes[0], 'PUT', `/risq/${i}`, {
				body: { di: `device-${i}`, d: i % 2 === 0 ? 'allow' : 'deny', r: i % 101 },
				retry: true,
			});
			assert.ok(res.status === 204 || res.status === 200, `PUT /risq/${i} returned ${res.status}`);
		}

		let replicated = false;
		for (let attempt = 0; attempt < 20 && !replicated; attempt++) {
			const res = await nodeFetch(nodes[1], 'GET', '/risq/0');
			if (res.status === 200) {
				const body = await res.json();
				if (body && body.deviceId === 'device-0') replicated = true;
			}
			if (!replicated) await delay(500);
		}
		assert.ok(replicated, 'record written to node 0 did not replicate to node 1');
	});

	test('k6 read canary', { skip: hasK6() ? false : 'k6 not on PATH' }, () => {
		assertK6(k6Script(NAME), {
			...nodeConnEnv(nodes[0]),
			RECORD_COUNT,
			RATE: 10,
			DURATION: '15s',
			DUR_P95: 1000,
		});
	});
});
