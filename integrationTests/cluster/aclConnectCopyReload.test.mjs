// Regression test for harper-pro#495: a live MQTT subscriber must receive records
// that arrive on its node via a copyApply base copy.
//
// copyApply (#480/#489) writes base-copy rows as snapshots with NO per-row audit
// entries, so the live-subscription notify path never fires for them. Pre-existing
// records that land on a node through a full copy are therefore durably stored but
// invisible to an already-connected subscriber — until the copy-complete reload
// marker (#489) drives the subscriber to re-read its scope (the #495 fix).
//
// Deterministic copy window: the subscriber is established on node C while C's `dog`
// table is empty, THEN `add_node { isLeader:true }` triggers a startTime=0 full copy
// of node A's pre-existing `dog` records (see addNodeFullCopy.test.mjs). The records
// arrive via copy AFTER the subscription is live, so plain audit forwarding cannot
// deliver them — only the reload re-read can.
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

const PROJECT = 'acl-connect-copy-reload';
const FIXTURE_PATH = join(import.meta.dirname ?? module.path, 'fixture-acl-connect');
const PRE_EXISTING_COUNT = 5;

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
		clientId: `copyreload-${clientIdSuffix}-${randomUUID().slice(0, 8)}`,
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

async function deployAclConnect(node) {
	const payload = await targz(FIXTURE_PATH);
	const body = await sendOperation(node, {
		operation: 'deploy_component',
		project: PROJECT,
		payload,
		replicated: false,
		restart: true,
	});
	ok(
		typeof body?.message === 'string' && body.message.includes(PROJECT),
		`unexpected deploy response on ${node.hostname}: ${JSON.stringify(body)}`
	);
}

suite('ACL Connect copyApply reload delivery (#495)', { timeout: 180_000 }, (ctx) => {
	before(async () => {
		const mkNode = async () => {
			const nodeCtx = { name: ctx.name, harper: { hostname: await getNextAvailableLoopbackAddress() } };
			await startHarper(nodeCtx, {
				config: {
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, console: true },
					replication: { securePort: nodeCtx.harper.hostname + ':9933' },
				},
				env: { HARPER_NO_FLUSH_ON_EXIT: true },
			});
			return nodeCtx.harper;
		};
		// A = source of the pre-existing records; C = joining node whose live subscriber must
		// receive the copied records. They start UNCLUSTERED so the copy is triggered explicitly,
		// after the subscriber is live.
		[ctx.nodeA, ctx.nodeC] = await Promise.all([mkNode(), mkNode()]);

		// tar the fixture and deploy to each node independently (replicated:false) so the `dog`
		// MQTT resource exists on both before any clustering. Clean stale node_modules first; the
		// harper symlink in there points outside the dir and tar-fs rejects it.
		await rm(join(FIXTURE_PATH, 'node_modules'), { recursive: true, force: true });
		await rm(join(FIXTURE_PATH, 'package-lock.json'), { force: true });
		await deployAclConnect(ctx.nodeA);
		await deployAclConnect(ctx.nodeC);
		await waitForAclReady(ctx.nodeA);
		await waitForAclReady(ctx.nodeC);

		// Pre-existing records: publish N retained messages to dog on A. These become the rows
		// that will reach C through a full copy (NOT live forwarding).
		ctx.markers = [];
		const pubA = await connectMqtt(mqttUrlFor(ctx.nodeA), adminOpts(ctx.nodeA, 'seed'));
		try {
			for (let i = 0; i < PRE_EXISTING_COUNT; i++) {
				const marker = `pre-${i}-${randomUUID()}`;
				ctx.markers.push({ topic: `dog/pre-${i}`, marker });
				await publish(pubA, `dog/pre-${i}`, JSON.stringify({ marker }));
			}
		} finally {
			await endQuiet(pubA);
		}
	});

	after(async () => {
		await Promise.all([
			ctx.nodeA && teardownHarper({ harper: ctx.nodeA }),
			ctx.nodeC && teardownHarper({ harper: ctx.nodeC }),
		]);
	});

	test('live subscriber on C receives pre-existing records delivered by a base copy', async () => {
		const { nodeA, nodeC, markers } = ctx;

		// 1) Establish the live subscription on C BEFORE C has the records. C's dog table is empty,
		//    so the initial snapshot delivers nothing and the subscription is purely live.
		const subClient = await connectMqtt(mqttUrlFor(nodeC), adminOpts(nodeC, 'sub'));
		const obs = collectMessages(subClient, 'dog/#');
		try {
			const granted = await subscribe(subClient, 'dog/#');
			const code = grantedCodes(granted)[0];
			ok(
				code !== undefined && !SUBACK_DENIED.includes(code) && code !== SUBACK_NO_RESOURCE,
				`precondition: dog/# must be granted on C, got SUBACK ${JSON.stringify(granted)}`
			);
			// Nothing should be there yet — the records live only on A.
			ok(obs.messages.length === 0, `precondition: C must start empty, saw ${JSON.stringify(obs.messages)}`);

			// 2) Trigger a full copy: C joins A as leader → startTime=0 base copy of A's `dog` rows.
			//    These are copyApplied on C with no per-row audit entries.
			await sendOperation(nodeC, {
				operation: 'add_node',
				hostname: nodeA.hostname,
				rejectUnauthorized: false,
				isLeader: true,
				authorization: nodeA.admin,
			});

			// 3) The live subscriber must receive every pre-existing record — only possible via the
			//    copy-complete reload re-read, since the copied rows fired no live audit events. (Verified
			//    by the negative control: with the reload handler disabled the subscriber sees nothing,
			//    and the consumer's only event for this subscription is a single `type:'reload'` marker —
			//    never a per-record `put`.)
			const arrived = await waitFor(
				() =>
					markers.every(({ topic, marker }) =>
						obs.messages.some((m) => m.topic === topic && tryParse(m.payload)?.marker === marker)
					),
				{ timeoutMs: 60_000, intervalMs: 200 }
			);

			ok(
				arrived,
				`live subscriber on C must receive all ${PRE_EXISTING_COUNT} copied records via the copy-complete ` +
					`reload re-read; subscriber saw: ${JSON.stringify(obs.messages)}`
			);
		} finally {
			obs.stop();
			await endQuiet(subClient);
		}
	});
});
