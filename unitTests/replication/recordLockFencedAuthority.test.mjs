/**
 * Authority a fenced node exercised under the old generation cannot admit on a survivor that staged
 * the next one, on core's real coordinator with `homeMap()` driven from a home-map row the way
 * `recordLockTransport.ts` drives it (no `active`, no map).
 */
import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import { LockCoordinator, homeFor, ringKeyFor } from '#src/core/resources/recordLockCoordinator';
import { digestOf, planActivate, planStage, provesQuiescence } from '#src/replication/recordLockHomes';

const LEASE = 1_000;
const WAIT = 500;
let sequence = 0;
const open = [];

function activeRow(database, generation, homes) {
	const digest = digestOf(generation, homes);
	const staged = planStage(undefined, database, generation, homes, digest, 0, homes).row;
	return planActivate(staged, database, generation, digest, 0, 0).row;
}

function cluster(names) {
	const database = `fenced${++sequence}`;
	const table = `FencedAuthority${sequence}`;
	const homes = [...names].sort();
	const nodes = new Map();
	const harness = {
		database,
		table,
		nodes,
		requests: [],
		/** Runs while the requester is still awaiting a reply: the window a delayed grant lands in. */
		beforeReply: undefined,
		keyHomedOn(name) {
			for (let i = 0; i < 10_000; i++) {
				const key = `key-${i}`;
				if (homeFor(ringKeyFor(database, table, key), homes) === name) return key;
			}
			throw new Error(`no key homes on ${name}`);
		},
		stage(name, generation, newHomes) {
			const node = nodes.get(name);
			const plan = planStage(node.row, database, generation, newHomes, digestOf(generation, newHomes), 0, homes);
			assert.strictEqual(plan.action, 'write', plan.reason);
			node.row = plan.row;
		},
		activate(name, generation, newHomes) {
			const node = nodes.get(name);
			const plan = planActivate(node.row, database, generation, digestOf(generation, newHomes), 0, 0);
			assert.strictEqual(plan.action, 'write', plan.reason);
			node.row = plan.row;
		},
	};
	for (const name of names) {
		const node = { name, alive: true, row: activeRow(database, 1, homes), written: [] };
		node.coordinator = new LockCoordinator({
			database,
			table,
			nodeId: name,
			transport: {
				homeMap: () =>
					node.row.active && {
						generation: node.row.active.generation,
						homes: node.row.active.homes,
						homeIncarnation: 1,
					},
				ownsCoordination: () => true,
				async requestDelegation(target, _database, _table, request) {
					harness.requests.push({ from: name, to: target });
					const home = nodes.get(target);
					if (!home.alive) throw new Error(`${target} is unreachable`);
					const reply = await home.coordinator.onDelegationRequest(request);
					await harness.beforeReply?.(name, target, reply);
					return reply;
				},
				async recallDelegation(target, _database, _table, recall) {
					const delegate = nodes.get(target);
					if (!delegate.alive) throw new Error(`${target} is unreachable`);
					return delegate.coordinator.onDelegationRecall(recall);
				},
				establishLockFreshness: async (_database, _table, _key, dependencies) => dependencies ?? [],
			},
			writeControl(entry) {
				node.written.push(entry);
				for (const peer of nodes.values()) if (peer !== node) peer.coordinator.applyEntry(entry, name);
				return node.written.length;
			},
			keyIdOf: (key) => String(key),
			nextTimestamp: () => performance.now(),
			grantableAfterMono: -Infinity,
			autoTick: false,
		});
		nodes.set(name, node);
		open.push(node.coordinator);
	}
	return harness;
}

describe('fenced apply: authority a fenced node exercised under generation g', () => {
	// Coordinators register themselves process-wide; close each test's so a later sweep never sees them.
	afterEach(() => {
		for (const coordinator of open.splice(0)) coordinator.close();
	});

	it('a grant from the fenced node that reaches a survivor after it staged g+1 is handed back, not installed', async () => {
		const harness = cluster(['a', 'b', 'c']);
		const { nodes } = harness;
		const key = harness.keyHomedOn('c');
		const b = nodes.get('b');
		// c granted, then died; its reply is still in flight when the operator's fenced apply stages b.
		harness.beforeReply = (from, to, reply) => {
			assert.strictEqual(reply.granted, true, 'c granted under generation 1');
			nodes.get('c').alive = false;
			harness.stage('b', 2, ['a', 'b']);
		};
		await assert.rejects(b.coordinator.acquire(key, LEASE, WAIT), /No agreed record lock home map/);
		assert.strictEqual(b.coordinator.stats.delegations, 0, "b installed the fenced node's generation-1 grant");
		const released = b.written.filter((entry) => entry.type === 'lockRelease');
		assert.strictEqual(released.length, 1, 'the stale grant was handed back');
		assert.strictEqual(released[0].token[0], 1);
	});

	it('a grant from the fenced node that reaches a survivor after it activated g+1 is handed back', async () => {
		const harness = cluster(['a', 'b', 'c']);
		const { nodes } = harness;
		// Homed on a under g+1, which stays at g and so refuses b's retry: nothing re-admits the key.
		const key = Array.from({ length: 10_000 }, (_, i) => `key-${i}`).find(
			(candidate) =>
				homeFor(ringKeyFor(harness.database, harness.table, candidate), ['a', 'b', 'c']) === 'c' &&
				homeFor(ringKeyFor(harness.database, harness.table, candidate), ['a', 'b']) === 'a'
		);
		const b = nodes.get('b');
		harness.beforeReply = () => {
			nodes.get('c').alive = false;
			harness.stage('b', 2, ['a', 'b']);
			harness.activate('b', 2, ['a', 'b']);
		};
		await assert.rejects(b.coordinator.acquire(key, LEASE, WAIT));
		assert.strictEqual(b.coordinator.stats.delegations, 0, "b installed the fenced node's generation-1 grant");
		const released = b.written.filter((entry) => entry.type === 'lockRelease');
		assert.strictEqual(released.length, 1, 'the stale grant was handed back');
		assert.strictEqual(released[0].token[0], 1);
	});

	it('a delegation request from the fenced node is refused once the survivor home staged, and after it activated', async () => {
		const harness = cluster(['a', 'b', 'c']);
		const { nodes } = harness;
		const key = harness.keyHomedOn('a');
		const a = nodes.get('a').coordinator;
		const late = { key, requester: 'c', generation: 1, leaseMs: LEASE };
		harness.stage('a', 2, ['a', 'b']);
		// A withheld map is answered as a home still coming up (record-locks.md §4.5): refused, and the
		// requester may wait it out inside its own deadline rather than fail at once.
		assert.deepStrictEqual(await a.onDelegationRequest(late), {
			granted: false,
			reason: 'generation',
			recovering: true,
			retryAfterMs: 250,
		});
		harness.activate('a', 2, ['a', 'b']);
		assert.deepStrictEqual(await a.onDelegationRequest(late), {
			granted: false,
			reason: 'generation',
			generation: 2,
		});
		assert.deepStrictEqual(await a.onDelegationRequest({ ...late, generation: 2 }), {
			granted: false,
			reason: 'unknown-node',
		});
		assert.strictEqual(a.stats.granted, 0);
	});

	it("a survivor's drain leaves its grant to the dead node outstanding, which only a fence on that node discounts", async () => {
		const harness = cluster(['a', 'b', 'c']);
		const { nodes } = harness;
		const a = nodes.get('a').coordinator;
		const c = nodes.get('c').coordinator;
		const key = harness.keyHomedOn('a');
		const round = await c.acquire(key, LEASE, WAIT);
		await c.release(key, round.admissionId);
		assert.strictEqual(a.stats.granted, 1, 'a granted c a delegation');
		nodes.get('c').alive = false;
		harness.stage('a', 2, ['a', 'b']);
		const quiesced = { complete: true, surrendered: 0, recalled: 0, outstanding: [] };
		await a.quiesce(quiesced, () => 1_000);
		if (quiesced.outstanding.length > 0) quiesced.complete = false;
		assert.strictEqual(quiesced.outstanding.length, 1);
		assert.strictEqual(quiesced.outstanding[0].delegate, 'c');
		assert.strictEqual(provesQuiescence(quiesced), false, 'an unconfirmed recall is not a proof by itself');
		assert.strictEqual(provesQuiescence(quiesced, ['c']), true, 'c is attested stopped: its delegation admits nothing');
		assert.strictEqual(provesQuiescence(quiesced, ['b']), false, 'a fence on another node covers nothing');
	});

	it('after activation a survivor home serves the keys it had delegated to the fenced node', async () => {
		const harness = cluster(['a', 'b', 'c']);
		const { nodes } = harness;
		const a = nodes.get('a').coordinator;
		const b = nodes.get('b').coordinator;
		const c = nodes.get('c').coordinator;
		const key = harness.keyHomedOn('a');
		const round = await c.acquire(key, LEASE, WAIT);
		await c.release(key, round.admissionId);
		nodes.get('c').alive = false;
		for (const name of ['a', 'b']) harness.stage(name, 2, ['a', 'b']);
		await a.quiesce({ complete: true, surrendered: 0, recalled: 0, outstanding: [] }, () => 1_000);
		for (const name of ['a', 'b']) harness.activate(name, 2, ['a', 'b']);
		const successor = await b.acquire(key, LEASE, WAIT);
		assert.ok(successor.admissionId, 'b holds the key c was delegated under generation 1');
		assert.strictEqual(a.stats.granted, 1);
	});
});
