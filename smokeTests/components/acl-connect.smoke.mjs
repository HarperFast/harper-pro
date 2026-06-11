/**
 * acl-connect smoke canary.
 * 1 publisher + 1 subscriber over MQTTS using the example's static JWTs (the JWT pins clientID,
 * so a single thread per role is required). Zero failed samples validates JWT auth, ACL
 * authorization, MQTTS, and delivery. Skipped if jmeter is not on PATH; CI installs it.
 */
import { suite, before, after, test } from 'node:test';
import { join } from 'node:path';
import { startCluster, teardownCluster } from '../lib/cluster.mjs';
import { prepareComponent, deployComponent } from '../lib/deploy.mjs';
import { assertJMeter, hasJMeter } from '../lib/jmeter.mjs';
import { waitForMqtts } from '../lib/mqtt.mjs';
import { componentDir, COMPONENTS } from '../manifest.mjs';

const NAME = 'acl-connect';
const PLAN = join(import.meta.dirname, '..', 'jmeter', 'acl-connect.canary.jmx');
const MQTTS_PORT = 8883;

suite(`smoke: ${NAME}`, { timeout: 600_000 }, () => {
	let nodes = [];

	before(async () => {
		const dir = componentDir(NAME);
		prepareComponent(dir);
		nodes = await startCluster(2);
		// Tear the cluster down on setup failure: node:test does not guarantee after() runs
		// if before() throws, which would orphan the in-process Harper processes.
		try {
			// Extra settle time for MQTT listeners to bind after the deploy restart.
			await deployComponent(nodes, dir, COMPONENTS[NAME].project, { settleMs: 15000 });
			await waitForMqtts(nodes[0].hostname, MQTTS_PORT);
		} catch (e) {
			await teardownCluster(nodes);
			nodes = [];
			throw e;
		}
	});

	after(async () => {
		await teardownCluster(nodes);
	});

	test('mqtt pub/sub canary over MQTTS', { skip: hasJMeter() ? false : 'jmeter not on PATH' }, () => {
		assertJMeter(PLAN, {
			host: nodes[0].hostname,
			port: MQTTS_PORT,
			duration_sec: 10,
			pub_threads: 1,
			sub_threads: 1,
			publish_timer_ms: 200,
			maxNoOfTopics: 10,
		});
	});
});
