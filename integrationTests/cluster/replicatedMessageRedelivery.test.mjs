/**
 * A checkpoint-grade route resumes below the origin's certified floor (replication/DESIGN.md note 33), so the origin
 * re-sends messages the receiver already applied. A clean-session subscriber on a restarted B can miss what B
 * applied before it resubscribed, so B's own log is the oracle that holds in every case.
 */
import { suite, test, before, after } from 'node:test';
import { deepEqual, ok } from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mqtt from 'mqtt';
import { startHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import {
	restartHttpWorkers,
	restartNode,
	sendOperation,
	stopAndTeardownNodes,
	waitForCondition,
} from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = resolve(
	import.meta.dirname,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const FIXTURE = resolve(import.meta.dirname, 'fixture-replicated-messages');
const FLOOR_INTERVAL_MS = 2_000;
const PUBLISH_INTERVAL_MS = 50;
const AFTER_RESUME_MS = 15_000;
const WAIT_MS = 90_000;

const nodeOptions = (hostname) => ({
	config: {
		analytics: { aggregatePeriod: -1 },
		logging: { colors: false, stdStreams: false, console: true },
		replication: { securePort: hostname + ':9933' },
	},
	env: { HARPER_TEST_ORIGIN_FLOOR_INTERVAL_MS: String(FLOOR_INTERVAL_MS) },
});

async function postToFixture(node, resource, body, signal) {
	const response = await fetch(`${node.httpURL}/${resource}`, {
		method: 'POST',
		signal: signal ?? AbortSignal.timeout(10_000),
		headers: {
			'Content-Type': 'application/json',
			'Authorization': 'Basic ' + Buffer.from(`${node.admin.username}:${node.admin.password}`).toString('base64'),
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${resource} on ${node.hostname}: ${response.status}`);
	return response.json();
}

function connectOptions(node, clientId) {
	return {
		username: node.admin.username,
		password: node.admin.password,
		clientId,
		clean: true,
		protocolVersion: 5,
		reconnectPeriod: 1000,
		connectTimeout: 8000,
	};
}

function startPublisher(node, topic) {
	const client = mqtt.connect(`mqtt://${node.hostname}:1883`, connectOptions(node, `pub-${topic}`));
	const publisher = { n: 0, client, connections: [] };
	client.on('connect', () => publisher.connections.push({ at: Date.now(), nextN: publisher.n }));
	const timer = setInterval(() => {
		if (client.connected) client.publish(`Message/${topic}`, JSON.stringify({ n: publisher.n++ }), { qos: 0 });
	}, PUBLISH_INTERVAL_MS);
	publisher.stop = () => clearInterval(timer);
	return publisher;
}

function subscribe(node, topic, publisher, label) {
	const wsUrl = `${node.httpURL.replace(/^http/, 'ws')}/mqtt`;
	const client = mqtt.connect(wsUrl, connectOptions(node, `${label}-${topic}`));
	const subscriber = { client, seen: new Map(), subscriptions: [] };
	client.on('connect', () =>
		client.subscribe(`Message/${topic}`, { qos: 0 }, (error) => {
			if (!error) subscriber.subscriptions.push({ at: Date.now(), nextN: publisher.n });
		})
	);
	client.on('message', (_topic, payload) => {
		const { n } = JSON.parse(payload.toString());
		subscriber.seen.set(n, (subscriber.seen.get(n) ?? 0) + 1);
	});
	return subscriber;
}

const duplicates = (subscriber) => [...subscriber.seen].filter(([, count]) => count > 1).map(([n]) => n);
const missingFrom = (subscriber, from, to) =>
	Array.from({ length: Math.max(to - from, 0) }, (_, i) => from + i).filter((n) => !subscriber.seen.has(n));

async function nextNAfter(events, since, description) {
	return (await waitForCondition(() => events.find((event) => event.at > since), { timeoutMs: WAIT_MS, description }))
		.nextN;
}

async function clusterConnected(nodes, signal) {
	let statuses;
	try {
		statuses = await Promise.all(nodes.map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal })));
	} catch (error) {
		// a restarted node writes its pid before it listens
		if (signal.aborted) throw error;
		return false;
	}
	return statuses.every(
		(status) =>
			status.connections.length === nodes.length - 1 &&
			status.connections.every((connection) => connection.database_sockets.every((socket) => socket.connected))
	);
}

async function deliversOnce(ctx, topic, interrupt) {
	const { A, B } = ctx;
	const publisher = startPublisher(A, topic);
	const onB = subscribe(B, topic, publisher, 'sub-b');
	const onA = subscribe(A, topic, publisher, 'sub-a');
	ctx.publisher = publisher;
	try {
		await waitForCondition(() => onB.seen.size > 0 && onA.seen.size > 0, {
			timeoutMs: WAIT_MS,
			description: `live delivery of ${topic} on both nodes`,
		});
		const caseStart = Date.now();
		let route;
		await waitForCondition(
			async (signal) => {
				route = await postToFixture(B, 'RouteState', { peer: A.hostname }, signal);
				return (
					route.closedFloor > caseStart &&
					route.closedFloor < route.seqId &&
					typeof route.originGeneration === 'string' &&
					route.fullCoverage
				);
			},
			{
				timeoutMs: WAIT_MS,
				description: () => `a checkpoint-grade floor for A on B below its position, last ${JSON.stringify(route)}`,
			}
		);
		const backUpN = await interrupt(onB);
		await sleep(AFTER_RESUME_MS);
		publisher.stop();
		const last = publisher.n - 1;
		await waitForCondition(() => onB.seen.has(last) && onA.seen.has(last), {
			timeoutMs: WAIT_MS,
			description: `message ${last} on both nodes`,
		});
		deepEqual(duplicates(onB), [], 'message numbers the subscriber on B received more than once');
		deepEqual(duplicates(onA), [], 'message numbers the subscriber on A received more than once');
		deepEqual(missingFrom(onB, backUpN, publisher.n), [], `numbers from ${backUpN} B never delivered`);
		const logged = await postToFixture(B, 'LoggedMessages', { peer: A.hostname, topic });
		ok(
			Object.keys(logged).length >= publisher.n - backUpN,
			`B logged ${Object.keys(logged).length} of A's messages, fewer than the ${publisher.n - backUpN} sent after it was back`
		);
		deepEqual(
			Object.entries(logged).filter(([, count]) => count > 1),
			[],
			'message versions from A that B logged more than once'
		);
	} finally {
		publisher.stop();
		for (const client of [publisher.client, onB.client, onA.client]) client.end(true);
	}
}

suite('Replicated MQTT messages reach live subscribers once across resumes', { timeout: 600_000 }, (ctx) => {
	before(async () => {
		const hostnames = await Promise.all([0, 1].map(() => getNextAvailableLoopbackAddress()));
		const roots = await Promise.all(hostnames.map(() => mkdtemp(join(tmpdir(), 'harper-integration-test-'))));
		await Promise.all(
			roots.map((root) => cp(FIXTURE, join(root, 'components', basename(FIXTURE)), { recursive: true }))
		);
		const nodes = hostnames.map((hostname, i) => ({ hostname, dataRootDir: roots[i] }));
		[ctx.A, ctx.B] = nodes;
		const starts = await Promise.allSettled(
			nodes.map(async (node) =>
				Object.assign(node, (await startHarper({ name: ctx.name, harper: node }, nodeOptions(node.hostname))).harper)
			)
		);
		const failed = starts.find((start) => start.status === 'rejected');
		if (failed) throw failed.reason;
		await sendOperation(ctx.B, {
			operation: 'add_node',
			hostname: ctx.A.hostname,
			rejectUnauthorized: false,
			authorization: ctx.A.admin,
		});
		await waitForCondition((signal) => clusterConnected([ctx.A, ctx.B], signal), {
			timeoutMs: WAIT_MS,
			description: 'the cluster to connect',
		});
	});

	after(() => stopAndTeardownNodes([ctx.A, ctx.B]));

	test('the publishing node restarts while a subscriber on the other node stays connected', async () => {
		await deliversOnce(ctx, 'origin-restart', async () => {
			const since = Date.now();
			await restartNode(ctx.A);
			await waitForCondition((signal) => clusterConnected([ctx.A, ctx.B], signal), {
				timeoutMs: WAIT_MS,
				description: 'the cluster to reconnect',
			});
			return nextNAfter(ctx.publisher.connections, since, 'the publisher to reconnect to A');
		});
		// the lowest start a route certifies stays, so only this first resume shows it was floor-only
		const { certifiedFrom } = await postToFixture(ctx.B, 'RouteState', { peer: ctx.A.hostname });
		ok(certifiedFrom > 0, 'B resumed from A floor-only');
	});

	test("the receiving node's HTTP workers restart", () =>
		deliversOnce(ctx, 'worker-restart', async (onB) => {
			const since = Date.now();
			await restartHttpWorkers(ctx.B);
			return nextNAfter(onB.subscriptions, since, 'the subscriber on B to resubscribe');
		}));

	test('the receiving node restarts', () =>
		deliversOnce(ctx, 'node-restart', async (onB) => {
			const since = Date.now();
			await restartNode(ctx.B);
			return nextNAfter(onB.subscriptions, since, 'the subscriber on B to resubscribe');
		}));
});
