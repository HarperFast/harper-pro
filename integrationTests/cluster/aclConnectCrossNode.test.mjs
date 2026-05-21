// 2-node cluster, deploys @harperdb/acl-connect, asserts MQTT messages
// published on one node arrive at subscribers on the other.
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import mqtt from 'mqtt';

import { startHarper, teardownHarper, getNextAvailableLoopbackAddress, targz } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const NODE_COUNT = 2;
const PROJECT = 'acl-connect-cross-node';
const FIXTURE_PATH = join(import.meta.dirname ?? module.path, 'fixture-acl-connect');

// SUBACK reason codes per server/mqtt.ts: 128/135 = denied, 143 = no resource registered.
const SUBACK_DENIED = [128, 135];
const SUBACK_NO_RESOURCE = 143;

function adminOpts(node, clientIdSuffix) {
	return {
		protocolVersion: 5,
		reconnectPeriod: 0,
		connectTimeout: 8000,
		clean: true,
		username: node.admin.username,
		password: node.admin.password,
		clientId: `cross-${clientIdSuffix}-${randomUUID().slice(0, 8)}`,
	};
}

function mqttUrlFor(node) {
	const wsScheme = node.httpURL.startsWith('https') ? 'wss' : 'ws';
	return `${node.httpURL.replace(/^https?/, wsScheme)}/mqtt`;
}

function connectMqtt(url, opts) {
	return new Promise((resolveP, rejectP) => {
		const client = mqtt.connect(url, opts);
		const onError = (err) => {
			client.removeListener('connect', onConnect);
			client.end(true);
			rejectP(err);
		};
		const onConnect = () => {
			client.removeListener('error', onError);
			resolveP(client);
		};
		client.once('error', onError);
		client.once('connect', onConnect);
	});
}

function subscribe(client, topic, opts = { qos: 1 }) {
	return new Promise((resolveP, rejectP) => {
		client.subscribe(topic, opts, (err, granted) => {
			if (err) rejectP(err);
			else resolveP(granted ?? []);
		});
	});
}

function publish(client, topic, payload, opts = { qos: 1, retain: true }) {
	return new Promise((resolveP, rejectP) => {
		client.publish(topic, payload, opts, (err) => {
			if (err) rejectP(err);
			else resolveP();
		});
	});
}

function endQuiet(client) {
	return new Promise((resolveP) => {
		if (!client) return resolveP();
		client.end(true, {}, () => resolveP());
	});
}

function grantedCodes(granted) {
	return granted.map((g) => (typeof g === 'number' ? g : (g.reasonCode ?? g.qos)));
}

function topicMatches(filter, topic) {
	const f = filter.split('/');
	const t = topic.split('/');
	for (let i = 0; i < f.length; i++) {
		if (f[i] === '#') return true;
		if (f[i] === '+') {
			if (t[i] === undefined) return false;
			continue;
		}
		if (f[i] !== t[i]) return false;
	}
	return f.length === t.length;
}

function collectMessages(client, filter) {
	const messages = [];
	const handler = (topic, payload) => {
		if (topicMatches(filter, topic)) messages.push({ topic, payload: payload.toString() });
	};
	client.on('message', handler);
	return { messages, stop: () => client.removeListener('message', handler) };
}

function tryParse(s) {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return false;
}

async function waitForAclReady(node) {
	const url = mqttUrlFor(node);
	const deadline = Date.now() + 30_000;
	let lastSubackCode;
	let lastError;
	let attempts = 0;
	while (Date.now() < deadline) {
		attempts++;
		let client;
		try {
			client = await connectMqtt(url, adminOpts(node, 'probe'));
			const granted = await subscribe(client, 'dog/#');
			lastSubackCode = grantedCodes(granted)[0];
			if (lastSubackCode !== SUBACK_NO_RESOURCE) return;
		} catch (err) {
			lastError = err;
		} finally {
			await endQuiet(client);
		}
		await sleep(500);
	}
	throw new Error(
		`Timed out waiting for acl-connect on ${url} after ${attempts} attempts. ` +
			`Last SUBACK for dog/#: ${lastSubackCode ?? 'n/a'}. Last error: ${lastError?.message ?? lastError}`
	);
}

suite('ACL Connect Cross-Node Delivery', { timeout: 180_000 }, (ctx) => {
	before(async () => {
		ctx.nodes = await Promise.all(
			Array(NODE_COUNT)
				.fill(null)
				.map(async () => {
					const nodeCtx = {
						name: ctx.name,
						harper: { hostname: await getNextAvailableLoopbackAddress() },
					};
					await startHarper(nodeCtx, {
						config: {
							analytics: { aggregatePeriod: -1 },
							logging: { colors: false, stdStreams: false, console: true },
							replication: { securePort: nodeCtx.harper.hostname + ':9933' },
						},
						env: { HARPER_NO_FLUSH_ON_EXIT: true },
					});
					return nodeCtx.harper;
				})
		);

		for (let j = 1; j < NODE_COUNT; j++) {
			await sendOperation(ctx.nodes[j], {
				operation: 'add_node',
				rejectUnauthorized: false,
				hostname: ctx.nodes[0].hostname,
				authorization: ctx.nodes[j].admin,
			});
		}
		let retries = 0;
		while (true) {
			const responses = await Promise.all(
				ctx.nodes.map((n) => sendOperation(n, { operation: 'cluster_status' }))
			);
			const allConnected = responses.every(
				(r) =>
					r.connections.length === NODE_COUNT - 1 &&
					r.connections.every((c) => c.database_sockets.every((s) => s.connected))
			);
			if (allConnected) break;
			if (retries++ > 20) throw new Error('Timed out waiting for cluster to connect');
			await sleep(200 * retries);
		}
		await sleep(500);

		// tar the fixture and deploy as payload — pointing `package:` at a
		// directory makes Harper symlink and skip `npm install`, which leaves
		// @harperdb/acl-connect uninstalled. payload extracts + installs.
		// Clean any node_modules left behind by prior runs first; the harper
		// symlink in there points outside the dir and tar-fs rejects it.
		await rm(join(FIXTURE_PATH, 'node_modules'), { recursive: true, force: true });
		await rm(join(FIXTURE_PATH, 'package-lock.json'), { force: true });
		const payload = await targz(FIXTURE_PATH);
		const deployBody = await sendOperation(ctx.nodes[0], {
			operation: 'deploy_component',
			project: PROJECT,
			payload,
			replicated: true,
			restart: true,
		});
		ok(
			typeof deployBody?.message === 'string' && deployBody.message.includes(PROJECT),
			`unexpected deploy response: ${JSON.stringify(deployBody)}`
		);

		// Cover the race where Harper restarts but acl-connect hasn't yet
		// registered `dog` as a resource on a freshly restarted worker.
		for (const node of ctx.nodes) {
			await waitForAclReady(node);
		}
	});

	after(async () => {
		if (!ctx.nodes) return;
		await Promise.all(ctx.nodes.map((n) => teardownHarper({ harper: n })));
	});

	test('subscriber on node 0 receives publish from node 1', async () => {
		const subClient = await connectMqtt(mqttUrlFor(ctx.nodes[0]), adminOpts(ctx.nodes[0], 'sub'));
		const pubClient = await connectMqtt(mqttUrlFor(ctx.nodes[1]), adminOpts(ctx.nodes[1], 'pub'));
		try {
			const granted = await subscribe(subClient, 'dog/#');
			const code = grantedCodes(granted)[0];
			ok(
				code !== undefined && !SUBACK_DENIED.includes(code) && code !== SUBACK_NO_RESOURCE,
				`precondition: dog/# must be granted on node 0, got SUBACK ${JSON.stringify(granted)}`
			);

			const obs = collectMessages(subClient, 'dog/#');
			const topic = `dog/cross-${randomUUID().slice(0, 8)}`;
			// Without a content-type header, Harper's deserializer only parses
			// the body as JSON when the first byte is `{` (an object) — strings
			// and other primitives round-trip as null. Send an object.
			const marker = `cross-node-${randomUUID()}`;
			const payload = JSON.stringify({ marker });
			await publish(pubClient, topic, payload);

			const arrived = await waitFor(
				() => obs.messages.some((m) => m.topic === topic && tryParse(m.payload)?.marker === marker),
				{ timeoutMs: 15_000 }
			);
			obs.stop();
			ok(
				arrived,
				`expected marker ${marker} on ${topic} cross-node; subscriber saw: ${JSON.stringify(obs.messages)}`
			);
		} finally {
			await endQuiet(pubClient);
			await endQuiet(subClient);
		}
	});

	test('wildcard subscriber on node 0 receives multi-depth topics from node 1', async () => {
		const suffix = randomUUID().slice(0, 8);
		const cases = [
			{ topic: `dog/${suffix}/1`, marker: `wc-1-${randomUUID()}` },
			{ topic: `dog/${suffix}/breed/labrador`, marker: `wc-breed-${randomUUID()}` },
			{ topic: `dog/${suffix}/US/12345`, marker: `wc-region-${randomUUID()}` },
			{ topic: `dog/${suffix}/a/b/c/d`, marker: `wc-deep-${randomUUID()}` },
		];

		const subClient = await connectMqtt(mqttUrlFor(ctx.nodes[0]), adminOpts(ctx.nodes[0], 'wc-sub'));
		const pubClient = await connectMqtt(mqttUrlFor(ctx.nodes[1]), adminOpts(ctx.nodes[1], 'wc-pub'));
		try {
			const granted = await subscribe(subClient, 'dog/#');
			const code = grantedCodes(granted)[0];
			ok(
				code !== undefined && !SUBACK_DENIED.includes(code) && code !== SUBACK_NO_RESOURCE,
				`precondition: dog/# must be granted on node 0, got SUBACK ${JSON.stringify(granted)}`
			);

			const obs = collectMessages(subClient, 'dog/#');
			for (const { topic, marker } of cases) {
				await publish(pubClient, topic, JSON.stringify({ marker }));
			}

			const arrived = await waitFor(
				() =>
					cases.every(({ topic, marker }) =>
						obs.messages.some((m) => m.topic === topic && tryParse(m.payload)?.marker === marker)
					),
				{ timeoutMs: 15_000 }
			);
			obs.stop();
			ok(
				arrived,
				`expected all ${cases.length} cross-node deliveries; subscriber saw: ${JSON.stringify(obs.messages)}`
			);
		} finally {
			await endQuiet(pubClient);
			await endQuiet(subClient);
		}
	});

	test('subscribers on both nodes receive publish from node 1', async () => {
		const sub0 = await connectMqtt(mqttUrlFor(ctx.nodes[0]), adminOpts(ctx.nodes[0], 'fanout-sub0'));
		const sub1 = await connectMqtt(mqttUrlFor(ctx.nodes[1]), adminOpts(ctx.nodes[1], 'fanout-sub1'));
		const pubClient = await connectMqtt(mqttUrlFor(ctx.nodes[1]), adminOpts(ctx.nodes[1], 'fanout-pub'));
		try {
			for (const sub of [sub0, sub1]) {
				const granted = await subscribe(sub, 'dog/#');
				const code = grantedCodes(granted)[0];
				ok(
					code !== undefined && !SUBACK_DENIED.includes(code) && code !== SUBACK_NO_RESOURCE,
					`precondition: dog/# must be granted, got SUBACK ${JSON.stringify(granted)}`
				);
			}

			const obs0 = collectMessages(sub0, 'dog/#');
			const obs1 = collectMessages(sub1, 'dog/#');
			const topic = `dog/fanout-${randomUUID().slice(0, 8)}`;
			const marker = `fanout-${randomUUID()}`;
			await publish(pubClient, topic, JSON.stringify({ marker }));

			const matches = (msgs) => msgs.some((m) => m.topic === topic && tryParse(m.payload)?.marker === marker);
			const arrived = await waitFor(() => matches(obs0.messages) && matches(obs1.messages), { timeoutMs: 15_000 });
			obs0.stop();
			obs1.stop();
			ok(
				arrived,
				`expected fanout to both nodes; node 0 saw: ${JSON.stringify(obs0.messages)}; node 1 saw: ${JSON.stringify(obs1.messages)}`
			);
		} finally {
			await endQuiet(pubClient);
			await endQuiet(sub1);
			await endQuiet(sub0);
		}
	});
});
