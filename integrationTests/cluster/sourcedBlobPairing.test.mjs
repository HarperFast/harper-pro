/**
 * Regression for harper-pro#645: a sourcedFrom record's metadata and blob must
 * converge as one winning write when two nodes independently fill the same key.
 */

import { suite, test, before, after } from 'node:test';
import { deepEqual, equal, notEqual, ok } from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { createServer } from 'node:http';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getNextAvailableLoopbackAddress, startHarper, teardownHarper } from '@harperfast/integration-testing';
import { sendOperation } from './clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = resolve(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const FIXTURE = resolve(import.meta.dirname ?? module.path, 'fixture-sourced-blob-pairing');
const TRIALS = Number(process.env.HARPER_645_TRIALS ?? 10);
const WORKERS = Number(process.env.HARPER_645_WORKERS ?? 2);

function startBarrierOrigin() {
	const trials = new Map();
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			if (req.method !== 'POST' || req.url !== '/resolve') {
				res.writeHead(404).end();
				return;
			}
			const call = JSON.parse(body);
			const state = trials.get(call.id) ?? { calls: [], timer: null, timedOut: false };
			trials.set(call.id, state);
			const token = `${call.id}:${call.node}:${call.threadId}:${state.calls.length}`;
			state.calls.push({ ...call, token, res });
			const release = (timedOut) => {
				if (state.timer) clearTimeout(state.timer);
				state.timedOut = timedOut;
				for (const pending of state.calls) {
					pending.res.writeHead(200, { 'Content-Type': 'application/json' });
					pending.res.end(JSON.stringify({ token: pending.token }));
				}
			};
			if (state.calls.length === 2) release(false);
			else if (state.calls.length === 1) state.timer = setTimeout(() => release(true), 2000);
		});
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolve({
				url: `http://127.0.0.1:${port}`,
				trial: (id) => trials.get(id),
				close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
			});
		});
	});
}

async function rawOperation(node, operation) {
	try {
		const response = await fetch(node.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(operation),
		});
		return { status: response.status, body: await response.json() };
	} catch (error) {
		return { status: 500, body: { error: error.message } };
	}
}

async function connectNodes(nodeA, nodeB) {
	let token;
	for (let i = 0; i < 20 && !token; i++) {
		const response = await rawOperation(nodeA, {
			operation: 'create_authentication_tokens',
			authorization: nodeA.admin,
		});
		token = response.status === 200 && response.body.operation_token;
		if (!token) await delay(300);
	}
	if (!token) throw new Error('Failed to obtain replication token');

	let connected = false;
	for (let i = 0; i < 30 && !connected; i++) {
		const response = await rawOperation(nodeB, {
			operation: 'add_node',
			rejectUnauthorized: false,
			hostname: nodeA.hostname,
			authorization: `Bearer ${token}`,
		});
		if (response.status === 200) connected = true;
		else if (/ECONNREFUSED|ECONNRESET|connect /.test(JSON.stringify(response.body))) await delay(500);
		else throw new Error(`add_node failed (${response.status}): ${JSON.stringify(response.body)}`);
	}
	if (!connected) throw new Error('Timed out adding replication peer');

	for (let i = 0; i < 60; i++) {
		const statuses = await Promise.all(
			[nodeA, nodeB].map((node) => sendOperation(node, { operation: 'cluster_status' }).catch(() => null))
		);
		if (statuses.every((status) => status?.connections?.some((c) => c.database_sockets?.some((s) => s.connected))))
			return;
		await delay(500);
	}
	throw new Error('Timed out waiting for replication sockets');
}

function requestJson(url, agent, options = {}) {
	return new Promise((resolve, reject) => {
		const requestBody = options.body == null ? null : JSON.stringify(options.body);
		const req = request(
			url,
			{ agent, method: options.method, headers: requestBody ? { 'Content-Type': 'application/json' } : undefined },
			(res) => {
				let responseBody = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (responseBody += chunk));
				res.on('end', () => {
					if (![200, 201, 204].includes(res.statusCode))
						reject(new Error(url + ' returned ' + res.statusCode + ': ' + responseBody));
					else resolve(responseBody ? JSON.parse(responseBody) : null);
				});
			}
		);
		req.setTimeout(5000, () => req.destroy(new Error(`Timed out requesting ${url}`)));
		req.on('error', reject);
		req.end(requestBody);
	});
}

async function pinWorkers(node) {
	const byThread = new Map();
	for (let i = 0; i < 40 && byThread.size < WORKERS; i++) {
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		const probe = await requestJson(`${node.httpURL}/PairWorker/probe-${i}`, agent);
		if (byThread.has(probe.threadId)) agent.destroy();
		else byThread.set(probe.threadId, agent);
	}
	equal(byThread.size, WORKERS, `expected ${WORKERS} addressable workers on ${node.hostname}`);
	return byThread;
}

async function waitForConvergence(nodes, id, agentsByNode) {
	const deadline = Date.now() + 30000;
	let scans;
	while (Date.now() < deadline) {
		scans = await Promise.all(
			nodes.map((node, index) =>
				requestJson(`${node.httpURL}/PairScanProbe/${id}`, agentsByNode[index].values().next().value)
			)
		);
		if (
			scans.every((scan) => scan.record) &&
			scans.every((scan) => scan.version === scans[0].version && scan.record.token === scans[0].record.token)
		) {
			return scans;
		}
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${id} convergence: ${JSON.stringify(scans)}`);
}

async function waitForAllWorkers(nodes, id, agentsByNode, probeResource) {
	const deadline = Date.now() + 30000;
	let probes;
	let stableSignature;
	let stableSince = 0;
	while (Date.now() < deadline) {
		probes = (
			await Promise.all(
				nodes.map((node, nodeIndex) =>
					Promise.all(
						Array.from(agentsByNode[nodeIndex], async ([threadId, agent]) => ({
							nodeIndex,
							threadId,
							probe: await requestJson(`${node.httpURL}/${probeResource}/${id}`, agent),
						}))
					)
				)
			)
		).flat();
		const winner = probes[0]?.probe.raw;
		if (
			winner?.record &&
			probes.every(
				({ probe }) =>
					probe.raw?.version === winner.version &&
					probe.raw.record.token === winner.record.token &&
					probe.record?.token === winner.record.token
			)
		) {
			const signature = `${winner.version}:${winner.record.token}`;
			if (signature !== stableSignature) {
				stableSignature = signature;
				stableSince = Date.now();
			} else if (Date.now() - stableSince >= 1000) {
				return probes;
			}
		} else {
			stableSignature = undefined;
			stableSince = 0;
		}
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${id} on every worker: ${JSON.stringify(probes)}`);
}

suite('sourcedFrom blob/metadata pairing under competing cache fills', { timeout: 300000 }, (ctx) => {
	before(async () => {
		ctx.origin = await startBarrierOrigin();
		const [hostnameA, hostnameB] = await Promise.all([
			getNextAvailableLoopbackAddress(),
			getNextAvailableLoopbackAddress(),
		]);
		const [dataRootDirA, dataRootDirB] = await Promise.all([
			mkdtemp(join(tmpdir(), 'harper-integration-test-')),
			mkdtemp(join(tmpdir(), 'harper-integration-test-')),
		]);
		const fixtureName = basename(FIXTURE);
		await Promise.all([
			cp(FIXTURE, join(dataRootDirA, 'components', fixtureName), { recursive: true, dereference: true }),
			cp(FIXTURE, join(dataRootDirB, 'components', fixtureName), { recursive: true, dereference: true }),
		]);
		const contexts = [
			{ name: ctx.name, harper: { hostname: hostnameA, dataRootDir: dataRootDirA } },
			{ name: ctx.name, harper: { hostname: hostnameB, dataRootDir: dataRootDirB } },
		];
		await Promise.all(
			contexts.map((nodeCtx) =>
				startHarper(nodeCtx, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: false, console: true },
						replication: { securePort: `${nodeCtx.harper.hostname}:9933` },
						threads: { count: WORKERS },
					},
					env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_ORIGIN_URL: ctx.origin.url },
				})
			)
		);
		ctx.nodes = contexts.map((nodeCtx) => nodeCtx.harper);
		await connectNodes(...ctx.nodes);
		ctx.agentsByNode = await Promise.all(ctx.nodes.map(pinWorkers));
	});

	after(async () => {
		for (const agents of ctx.agentsByNode ?? []) for (const agent of agents.values()) agent.destroy();
		await Promise.all((ctx.nodes ?? []).map((node) => teardownHarper({ harper: node })));
		await ctx.origin?.close();
	});

	test(`${TRIALS} two-node cache-fill races settle each record and blob from one write on every worker`, async () => {
		for (let trial = 0; trial < TRIALS; trial++) {
			const id = `pair-${trial}`;
			const fillAgents = ctx.agentsByNode.map((agents) => agents.values().next().value);
			const fills = await Promise.all(
				ctx.nodes.map((node, index) => requestJson(`${node.httpURL}/PairRecord/${id}`, fillAgents[index]))
			);
			const originTrial = ctx.origin.trial(id);
			equal(originTrial.calls.length, 2, `${id} must perform exactly two independent source fills`);
			equal(originTrial.timedOut, false, `${id} barrier timed out, so this trial is inconclusive`);
			notEqual(fills[0].token, fills[1].token, `${id} source fills must be distinguishable`);

			await waitForAllWorkers(ctx.nodes, id, ctx.agentsByNode, 'PairPointProbe');
			const scans = await waitForConvergence(ctx.nodes, id, ctx.agentsByNode);
			deepEqual(scans[0].record, scans[1].record, `${id} raw stores must converge`);
			equal(scans[0].record.payloadToken, scans[0].record.token, `${id} raw record/blob pairing`);

			for (let nodeIndex = 0; nodeIndex < ctx.nodes.length; nodeIndex++) {
				for (const [threadId, agent] of ctx.agentsByNode[nodeIndex]) {
					const probe = await requestJson(`${ctx.nodes[nodeIndex].httpURL}/PairPointProbe/${id}`, agent);
					equal(probe.threadId, threadId, `${id} connection moved between workers`);
					ok(probe.record, `${id} missing on node ${nodeIndex}, worker ${threadId}`);
					equal(
						probe.raw?.record.token,
						scans[0].record.token,
						`${id} raw store differs on ${probe.node} worker ${threadId}: ${JSON.stringify(probe)}`
					);
					equal(
						probe.record.token,
						scans[0].record.token,
						`${id} stale point read on ${probe.node} worker ${threadId}: ${JSON.stringify(probe)}`
					);
					equal(probe.record.payloadToken, probe.record.token, `${id} blob/metadata split on worker ${threadId}`);
				}
			}
		}
	});
});
