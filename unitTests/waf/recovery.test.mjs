/**
 * The published matcher converges on the persisted rows after any recovery, with no later write
 * (harper-pro#889). Drives the real start() and compileRules. Most cases use a fake table over core's real
 * IterableEventQueue so each failure can be staged exactly; the last suite uses a real system table.
 * integrationTests/cluster/wafFullCopyConvergence.test.mjs covers the same contract through a real copy.
 */

import { expect } from 'chai';
import { setTimeout as delay } from 'node:timers/promises';
import { table as defineTable } from '#src/core/resources/databases';
import { IterableEventQueue } from '#src/core/resources/IterableEventQueue';
import { start, stop, getCurrentMatcher, WAF_RULE_TABLE, WAF_RULE_DATABASE } from '#src/waf/waf';
import { WAF_CONTROL_ID } from '#src/waf/ruleOperations';

function rule(id, prefix, overrides = {}) {
	return {
		id,
		enabled: true,
		priority: 1,
		phase: 'request',
		action: 'block',
		blockStatus: 403,
		match: { path: { prefix } },
		...overrides,
	};
}

class FailableQueue extends IterableEventQueue {
	#iterator;
	[Symbol.asyncIterator]() {
		this.#iterator = super[Symbol.asyncIterator]();
		const queue = this;
		return {
			next: () => (queue.nextFailure ? Promise.reject(queue.nextFailure) : queue.#iterator.next()),
			return: (value) => queue.#iterator.return(value),
		};
	}
	failNext(error) {
		this.nextFailure = error;
		this.send({ type: 'end_txn' });
	}
}

function makeTable(rows = []) {
	const table = {
		rows: new Map(rows.map((row) => [row.id, row])),
		queues: [],
		subscribes: 0,
		scans: 0,
		beforeScan: null,
		afterScan: null,
		subscribe: async () => {
			table.subscribes++;
			const queue = new FailableQueue();
			table.queues.push(queue);
			return queue;
		},
		primaryStore: {
			getRange: () => {
				table.scans++;
				table.beforeScan?.();
				const entries = Array.from(table.rows.values(), (value) => ({ key: value.id, value }));
				table.afterScan?.();
				return entries;
			},
		},
		put(row) {
			table.rows.set(row.id, row);
		},
		get liveQueue() {
			return table.queues.at(-1);
		},
	};
	return table;
}

function makeServer() {
	const server = {
		middleware: null,
		http: (listener) => {
			server.middleware = listener;
		},
	};
	return server;
}

async function until(condition, description, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
		await delay(2);
	}
}

function isBlocked(server, url) {
	const headers = new Map();
	const request = {
		ip: '203.0.113.7',
		method: 'GET',
		url,
		headers: { get: (name) => headers.get(name), keys: () => headers.keys() },
	};
	return server.middleware(request, () => 'pass')?.status === 403;
}

async function startSettled(table, options = {}) {
	const server = makeServer();
	start({ server, ensureTable: () => table, debounceMs: 5, ...options });
	await until(() => table.subscribes === 1 && table.scans >= 2, 'the first subscription to settle');
	return server;
}

describe('WAF matcher recovery', () => {
	afterEach(() => stop());

	describe('a subscription that ends, with no event for what changed meanwhile', () => {
		const endings = {
			'a normal iterator end': (table) => table.liveQueue.close(),
			// endSubscriptionsFromEarlierHandles delivers the error as a final message, then ends
			'a final error message': (table) => table.liveQueue.close(new Error('database closing')),
			'a rejected next()': (table) => table.liveQueue.failNext(new Error('iterator failed')),
		};
		for (const [name, end] of Object.entries(endings)) {
			it(`${name}: an insert converges`, async () => {
				const table = makeTable();
				const server = await startSettled(table);
				end(table);
				await delay(30); // so only the scan after resubscribing can see the write
				table.put(rule('inserted', '/admin'));
				await until(() => isBlocked(server, '/admin/x'), 'the inserted rule');
				expect(table.subscribes).to.equal(2);
			});
		}

		it('a final error message schedules no scan on the closing handle', async () => {
			const table = makeTable();
			await startSettled(table);
			const scans = table.scans;
			table.liveQueue.close(new Error('database closing'));
			await delay(30);
			expect(table.scans).to.equal(scans);
		});

		it('an update converges', async () => {
			const table = makeTable([rule('moved', '/old')]);
			const server = await startSettled(table);
			expect(isBlocked(server, '/old/x')).to.equal(true);
			table.liveQueue.close();
			table.put(rule('moved', '/new'));
			await until(() => isBlocked(server, '/new/x'), 'the updated rule');
			expect(isBlocked(server, '/old/x')).to.equal(false);
		});

		it('a delete converges, leaving the others', async () => {
			const table = makeTable([rule('kept', '/kept'), rule('dropped', '/dropped')]);
			const server = await startSettled(table);
			table.liveQueue.close();
			table.rows.delete('dropped');
			await until(() => !isBlocked(server, '/dropped/x'), 'the deleted rule to stop applying');
			expect(isBlocked(server, '/kept/x')).to.equal(true);
		});

		it('an emptied rule set converges on an empty matcher, not the previous one', async () => {
			const table = makeTable([rule('only', '/admin')]);
			const server = await startSettled(table);
			table.liveQueue.close();
			table.rows.clear();
			await until(() => getCurrentMatcher().isEmpty, 'the matcher to empty');
			expect(isBlocked(server, '/admin/x')).to.equal(false);
		});

		it('a subscribe that throws is retried, then converges', async () => {
			const table = makeTable();
			const server = await startSettled(table);
			const subscribe = table.subscribe;
			table.subscribe = async () => {
				table.subscribe = subscribe;
				table.subscribes++;
				throw new Error('subscribe failed');
			};
			table.liveQueue.close();
			table.put(rule('inserted', '/admin'));
			await until(() => isBlocked(server, '/admin/x'), 'the rule after a failed subscribe');
			expect(table.subscribes).to.equal(3);
		});
	});

	describe('control-row changes while a subscription was down', () => {
		const SCORE_RULE = rule('scored', '/scored', { action: 'score', score: 5 });

		it('a new mode takes effect', async () => {
			const table = makeTable([rule('block', '/admin')]);
			const server = await startSettled(table);
			table.liveQueue.close();
			table.put({ id: WAF_CONTROL_ID, mode: 'monitor' });
			await until(() => !isBlocked(server, '/admin/x'), 'monitor mode');
		});

		it('a new threshold beats the config fallback, and is never compiled as a rule', async () => {
			const table = makeTable([SCORE_RULE]);
			const server = await startSettled(table, { scoreThreshold: 10 });
			expect(isBlocked(server, '/scored')).to.equal(false);
			table.liveQueue.close();
			table.put({ id: WAF_CONTROL_ID, scoreThreshold: 5 });
			await until(() => isBlocked(server, '/scored'), 'the replicated threshold');
			expect(getCurrentMatcher().ruleCount).to.equal(1);
		});

		it('a removed control row restores the config fallback', async () => {
			const table = makeTable([SCORE_RULE, { id: WAF_CONTROL_ID, scoreThreshold: 5 }]);
			const server = await startSettled(table, { scoreThreshold: 10 });
			expect(isBlocked(server, '/scored')).to.equal(true);
			table.liveQueue.close();
			table.rows.delete(WAF_CONTROL_ID);
			await until(() => !isBlocked(server, '/scored'), 'the config threshold');
		});
	});

	describe('a subscription that survives a bulk reload', () => {
		const RELOAD = { type: 'reload', id: null };

		it('a reload marker alone converges rules and control, without resubscribing', async () => {
			const table = makeTable([rule('stale', '/stale')]);
			const server = await startSettled(table);
			table.rows.clear();
			table.put(rule('copied', '/copied'));
			table.put({ id: WAF_CONTROL_ID, mode: 'enforce', scoreThreshold: 7 });
			table.liveQueue.send(RELOAD);
			await until(() => isBlocked(server, '/copied/x'), 'the copied rule');
			expect(isBlocked(server, '/stale/x')).to.equal(false);
			expect(table.subscribes).to.equal(1);
		});

		it('a reload marker over an empty table empties the matcher', async () => {
			const table = makeTable([rule('stale', '/stale')]);
			await startSettled(table);
			table.rows.clear();
			table.liveQueue.send(RELOAD);
			await until(() => getCurrentMatcher().isEmpty, 'the matcher to empty');
		});

		it('end_txn alone does not recompile', async () => {
			const table = makeTable();
			await startSettled(table);
			const scans = table.scans;
			table.liveQueue.send({ type: 'end_txn' });
			await delay(30);
			expect(table.scans).to.equal(scans);
		});
	});

	describe('writes around a scan', () => {
		it('a write before the first subscription takes effect converges', async () => {
			const table = makeTable();
			const subscribe = table.subscribe;
			let register;
			table.subscribe = async () => {
				await new Promise((resolve) => (register = resolve));
				return subscribe();
			};
			const server = makeServer();
			start({ server, ensureTable: () => table, debounceMs: 5 });
			expect(table.scans).to.equal(1);
			table.put(rule('early', '/admin'));
			register();
			await until(() => isBlocked(server, '/admin/x'), 'the write the first scan missed');
		});

		it('a write landing just after a scan read the rows converges through its event', async () => {
			const table = makeTable();
			const server = await startSettled(table);
			table.afterScan = () => {
				table.afterScan = null;
				table.put(rule('late', '/admin'));
				table.liveQueue.send({ type: 'put', id: 'late' });
			};
			table.liveQueue.send({ type: 'put', id: 'trigger' });
			await until(() => isBlocked(server, '/admin/x'), 'the write behind the scan');
		});

		it('debounces a burst into one scan and publishes one matcher', async () => {
			const table = makeTable();
			const server = await startSettled(table, { debounceMs: 20 });
			const scans = table.scans;
			table.put(rule('burst', '/admin'));
			for (let i = 0; i < 50; i++) table.liveQueue.send({ type: 'put', id: i });
			await until(() => isBlocked(server, '/admin/x'), 'the burst');
			await delay(40);
			expect(table.scans).to.equal(scans + 1);
		});

		it('keeps serving the previous matcher object until a replacement is complete', async () => {
			const table = makeTable([rule('first', '/admin')]);
			await startSettled(table);
			const previous = getCurrentMatcher();
			let duringScan;
			table.afterScan = () => {
				table.afterScan = null;
				duringScan = getCurrentMatcher();
			};
			table.put(rule('second', '/other'));
			table.liveQueue.send({ type: 'put', id: 'second' });
			await until(() => getCurrentMatcher() !== previous, 'the swap');
			expect(duringScan).to.equal(previous);
			expect(getCurrentMatcher().ruleCount).to.equal(2);
		});
	});

	describe('retry after a failed scan or compile', () => {
		it('a scan error keeps the previous matcher and retries with no later event', async () => {
			const table = makeTable([rule('old', '/old')]);
			const server = await startSettled(table);
			table.beforeScan = () => {
				table.beforeScan = null;
				throw new Error('scan failed');
			};
			const previous = getCurrentMatcher();
			table.put(rule('new', '/new'));
			table.liveQueue.send({ type: 'put', id: 'new' });
			await until(() => table.beforeScan === null, 'the failing scan');
			expect(getCurrentMatcher()).to.equal(previous);
			expect(isBlocked(server, '/old/x')).to.equal(true);
			await until(() => isBlocked(server, '/new/x'), 'the retried scan');
		});

		it('a compile error keeps the previous matcher and retries with no later event', async () => {
			const table = makeTable();
			const server = await startSettled(table);
			let compileFailures = 1;
			const unstable = rule('unstable', '/admin');
			Object.defineProperty(unstable, 'enabled', {
				get() {
					if (compileFailures-- > 0) throw new Error('compile failed');
					return true;
				},
			});
			table.put(unstable);
			table.liveQueue.send({ type: 'put', id: 'unstable' });
			await until(() => compileFailures === 0, 'the failing compile');
			expect(isBlocked(server, '/admin/x')).to.equal(false);
			await until(() => isBlocked(server, '/admin/x'), 'the retried compile');
		});

		it('a failed first compile passes traffic through, then retries', async () => {
			const table = makeTable([rule('first', '/admin')]);
			table.beforeScan = () => {
				table.beforeScan = null;
				throw new Error('scan failed');
			};
			// no subscription to help: only the retry can compile
			table.subscribe = () => new Promise(() => {});
			const server = makeServer();
			start({ server, ensureTable: () => table, debounceMs: 5 });
			expect(getCurrentMatcher()).to.equal(null);
			expect(isBlocked(server, '/admin/x')).to.equal(false);
			await until(() => isBlocked(server, '/admin/x'), 'the retried first compile');
		});

		it('an event during backoff compiles at the debounce interval, and success cancels the retry', async () => {
			const table = makeTable();
			const server = await startSettled(table);
			table.beforeScan = () => {
				table.beforeScan = null;
				throw new Error('scan failed');
			};
			table.liveQueue.send({ type: 'put', id: 'a' });
			await until(() => table.beforeScan === null, 'the failing scan');
			table.put(rule('b', '/admin'));
			table.liveQueue.send({ type: 'put', id: 'b' });
			await until(() => isBlocked(server, '/admin/x'), 'the event during backoff', 500);
			const scans = table.scans;
			await delay(1200);
			expect(table.scans).to.equal(scans);
		});

		it('events during a failure run share one retry chain', async () => {
			const table = makeTable();
			await startSettled(table, { debounceMs: 1 });
			table.beforeScan = () => {
				throw new Error('scan failed');
			};
			const baseline = table.scans;
			table.liveQueue.send({ type: 'put', id: 'first' });
			await until(() => table.scans === baseline + 1, 'the first failure');
			let sent = 1;
			const deadline = Date.now() + 500;
			while (Date.now() < deadline) {
				const before = table.scans;
				table.liveQueue.send({ type: 'put', id: sent++ });
				await until(() => table.scans > before, 'the event-driven scan');
			}
			// each event scans once; the only other scan allowed is the single pending retry's
			expect(table.scans - baseline).to.be.at.most(sent + 1);
			table.beforeScan = null;
		});
	});

	describe('stop', () => {
		it('closes the parked subscription', async () => {
			const table = makeTable();
			await startSettled(table);
			stop();
			expect(table.liveQueue.closed).to.equal(true);
		});

		it('cancels a pending debounced compile, so nothing publishes after stop', async () => {
			const table = makeTable();
			const server = await startSettled(table, { debounceMs: 20 });
			const scans = table.scans;
			table.put(rule('late', '/admin'));
			table.liveQueue.send({ type: 'put', id: 'late' });
			await delay(1); // lets the loop take the event
			stop();
			await delay(40);
			expect(table.scans).to.equal(scans);
			expect(isBlocked(server, '/admin/x')).to.equal(false);
		});

		it('cancels a pending retry', async () => {
			const table = makeTable();
			await startSettled(table);
			table.beforeScan = () => {
				table.beforeScan = null;
				throw new Error('scan failed');
			};
			table.liveQueue.send({ type: 'put', id: 'a' });
			await until(() => table.beforeScan === null, 'the failing scan');
			const scans = table.scans;
			stop();
			await delay(1200);
			expect(table.scans).to.equal(scans);
		});

		it('does not resubscribe after a stop during the resubscribe wait', async () => {
			const table = makeTable();
			await startSettled(table);
			table.liveQueue.close();
			await delay(10);
			stop();
			await delay(1200);
			expect(table.subscribes).to.equal(1);
		});

		it('closes a subscription that resolves after stop, without scanning', async () => {
			const table = makeTable();
			const subscribe = table.subscribe;
			let register;
			table.subscribe = async () => {
				await new Promise((resolve) => (register = resolve));
				return subscribe();
			};
			const server = makeServer();
			start({ server, ensureTable: () => table, debounceMs: 5 });
			stop();
			const scans = table.scans;
			register();
			await until(() => table.liveQueue?.closed, 'the late subscription to close');
			await delay(20);
			expect(table.scans).to.equal(scans);
		});

		for (const [name, closeFailure] of Object.entries({
			throws: () => {
				throw new Error('close failed');
			},
			rejects: () => Promise.reject(new Error('close failed')),
		})) {
			it(`survives an iterator whose return ${name}, and a later start still works`, async () => {
				const failing = makeTable();
				failing.subscribe = async () => {
					failing.subscribes++;
					return {
						[Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: closeFailure }),
					};
				};
				await startSettled(failing);
				expect(() => stop()).to.not.throw();
				await delay(5); // a rejection here would surface as an unhandled rejection in the run

				const next = makeTable([rule('next', '/admin')]);
				const server = await startSettled(next);
				expect(isBlocked(server, '/admin/x')).to.equal(true);
			});
		}

		it('a stopped instance cannot publish over its replacement', async () => {
			const first = makeTable();
			await startSettled(first);
			const firstQueue = first.liveQueue;
			const second = makeTable([rule('second', '/admin')]);
			const server = await startSettled(second);
			const scans = first.scans;
			first.put(rule('first', '/first'));
			firstQueue.send({ type: 'put', id: 'first' });
			await delay(30);
			expect(first.scans).to.equal(scans);
			expect(isBlocked(server, '/first/x')).to.equal(false);
			expect(isBlocked(server, '/admin/x')).to.equal(true);
		});
	});

	describe('against a real system table', () => {
		let RuleTable;
		let subscriptions;
		let realSubscribe;

		const ensureTable = (definition) => defineTable(definition);
		// Writes the row the way a copy does: into the store, with no audit entry and so no event.
		const writeWithoutAudit = (row) => RuleTable.primaryStore.put(row.id, row, { version: Date.now() });

		before(() => {
			RuleTable = defineTable({
				table: WAF_RULE_TABLE,
				database: WAF_RULE_DATABASE,
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			realSubscribe = RuleTable.subscribe;
			RuleTable.subscribe = function (...args) {
				const subscription = realSubscribe.apply(this, args);
				subscription.then((resolved) => subscriptions.push(resolved));
				return subscription;
			};
		});

		after(() => {
			RuleTable.subscribe = realSubscribe;
		});

		beforeEach(async () => {
			subscriptions = [];
			for (const { key } of RuleTable.primaryStore.getRange({})) await RuleTable.primaryStore.remove(key);
		});

		async function startOnRealTable() {
			const server = makeServer();
			start({ server, ensureTable, debounceMs: 5 });
			const startupMatcher = getCurrentMatcher();
			await until(() => subscriptions.length === 1, 'the real subscription');
			await until(() => getCurrentMatcher() !== startupMatcher, 'the scan the subscription schedules');
			return server;
		}

		it('a surviving subscription stays stale on audit-less rows until the reload marker', async () => {
			const server = await startOnRealTable();
			await writeWithoutAudit(rule('copied', '/copied'));
			await delay(50);
			expect(isBlocked(server, '/copied/x')).to.equal(false);
			await RuleTable.writeReloadMarker();
			await until(() => isBlocked(server, '/copied/x'), 'the reload marker');
			expect(subscriptions).to.have.length(1);
		});

		it('a closed real subscription resubscribes and picks up what it missed', async () => {
			const server = await startOnRealTable();
			subscriptions[0].close();
			await writeWithoutAudit(rule('missed', '/missed'));
			await until(() => subscriptions.length === 2, 'the resubscribe');
			await until(() => isBlocked(server, '/missed/x'), 'the rescan');
		});

		it('an audited write still converges through its event', async () => {
			const server = await startOnRealTable();
			await RuleTable.put('audited', rule('audited', '/audited'));
			await until(() => isBlocked(server, '/audited/x'), 'the audited write');
		});

		it('stop removes the real listener', async () => {
			await startOnRealTable();
			const [subscription] = subscriptions;
			expect(subscription.subscriptions).to.not.equal(null);
			stop();
			expect(subscription.closed).to.equal(true);
			expect(subscription.subscriptions).to.equal(null);
		});
	});
});
