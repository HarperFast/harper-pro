/**
 * acl-connect stress. v5-faithful JMeter profile: 1 publisher (100ms timer) + 20000 subscribers
 * (120s ramp) x 600s. The JWT pins clientID, so most subscriber sessions are kicked as duplicates;
 * the v5 report observed ~6052 of 20000 connections established before the load generator became
 * the bottleneck (not a Harper defect). Override env knobs to dial down for CI.
 */
import { suite, before, after, test } from 'node:test';
import { join } from 'node:path';
import { startCluster, teardownCluster } from '../../smokeTests/lib/cluster.mjs';
import { prepareComponent, deployComponent } from '../../smokeTests/lib/deploy.mjs';
import { assertJMeter, hasJMeter } from '../../smokeTests/lib/jmeter.mjs';
import { waitForMqtts } from '../../smokeTests/lib/mqtt.mjs';
import { componentDir, COMPONENTS } from '../../smokeTests/manifest.mjs';

const NAME = 'acl-connect';
const PLAN = join(import.meta.dirname, '..', 'jmeter', 'acl-connect.stress.jmx');
const MQTTS_PORT = 8883;

const SUB_THREADS = parseInt(process.env.STRESS_SUB_THREADS || '20000', 10);
const SUB_RAMPUP_SEC = parseInt(process.env.STRESS_SUB_RAMPUP_SEC || '120', 10);
const PUB_THREADS = parseInt(process.env.STRESS_PUB_THREADS || '1', 10);
const PUBLISH_TIMER_MS = parseInt(process.env.STRESS_PUBLISH_TIMER_MS || '100', 10);
const DURATION_SEC = parseInt(process.env.STRESS_DURATION_SEC || '600', 10);
const MAX_NO_OF_TOPICS = parseInt(process.env.STRESS_MAX_NO_OF_TOPICS || '100', 10);
const JMETER_TIMEOUT_MS = (DURATION_SEC + 120) * 1000;

suite(`stress: ${NAME}`, { timeout: 1_800_000 }, () => {
	let nodes = [];

	before(async () => {
		const dir = componentDir(NAME);
		prepareComponent(dir);
		nodes = await startCluster(2);
		await deployComponent(nodes, dir, COMPONENTS[NAME].project, { settleMs: 15000 });
		await waitForMqtts(nodes[0].hostname, MQTTS_PORT);
	});

	after(async () => {
		await teardownCluster(nodes);
	});

	test(
		`mqtt pub/sub stress (${PUB_THREADS} pub + ${SUB_THREADS} sub x ${DURATION_SEC}s)`,
		{ skip: hasJMeter() ? false : 'jmeter not on PATH' },
		() => {
			assertJMeter(
				PLAN,
				{
					host: nodes[0].hostname,
					port: MQTTS_PORT,
					duration_sec: DURATION_SEC,
					pub_threads: PUB_THREADS,
					sub_threads: SUB_THREADS,
					sub_rampUp_sec: SUB_RAMPUP_SEC,
					publish_timer_ms: PUBLISH_TIMER_MS,
					maxNoOfTopics: MAX_NO_OF_TOPICS,
				},
				{ timeoutMs: JMETER_TIMEOUT_MS }
			);
		}
	);
});
