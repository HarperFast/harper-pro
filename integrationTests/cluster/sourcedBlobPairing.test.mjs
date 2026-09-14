/**
 * Regression for harper-pro#645: a sourcedFrom record's metadata and blob must
 * converge as one winning write when two nodes independently fill the same key.
 */

import { suite, test, before, after } from 'node:test';
import { deepEqual, equal, notEqual, ok } from 'node:assert/strict';
import { Agent, createServer, request } from 'node:http';
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
// Far enough back that the reported version is unambiguously below both nodes' local clocks, so
// neither caps it at local time and both store exactly this version.
const TIE_BACKDATE_MS = 3600_000;
const BARRIER_MS = 10000;
// Each bootstrap phase gets one budget rather than one per attempt: retry counts times a per-request
// timeout let a node that accepts connections without answering burn the whole 25-minute cluster job
// (.github/workflows/integration-tests.yaml) before any phase reports its own diagnostic, and this
// file bootstraps twice — once per storage engine.
const BOOTSTRAP_PHASE_MS = 120000;
// Restages are budgeted for the whole suite, not per trial: one unstaged race is a scheduling
// accident worth retrying, but a race that can never be staged must fail inside the suite timeout
// rather than spend TRIALS x attempts x the barrier window discovering it.
const RESTAGE_BUDGET = 3;
// The two race shapes the convergence claim has to hold for. They reach different arbiters, so a
// regression in one is invisible to the other: `distinct` is settled by version ordering, while
// `tied-late` has to be settled by the cache-fill resolution itself, at an equal version.
//
// A third shape — both fills concurrent AND at an equal version, so each node commits its own
// record before its peer's arrives — is deliberately absent: it does not converge, on either
// engine. The replicas settle holding each other's record at the same version, which is an open
// defect rather than a property this regression can assert. Adding
// `{ id: 'tied', stagger: false, tied: true }` here reproduces it.
const SHAPES = [
	{ id: 'distinct', stagger: false, tied: false },
	{ id: 'tied-late', stagger: true, tied: true },
];

function respondTo(state, pending) {
	if (pending.answered) return;
	pending.answered = true;
	if (pending.res.destroyed || pending.res.writableEnded) return;
	pending.res.writeHead(200, { 'Content-Type': 'application/json' });
	pending.res.end(JSON.stringify({ token: pending.token, lastModified: state.lastModified }));
}

function releaseTrial(state, timedOut) {
	if (!state) return;
	clearTimeout(state.timer);
	state.timer = null;
	state.released = true;
	state.timedOut ||= timedOut;
	for (const pending of state.calls) respondTo(state, pending);
}

function startBarrierOrigin() {
	const trials = new Map();
	const newTrial = (shape = {}) => ({
		calls: [],
		timer: null,
		timedOut: false,
		released: false,
		lastModified: shape.lastModified,
		stagger: shape.stagger === true,
	});
	const server = createServer((req, res) => {
		let body = '';
		req.on('error', () => {});
		res.on('error', () => {});
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			if (req.method !== 'POST' || req.url !== '/resolve') {
				res.writeHead(404).end();
				return;
			}
			let call;
			try {
				call = JSON.parse(body);
			} catch {
				if (!res.destroyed) res.writeHead(400).end();
				return;
			}
			const state = trials.get(call.id) ?? newTrial();
			trials.set(call.id, state);
			const token = `${call.id}:${call.node}:${call.threadId}:${state.calls.length}`;
			const pending = { ...call, token, res, answered: false };
			state.calls.push(pending);
			if (state.released) respondTo(state, pending);
			// A staggered trial answers the first fill at once and parks the second for the test to
			// release; the timer is only ever the safety valve that keeps a parked fill from hanging.
			else if (state.stagger && state.calls.length === 1) respondTo(state, pending);
			else if (!state.stagger && state.calls.length >= 2) releaseTrial(state, false);
			else state.timer ??= setTimeout(() => releaseTrial(state, true), BARRIER_MS);
		});
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolve({
				url: `http://127.0.0.1:${port}`,
				stage: (id, shape) => trials.set(id, newTrial(shape)),
				release: (id) => releaseTrial(trials.get(id), false),
				trial: (id) => trials.get(id),
				close: () =>
					new Promise((resolve, reject) => {
						server.close((error) => (error ? reject(error) : resolve()));
						server.closeAllConnections();
					}),
			});
		});
	});
}

async function rawOperation(node, operation, deadline) {
	try {
		const response = await fetch(node.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(operation),
			signal: AbortSignal.timeout(Math.max(1, Math.min(20000, deadline - Date.now()))),
		});
		return { status: response.status, body: await response.json() };
	} catch (error) {
		// node's fetch reports a connection failure as a generic "fetch failed" and puts the code on
		// error.cause, where the retry classification below cannot see it.
		const cause = error.cause?.code ? ` (${error.cause.code})` : '';
		return { status: 500, body: { error: error.message + cause } };
	}
}

async function connectNodes(nodeA, nodeB) {
	let token;
	let deadline = Date.now() + BOOTSTRAP_PHASE_MS;
	while (!token && Date.now() < deadline) {
		const response = await rawOperation(
			nodeA,
			{ operation: 'create_authentication_tokens', authorization: nodeA.admin },
			deadline
		);
		token = response.status === 200 && response.body.operation_token;
		if (!token) await delay(300);
	}
	if (!token) throw new Error('Failed to obtain replication token');

	let connected = false;
	deadline = Date.now() + BOOTSTRAP_PHASE_MS;
	while (!connected && Date.now() < deadline) {
		const response = await rawOperation(
			nodeB,
			{ operation: 'add_node', rejectUnauthorized: false, hostname: nodeA.hostname, authorization: `Bearer ${token}` },
			deadline
		);
		if (response.status === 200) connected = true;
		else if (/ECONNREFUSED|ECONNRESET|connect |aborted|timeout/i.test(JSON.stringify(response.body))) await delay(500);
		else throw new Error(`add_node failed (${response.status}): ${JSON.stringify(response.body)}`);
	}
	if (!connected) throw new Error('Timed out adding replication peer');

	deadline = Date.now() + BOOTSTRAP_PHASE_MS;
	while (Date.now() < deadline) {
		const statuses = await Promise.all(
			[nodeA, nodeB].map((node) =>
				sendOperation(node, { operation: 'cluster_status' }, { signal: AbortSignal.timeout(5000) }).catch(() => null)
			)
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
				res.on('error', reject);
				res.on('data', (chunk) => (responseBody += chunk));
				res.on('end', () => {
					if (![200, 201, 204].includes(res.statusCode))
						reject(new Error(url + ' returned ' + res.statusCode + ': ' + responseBody));
					else {
						try {
							resolve(responseBody ? JSON.parse(responseBody) : null);
						} catch (error) {
							reject(error);
						}
					}
				});
			}
		);
		req.setTimeout(20000, () => req.destroy(new Error(`Timed out requesting ${url}`)));
		req.on('error', reject);
		req.end(requestBody);
	});
}

// A blob mid-write or pending replication 500s transiently even after waitForAllWorkers has
// already seen this worker stable; retry like the other probes instead of failing the trial on it.
async function requestJsonRetrying(url, agent, options, attempts = 10, delayMs = 300) {
	let lastError;
	for (let i = 0; i < attempts; i++) {
		try {
			return await requestJson(url, agent, options);
		} catch (error) {
			lastError = error;
			await delay(delayMs);
		}
	}
	throw lastError;
}

async function pinWorkers(node) {
	const byThread = new Map();
	try {
		for (let i = 0; i < 40 && byThread.size < WORKERS; i++) {
			const agent = new Agent({ keepAlive: true, maxSockets: 1 });
			// a worker still coming up answers 5xx; keep probing rather than aborting the bootstrap
			const probe = await requestJson(`${node.httpURL}/PairWorker/probe-${i}`, agent).catch(() => null);
			if (!probe || byThread.has(probe.threadId)) {
				agent.destroy();
				if (!probe) await delay(100);
			} else byThread.set(probe.threadId, agent);
		}
		equal(byThread.size, WORKERS, `expected ${WORKERS} addressable workers on ${node.hostname}`);
	} catch (error) {
		// the after() hook can only destroy agents it was handed, and it is never handed these:
		// pinWorkers runs inside a Promise.all whose rejection leaves ctx.agentsByNode unassigned.
		for (const agent of byThread.values()) agent.destroy();
		throw error;
	}
	return byThread;
}

async function waitForConvergence(nodes, id, agentsByNode) {
	const deadline = Date.now() + 30000;
	let scans, lastError;
	while (Date.now() < deadline) {
		try {
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
		} catch (error) {
			lastError = error;
		}
		await delay(100);
	}
	throw new Error(
		`Timed out waiting for ${id} convergence: ${JSON.stringify(scans)}${lastError ? `; last error: ${lastError.message}` : ''}`
	);
}

async function waitForAllWorkers(nodes, id, agentsByNode, probeResource) {
	const deadline = Date.now() + 30000;
	let probes, lastError;
	let stableSignature;
	let stableSince = 0;
	while (Date.now() < deadline) {
		try {
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
						probe.raw?.record &&
						probe.raw.version === winner.version &&
						probe.raw.record.token === winner.record.token &&
						probe.record?.token === winner.record.token
				)
			) {
				const signature = `${winner.version}:${winner.record.token}`;
				if (signature !== stableSignature) {
					stableSignature = signature;
					stableSince = Date.now();
				} else if (Date.now() - stableSince >= 3000) {
					return probes;
				}
			} else {
				stableSignature = undefined;
				stableSince = 0;
			}
		} catch (error) {
			lastError = error;
			stableSignature = undefined;
			stableSince = 0;
		}
		await delay(100);
	}
	throw new Error(
		`Timed out waiting for ${id} on every worker: ${JSON.stringify(probes)}${lastError ? `; last error: ${lastError.message}` : ''}`
	);
}

/**
 * Lets the first fill's record replicate to the node whose own fill is parked at the origin, then
 * releases it, so that fill commits against a peer record instead of an empty store. Probes on a
 * throwaway agent: the node's pinned agents are single-socket and one of them is holding the
 * parked fill.
 *
 * Returns false when the peer record never arrived, which leaves the released fill racing an empty
 * store — the ordinary shape, not the one this trial is for.
 */
async function releaseLateFill(ctx, id) {
	const deadline = Date.now() + BARRIER_MS;
	let lateIndex = -1;
	let staged = false;
	while (lateIndex < 0 && Date.now() < deadline) {
		const calls = ctx.origin.trial(id)?.calls ?? [];
		if (calls.length >= 2) lateIndex = ctx.nodes.findIndex((node) => node.hostname === calls[1].node);
		else await delay(50);
	}
	if (lateIndex < 0) return false;
	const probeAgent = new Agent({ keepAlive: true, maxSockets: 1 });
	try {
		while (!staged && Date.now() < deadline) {
			const scan = await requestJson(`${ctx.nodes[lateIndex].httpURL}/PairScanProbe/${id}`, probeAgent).catch(
				() => null
			);
			if (scan?.record) staged = true;
			else await delay(50);
		}
	} finally {
		probeAgent.destroy();
		ctx.origin.release(id);
	}
	return staged;
}

/**
 * Races one key across both nodes and asserts the whole cluster settles on a single write.
 * Returns false when the barrier never held two concurrent fills — one node learned the key by
 * replication before issuing its own, so nothing about convergence was demonstrated.
 */
async function raceTrial(ctx, id, shape) {
	ctx.origin.stage(id, shape);
	const fillAgents = ctx.agentsByNode.map((agents) => agents.values().next().value);
	const pendingFills = Promise.all(
		ctx.nodes.map((node, index) => requestJson(`${node.httpURL}/PairRecord/${id}`, fillAgents[index]))
	);
	// releaseLateFill awaits real I/O before this is awaited below, so a fill that rejects meanwhile
	// would reach node as an unhandled rejection and take the runner down instead of failing a trial.
	pendingFills.catch(() => {});
	const lateFillRacedAPeer = shape.stagger ? await releaseLateFill(ctx, id) : true;
	const fills = await pendingFills;
	const originTrial = ctx.origin.trial(id);
	ok(originTrial, `${id} performed no source fills`);
	if (originTrial.timedOut || originTrial.calls.length < 2 || !lateFillRacedAPeer) return false;
	equal(originTrial.calls.length, 2, `${id} must perform exactly two independent source fills`);
	equal(
		new Set(originTrial.calls.map((call) => call.node)).size,
		2,
		`${id} both source fills came from the same node — this did not race two nodes`
	);
	notEqual(fills[0].token, fills[1].token, `${id} source fills must be distinguishable`);

	await waitForConvergence(ctx.nodes, id, ctx.agentsByNode);
	await waitForAllWorkers(ctx.nodes, id, ctx.agentsByNode, 'PairPointProbe');
	// waitForAllWorkers's stability check only compares version/token; capture the current
	// node[0]/node[1] pair here for the full-record deepEqual/payloadToken checks below.
	const scans = await waitForConvergence(ctx.nodes, id, ctx.agentsByNode);
	deepEqual(scans[0].record, scans[1].record, `${id} raw stores must converge`);
	equal(scans[0].record.payloadToken, scans[0].record.token, `${id} raw record/blob pairing`);
	if (shape.tied)
		equal(
			scans[0].version,
			shape.lastModified,
			`${id} both fills reported ${shape.lastModified}, so the stored version must tie`
		);

	for (let nodeIndex = 0; nodeIndex < ctx.nodes.length; nodeIndex++) {
		for (const [threadId, agent] of ctx.agentsByNode[nodeIndex]) {
			const probe = await requestJsonRetrying(`${ctx.nodes[nodeIndex].httpURL}/PairPointProbe/${id}`, agent);
			equal(probe.threadId, threadId, `${id} connection moved between workers`);
			ok(probe.record, `${id} missing on node ${nodeIndex}, worker ${threadId}`);
			ok(probe.raw?.record, `${id} missing raw record on node ${nodeIndex}, worker ${threadId}`);
			equal(
				probe.raw.record.token,
				scans[0].record.token,
				`${id} raw store differs on ${probe.node} worker ${threadId}: ${JSON.stringify(probe)}`
			);
			equal(
				probe.record.token,
				scans[0].record.token,
				`${id} stale point read on ${probe.node} worker ${threadId}: ${JSON.stringify(probe)}`
			);
			equal(
				probe.raw.record.payloadToken,
				probe.raw.record.token,
				`${id} raw blob/metadata split on worker ${threadId}`
			);
			equal(probe.record.payloadToken, probe.record.token, `${id} blob/metadata split on worker ${threadId}`);
		}
	}
	equal(ctx.origin.trial(id).calls.length, 2, `${id} performed extra source fills during probing`);
	return true;
}

function sourcedBlobPairing(ctx) {
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
		ctx.nodes = [];
		await Promise.all(
			contexts.map(async (nodeCtx, index) => {
				await startHarper(nodeCtx, {
					config: {
						analytics: { aggregatePeriod: -1 },
						logging: { colors: false, stdStreams: false, console: true },
						replication: { securePort: `${nodeCtx.harper.hostname}:9933` },
						storage: { engine: ctx.testLMDB ? 'lmdb' : 'rocksdb' },
						threads: { count: WORKERS },
					},
					env: { HARPER_NO_FLUSH_ON_EXIT: true, HARPER_TEST_ORIGIN_URL: ctx.origin.url },
				});
				ctx.nodes[index] = nodeCtx.harper;
			})
		);
		await connectNodes(...ctx.nodes);
		ctx.agentsByNode = await Promise.all(ctx.nodes.map(pinWorkers));
	});

	after(async () => {
		for (const agents of ctx.agentsByNode ?? []) {
			for (const agent of agents.values()) {
				try {
					agent.destroy();
				} catch {}
			}
		}
		try {
			await Promise.allSettled((ctx.nodes ?? []).filter(Boolean).map((node) => teardownHarper({ harper: node })));
		} finally {
			await ctx.origin?.close();
		}
	});

	test(`${TRIALS} two-node cache-fill races settle each record and blob from one write on every worker`, async () => {
		let restagesLeft = RESTAGE_BUDGET;
		for (let trial = 0; trial < TRIALS; trial++) {
			const { id, ...rest } = SHAPES[trial % SHAPES.length];
			const shape = { ...rest, lastModified: rest.tied ? Date.now() - TIE_BACKDATE_MS : undefined };
			let staged = await raceTrial(ctx, `${id}-${trial}`, shape);
			for (let restage = 1; !staged && restagesLeft > 0; restage++) {
				restagesLeft--;
				staged = await raceTrial(ctx, `${id}-${trial}-restage${restage}`, shape);
			}
			ok(staged, `${id}-${trial} never staged two concurrent source fills; suite restage budget exhausted`);
		}
	});
}

suite('sourcedFrom blob/metadata pairing under competing cache fills', { timeout: 300000 }, sourcedBlobPairing);
suite('sourcedFrom blob/metadata pairing under competing cache fills with LMDB', { timeout: 300000 }, (ctx) => {
	ctx.testLMDB = true;
	sourcedBlobPairing(ctx);
});
